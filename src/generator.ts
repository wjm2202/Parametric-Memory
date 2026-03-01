/**
 * Synthetic Sequence Generator
 *
 * Generates training sequences by sampling random walks from a user-defined
 * ground-truth transition probability matrix.
 *
 * This is the entry point for real-world convergence studies:
 *   1. Define the true distribution you want the model to learn
 *   2. Generate N sequences sampled from that distribution
 *   3. Train the cluster in epochs and use GET /weights/:atom to observe
 *      whether the recovered weights converge toward the true distribution
 *
 * Pure functions only — no I/O, no side effects. Safe to import anywhere.
 */
import { DataAtom } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry in the ground-truth probability table for a given source atom */
export interface TransitionProbability {
    to: DataAtom;
    /** Must sum to 1.0 across all entries for the same `from` atom */
    probability: number;
}

/**
 * Ground-truth transition matrix — the distribution you want the model to learn.
 *
 * Example:
 *   [
 *     { from: 'A', transitions: [{ to: 'B', probability: 0.7 }, { to: 'C', probability: 0.3 }] },
 *     { from: 'B', transitions: [{ to: 'C', probability: 1.0 }] },
 *   ]
 */
export interface GroundTruthEdge {
    from: DataAtom;
    transitions: TransitionProbability[];
}

export interface GeneratorConfig {
    /** The ground-truth Markov chain definition */
    groundTruth: GroundTruthEdge[];
    /** Starting atom for every generated walk */
    startAtom: DataAtom;
    /** Number of steps per sequence (sequence length = steps + 1) */
    stepsPerSequence: number;
    /** Total number of sequences to generate */
    numSequences: number;
    /** Optional seed for reproducible output (simple LCG) */
    seed?: number;
}

export interface GeneratorResult {
    sequences: DataAtom[][];
    /** All unique atoms that appear in any sequence */
    atoms: DataAtom[];
    /** The ground-truth edge used to generate, for later comparison */
    groundTruth: GroundTruthEdge[];
}

// ─── Core generator ───────────────────────────────────────────────────────────

/**
 * Generate training sequences by random-walking the ground-truth matrix.
 *
 * Each sequence starts at `startAtom` and takes `stepsPerSequence` steps,
 * sampling the next atom according to the defined probabilities.
 * If a terminal node is reached (no outgoing edges), the walk stops early.
 */
export function generateSequences(config: GeneratorConfig): GeneratorResult {
    const { groundTruth, startAtom, stepsPerSequence, numSequences, seed } = config;

    // Build O(1) lookup table from the ground-truth array
    const lookup = new Map<DataAtom, TransitionProbability[]>();
    for (const edge of groundTruth) {
        validateProbabilities(edge);
        lookup.set(edge.from, edge.transitions);
    }

    // Simple seeded LCG for reproducibility (not crypto-quality — just for tests)
    let rngState = seed ?? Date.now();
    const rng = (): number => {
        rngState = (rngState * 1664525 + 1013904223) & 0xffffffff;
        return (rngState >>> 0) / 0xffffffff;
    };

    const sequences: DataAtom[][] = [];
    const atomSet = new Set<DataAtom>();

    for (let s = 0; s < numSequences; s++) {
        const seq: DataAtom[] = [startAtom];
        atomSet.add(startAtom);
        let current = startAtom;

        for (let step = 0; step < stepsPerSequence; step++) {
            const edges = lookup.get(current);
            if (!edges || edges.length === 0) break; // terminal node

            const next = sampleWeighted(edges, rng());
            seq.push(next);
            atomSet.add(next);
            current = next;
        }

        sequences.push(seq);
    }

    return {
        sequences,
        atoms: Array.from(atomSet),
        groundTruth,
    };
}

/**
 * Split sequences into epoch batches.
 * Useful for iterative training studies where you want to observe weight
 * evolution after every N sequences.
 *
 * @param sequences - full sequence array from generateSequences()
 * @param batchSize - number of sequences per epoch
 */
export function toBatches(sequences: DataAtom[][], batchSize: number): DataAtom[][][] {
    const batches: DataAtom[][][] = [];
    for (let i = 0; i < sequences.length; i += batchSize) {
        batches.push(sequences.slice(i, i + batchSize));
    }
    return batches;
}

/**
 * Given a ground-truth edge definition, return the expected dominant next atom
 * for each source — i.e. the atom with the highest probability.
 * Used by convergence tests to verify the model learned the right structure.
 */
export function expectedDominant(groundTruth: GroundTruthEdge[]): Map<DataAtom, DataAtom> {
    const result = new Map<DataAtom, DataAtom>();
    for (const edge of groundTruth) {
        if (edge.transitions.length === 0) continue;
        const dominant = edge.transitions.reduce((best, t) =>
            t.probability > best.probability ? t : best
        );
        result.set(edge.from, dominant.to);
    }
    return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sampleWeighted(edges: TransitionProbability[], rand: number): DataAtom {
    let cumulative = 0;
    for (const edge of edges) {
        cumulative += edge.probability;
        if (rand <= cumulative) return edge.to;
    }
    // Floating point guard — return last entry
    return edges[edges.length - 1].to;
}

function validateProbabilities(edge: GroundTruthEdge): void {
    const sum = edge.transitions.reduce((s, t) => s + t.probability, 0);
    if (Math.abs(sum - 1.0) > 0.001) {
        throw new Error(
            `Probabilities for '${edge.from}' sum to ${sum.toFixed(4)}, expected 1.0`
        );
    }
}
