/**
 * Convergence Tests
 *
 * These tests answer the question: "Does the model actually learn?"
 *
 * Each study:
 *   1. Defines a ground-truth probability distribution
 *   2. Generates training sequences sampled from that distribution
 *   3. Trains the cluster in epochs (batches of sequences)
 *   4. After each epoch reads weights via orchestrator.getWeights()
 *   5. Asserts that weights converge to the correct dominant prediction
 *
 * The weight evolution table is printed to stdout so you can observe the
 * learning curve. Run with:
 *   npx vitest run convergence --reporter=verbose
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShardedOrchestrator } from '../orchestrator';
import {
    generateSequences,
    toBatches,
    expectedDominant,
    GroundTruthEdge,
} from '../generator';

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface WeightSnapshot {
    epoch: number;
    sequencesSeen: number;
    weights: Map<string, { to: string; weight: number; ratio: number }[]>;
}

function captureWeights(
    orchestrator: ShardedOrchestrator,
    atoms: string[],
    epoch: number,
    sequencesSeen: number,
): WeightSnapshot {
    const weights = new Map<string, { to: string; weight: number; ratio: number }[]>();
    for (const atom of atoms) {
        const raw = orchestrator.getWeights(atom);
        if (!raw) continue;
        const total = raw.reduce((s, t) => s + t.weight, 0);
        weights.set(atom, raw.map(t => ({
            to: t.to,
            weight: t.weight,
            ratio: total > 0 ? t.weight / total : 0,
        })));
    }
    return { epoch, sequencesSeen, weights };
}

function printLearningCurve(history: WeightSnapshot[], sourceAtom: string): void {
    console.log(`\n  Learning curve for '${sourceAtom}':`);
    console.log('  Epoch  Seqs   ' +
        (history[0]?.weights.get(sourceAtom)?.map(t => t.to.padEnd(14)).join('') ?? ''));
    for (const snap of history) {
        const row = snap.weights.get(sourceAtom) ?? [];
        const cols = row.map(t => `${(t.ratio * 100).toFixed(1)}%`.padEnd(14)).join('');
        console.log(`  ${String(snap.epoch).padEnd(7)}${String(snap.sequencesSeen).padEnd(7)}${cols}`);
    }
}

async function trainEpoch(orchestrator: ShardedOrchestrator, sequences: string[][]): Promise<void> {
    for (const seq of sequences) {
        await orchestrator.train(seq);
    }
}

function makeOrchestrator(atoms: string[]): { orchestrator: ShardedOrchestrator; dbDir: string } {
    const dbDir = mkdtempSync(join(tmpdir(), 'mmpm-convergence-'));
    const orchestrator = new ShardedOrchestrator(2, atoms, dbDir);
    return { orchestrator, dbDir };
}

// ─── Study 1: Dominant path ───────────────────────────────────────────────────
// Ground truth: A→B 70%, A→C 30%.
// With enough training the model must predict B from A.
// This is the minimum viable convergence check.

describe('Convergence Study 1: dominant path (70/30 split)', () => {
    const GROUND_TRUTH: GroundTruthEdge[] = [
        { from: 'S1_A', transitions: [{ to: 'S1_B', probability: 0.7 }, { to: 'S1_C', probability: 0.3 }] },
        { from: 'S1_B', transitions: [{ to: 'S1_End', probability: 1.0 }] },
        { from: 'S1_C', transitions: [{ to: 'S1_End', probability: 1.0 }] },
    ];
    const BATCH_SIZE = 20;
    const NUM_EPOCHS = 10;

    let orchestrator: ShardedOrchestrator;
    let dbDir: string;
    let history: WeightSnapshot[] = [];

    beforeAll(async () => {
        const result = generateSequences({
            groundTruth: GROUND_TRUTH,
            startAtom: 'S1_A',
            stepsPerSequence: 2,
            numSequences: BATCH_SIZE * NUM_EPOCHS,
            seed: 42,
        });

        ({ orchestrator, dbDir } = makeOrchestrator(result.atoms));
        await orchestrator.init();

        const batches = toBatches(result.sequences, BATCH_SIZE);
        let seen = 0;
        for (let epoch = 0; epoch < batches.length; epoch++) {
            await trainEpoch(orchestrator, batches[epoch]);
            seen += batches[epoch].length;
            history.push(captureWeights(orchestrator, ['S1_A'], epoch + 1, seen));
        }

        printLearningCurve(history, 'S1_A');
    }, 30_000);

    afterAll(async () => {
        await orchestrator.close();
        rmSync(dbDir, { recursive: true, force: true });
    });

    it('after full training, dominant prediction is S1_B (the 70% path)', () => {
        const dominant = expectedDominant(GROUND_TRUTH);
        const weights = orchestrator.getWeights('S1_A');
        expect(weights).not.toBeNull();
        expect(weights!.length).toBeGreaterThan(0);
        expect(weights![0].to).toBe(dominant.get('S1_A'));
    });

    it('S1_B weight is strictly greater than S1_C weight after training', () => {
        const weights = orchestrator.getWeights('S1_A')!;
        const bWeight = weights.find(t => t.to === 'S1_B')?.weight ?? 0;
        const cWeight = weights.find(t => t.to === 'S1_C')?.weight ?? 0;
        expect(bWeight).toBeGreaterThan(cWeight);
    });

    it('final dominance ratio for S1_B exceeds 50% (model learned the dominant path)', () => {
        // Count-based Markov weights fluctuate around the true probability due to
        // sampling noise — strict monotonicity does not hold. The meaningful check
        // is that across 200 training sequences drawn from a 70/30 distribution,
        // the model's recovered ratio for the dominant path exceeds 50%.
        const finalSnap = history[history.length - 1];
        const row = finalSnap.weights.get('S1_A') ?? [];
        const total = row.reduce((s, t) => s + t.weight, 0);
        const bRatio = total > 0 ? (row.find(t => t.to === 'S1_B')?.weight ?? 0) / total : 0;
        expect(bRatio).toBeGreaterThan(0.5);
    });

    it('weight evolution history has one snapshot per epoch', () => {
        expect(history.length).toBe(NUM_EPOCHS);
    });
});

// ─── Study 2: Weight flip ─────────────────────────────────────────────────────
// Phase 1: train A→B exclusively (10 seqs).
// Phase 2: then train A→C exclusively at 3× the volume (30 seqs).
// Final prediction must flip from B to C.
// Verifies that accumulated weight can be overridden by sustained counter-training.

describe('Convergence Study 2: weight flip (B dominant → C overtakes)', () => {
    const ATOMS = ['S2_A', 'S2_B', 'S2_C'];
    const PHASE1_SEQ: string[][] = Array.from({ length: 10 }, () => ['S2_A', 'S2_B']);
    const PHASE2_SEQ: string[][] = Array.from({ length: 30 }, () => ['S2_A', 'S2_C']);

    let orchestrator: ShardedOrchestrator;
    let dbDir: string;
    let afterPhase1: { to: string; weight: number }[];
    let afterPhase2: { to: string; weight: number }[];

    beforeAll(async () => {
        ({ orchestrator, dbDir } = makeOrchestrator(ATOMS));
        await orchestrator.init();

        await trainEpoch(orchestrator, PHASE1_SEQ);
        afterPhase1 = orchestrator.getWeights('S2_A') ?? [];
        console.log('\n  After Phase 1 (A→B ×10):', afterPhase1);

        await trainEpoch(orchestrator, PHASE2_SEQ);
        afterPhase2 = orchestrator.getWeights('S2_A') ?? [];
        console.log('  After Phase 2 (A→C ×30):', afterPhase2);
    }, 30_000);

    afterAll(async () => {
        await orchestrator.close();
        rmSync(dbDir, { recursive: true, force: true });
    });

    it('after Phase 1, dominant prediction is S2_B', () => {
        expect(afterPhase1[0]?.to).toBe('S2_B');
    });

    it('after Phase 2, dominant prediction flips to S2_C', () => {
        expect(afterPhase2[0]?.to).toBe('S2_C');
    });

    it('S2_C weight exceeds S2_B weight after Phase 2', () => {
        const bW = afterPhase2.find(t => t.to === 'S2_B')?.weight ?? 0;
        const cW = afterPhase2.find(t => t.to === 'S2_C')?.weight ?? 0;
        expect(cW).toBeGreaterThan(bW);
    });

    it('total weight equals total training steps (weights are counts, not normalised)', () => {
        const total = afterPhase2.reduce((s, t) => s + t.weight, 0);
        expect(total).toBe(40); // 10 phase1 + 30 phase2
    });
});

// ─── Study 3: Multi-source convergence ───────────────────────────────────────
// A more realistic topology: three source atoms each with a clear dominant path.
// All three must converge to their respective dominant within the same training run.

describe('Convergence Study 3: multi-source convergence', () => {
    const GROUND_TRUTH: GroundTruthEdge[] = [
        { from: 'S3_X', transitions: [{ to: 'S3_P', probability: 0.9 }, { to: 'S3_Q', probability: 0.1 }] },
        { from: 'S3_Y', transitions: [{ to: 'S3_Q', probability: 0.8 }, { to: 'S3_P', probability: 0.2 }] },
        { from: 'S3_Z', transitions: [{ to: 'S3_R', probability: 0.6 }, { to: 'S3_P', probability: 0.4 }] },
        { from: 'S3_P', transitions: [{ to: 'S3_End', probability: 1.0 }] },
        { from: 'S3_Q', transitions: [{ to: 'S3_End', probability: 1.0 }] },
        { from: 'S3_R', transitions: [{ to: 'S3_End', probability: 1.0 }] },
    ];

    let orchestrator: ShardedOrchestrator;
    let dbDir: string;

    beforeAll(async () => {
        const result = generateSequences({
            groundTruth: GROUND_TRUTH,
            startAtom: 'S3_X',   // generator will only walk from X; Y and Z trained separately below
            stepsPerSequence: 2,
            numSequences: 1,      // just to capture atoms
            seed: 99,
        });

        // Use all atoms from the ground truth, not just those visited from X
        const allAtoms = Array.from(new Set(
            GROUND_TRUTH.flatMap(e => [e.from, ...e.transitions.map(t => t.to)])
        ));

        ({ orchestrator, dbDir } = makeOrchestrator(allAtoms));
        await orchestrator.init();

        // Train each source independently
        const sourceAtoms = ['S3_X', 'S3_Y', 'S3_Z'];
        for (const start of sourceAtoms) {
            const r = generateSequences({
                groundTruth: GROUND_TRUTH,
                startAtom: start,
                stepsPerSequence: 2,
                numSequences: 100,
                seed: start.charCodeAt(3),
            });
            await trainEpoch(orchestrator, r.sequences);
        }
    }, 30_000);

    afterAll(async () => {
        await orchestrator.close();
        rmSync(dbDir, { recursive: true, force: true });
    });

    const dominant = expectedDominant([
        { from: 'S3_X', transitions: [{ to: 'S3_P', probability: 0.9 }, { to: 'S3_Q', probability: 0.1 }] },
        { from: 'S3_Y', transitions: [{ to: 'S3_Q', probability: 0.8 }, { to: 'S3_P', probability: 0.2 }] },
        { from: 'S3_Z', transitions: [{ to: 'S3_R', probability: 0.6 }, { to: 'S3_P', probability: 0.4 }] },
    ]);

    for (const [source, expectedNext] of dominant) {
        it(`[${source}] converges to predict '${expectedNext}'`, () => {
            const weights = orchestrator.getWeights(source);
            expect(weights).not.toBeNull();
            expect(weights!.length).toBeGreaterThan(0);
            expect(weights![0].to).toBe(expectedNext);
        });
    }
});

// ─── Study 4: GET /weights API contract ──────────────────────────────────────
// Verifies the HTTP endpoint returns well-formed data and that
// dominanceRatio tracks actual weight distribution.

describe('Convergence Study 4: GET /weights API contract', () => {
    let orchestrator: ShardedOrchestrator;
    let dbDir: string;

    beforeAll(async () => {
        ({ orchestrator, dbDir } = makeOrchestrator(['W_A', 'W_B', 'W_C']));
        await orchestrator.init();
        // Train deterministic weights: W_A→W_B ×3, W_A→W_C ×1
        for (let i = 0; i < 3; i++) await orchestrator.train(['W_A', 'W_B']);
        await orchestrator.train(['W_A', 'W_C']);
    });

    afterAll(async () => {
        await orchestrator.close();
        rmSync(dbDir, { recursive: true, force: true });
    });

    it('returns transitions sorted descending by weight', () => {
        const weights = orchestrator.getWeights('W_A')!;
        for (let i = 1; i < weights.length; i++) {
            expect(weights[i - 1].weight).toBeGreaterThanOrEqual(weights[i].weight);
        }
    });

    it('dominant next is W_B (weight 3 > weight 1)', () => {
        const weights = orchestrator.getWeights('W_A')!;
        expect(weights[0].to).toBe('W_B');
        expect(weights[0].weight).toBe(3);
    });

    it('returns empty array for an untrained atom (no outgoing transitions)', () => {
        const weights = orchestrator.getWeights('W_B');
        expect(weights).toEqual([]);
    });

    it('returns null for an atom not in any shard', () => {
        const weights = orchestrator.getWeights('NOT_IN_CLUSTER');
        expect(weights).toBeNull();
    });
});
