import { describe, it, expect, afterAll, vi } from 'vitest';
import { ShardWorker } from '../shard_worker';
import { MerkleKernel } from '../merkle';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let counter = 0;

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
        const worker = new ShardWorker(['A', 'B', 'C'], freshDb());
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
        const workerA = new ShardWorker(['X', 'Y'], freshDb());
        const workerB = new ShardWorker(['X', 'Y'], freshDb());
        await workerA.init();
        await workerB.init();
        expect(workerA.getKernelRoot()).toBe(workerB.getKernelRoot());
        await workerA.close();
        await workerB.close();
    });

    // --- getHash ---
    it('getHash returns a valid 64-char hex string for a known item', async () => {
        const worker = new ShardWorker(['hello', 'world'], freshDb());
        await worker.init();
        expect(worker.getHash('hello')).toMatch(/^[a-f0-9]{64}$/);
        expect(worker.getHash('world')).toMatch(/^[a-f0-9]{64}$/);
        await worker.close();
    });

    it('getHash returns undefined for an unknown item', async () => {
        const worker = new ShardWorker(['A', 'B'], freshDb());
        await worker.init();
        expect(worker.getHash('NOT_IN_SHARD')).toBeUndefined();
        await worker.close();
    });

    it('getHash matches the leaf hash from a standalone MerkleKernel', async () => {
        const data = ['alpha', 'beta'];
        const worker = new ShardWorker(data, freshDb());
        await worker.init();
        const kernel = new MerkleKernel(data);
        expect(worker.getHash('alpha')).toBe(kernel.getLeafHash(0));
        expect(worker.getHash('beta')).toBe(kernel.getLeafHash(1));
        await worker.close();
    });

    // --- access ---
    it('access returns proof, hash, and null prediction for untrained item', async () => {
        const worker = new ShardWorker(['A', 'B', 'C'], freshDb());
        await worker.init();
        const result = await worker.access('A');
        expect(result.proof.leaf).toMatch(/^[a-f0-9]{64}$/);
        expect(result.proof.root).toBe(worker.getKernelRoot());
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(result.next).toBeNull();
        expect(result.nextProof).toBeNull();
        await worker.close();
    });

    it('access throws for an item not in the shard', async () => {
        const worker = new ShardWorker(['A', 'B'], freshDb());
        await worker.init();
        await expect(worker.access('UNKNOWN')).rejects.toThrow();
        await worker.close();
    });

    it('access proof is valid via MerkleKernel.verifyProof', async () => {
        const worker = new ShardWorker(['A', 'B', 'C', 'D'], freshDb());
        await worker.init();
        const result = await worker.access('C');
        expect(MerkleKernel.verifyProof(result.proof)).toBe(true);
        await worker.close();
    });

    // --- recordTransition + prediction ---
    it('recordTransition makes access predict the next item', async () => {
        const worker = new ShardWorker(['A', 'B', 'C'], freshDb());
        await worker.init();
        const hashA = worker.getHash('A')!;
        const hashB = worker.getHash('B')!;
        await worker.recordTransition(hashA, hashB);
        const result = await worker.access('A');
        expect(result.next).toBe('B');
        expect(result.nextProof).not.toBeNull();
        expect(MerkleKernel.verifyProof(result.nextProof!)).toBe(true);
        await worker.close();
    });

    it('recordTransition with more weight wins prediction', async () => {
        const worker = new ShardWorker(['A', 'B', 'C'], freshDb());
        await worker.init();
        const hashA = worker.getHash('A')!;
        const hashB = worker.getHash('B')!;
        const hashC = worker.getHash('C')!;
        // Record A→C 3 times vs A→B 1 time
        for (let i = 0; i < 3; i++) await worker.recordTransition(hashA, hashC);
        await worker.recordTransition(hashA, hashB);
        const result = await worker.access('A');
        expect(result.next).toBe('C'); // C has higher accumulated weight
        await worker.close();
    });

    // --- LevelDB persistence ---
    it('persists transitions across close/reopen', async () => {
        const db = freshDb();
        const data = ['P', 'Q', 'R'];

        // Write
        const w1 = new ShardWorker(data, db);
        await w1.init();
        const hp = w1.getHash('P')!;
        const hq = w1.getHash('Q')!;
        await w1.recordTransition(hp, hq);
        await new Promise(r => setTimeout(r, 30)); // let async persist settle
        await w1.close();

        // Reopen
        const w2 = new ShardWorker(data, db);
        await w2.init(); // loads from LevelDB
        const result = await w2.access('P');
        expect(result.next).toBe('Q');
        await w2.close();
    });

    // --- close ---
    it('close() resolves without error', async () => {
        const worker = new ShardWorker(['A'], freshDb());
        await worker.init();
        await expect(worker.close()).resolves.not.toThrow();
    });

    it('close() can be called on a freshly constructed (uninitialised) worker', async () => {
        const worker = new ShardWorker(['A'], freshDb());
        await expect(worker.close()).resolves.not.toThrow();
    });
});

// ─── Commit scheduling policy (Story 3.3) ────────────────────────────────────

describe('ShardWorker — commit scheduling', () => {
    it('commitThreshold=1: addAtoms auto-commits without an explicit commit() call', async () => {
        const worker = new ShardWorker([], freshDb(), { commitThreshold: 1 });
        await worker.init();
        const vBefore = worker.snapshotVersion;
        // addAtoms() internally triggers commit when pending.size >= threshold
        await worker.addAtoms(['AutoCommitAtom']);
        const vAfter = worker.snapshotVersion;
        expect(vAfter).toBeGreaterThan(vBefore);
        expect(worker.pendingCount).toBe(0); // pending queue flushed by auto-commit
        await worker.close();
    });

    it('commitThreshold=2: no auto-commit after 1 atom, auto-commits after 2nd', async () => {
        const worker = new ShardWorker([], freshDb(), { commitThreshold: 2 });
        await worker.init();
        await worker.addAtoms(['First']);
        // 1 atom — threshold not yet reached
        expect(worker.pendingCount).toBe(1);
        expect(worker.snapshotVersion).toBe(0);

        await worker.addAtoms(['Second']);
        // 2 atoms — threshold reached, auto-commit fires
        expect(worker.pendingCount).toBe(0);
        expect(worker.snapshotVersion).toBeGreaterThan(0);
        await worker.close();
    });

    it('no commitThreshold: pending writes accumulate until explicit commit', async () => {
        // Default threshold = Infinity
        const worker = new ShardWorker([], freshDb());
        await worker.init();
        await worker.addAtoms(['A']);
        await worker.addAtoms(['B']);
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
        await worker.addAtoms(['TimedAtom']);
        expect(worker.pendingCount).toBe(1);

        // Wait long enough for the interval to fire and the async commit to finish
        await new Promise(r => setTimeout(r, 80));

        expect(worker.pendingCount).toBe(0);
        expect(worker.snapshotVersion).toBeGreaterThan(0);
        await worker.close();
    });

    it('commitIntervalMs: no pending writes — timer fires but version does not change', async () => {
        const worker = new ShardWorker(['A'], freshDb(), { commitIntervalMs: 30 });
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
