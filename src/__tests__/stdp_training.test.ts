import { describe, it, expect, afterEach } from 'vitest';
import { ShardWorker } from '../shard_worker';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const atom = (s: string) => `v1.fact.${s}` as const;

const dirs: string[] = [];
function tempDb(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-stdp-${prefix}-`));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of dirs.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }); } catch { }
    }
});

// ─── STDP Weight Function ─────────────────────────────────────────────

describe('STDP — Temporal Weight Function', () => {
    it('training immediately after access gives maximum weight (delta ~1000)', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-immediate'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        // Train immediately (dt ~= 0)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights!.length).toBe(1);
        // At dt=0, delta = round(1000 * exp(0)) = 1000
        expect(weights![0].weight).toBe(1000);
    });

    it('training long after access gives diminished weight', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-delayed'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        // Advance time by 10 minutes (2x tau)
        nowMs += 600_000;

        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        // exp(-600000/300000) = exp(-2) ≈ 0.135, * 1000 ≈ 135
        expect(weights![0].weight).toBeLessThan(1000);
        expect(weights![0].weight).toBeGreaterThan(100);
    });

    it('minimum weight is 1 — never zero', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-min'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        // Advance time by 1 hour (12x tau)
        nowMs += 3_600_000;

        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        // exp(-3600000/300000) = exp(-12) ≈ 6e-6, * 1000 ≈ 0.006 → rounds to 0, clamped to 1
        expect(weights![0].weight).toBe(1);
        expect(weights![0].weight).toBeGreaterThanOrEqual(1);
    });

    it('STDP disabled (tau=0) gives classic +1 per training', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-disabled'),
            { clock: () => nowMs, stdpTauMs: 0 },
        );
        await worker.init();
        await worker.commit();

        // Train 3 times
        for (let i = 0; i < 3; i++) {
            nowMs += 100;
            worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        }
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights![0].weight).toBe(3); // classic +1 per call
    });

    it('repeated training within tau accumulates high weight', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-accum'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        // Train 3 times rapidly (each 1 second apart)
        for (let i = 0; i < 3; i++) {
            nowMs += 1_000;
            worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        }
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        // Each call gives ~1000 (dt to creation time increases slightly but still within tau)
        // Total should be close to 3000
        expect(weights![0].weight).toBeGreaterThan(2500);
    });

    it('recent training on fresh atom gives full weight', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B'), atom('C')],
            tempDb('stdp-fresh'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        // Add a new atom dynamically
        nowMs += 100;
        await worker.addAtoms([atom('D')]);
        await worker.commit();

        // Train immediately after adding — dt from creation ≈ 0
        nowMs += 100;
        worker.recordTransitionBatched(worker.getHash(atom('D'))!, worker.getHash(atom('A'))!);
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('D'));
        expect(weights).not.toBeNull();
        // dt ~200ms → exp(-200/300000) ≈ 0.9993 → round(999.3) = 999
        expect(weights![0].weight).toBeGreaterThanOrEqual(990);
    });

    it('backward compatibility: old integer weights are still valid', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-compat'),
            { clock: () => nowMs, stdpTauMs: 0 },  // Disable STDP for seed
        );
        await worker.init();
        await worker.commit();

        // Classic training (STDP disabled → +1)
        worker.recordTransitionBatched(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);
        await worker.flushTransitionBatch();

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights![0].weight).toBe(1); // old-style integer

        // Access still works
        const result = await worker.access(atom('A'));
        expect(result).toBeDefined();
        expect(result.hash).toBeDefined();
    });

    it('non-batched recordTransition also uses STDP', async () => {
        let nowMs = 1_000_000;
        const worker = new ShardWorker(
            [atom('A'), atom('B')],
            tempDb('stdp-nonbatch'),
            { clock: () => nowMs, stdpTauMs: 300_000 },
        );
        await worker.init();
        await worker.commit();

        await worker.recordTransition(worker.getHash(atom('A'))!, worker.getHash(atom('B'))!);

        const weights = worker.getWeights(atom('A'));
        expect(weights).not.toBeNull();
        expect(weights![0].weight).toBe(1000); // full STDP weight
    });
});
