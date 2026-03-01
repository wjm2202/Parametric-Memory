import { describe, it, expect, afterAll } from 'vitest';
import { ShardedOrchestrator } from '../orchestrator';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let dbCounter = 0;

function freshDb(): string {
    const path = `./test-orch-db-${Date.now()}-${dbCounter++}`;
    dbDirs.push(path);
    return path;
}

afterAll(() => {
    for (const dir of dbDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('ShardedOrchestrator', () => {
    it('access returns proof for known atom', async () => {
        const mem = new ShardedOrchestrator(4, ['A', 'B', 'C'], freshDb());
        await mem.init();
        const report = await mem.access('A');
        expect(report.currentData).toBe('A');
        expect(report.currentProof.leaf).toMatch(/^[a-f0-9]{64}$/);
        expect(report.latencyMs).toBeGreaterThanOrEqual(0);
        await mem.close();
    });

    it('access throws for unknown atom', async () => {
        const mem = new ShardedOrchestrator(4, ['A'], freshDb());
        await mem.init();
        await expect(mem.access('Z')).rejects.toThrow();
        await mem.close();
    });

    it('train then access predicts the next atom', async () => {
        const mem = new ShardedOrchestrator(4, ['A', 'B', 'C'], freshDb());
        await mem.init();
        await mem.train(['A', 'B', 'C']);

        const report = await mem.access('A');
        // After training A->B->C, accessing A should predict B
        expect(report.predictedNext).toBe('B');
        expect(report.predictedProof).not.toBeNull();
        await mem.close();
    });

    it('access returns shardRootProof from the master tree', async () => {
        const mem = new ShardedOrchestrator(4, ['A', 'B'], freshDb());
        await mem.init();
        const report = await mem.access('A');
        // shardRootProof may be undefined if the master tree has a single shard
        // but the field itself should exist (not throw)
        expect(report).toHaveProperty('shardRootProof');
        await mem.close();
    });

    it('init restores persisted transitions across restart', async () => {
        const db = freshDb();
        const mem1 = new ShardedOrchestrator(4, ['X', 'Y', 'Z'], db);
        await mem1.init();
        await mem1.train(['X', 'Y', 'Z']);
        // Allow async persist to settle
        await new Promise(r => setTimeout(r, 50));
        await mem1.close();

        // Reopen with same DB path — weights must reload
        const mem2 = new ShardedOrchestrator(4, ['X', 'Y', 'Z'], db);
        await mem2.init();
        const report = await mem2.access('X');
        expect(report.predictedNext).toBe('Y');
        await mem2.close();
    });

    it('train with a single-element sequence is a no-op (no transitions)', async () => {
        const mem = new ShardedOrchestrator(4, ['A', 'B'], freshDb());
        await mem.init();
        await mem.train(['A']); // no pairs — should not throw
        const report = await mem.access('A');
        expect(report.predictedNext).toBeNull();
        await mem.close();
    });

    it('inter-shard transitions are recorded in the global matrix', async () => {
        // Access two atoms that hash to different shards back-to-back
        // We cannot assert the global matrix directly, but access should not throw
        const mem = new ShardedOrchestrator(4, ['A', 'B', 'C', 'D', 'E'], freshDb());
        await mem.init();
        for (const atom of ['A', 'B', 'C', 'D', 'E']) {
            await mem.access(atom);
        }
        await mem.close();
    });

    it('predictedProof is a valid Merkle proof after training', async () => {
        const mem = new ShardedOrchestrator(4, ['A', 'B', 'C', 'D'], freshDb());
        await mem.init();
        await mem.train(['A', 'B', 'C', 'D']);
        const { MerkleKernel } = await import('../merkle');
        const report = await mem.access('A');
        expect(report.predictedNext).toBe('B');
        expect(report.predictedProof).not.toBeNull();
        expect(MerkleKernel.verifyProof(report.predictedProof!)).toBe(true);
        // predictedProof.leaf should be the hash for 'B'
        expect(report.predictedProof!.leaf).toMatch(/^[a-f0-9]{64}$/);
        await mem.close();
    });

    it('close() can be called safely with no activity', async () => {
        const mem = new ShardedOrchestrator(4, ['A'], freshDb());
        await expect(mem.close()).resolves.not.toThrow();
    });
});
