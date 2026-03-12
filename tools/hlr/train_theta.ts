#!/usr/bin/env npx ts-node
/**
 * HLR Theta Training Pipeline — Sprint 14
 *
 * Reads access logs from all shards, builds training examples, and uses
 * gradient descent to learn optimal HLR theta values.
 *
 * Usage:  npm run hlr:train [-- --data-dir ./data/shards --min-events 1000]
 *
 * Output: tools/hlr/theta-{date}.json with:
 *   - learned theta values
 *   - recommended STDP tau (Sprint 14.5)
 *   - training/validation loss curves
 *   - all random restart results for transparency
 *
 * This script does NOT modify any server code.  Deploy new theta values
 * by setting the MMPM_HLR_THETA env var.
 */

import type { AccessLogEntry } from '../../src/access_log';
import type { HlrTheta } from '../../src/hlr';

// ─── Types ──────────────────────────────────────────────────────────────

export interface TrainingExample {
    /** Feature vector: [accessCount, trainingPasses, typeBias, provenanceBias] */
    features: [number, number, number, number];
    /** Observed re-access interval in ms (ground truth for half-life). */
    observedIntervalMs: number;
}

export interface ThetaResult {
    theta: HlrTheta;
    loss: number;
}

export interface TrainingOutput {
    bestTheta: HlrTheta;
    bestLoss: number;
    validationLoss: number;
    recommendedStdpTauMs: number;
    allRuns: ThetaResult[];
    trainLossCurve: number[];
    generalizationWarning: boolean;
    trainingExamples: number;
    validationExamples: number;
    timestamp: string;
}

// ─── Feature extraction (mirrors hlr.ts) ────────────────────────────────

function typeBias(atom: string): number {
    if (atom.includes('.procedure.')) return 1;
    if (atom.includes('.fact.'))      return 0;
    if (atom.includes('.relation.'))  return 0;
    if (atom.includes('.state.'))     return -1;
    if (atom.includes('.event.'))     return -1;
    return -0.5;
}

function provenanceBias(atom: string): number {
    if (atom.endsWith('_src_human'))    return 1;
    if (atom.endsWith('_src_test'))     return 0;
    if (atom.endsWith('_src_research')) return -0.5;
    return -1;
}

// ─── Training example extraction ────────────────────────────────────────

/**
 * Build training examples from a sorted access log.
 *
 * For each atom, we compute:
 *   - Features: access count, train count, type bias, provenance bias
 *     as accumulated UP TO each access event
 *   - Label: time until next access (observed re-access interval)
 *
 * Atoms that are only accessed once don't produce examples (no re-access).
 */
export function buildTrainingExamples(entries: AccessLogEntry[]): TrainingExample[] {
    // Group entries by atom, preserving chronological order
    const byAtom = new Map<string, AccessLogEntry[]>();
    for (const e of entries) {
        const list = byAtom.get(e.atom) ?? [];
        list.push(e);
        byAtom.set(e.atom, list);
    }

    const examples: TrainingExample[] = [];

    for (const [atom, events] of byAtom) {
        let accessCount = 0;
        let trainCount = 0;
        const tb = typeBias(atom);
        const pb = provenanceBias(atom);

        // Sort by timestamp (should already be sorted, but be safe)
        events.sort((a, b) => a.ts - b.ts);

        // Find pairs of consecutive access events
        const accessEvents = events.filter(e => e.type === 'access');
        for (const e of events) {
            if (e.type === 'access') accessCount++;
            if (e.type === 'train') trainCount++;
        }

        // We need at least 2 access events to have a re-access interval
        if (accessEvents.length < 2) continue;

        // Build examples from consecutive access pairs
        let runningAccess = 0;
        let runningTrain = 0;
        let eventIdx = 0;

        for (let i = 0; i < accessEvents.length - 1; i++) {
            const current = accessEvents[i];
            const next = accessEvents[i + 1];
            const interval = next.ts - current.ts;

            if (interval <= 0) continue; // skip duplicates

            // Count features accumulated up to current access
            while (eventIdx < events.length && events[eventIdx].ts <= current.ts) {
                if (events[eventIdx].type === 'access') runningAccess++;
                if (events[eventIdx].type === 'train') runningTrain++;
                eventIdx++;
            }

            examples.push({
                features: [runningAccess, runningTrain, tb, pb],
                observedIntervalMs: interval,
            });
        }
    }

    return examples;
}

// ─── Gradient descent ───────────────────────────────────────────────────

const BASE_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (default server config)

/**
 * Normalize raw features to prevent numeric overflow.
 * accessCount and trainingPasses are log-scaled since they grow unbounded.
 * typeBias and provenanceBias are already in [-1, 1] range.
 */
function normalizeFeatures(features: [number, number, number, number]): [number, number, number, number] {
    return [
        Math.log1p(features[0]),  // accessCount → log(1 + count)
        Math.log1p(features[1]),  // trainingPasses → log(1 + passes)
        features[2],              // typeBias [-1, 1]
        features[3],              // provenanceBias [-1, 1]
    ];
}

/**
 * Predicted half-life given theta and features.
 *   h = baseHalfLife × 2^(θ·x)
 *
 * Features are normalized to prevent numeric overflow.
 * Dot product is clamped to [-20, 20] as a safety bound.
 */
function predictHalfLife(theta: number[], features: number[]): number {
    const norm = normalizeFeatures(features as [number, number, number, number]);
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += theta[i] * norm[i];
    // Clamp to prevent Infinity
    dot = Math.max(-20, Math.min(20, dot));
    return BASE_HALF_LIFE_MS * Math.pow(2, dot);
}

/**
 * Mean squared log error: MSE(log(predicted), log(observed))
 *
 * We use log-space because half-lives span orders of magnitude.
 * This is equivalent to minimizing the geometric mean of the ratio
 * predicted/observed.
 */
export function computeLoss(theta: number[], examples: TrainingExample[]): number {
    if (examples.length === 0) return 0;
    let sum = 0;
    for (const ex of examples) {
        const predicted = predictHalfLife(theta, ex.features);
        const diff = Math.log(predicted) - Math.log(ex.observedIntervalMs);
        sum += diff * diff;
    }
    return sum / examples.length;
}

/**
 * Gradient of MSE log loss w.r.t. theta.
 */
function computeGradient(theta: number[], examples: TrainingExample[]): number[] {
    const grad = [0, 0, 0, 0];
    if (examples.length === 0) return grad;

    for (const ex of examples) {
        const predicted = predictHalfLife(theta, ex.features);
        const logDiff = Math.log(predicted) - Math.log(ex.observedIntervalMs);
        // d/dθ_j [log(h)]^2 = 2 * logDiff * d/dθ_j [log(h)]
        // log(h) = log(base) + θ·x_norm * log(2)
        // d/dθ_j log(h) = x_norm_j * log(2)
        const norm = normalizeFeatures(ex.features);
        const factor = 2 * logDiff * Math.LN2;
        for (let j = 0; j < 4; j++) {
            grad[j] += factor * norm[j];
        }
    }

    for (let j = 0; j < 4; j++) grad[j] /= examples.length;
    return grad;
}

/**
 * Train theta using gradient descent with random restarts.
 */
export function trainTheta(
    examples: TrainingExample[],
    options?: { epochs?: number; lr?: number; restarts?: number; batchSize?: number }
): { best: ThetaResult; allRuns: ThetaResult[]; lossCurve: number[] } {
    const epochs = options?.epochs ?? 1000;
    const lr = options?.lr ?? 0.01;
    const restarts = options?.restarts ?? 10;
    const batchSize = options?.batchSize ?? Math.min(64, examples.length);

    const allRuns: ThetaResult[] = [];
    let bestRun: ThetaResult = { theta: { access: 0.1, training: 0.15, type: 0.3, provenance: 0.4 }, loss: Infinity };
    let bestLossCurve: number[] = [];

    for (let r = 0; r < restarts; r++) {
        // Random initialization: small random values around 0
        const theta = [
            (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.5) * 0.4,
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.8,
        ];

        const lossCurve: number[] = [];

        for (let epoch = 0; epoch < epochs; epoch++) {
            // Mini-batch: randomly sample batchSize examples
            const batch: TrainingExample[] = [];
            for (let b = 0; b < batchSize; b++) {
                batch.push(examples[Math.floor(Math.random() * examples.length)]);
            }

            const grad = computeGradient(theta, batch);
            for (let j = 0; j < 4; j++) {
                theta[j] -= lr * grad[j];
            }

            // Record full loss every 100 epochs
            if (epoch % 100 === 0 || epoch === epochs - 1) {
                lossCurve.push(computeLoss(theta, examples));
            }
        }

        const finalLoss = computeLoss(theta, examples);
        const result: ThetaResult = {
            theta: { access: theta[0], training: theta[1], type: theta[2], provenance: theta[3] },
            loss: finalLoss,
        };
        allRuns.push(result);

        if (finalLoss < bestRun.loss) {
            bestRun = result;
            bestLossCurve = lossCurve;
        }
    }

    return { best: bestRun, allRuns, lossCurve: bestLossCurve };
}

// ─── STDP Tau calibration (Sprint 14.5) ─────────────────────────────────

/**
 * Estimate the optimal STDP tau from training event inter-arrival times.
 *
 * Strategy: collect all inter-training intervals per atom, then find the
 * tau that best separates "same-session bursts" (short intervals, < tau)
 * from "cross-session gaps" (long intervals, >> tau).
 *
 * We use the median of same-session intervals as a robust estimator.
 * "Same-session" is defined as intervals < 10 minutes (a reasonable
 * upper bound for interactive session activity).
 */
export function calibrateStdpTau(entries: AccessLogEntry[]): number {
    const trainEvents = entries.filter(e => e.type === 'train');

    // Group by atom
    const byAtom = new Map<string, number[]>();
    for (const e of trainEvents) {
        const list = byAtom.get(e.atom) ?? [];
        list.push(e.ts);
        byAtom.set(e.atom, list);
    }

    // Collect inter-training intervals within the same session window
    const SESSION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
    const sameSessionIntervals: number[] = [];

    for (const timestamps of byAtom.values()) {
        timestamps.sort((a, b) => a - b);
        for (let i = 1; i < timestamps.length; i++) {
            const dt = timestamps[i] - timestamps[i - 1];
            if (dt > 0 && dt < SESSION_WINDOW_MS) {
                sameSessionIntervals.push(dt);
            }
        }
    }

    if (sameSessionIntervals.length === 0) {
        // No multi-event training data — return the original guess
        return 300_000; // 5 min fallback
    }

    // Use the 75th percentile as tau: captures most same-session activity
    sameSessionIntervals.sort((a, b) => a - b);
    const p75Index = Math.floor(sameSessionIntervals.length * 0.75);
    const tau = sameSessionIntervals[p75Index];

    // Clamp to reasonable range [30s, 30min]
    return Math.max(30_000, Math.min(tau, 30 * 60 * 1000));
}

// ─── A/B Evaluation (Sprint 14.3) ───────────────────────────────────────

/**
 * Evaluate theta on held-out data.  Returns the loss on validation examples.
 * Also computes a simple pairwise accuracy: for pairs of atoms, does the
 * one with higher predicted half-life actually get re-accessed sooner?
 */
export function evaluate(
    theta: HlrTheta,
    validationExamples: TrainingExample[]
): { loss: number; pairwiseAccuracy: number } {
    const thetaArr = [theta.access, theta.training, theta.type, theta.provenance];
    const loss = computeLoss(thetaArr, validationExamples);

    // Pairwise accuracy
    let correct = 0;
    let total = 0;
    for (let i = 0; i < validationExamples.length - 1; i++) {
        for (let j = i + 1; j < Math.min(i + 10, validationExamples.length); j++) {
            const predI = predictHalfLife(thetaArr, validationExamples[i].features);
            const predJ = predictHalfLife(thetaArr, validationExamples[j].features);
            const actualI = validationExamples[i].observedIntervalMs;
            const actualJ = validationExamples[j].observedIntervalMs;

            // If predicted order matches actual order, it's correct
            if ((predI > predJ) === (actualI > actualJ)) correct++;
            total++;
        }
    }

    return {
        loss,
        pairwiseAccuracy: total > 0 ? correct / total : 0,
    };
}

// ─── Main pipeline ──────────────────────────────────────────────────────

/**
 * Run the full training pipeline.
 *
 * @param allEntries  All access log entries across all shards, sorted by ts.
 * @returns           Full training output with theta, tau, metrics.
 */
export function runTrainingPipeline(allEntries: AccessLogEntry[]): TrainingOutput {
    const examples = buildTrainingExamples(allEntries);

    if (examples.length < 10) {
        // Not enough data — return defaults with a warning
        return {
            bestTheta: { access: 0.1, training: 0.15, type: 0.3, provenance: 0.4 },
            bestLoss: NaN,
            validationLoss: NaN,
            recommendedStdpTauMs: 300_000,
            allRuns: [],
            trainLossCurve: [],
            generalizationWarning: true,
            trainingExamples: examples.length,
            validationExamples: 0,
            timestamp: new Date().toISOString(),
        };
    }

    // 80/20 train/validation split
    const shuffled = [...examples].sort(() => Math.random() - 0.5);
    const splitIdx = Math.floor(shuffled.length * 0.8);
    const trainSet = shuffled.slice(0, splitIdx);
    const valSet = shuffled.slice(splitIdx);

    // Train theta
    const { best, allRuns, lossCurve } = trainTheta(trainSet);

    // Evaluate on validation set
    const valResult = evaluate(best.theta, valSet);

    // STDP tau calibration
    const recommendedTau = calibrateStdpTau(allEntries);

    // Generalization warning: validation loss > 2x training loss
    const generalizationWarning = valResult.loss > 2 * best.loss;

    return {
        bestTheta: best.theta,
        bestLoss: best.loss,
        validationLoss: valResult.loss,
        recommendedStdpTauMs: recommendedTau,
        allRuns,
        trainLossCurve: lossCurve,
        generalizationWarning,
        trainingExamples: trainSet.length,
        validationExamples: valSet.length,
        timestamp: new Date().toISOString(),
    };
}
