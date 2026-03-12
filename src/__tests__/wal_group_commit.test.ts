import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ShardWAL } from '../wal';
import { ShardWorker } from '../shard_worker';
import { InMemoryBackend } from '../memory_backend';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── WAL batch helpers ───────────────────────────────────────────────

function tempWal(opts?: { compactThresholdBytes?: number }): { wal: ShardWAL; dir: string; walPath: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'mmpm-wal-gc-test-'));
    const walPath = join(dir, 'test.wal');
    const wal = new ShardWAL(walPath, opts);
    return {
        wal,
        dir,
        walPath,
        cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { } },
    };
}

describe('WAL Group Commit — Batched Writes', () => {
    it('writeAddBatched + flushBatch produces readable entries', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();

        wal.writeAddBatched('atom_1', 0);
        wal.writeAddBatched('atom_2', 1);
        wal.writeAddBatched('atom_3', 2);

        expect(wal.pendingBatchSize).toBe(3);
        const flushed = await wal.flushBatch();
        expect(flushed).toBe(3);
        expect(wal.pendingBatchSize).toBe(0);

        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(3);
        expect(entries[0].op).toBe('ADD');
        expect(entries[0].data).toBe('atom_1');
        expect(entries[1].data).toBe('atom_2');
        expect(entries[2].data).toBe('atom_3');

        await wal.close();
        cleanup();
    });

    it('writeTombstoneBatched + flushBatch produces readable entries', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();

        wal.writeTombstoneBatched(5);
        wal.writeTombstoneBatched(10);
        const flushed = await wal.flushBatch();
        expect(flushed).toBe(2);

        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(2);
        expect(entries[0].op).toBe('TOMBSTONE');
        expect(entries[0].index).toBe(5);
        expect(entries[1].index).toBe(10);

        await wal.close();
        cleanup();
    });

    it('flushBatch returns 0 and no-ops when buffer is empty', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();
        const flushed = await wal.flushBatch();
        expect(flushed).toBe(0);
        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(0);
        await wal.close();
        cleanup();
    });

    it('mixed batched and individual writes interleave correctly', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();

        // Individual write first
        await wal.writeAdd('single_1');

        // Batched writes
        wal.writeAddBatched('batch_1', 1);
        wal.writeAddBatched('batch_2', 2);
        await wal.flushBatch();

        // Individual write after
        await wal.writeAdd('single_2');

        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(4);
        expect(entries.map(e => e.data)).toEqual(['single_1', 'batch_1', 'batch_2', 'single_2']);
        // Sequence numbers are monotonically increasing
        for (let i = 1; i < entries.length; i++) {
            expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
        }

        await wal.close();
        cleanup();
    });

    it('batched entries survive simulated crash (pre-flush data is lost)', async () => {
        const { wal, walPath, cleanup } = tempWal();
        await wal.open();

        // Flush a batch of 3
        wal.writeAddBatched('flushed_1', 0);
        wal.writeAddBatched('flushed_2', 1);
        await wal.flushBatch();

        // Buffer more without flushing (simulates crash)
        wal.writeAddBatched('unflushed_1', 2);
        expect(wal.pendingBatchSize).toBe(1);

        // Close without flushing — unflushed_1 is lost
        await wal.close();

        // Re-open and verify: only flushed entries survive
        const wal2 = new ShardWAL(walPath);
        await wal2.open();
        const entries = await wal2.readUncommitted();
        expect(entries).toHaveLength(2);
        expect(entries.map(e => e.data)).toEqual(['flushed_1', 'flushed_2']);
        await wal2.close();
        cleanup();
    });

    it('partial write corruption is handled via checksum validation', async () => {
        const { wal, walPath, cleanup } = tempWal();
        await wal.open();

        // Write valid entries
        wal.writeAddBatched('valid_1', 0);
        wal.writeAddBatched('valid_2', 1);
        await wal.flushBatch();
        await wal.close();

        // Corrupt the file by appending a partial line (simulates crash mid-write)
        const content = readFileSync(walPath, 'utf-8');
        writeFileSync(walPath, content + '{"seq":99,"ts":9999,"op":"ADD","data":"corrupt","ck":"bad');

        // Re-open: corrupt line is silently dropped
        const wal2 = new ShardWAL(walPath);
        const entries = await wal2.readUncommitted();
        expect(entries).toHaveLength(2);
        expect(entries.map(e => e.data)).toEqual(['valid_1', 'valid_2']);
        cleanup();
    });

    it('batched entries followed by commit then truncate leaves clean state', async () => {
        const { wal, cleanup } = tempWal();
        await wal.open();

        wal.writeAddBatched('a', 0);
        wal.writeAddBatched('b', 1);
        await wal.flushBatch();
        await wal.writeCommit();
        await wal.truncate();

        const entries = await wal.readUncommitted();
        expect(entries).toHaveLength(0);

        await wal.close();
        cleanup();
    });
});

// ─── ShardWorker batched training ────────────────────────────────────

describe('ShardWorker — Batched Training (Group Commit)', () => {
    let dir: string;
    let cleanup: () => void;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mmpm-sw-gc-test-'));
        cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { } };
    });

    afterEach(() => cleanup());

    function makeWorker(atoms: string[]) {
        const storage = new InMemoryBackend();
        const worker = new ShardWorker(atoms, join(dir, 'shard_0'), {
            storage,
            clock: (() => { let t = 1000; return () => t++; })(),
        });
        return { worker, storage };
    }

    it('recordTransitionBatched buffers in memory, flushTransitionBatch persists', async () => {
        const atoms = ['v1.fact.a', 'v1.fact.b', 'v1.fact.c'];
        const { worker } = makeWorker(atoms);
        await worker.init();
        await worker.commit();

        const hashA = worker.getHash('v1.fact.a')!;
        const hashB = worker.getHash('v1.fact.b')!;
        const hashC = worker.getHash('v1.fact.c')!;

        // Buffer transitions
        worker.recordTransitionBatched(hashA, hashB);
        worker.recordTransitionBatched(hashB, hashC);

        // Flush all at once
        const count = await worker.flushTransitionBatch();
        expect(count).toBe(4); // 2 transitions × 2 puts (w: + wu:) each

        // Verify transitions are in memory via stats
        const stats = worker.getStats();
        expect(stats.trainedAtoms).toBe(2); // a→b and b→c
        expect(stats.totalEdges).toBe(2);

        await worker.close();
    });

    it('flushTransitionBatch returns 0 when nothing is buffered', async () => {
        const atoms = ['v1.fact.a'];
        const { worker } = makeWorker(atoms);
        await worker.init();
        const count = await worker.flushTransitionBatch();
        expect(count).toBe(0);
        await worker.close();
    });

    it('batched addAtoms uses group commit for WAL + storage', async () => {
        const atoms = ['v1.fact.seed'];
        const { worker } = makeWorker(atoms);
        await worker.init();
        await worker.commit();

        // Add multiple atoms in a single call — should batch WAL + storage
        await worker.addAtoms([
            'v1.fact.new_1',
            'v1.fact.new_2',
            'v1.fact.new_3',
        ]);
        // Must commit to make atoms accessible (they're pending before commit)
        await worker.commit();

        // All atoms should be in getAtoms list
        const allAtoms = worker.getAtoms().map(a => a.atom);
        expect(allAtoms).toContain('v1.fact.new_1');
        expect(allAtoms).toContain('v1.fact.new_2');
        expect(allAtoms).toContain('v1.fact.new_3');

        // Should be accessible after commit (access returns hash, not item name)
        const r1 = await worker.access('v1.fact.new_1');
        expect(r1.hash).toBeDefined();
        expect(r1.proof).toBeDefined();

        await worker.close();
    });

    it('batched addAtoms survives restart (WAL recovery)', async () => {
        const atoms = ['v1.fact.seed'];
        const dbPath = join(dir, 'shard_persist');

        // Create worker with real LevelDB (default storage) for persistence test
        const worker1 = new ShardWorker(atoms, dbPath, {
            clock: (() => { let t = 1000; return () => t++; })(),
        });
        await worker1.init();
        await worker1.commit();

        // Add atoms via batched path
        await worker1.addAtoms(['v1.fact.persisted_1', 'v1.fact.persisted_2']);
        await worker1.commit();
        await worker1.close();

        // Restart with same data
        const worker2 = new ShardWorker(atoms, dbPath, {
            clock: (() => { let t = 5000; return () => t++; })(),
        });
        await worker2.init();

        // Verify atoms survived
        const atoms2 = worker2.getAtoms().map(a => a.atom);
        expect(atoms2).toContain('v1.fact.persisted_1');
        expect(atoms2).toContain('v1.fact.persisted_2');

        await worker2.close();
    });

    it('batched transitions match non-batched behavior (equivalence)', async () => {
        const atoms = ['v1.fact.x', 'v1.fact.y', 'v1.fact.z'];

        // Worker 1: use regular recordTransition
        const { worker: w1 } = makeWorker(atoms);
        await w1.init();
        await w1.commit();
        const hx1 = w1.getHash('v1.fact.x')!;
        const hy1 = w1.getHash('v1.fact.y')!;
        const hz1 = w1.getHash('v1.fact.z')!;
        await w1.recordTransition(hx1, hy1);
        await w1.recordTransition(hy1, hz1);
        const stats1 = w1.getStats();
        const r1 = await w1.access('v1.fact.x');

        // Worker 2: use batched recordTransition
        const { worker: w2 } = makeWorker(atoms);
        await w2.init();
        await w2.commit();
        const hx2 = w2.getHash('v1.fact.x')!;
        const hy2 = w2.getHash('v1.fact.y')!;
        const hz2 = w2.getHash('v1.fact.z')!;
        w2.recordTransitionBatched(hx2, hy2);
        w2.recordTransitionBatched(hy2, hz2);
        await w2.flushTransitionBatch();
        const stats2 = w2.getStats();
        const r2 = await w2.access('v1.fact.x');

        // Results should be identical
        expect(stats2.trainedAtoms).toBe(stats1.trainedAtoms);
        expect(stats2.totalEdges).toBe(stats1.totalEdges);
        expect(r2.predictedNext?.atom).toBe(r1.predictedNext?.atom);
        expect(r2.predictedNext?.weight).toBe(r1.predictedNext?.weight);

        await w1.close();
        await w2.close();
    });
});

// ─── Orchestrator-level training integration ─────────────────────────

describe('Orchestrator — Batched Training Integration', () => {
    let dir: string;
    let cleanup: () => void;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mmpm-orch-gc-test-'));
        cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { } };
    });

    afterEach(() => cleanup());

    it('train() uses group commit (end-to-end)', async () => {
        // Dynamic import to get ShardedOrchestrator
        const { ShardedOrchestrator } = await import('../orchestrator');

        const seedAtoms = ['v1.fact.step_a'];
        const orch = new ShardedOrchestrator(2, seedAtoms, join(dir, 'orch'));
        await orch.init();

        // Add more atoms (addAtoms auto-commits per shard)
        await orch.addAtoms([
            'v1.fact.step_b',
            'v1.fact.step_c',
            'v1.fact.step_d',
        ]);

        // Train a sequence (uses batched path internally)
        await orch.train([
            'v1.fact.step_a',
            'v1.fact.step_b',
            'v1.fact.step_c',
            'v1.fact.step_d',
        ]);

        // Verify stats: edges were recorded
        const stats = orch.getClusterStats();
        expect(stats.totalEdges).toBeGreaterThanOrEqual(3);

        await orch.close();
    });
});
