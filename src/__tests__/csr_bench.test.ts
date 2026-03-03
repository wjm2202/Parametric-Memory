import { describe, it, expect } from 'vitest';
import { performance } from 'perf_hooks';
import { CsrTransitionMatrix } from '../csr_matrix';

type BuildResult = {
    transitions: Map<number, Map<string, number>>;
    hashToIndex: Map<string, number>;
    atomHashes: string[];
};

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

function buildSyntheticGraph(atomCount: number, outDegree: number): BuildResult {
    const atomHashes = Array.from({ length: atomCount }, (_, i) => `h${i}`);
    const hashToIndex = new Map<string, number>(atomHashes.map((h, i) => [h, i]));
    const transitions = new Map<number, Map<string, number>>();

    for (let fromIdx = 0; fromIdx < atomCount; fromIdx++) {
        const row = new Map<string, number>();
        for (let edge = 0; edge < outDegree; edge++) {
            const toIdx = (fromIdx + edge + 1) % atomCount;
            const toHash = atomHashes[toIdx];
            row.set(toHash, outDegree - edge);
        }
        transitions.set(fromIdx, row);
    }

    return { transitions, hashToIndex, atomHashes };
}

function mapTopPrediction(
    transitions: Map<number, Map<string, number>>,
    hashToIndex: Map<string, number>,
    fromIdx: number,
): number {
    const row = transitions.get(fromIdx);
    if (!row || row.size === 0) return -1;

    let bestIdx = -1;
    let bestWeight = -Infinity;
    for (const [toHash, weight] of row) {
        const toIdx = hashToIndex.get(toHash);
        if (toIdx === undefined) continue;
        if (weight > bestWeight) {
            bestWeight = weight;
            bestIdx = toIdx;
        }
    }
    return bestIdx;
}

function runMapLatency(
    iterations: number,
    atomCount: number,
    transitions: Map<number, Map<string, number>>,
    hashToIndex: Map<string, number>,
): number[] {
    const latencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const fromIdx = i % atomCount;
        const t0 = performance.now();
        mapTopPrediction(transitions, hashToIndex, fromIdx);
        latencies.push(performance.now() - t0);
    }
    return latencies;
}

function runCsrLatency(
    iterations: number,
    atomCount: number,
    matrix: CsrTransitionMatrix,
): number[] {
    const latencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const fromIdx = i % atomCount;
        const t0 = performance.now();
        matrix.getTopPrediction(fromIdx);
        latencies.push(performance.now() - t0);
    }
    return latencies;
}

describe('CSR vs Map prediction benchmark (Story 12.3)', () => {
    const LOOKUPS = 10_000;

    it('CSR build time is O(edges), not O(atoms²)', () => {
        const small = buildSyntheticGraph(4_000, 2);
        const medium = buildSyntheticGraph(4_000, 6);

        const t0 = performance.now();
        CsrTransitionMatrix.build(small.transitions, small.hashToIndex, 4_000);
        const smallMs = performance.now() - t0;

        const t1 = performance.now();
        CsrTransitionMatrix.build(medium.transitions, medium.hashToIndex, 4_000);
        const mediumMs = performance.now() - t1;

        const edgeRatio = (4_000 * 6) / (4_000 * 2);
        const timeRatio = mediumMs / Math.max(smallMs, 0.0001);

        console.table([
            { case: 'small', atoms: 4_000, outDegree: 2, edges: 8_000, buildMs: smallMs.toFixed(3) },
            { case: 'medium', atoms: 4_000, outDegree: 6, edges: 24_000, buildMs: mediumMs.toFixed(3) },
            { case: 'ratio', edgeRatio: edgeRatio.toFixed(2), timeRatio: timeRatio.toFixed(2) },
        ]);

        expect(mediumMs).toBeGreaterThan(0);
        expect(timeRatio).toBeLessThan(edgeRatio * 2.5);
    });

    it('CSR prediction latency p50 ≤ Map iteration p50 at N=1K atoms', () => {
        const atomCount = 1_000;
        const outDegree = 5;
        const graph = buildSyntheticGraph(atomCount, outDegree);
        const matrix = CsrTransitionMatrix.build(graph.transitions, graph.hashToIndex, atomCount);

        const mapLat = runMapLatency(LOOKUPS, atomCount, graph.transitions, graph.hashToIndex);
        const csrLat = runCsrLatency(LOOKUPS, atomCount, matrix);

        const mapP50 = percentile(mapLat, 50);
        const csrP50 = percentile(csrLat, 50);

        console.table([
            { N: atomCount, path: 'map', p50: mapP50.toFixed(6), p95: percentile(mapLat, 95).toFixed(6), p99: percentile(mapLat, 99).toFixed(6) },
            { N: atomCount, path: 'csr', p50: csrP50.toFixed(6), p95: percentile(csrLat, 95).toFixed(6), p99: percentile(csrLat, 99).toFixed(6) },
        ]);

        expect(csrP50).toBeLessThanOrEqual(mapP50);
    });

    it('CSR prediction latency p50 ≤ Map iteration p50 at N=10K atoms', () => {
        const atomCount = 10_000;
        const outDegree = 5;
        const graph = buildSyntheticGraph(atomCount, outDegree);
        const matrix = CsrTransitionMatrix.build(graph.transitions, graph.hashToIndex, atomCount);

        const mapLat = runMapLatency(LOOKUPS, atomCount, graph.transitions, graph.hashToIndex);
        const csrLat = runCsrLatency(LOOKUPS, atomCount, matrix);

        const mapP50 = percentile(mapLat, 50);
        const csrP50 = percentile(csrLat, 50);

        console.table([
            { N: atomCount, path: 'map', p50: mapP50.toFixed(6), p95: percentile(mapLat, 95).toFixed(6), p99: percentile(mapLat, 99).toFixed(6) },
            { N: atomCount, path: 'csr', p50: csrP50.toFixed(6), p95: percentile(csrLat, 95).toFixed(6), p99: percentile(csrLat, 99).toFixed(6) },
        ]);

        expect(csrP50).toBeLessThanOrEqual(mapP50);
    });

    it('CSR vs Map parity: both return same predicted atom for same training', () => {
        const atomCount = 100_000;
        const outDegree = 5;
        const graph = buildSyntheticGraph(atomCount, outDegree);
        const matrix = CsrTransitionMatrix.build(graph.transitions, graph.hashToIndex, atomCount);

        for (let fromIdx = 0; fromIdx < atomCount; fromIdx += 137) {
            const mapIdx = mapTopPrediction(graph.transitions, graph.hashToIndex, fromIdx);
            const csrIdx = matrix.getTopPrediction(fromIdx);
            expect(csrIdx).toBe(mapIdx);
        }
    });
});
