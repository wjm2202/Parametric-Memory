import { describe, it, expect, afterAll } from 'vitest';
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
