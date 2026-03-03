import { describe, it, expect, afterAll, vi } from 'vitest';
import { ShardWorker } from '../shard_worker';
import { MerkleKernel } from '../merkle';
import { CsrTransitionMatrix } from '../csr_matrix';
import { TransitionPolicy } from '../transition_policy';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let counter = 0;
const atom = (value: string) => `v1.other.${value}`;

function freshDb(): string {
    const path = `./test-shard-db-${Date.now()}-${counter++}`;
    dbDirs.push(path);
    return path;
}

afterAll(() => {
    for (const dir of dbDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
        try { rmSync(`${dir}.wal`, { force: true }); } catch { }
    }
});

describe('ShardWorker', () => {
    // --- Basic structure ---
    it('getKernelRoot returns a valid 64-char hex string for non-empty data', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();
        expect(worker.getKernelRoot()).toMatch(/^[a-f0-9]{64}$/);
        await worker.close();
    });

    it('getKernelRoot returns a zero-hash string for empty shard (after empty-tree fix)', async () => {
        const worker = new ShardWorker([], freshDb());
        await worker.init();
        // Empty MerkleKernel should not crash and should return a defined value
        expect(typeof worker.getKernelRoot()).toBe('string');
        await worker.close();
    });

    it('getKernelRoot is deterministic for the same data', async () => {
        const workerA = new ShardWorker([atom('X'), atom('Y')], freshDb());
        const workerB = new ShardWorker([atom('X'), atom('Y')], freshDb());
        await workerA.init();
        await workerB.init();
        expect(workerA.getKernelRoot()).toBe(workerB.getKernelRoot());
        await workerA.close();
        await workerB.close();
    });

    // --- getHash ---
    it('getHash returns a valid 64-char hex string for a known item', async () => {
        const worker = new ShardWorker([atom('hello'), atom('world')], freshDb());
        await worker.init();
        expect(worker.getHash(atom('hello'))).toMatch(/^[a-f0-9]{64}$/);
        expect(worker.getHash(atom('world'))).toMatch(/^[a-f0-9]{64}$/);
        await worker.close();
    });

    it('getHash returns undefined for an unknown item', async () => {
        const worker = new ShardWorker([atom('A'), atom('B')], freshDb());
        await worker.init();
        expect(worker.getHash(atom('NOT_IN_SHARD'))).toBeUndefined();
        await worker.close();
    });

    it('getHash matches the leaf hash from a standalone MerkleKernel', async () => {
        const data = [atom('alpha'), atom('beta')];
        const worker = new ShardWorker(data, freshDb());
        await worker.init();
        const kernel = new MerkleKernel(data);
        expect(worker.getHash(atom('alpha'))).toBe(kernel.getLeafHash(0));
        expect(worker.getHash(atom('beta'))).toBe(kernel.getLeafHash(1));
        await worker.close();
    });

    // --- access ---
    it('access returns proof, hash, and null prediction for untrained item', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();
        const result = await worker.access(atom('A'));
        expect(result.proof.leaf).toMatch(/^[a-f0-9]{64}$/);
        expect(result.proof.root).toBe(worker.getKernelRoot());
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.next).toBeNull();
        expect(result.nextProof).toBeNull();
        await worker.close();
    });

    it('access throws for an item not in the shard', async () => {
        const worker = new ShardWorker([atom('A'), atom('B')], freshDb());
        await worker.init();
        await expect(worker.access(atom('UNKNOWN'))).rejects.toThrow();
        await worker.close();
    });

    it('access proof is valid via MerkleKernel.verifyProof', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C'), atom('D')], freshDb());
        await worker.init();
        const result = await worker.access(atom('C'));
        expect(MerkleKernel.verifyProof(result.proof)).toBe(true);
        await worker.close();
    });

    // --- recordTransition + prediction ---
    it('recordTransition makes access predict the next item', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();
        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        await worker.recordTransition(hashA, hashB);
        const result = await worker.access(atom('A'));
        expect(result.next).toBe(atom('B'));
        expect(result.nextProof).not.toBeNull();
        expect(MerkleKernel.verifyProof(result.nextProof!)).toBe(true);
        await worker.close();
    });

    it('recordTransition with more weight wins prediction', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();
        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        const hashC = worker.getHash(atom('C'))!;
        // Record A→C 3 times vs A→B 1 time
        for (let i = 0; i < 3; i++) await worker.recordTransition(hashA, hashC);
        await worker.recordTransition(hashA, hashB);
        const result = await worker.access(atom('A'));
        expect(result.next).toBe(atom('C')); // C has higher accumulated weight
        await worker.close();
    });

    // --- LevelDB persistence ---
    it('persists transitions across close/reopen', async () => {
        const db = freshDb();
        const data = [atom('P'), atom('Q'), atom('R')];

        // Write
        const w1 = new ShardWorker(data, db);
        await w1.init();
        const hp = w1.getHash(atom('P'))!;
        const hq = w1.getHash(atom('Q'))!;
        await w1.recordTransition(hp, hq);
        await new Promise(r => setTimeout(r, 30)); // let async persist settle
        await w1.close();

        // Reopen
        const w2 = new ShardWorker(data, db);
        await w2.init(); // loads from LevelDB
        const result = await w2.access(atom('P'));
        expect(result.next).toBe(atom('Q'));
        await w2.close();
    });

    // --- close ---
    it('close() resolves without error', async () => {
        const worker = new ShardWorker([atom('A')], freshDb());
        await worker.init();
        await expect(worker.close()).resolves.not.toThrow();
    });

    it('close() can be called on a freshly constructed (uninitialised) worker', async () => {
        const worker = new ShardWorker([atom('A')], freshDb());
        await expect(worker.close()).resolves.not.toThrow();
    });
});

describe('ShardWorker — CSR integration (Sprint 8)', () => {
    it('CSR is built on init() after weight rehydration from LevelDB', async () => {
        const db = freshDb();

        const w1 = new ShardWorker([atom('A'), atom('B')], db);
        await w1.init();
        const hashA = w1.getHash(atom('A'))!;
        const hashB = w1.getHash(atom('B'))!;
        await w1.recordTransition(hashA, hashB);
        await w1.close();

        const w2 = new ShardWorker([atom('A'), atom('B')], db);
        await w2.init();
        const csr = w2.getCsrMatrix();
        const aIdx = w2.getAtomRecord(atom('A'))!.index;
        const bIdx = w2.getAtomRecord(atom('B'))!.index;

        expect(csr.edgeCount).toBeGreaterThan(0);
        expect(csr.getTopPrediction(aIdx)).toBe(bIdx);
        await w2.close();
    });

    it('CSR is rebuilt after commit() when new transitions were recorded', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const before = worker.getCsrMatrix().edgeCount;
        const hashA = worker.getHash(atom('A'))!;
        const hashC = worker.getHash(atom('C'))!;
        await worker.recordTransition(hashA, hashC);
        await worker.commit(); // no pending writes path should still rebuild CSR

        const after = worker.getCsrMatrix().edgeCount;
        expect(after).toBeGreaterThan(before);
        await worker.close();
    });

    it('CSR topPrediction matches first entry of getWeights()', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        const hashC = worker.getHash(atom('C'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashC);
        await worker.commit();

        const aIdx = worker.getAtomRecord(atom('A'))!.index;
        const topIdx = worker.getCsrMatrix().getTopPrediction(aIdx);
        const weights = worker.getWeights(atom('A'))!;
        const topAtomFromCsr = topIdx >= 0 ? worker.getAtoms()[topIdx]?.atom ?? null : null;

        expect(weights.length).toBeGreaterThan(0);
        expect(topAtomFromCsr).toBe(weights[0].to);
        await worker.close();
    });

    it('CSR handles tombstoned target by skipping it during build', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.tombstoneAtom(atom('B'));
        await worker.addAtoms([atom('D')]); // force pending so commitInternal runs
        await worker.commit();

        const aIdx = worker.getAtomRecord(atom('A'))!.index;
        const edges = worker.getCsrMatrix().getEdges(aIdx);
        const bIdx = worker.getAtomRecord(atom('B'))!.index;
        expect(edges.find(e => e.toIdx === bIdx)).toBeUndefined();
        await worker.close();
    });

    it('getCsrMatrix().edgeCount matches total active edges in transition Map', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C'), atom('D')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        const hashC = worker.getHash(atom('C'))!;
        const hashD = worker.getHash(atom('D'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashC);
        await worker.recordTransition(hashC, hashD);
        await worker.commit();

        expect(worker.getCsrMatrix().edgeCount).toBe(3);
        await worker.close();
    });

    it('access() falls back to Map iteration when CSR is empty', async () => {
        const worker = new ShardWorker([atom('A'), atom('B')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        await worker.recordTransition(hashA, hashB);

        (worker as any).csrMatrix = CsrTransitionMatrix.empty(0);
        const result = await worker.access(atom('A'));
        expect(result.next).toBe(atom('B'));
        await worker.close();
    });

    it('batchAccess() returns results for all valid items', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.commit();

        const batch = await worker.batchAccess([atom('A'), atom('B')]);
        expect(batch).toHaveLength(2);
        expect(batch.every(entry => entry.ok)).toBe(true);
        await worker.close();
    });

    it('batchAccess() on empty list returns empty array', async () => {
        const worker = new ShardWorker([atom('A')], freshDb());
        await worker.init();
        const batch = await worker.batchAccess([]);
        expect(batch).toEqual([]);
        await worker.close();
    });

    it('batchAccess() result for each item matches individual access() result', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const hashA = worker.getHash(atom('A'))!;
        const hashB = worker.getHash(atom('B'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.commit();

        const batch = await worker.batchAccess([atom('A'), atom('B')]);
        const singleA = await worker.access(atom('A'));
        const singleB = await worker.access(atom('B'));

        expect(batch[0].ok).toBe(true);
        expect(batch[1].ok).toBe(true);
        if (batch[0].ok && batch[1].ok) {
            expect(batch[0].result.next).toBe(singleA.next);
            expect(batch[0].result.hash).toBe(singleA.hash);
            expect(batch[1].result.next).toBe(singleB.next);
            expect(batch[1].result.hash).toBe(singleB.hash);
        }
        await worker.close();
    });

    it('batchAccess() acquires epoch ticket exactly once', async () => {
        const worker = new ShardWorker([atom('A'), atom('B'), atom('C')], freshDb());
        await worker.init();

        const epoch = (worker as any).epoch;
        const beginReadSpy = vi.spyOn(epoch, 'beginRead');
        const endReadSpy = vi.spyOn(epoch, 'endRead');

        await worker.batchAccess([atom('A'), atom('B'), atom('C')]);

        expect(beginReadSpy).toHaveBeenCalledTimes(1);
        expect(endReadSpy).toHaveBeenCalledTimes(1);
        expect(worker.getEpochStatus().activeReadersByEpoch).toEqual({});
        await worker.close();
    });

    it('setPolicy(restricted) skips disallowed top prediction and returns next best', async () => {
        const worker = new ShardWorker([
            'v1.fact.A',
            'v1.event.B',
            'v1.relation.C',
        ], freshDb());
        await worker.init();

        const hashA = worker.getHash('v1.fact.A')!;
        const hashB = worker.getHash('v1.event.B')!;
        const hashC = worker.getHash('v1.relation.C')!;

        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashC);
        await worker.commit();

        worker.setPolicy(TransitionPolicy.fromConfig({ fact: ['relation'] }));
        const report = await worker.access('v1.fact.A');
        expect(report.next).toBe('v1.relation.C');
        await worker.close();
    });

    it('setPolicy(restricted) returns null prediction when no allowed type exists', async () => {
        const worker = new ShardWorker([
            'v1.fact.A',
            'v1.event.B',
        ], freshDb());
        await worker.init();

        const hashA = worker.getHash('v1.fact.A')!;
        const hashB = worker.getHash('v1.event.B')!;
        await worker.recordTransition(hashA, hashB);
        await worker.commit();

        worker.setPolicy(TransitionPolicy.fromConfig({ fact: ['state'] }));
        const report = await worker.access('v1.fact.A');
        expect(report.next).toBeNull();
        expect(report.predictedHash).toBeNull();
        await worker.close();
    });

    it('setPolicy(default) restores original prediction behaviour', async () => {
        const worker = new ShardWorker([
            'v1.fact.A',
            'v1.event.B',
            'v1.relation.C',
        ], freshDb());
        await worker.init();

        const hashA = worker.getHash('v1.fact.A')!;
        const hashB = worker.getHash('v1.event.B')!;
        const hashC = worker.getHash('v1.relation.C')!;
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashC);
        await worker.commit();

        worker.setPolicy(TransitionPolicy.fromConfig({ fact: ['relation'] }));
        const restricted = await worker.access('v1.fact.A');
        expect(restricted.next).toBe('v1.relation.C');

        worker.setPolicy(TransitionPolicy.default());
        const open = await worker.access('v1.fact.A');
        expect(open.next).toBe('v1.event.B');
        await worker.close();
    });
});

// ─── Commit scheduling policy (Story 3.3) ────────────────────────────────────

describe('ShardWorker — commit scheduling', () => {
    it('commitThreshold=1: addAtoms auto-commits without an explicit commit() call', async () => {
        const worker = new ShardWorker([], freshDb(), { commitThreshold: 1 });
        await worker.init();
        const vBefore = worker.snapshotVersion;
        // addAtoms() internally triggers commit when pending.size >= threshold
        await worker.addAtoms([atom('AutoCommitAtom')]);
        const vAfter = worker.snapshotVersion;
        expect(vAfter).toBeGreaterThan(vBefore);
        expect(worker.pendingCount).toBe(0); // pending queue flushed by auto-commit
        await worker.close();
    });

    it('commitThreshold=2: no auto-commit after 1 atom, auto-commits after 2nd', async () => {
        const worker = new ShardWorker([], freshDb(), { commitThreshold: 2 });
        await worker.init();
        await worker.addAtoms([atom('First')]);
        // 1 atom — threshold not yet reached
        expect(worker.pendingCount).toBe(1);
        expect(worker.snapshotVersion).toBe(0);

        await worker.addAtoms([atom('Second')]);
        // 2 atoms — threshold reached, auto-commit fires
        expect(worker.pendingCount).toBe(0);
        expect(worker.snapshotVersion).toBeGreaterThan(0);
        await worker.close();
    });

    it('no commitThreshold: pending writes accumulate until explicit commit', async () => {
        // Default threshold = Infinity
        const worker = new ShardWorker([], freshDb());
        await worker.init();
        await worker.addAtoms([atom('A')]);
        await worker.addAtoms([atom('B')]);
        expect(worker.pendingCount).toBe(2);
        expect(worker.snapshotVersion).toBe(0);
        await worker.commit();
        expect(worker.pendingCount).toBe(0);
        expect(worker.snapshotVersion).toBe(1);
        await worker.close();
    });

    it('commitIntervalMs: timer triggers auto-commit after init', async () => {
        // Use a short real interval rather than fake timers to avoid races
        // between vi.advanceTimersByTimeAsync and in-flight WAL I/O.
        const worker = new ShardWorker([], freshDb(), { commitIntervalMs: 30 });
        await worker.init();
        await worker.addAtoms([atom('TimedAtom')]);
        expect(worker.pendingCount).toBe(1);

        // Wait long enough for the interval to fire and the async commit to finish
        await new Promise(r => setTimeout(r, 80));

        expect(worker.pendingCount).toBe(0);
        expect(worker.snapshotVersion).toBeGreaterThan(0);
        await worker.close();
    });

    it('commitIntervalMs: no pending writes — timer fires but version does not change', async () => {
        const worker = new ShardWorker([atom('A')], freshDb(), { commitIntervalMs: 30 });
        await worker.init();
        // Wait for init-implicit commit (none — no pending writes at start)
        await worker.commit(); // explicit commit of any init-time pending writes
        const vBefore = worker.snapshotVersion;
        // Wait for at least one interval to fire
        await new Promise(r => setTimeout(r, 80));
        expect(worker.snapshotVersion).toBe(vBefore);
        await worker.close();
    });

    it('close() clears the commit interval so it does not fire after close', async () => {
        vi.useFakeTimers();
        try {
            const worker = new ShardWorker([], freshDb(), { commitIntervalMs: 50 });
            await worker.init();
            await worker.close(); // clears the interval before it fires
            // Advancing time should not trigger any disposed timer
            await expect(vi.advanceTimersByTimeAsync(200)).resolves.not.toThrow();
        } finally {
            vi.useRealTimers();
        }
    });
});
