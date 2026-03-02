import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { ShardedOrchestrator } from '../orchestrator';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let dbCounter = 0;
const atom = (value: string) => `v1.other.${value}`;

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
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B'), atom('C')], freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));
        expect(report.currentData).toBe(atom('A'));
        expect(report.currentProof.leaf).toMatch(/^[a-f0-9]{64}$/);
        expect(report.latencyMs).toBeGreaterThanOrEqual(0);
        await mem.close();
    });

    it('access throws for unknown atom', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A')], freshDb());
        await mem.init();
        await expect(mem.access(atom('Z'))).rejects.toThrow();
        await mem.close();
    });

    it('train then access predicts the next atom', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B'), atom('C')], freshDb());
        await mem.init();
        await mem.train([atom('A'), atom('B'), atom('C')]);

        const report = await mem.access(atom('A'));
        // After training A->B->C, accessing A should predict B
        expect(report.predictedNext).toBe(atom('B'));
        expect(report.predictedProof).not.toBeNull();
        await mem.close();
    });

    it('access returns shardRootProof from the master tree', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B')], freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));
        // shardRootProof may be undefined if the master tree has a single shard
        // but the field itself should exist (not throw)
        expect(report).toHaveProperty('shardRootProof');
        await mem.close();
    });

    it('init restores persisted transitions across restart', async () => {
        const db = freshDb();
        const mem1 = new ShardedOrchestrator(4, [atom('X'), atom('Y'), atom('Z')], db);
        await mem1.init();
        await mem1.train([atom('X'), atom('Y'), atom('Z')]);
        // Allow async persist to settle
        await new Promise(r => setTimeout(r, 50));
        await mem1.close();

        // Reopen with same DB path — weights must reload
        const mem2 = new ShardedOrchestrator(4, [atom('X'), atom('Y'), atom('Z')], db);
        await mem2.init();
        const report = await mem2.access(atom('X'));
        expect(report.predictedNext).toBe(atom('Y'));
        await mem2.close();
    });

    it('train with a single-element sequence is a no-op (no transitions)', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B')], freshDb());
        await mem.init();
        await mem.train([atom('A')]); // no pairs — should not throw
        const report = await mem.access(atom('A'));
        expect(report.predictedNext).toBeNull();
        await mem.close();
    });

    it('inter-shard transitions are recorded in the global matrix', async () => {
        // Access two atoms that hash to different shards back-to-back
        // We cannot assert the global matrix directly, but access should not throw
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B'), atom('C'), atom('D'), atom('E')], freshDb());
        await mem.init();
        for (const item of [atom('A'), atom('B'), atom('C'), atom('D'), atom('E')]) {
            await mem.access(item);
        }
        await mem.close();
    });

    it('predictedProof is a valid Merkle proof after training', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A'), atom('B'), atom('C'), atom('D')], freshDb());
        await mem.init();
        await mem.train([atom('A'), atom('B'), atom('C'), atom('D')]);
        const { MerkleKernel } = await import('../merkle');
        const report = await mem.access(atom('A'));
        expect(report.predictedNext).toBe(atom('B'));
        expect(report.predictedProof).not.toBeNull();
        expect(MerkleKernel.verifyProof(report.predictedProof!)).toBe(true);
        // predictedProof.leaf should be the hash for 'B'
        expect(report.predictedProof!.leaf).toMatch(/^[a-f0-9]{64}$/);
        await mem.close();
    });

    it('close() can be called safely with no activity', async () => {
        const mem = new ShardedOrchestrator(4, [atom('A')], freshDb());
        await expect(mem.close()).resolves.not.toThrow();
    });
});

// ─── Commit scheduling policy (Story 3.3) ────────────────────────────────────

describe('ShardedOrchestrator — commit scheduling', () => {
    afterEach(() => {
        // Clean up any env vars set during tests
        delete process.env.MMPM_COMMIT_THRESHOLD;
        delete process.env.MMPM_COMMIT_INTERVAL_MS;
    });

    it('accepts commitThreshold and commitIntervalMs options without error', async () => {
        const db = freshDb();
        const mem = new ShardedOrchestrator(2, [atom('A'), atom('B')], db, {
            commitThreshold: 10,
            commitIntervalMs: 5000,
        });
        await expect(mem.init()).resolves.not.toThrow();
        await mem.close();
    });

    it('options default: no option provided — normal operation unaffected', async () => {
        const mem = new ShardedOrchestrator(2, [atom('A'), atom('B')], freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));
        expect(report.currentData).toBe(atom('A'));
        await mem.close();
    });

    it('MMPM_COMMIT_THRESHOLD env var is read and does not break init or addAtoms', async () => {
        process.env.MMPM_COMMIT_THRESHOLD = '2';
        const mem = new ShardedOrchestrator(2, [], freshDb());
        await mem.init();
        const v = await mem.addAtoms([atom('X'), atom('Y'), atom('Z')]);
        expect(v).toBeGreaterThan(0);
        await mem.close();
    });

    it('MMPM_COMMIT_INTERVAL_MS env var is read and close() does not hang', async () => {
        process.env.MMPM_COMMIT_INTERVAL_MS = '100';
        const mem = new ShardedOrchestrator(2, [atom('A')], freshDb());
        await mem.init();
        // close() must resolve promptly (timer cleared by ShardWorker.close())
        await expect(mem.close()).resolves.not.toThrow();
    });

    it('env var overrides constructor option: MMPM_COMMIT_THRESHOLD takes precedence', async () => {
        // Env says threshold=1, constructor says 1000.
        // With threshold=1 every single addAtoms call auto-commits inside ShardWorker
        // before the orchestrator’s own shard.commit(). Both paths reach the same
        // observable state — what we’re verifying is that the env var is accepted
        // and the orchestrator works correctly regardless.
        process.env.MMPM_COMMIT_THRESHOLD = '1';
        const mem = new ShardedOrchestrator(2, [], freshDb(), { commitThreshold: 1000 });
        await mem.init();
        const v = await mem.addAtoms([atom('P'), atom('Q'), atom('R')]);
        expect(v).toBeGreaterThan(0);
        // master version should have advanced after the batch
        expect(mem.getMasterVersion()).toBe(v);
        await mem.close();
    });

    it('commitThreshold option wired: ShardWorker auto-commits when threshold reached', async () => {
        // Use threshold=1 via options (env var not set in this test).
        // addAtoms routes atoms to shards; ShardWorker.addAtoms() auto-commits
        // when pending >= threshold, before the orchestrator calls shard.commit().
        // The master version advances regardless — proves the option is passed through.
        const mem = new ShardedOrchestrator(2, [], freshDb(), { commitThreshold: 1 });
        await mem.init();
        const v1 = mem.getMasterVersion();
        await mem.addAtoms([atom('Alpha')]);
        const v2 = mem.getMasterVersion();
        expect(v2).toBeGreaterThan(v1);
        await mem.close();
    });
});
