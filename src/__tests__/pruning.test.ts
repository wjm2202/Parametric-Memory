import { describe, it, expect, afterEach } from 'vitest';
import { ShardWorker } from '../shard_worker';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const atom = (s: string) => `v1.fact.${s}` as const;

const dirs: string[] = [];
function tempDb(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-prune-${prefix}-`));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of dirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }); } catch { }
    }
});

// ─── Active Forgetting (Pruning) ──────────────────────────────────────

describe('Active Forgetting — pruneStaleTransitions', () => {
    it('does not prune when disabled', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('prune-disabled'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: false,
                confidenceHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
            },
        );
        await worker.init();
        await worker.commit();

        // Train
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        // Advance 60 days
        nowMs += 60 * 24 * 60 * 60 * 1000;

        // Prune is disabled — should still have weights after commit
        await worker.addAtoms([atom('C')]);
        await worker.commit();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);
    });

    it('prunes stale, low-weight transitions', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B'), atom('C')],
            tempDb('prune-stale'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,  // classic +1 for simplicity
                pruneEnabled: true,
                pruneStaleDays: 30,
                pruneWeightThreshold: 0.1,
                confidenceHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
            },
        );
        await worker.init();
        await worker.commit();

        // Train A→B (weight = 1)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        // Verify weight exists
        let weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);

        // Advance 60 days — well past stale threshold and half-life
        // With half-life 7 days and 60 days elapsed:
        // effectiveWeight = 1 * 0.5^(60*24*60*60*1000 / (7*24*60*60*1000)) = 1 * 0.5^8.57 ≈ 0.0026
        // That's well below the 0.1 threshold
        nowMs += 60 * 24 * 60 * 60 * 1000;

        // Trigger pruning via commit (needs pending writes to commit)
        await worker.addAtoms([atom('D')]);
        await worker.commit();

        // The transition should be pruned
        weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(0); // pruned
    });

    it('preserves high-weight transitions even when stale', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('prune-highweight'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: true,
                pruneStaleDays: 30,
                pruneWeightThreshold: 0.1,
                confidenceHalfLifeMs: -1,  // disable decay — weights stay at raw value
            },
        );
        await worker.init();
        await worker.commit();

        // Train A→B 100 times (weight = 100, well above threshold)
        for (let i = 0; i < 100; i++) {
            worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        }
        await worker.flushTransitionBatch();

        // Advance 60 days
        nowMs += 60 * 24 * 60 * 60 * 1000;

        // Trigger pruning
        await worker.addAtoms([atom('C')]);
        await worker.commit();

        // Transition survives — weight (100) > threshold (0.1) even though stale
        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);
        expect(weights![0].weight).toBe(100);
    });

    it('preserves fresh transitions even with low weight', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('prune-fresh'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: true,
                pruneStaleDays: 30,
                pruneWeightThreshold: 100,  // absurdly high threshold
                confidenceHalfLifeMs: -1,
            },
        );
        await worker.init();
        await worker.commit();

        // Train once (weight = 1, below threshold 100)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        // Only advance 1 day — below pruneStaleDays
        nowMs += 1 * 24 * 60 * 60 * 1000;

        await worker.addAtoms([atom('C')]);
        await worker.commit();

        // Transition survives — not stale yet (age < 30 days)
        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);
    });

    it('pruneStaleTransitions returns count of pruned edges', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B'), atom('C')],
            tempDb('prune-count'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: false,  // manual control
                pruneStaleDays: 30,
                pruneWeightThreshold: 0.1,
                confidenceHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
            },
        );
        await worker.init();
        await worker.commit();

        // Train A→B and A→C
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('C'))!);
        await worker.flushTransitionBatch();

        // Advance 60 days
        nowMs += 60 * 24 * 60 * 60 * 1000;

        // Manually call prune
        const pruned = await worker.pruneStaleTransitions();
        expect(pruned).toBe(2); // both A→B and A→C are stale + low effective weight
    });

    it('prune does not affect atoms — only weights', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('prune-atoms-safe'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: true,
                pruneStaleDays: 30,
                pruneWeightThreshold: 0.1,
                confidenceHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
            },
        );
        await worker.init();
        await worker.commit();

        // Train
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        // Advance 60 days and prune
        nowMs += 60 * 24 * 60 * 60 * 1000;
        await worker.addAtoms([atom('C')]);
        await worker.commit();

        // Atoms still accessible
        const resultA = await worker.access(atom('A'));
        expect(resultA.hash).toBeDefined();
        const resultB = await worker.access(atom('B'));
        expect(resultB.hash).toBeDefined();
    });

    it('pruned transitions disappear from getWeights', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B'), atom('C')],
            tempDb('prune-getweights'),
            {
                clock: () => nowMs,
                stdpTauMs: 0,
                pruneEnabled: false,
                pruneStaleDays: 10,
                pruneWeightThreshold: 0.5,
                confidenceHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
            },
        );
        await worker.init();
        await worker.commit();

        // Train A→B (stale target) and A→C (will be refreshed)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('C'))!);
        await worker.flushTransitionBatch();

        // Advance 15 days — past the stale threshold
        nowMs += 15 * 24 * 60 * 60 * 1000;

        // Refresh A→C (but not A→B)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('C'))!);
        await worker.flushTransitionBatch();

        // Now prune — A→B should be pruned (stale + low effective weight)
        // A→C was just refreshed so it survives
        const pruned = await worker.pruneStaleTransitions();
        expect(pruned).toBe(1); // only A→B

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);
        // The surviving edge should be A→C
        expect(weights![0].toHash).toBe(worker.getHash(atom('C')));
    });
});
