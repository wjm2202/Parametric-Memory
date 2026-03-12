import { describe, it, expect } from 'vitest';
import {
    buildTrainingExamples,
    trainTheta,
    computeLoss,
    calibrateStdpTau,
    evaluate,
    runTrainingPipeline,
} from '../../tools/hlr/train_theta';
import type { AccessLogEntry } from '../access_log';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate synthetic access log entries with predictable patterns.
 *
 * - Procedures get accessed frequently (every 2 hours)
 * - Facts get accessed moderately (every 12 hours)
 * - States get accessed rarely (every 48 hours)
 *
 * This creates a clear signal for the trainer: procedures should have
 * longer half-lives, states shorter.
 */
function generateSyntheticLog(numAtoms = 30, durationDays = 14): AccessLogEntry[] {
    const entries: AccessLogEntry[] = [];
    const MS_PER_HOUR = 60 * 60 * 1000;
    const startTs = Date.now() - durationDays * 24 * MS_PER_HOUR;

    for (let i = 0; i < numAtoms; i++) {
        const type = i % 3 === 0 ? 'procedure' : i % 3 === 1 ? 'fact' : 'state';
        const provenance = i % 5 === 0 ? '_src_human' : '';
        const atom = `v1.${type}.item_${i}${provenance}`;

        // Access interval depends on type
        const intervalHours = type === 'procedure' ? 2 : type === 'fact' ? 12 : 48;

        // Generate access events
        let ts = startTs + i * 1000; // stagger starts
        while (ts < startTs + durationDays * 24 * MS_PER_HOUR) {
            entries.push({ atom, type: 'access', ts });
            ts += intervalHours * MS_PER_HOUR * (0.8 + Math.random() * 0.4); // add jitter
        }

        // Also add some training events (clustered in sessions)
        const trainCount = type === 'procedure' ? 15 : type === 'fact' ? 5 : 2;
        for (let t = 0; t < trainCount; t++) {
            // Training events within 5 minutes of each other (same session)
            entries.push({ atom, type: 'train', ts: startTs + t * 30_000 + i * 1000 });
        }
    }

    // Sort chronologically
    entries.sort((a, b) => a.ts - b.ts);
    return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HLR Training Pipeline (Sprint 14)', () => {

    describe('buildTrainingExamples', () => {

        it('extracts examples from access pairs', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'access', ts: 1000 },
                { atom: 'v1.fact.a', type: 'access', ts: 5000 },
                { atom: 'v1.fact.a', type: 'access', ts: 12000 },
            ];

            const examples = buildTrainingExamples(entries);
            expect(examples.length).toBe(2);
            expect(examples[0].observedIntervalMs).toBe(4000);
            expect(examples[1].observedIntervalMs).toBe(7000);
        });

        it('returns empty for single-access atoms', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'access', ts: 1000 },
                { atom: 'v1.fact.b', type: 'access', ts: 2000 },
            ];
            // Each atom only accessed once — no re-access intervals
            expect(buildTrainingExamples(entries)).toHaveLength(0);
        });

        it('includes type and provenance bias in features', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.procedure.x_src_human', type: 'access', ts: 1000 },
                { atom: 'v1.procedure.x_src_human', type: 'access', ts: 5000 },
            ];

            const examples = buildTrainingExamples(entries);
            expect(examples).toHaveLength(1);
            // features = [accessCount, trainCount, typeBias, provenanceBias]
            expect(examples[0].features[2]).toBe(1);  // procedure = +1
            expect(examples[0].features[3]).toBe(1);  // _src_human = +1
        });

        it('counts training events in features', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'train', ts: 500 },
                { atom: 'v1.fact.a', type: 'train', ts: 600 },
                { atom: 'v1.fact.a', type: 'access', ts: 1000 },
                { atom: 'v1.fact.a', type: 'access', ts: 5000 },
            ];

            const examples = buildTrainingExamples(entries);
            expect(examples).toHaveLength(1);
            // By ts=1000, we've seen 2 trains and 1 access
            expect(examples[0].features[0]).toBe(1);  // 1 access before the pair
            expect(examples[0].features[1]).toBe(2);  // 2 trains before the pair
        });
    });

    describe('trainTheta', () => {

        it('produces theta values', () => {
            const entries = generateSyntheticLog(20, 7);
            const examples = buildTrainingExamples(entries);
            expect(examples.length).toBeGreaterThan(10);

            const { best, allRuns } = trainTheta(examples, { epochs: 200, restarts: 3 });

            expect(best.theta).toBeDefined();
            expect(best.theta.access).toBeTypeOf('number');
            expect(best.theta.training).toBeTypeOf('number');
            expect(best.theta.type).toBeTypeOf('number');
            expect(best.theta.provenance).toBeTypeOf('number');
            expect(best.loss).toBeLessThan(Infinity);
            expect(allRuns).toHaveLength(3);
        });

        it('loss decreases over training', () => {
            const entries = generateSyntheticLog(20, 7);
            const examples = buildTrainingExamples(entries);

            const { lossCurve } = trainTheta(examples, { epochs: 500, restarts: 1 });

            expect(lossCurve.length).toBeGreaterThan(1);
            // First loss should be >= last loss (training should improve)
            expect(lossCurve[lossCurve.length - 1]).toBeLessThanOrEqual(lossCurve[0]);
        });
    });

    describe('computeLoss', () => {

        it('returns zero for perfect predictions', () => {
            // If predicted half-life equals observed interval for all examples, loss = 0
            // predictedHL = base * 2^(theta·x).  For theta=[0,0,0,0], predicted = base always.
            // So loss = MSE(log(base), log(observed)).  Only zero if all observed = base.
            const BASE = 7 * 24 * 60 * 60 * 1000;
            const examples = [
                { features: [0, 0, 0, 0] as [number, number, number, number], observedIntervalMs: BASE },
                { features: [0, 0, 0, 0] as [number, number, number, number], observedIntervalMs: BASE },
            ];
            const loss = computeLoss([0, 0, 0, 0], examples);
            expect(loss).toBeCloseTo(0, 10);
        });

        it('returns positive for imperfect predictions', () => {
            const examples = [
                { features: [1, 0, 0, 0] as [number, number, number, number], observedIntervalMs: 1000 },
            ];
            const loss = computeLoss([0, 0, 0, 0], examples);
            expect(loss).toBeGreaterThan(0);
        });
    });

    describe('calibrateStdpTau', () => {

        it('returns reasonable tau for clustered training events', () => {
            const entries: AccessLogEntry[] = [];
            // Session 1: burst of training at t=0, 10s, 20s, 30s
            for (let i = 0; i < 10; i++) {
                entries.push({ atom: 'v1.fact.a', type: 'train', ts: i * 10_000 });
            }
            // Session 2: another burst 1 hour later
            const offset = 60 * 60 * 1000;
            for (let i = 0; i < 10; i++) {
                entries.push({ atom: 'v1.fact.a', type: 'train', ts: offset + i * 10_000 });
            }

            const tau = calibrateStdpTau(entries);

            // Should be in the range of intra-session intervals (10s-ish),
            // clamped to at least 30s
            expect(tau).toBeGreaterThanOrEqual(30_000);
            expect(tau).toBeLessThanOrEqual(30 * 60 * 1000);
        });

        it('returns fallback when no multi-event training data', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'train', ts: 1000 },
                { atom: 'v1.fact.b', type: 'train', ts: 2000 },
            ];
            // Different atoms — no intra-atom intervals
            const tau = calibrateStdpTau(entries);
            expect(tau).toBe(300_000); // fallback
        });

        it('ignores access events, only uses train events', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'access', ts: 1000 },
                { atom: 'v1.fact.a', type: 'access', ts: 2000 },
            ];
            const tau = calibrateStdpTau(entries);
            expect(tau).toBe(300_000); // fallback — no train events
        });
    });

    describe('evaluate', () => {

        it('returns loss and pairwise accuracy', () => {
            const examples = buildTrainingExamples(generateSyntheticLog(20, 7));
            const theta = { access: 0.1, training: 0.15, type: 0.3, provenance: 0.4 };

            const result = evaluate(theta, examples);

            expect(result.loss).toBeTypeOf('number');
            expect(result.loss).toBeGreaterThanOrEqual(0);
            expect(result.pairwiseAccuracy).toBeGreaterThanOrEqual(0);
            expect(result.pairwiseAccuracy).toBeLessThanOrEqual(1);
        });
    });

    describe('runTrainingPipeline', () => {

        it('returns full output with synthetic data', () => {
            const entries = generateSyntheticLog(30, 14);
            const output = runTrainingPipeline(entries);

            expect(output.bestTheta).toBeDefined();
            expect(output.bestLoss).toBeTypeOf('number');
            expect(output.validationLoss).toBeTypeOf('number');
            expect(output.recommendedStdpTauMs).toBeGreaterThan(0);
            expect(output.trainLossCurve.length).toBeGreaterThan(0);
            expect(output.trainingExamples).toBeGreaterThan(0);
            expect(output.validationExamples).toBeGreaterThan(0);
            expect(output.timestamp).toBeTruthy();
        });

        it('returns defaults with insufficient data', () => {
            const entries: AccessLogEntry[] = [
                { atom: 'v1.fact.a', type: 'access', ts: 1000 },
                { atom: 'v1.fact.a', type: 'access', ts: 2000 },
            ];
            const output = runTrainingPipeline(entries);

            expect(output.generalizationWarning).toBe(true);
            expect(output.trainingExamples).toBeLessThan(10);
            expect(output.bestTheta.access).toBe(0.1); // default
        });

        it('trained theta produces valid theta JSON shape', () => {
            const entries = generateSyntheticLog(30, 14);
            const output = runTrainingPipeline(entries);

            // Validate the output matches what MMPM_HLR_THETA env var expects
            const theta = output.bestTheta;
            expect(Number.isFinite(theta.access)).toBe(true);
            expect(Number.isFinite(theta.training)).toBe(true);
            expect(Number.isFinite(theta.type)).toBe(true);
            expect(Number.isFinite(theta.provenance)).toBe(true);

            // Recommended tau is a finite positive number
            expect(Number.isFinite(output.recommendedStdpTauMs)).toBe(true);
            expect(output.recommendedStdpTauMs).toBeGreaterThan(0);
        });
    });
});
