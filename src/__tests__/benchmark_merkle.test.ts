import { describe, it, expect } from 'vitest';
import { performance } from 'perf_hooks';
import { MerkleSnapshot } from '../merkle_snapshot';
import { IncrementalMerkleTree } from '../incremental_merkle';
import { TOMBSTONE_HASH } from '../types';

type BenchOp =
    | { kind: 'tombstone'; index: number }
    | { kind: 'append'; hash: Buffer };

type BenchResult = {
    leafCount: number;
    trials: number;
    opCount: number;
    fullP50Ms: number;
    fullP95Ms: number;
    incrementalP50Ms: number;
    incrementalP95Ms: number;
    speedupP50: number;
    approxNodeMiB: number;
    approxLeafMiB: number;
    nodeOverheadRatio: number;
};

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

function makeLeaf(i: number): Buffer {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(i >>> 0, 28);
    return b;
}

function buildBaseLeaves(leafCount: number): Buffer[] {
    const out = new Array<Buffer>(leafCount);
    for (let i = 0; i < leafCount; i++) out[i] = makeLeaf(i);
    return out;
}

function buildOps(leafCount: number, opCount: number): BenchOp[] {
    const ops: BenchOp[] = [];
    const tombstones = Math.max(1, Math.floor(opCount * 0.7));
    const appends = opCount - tombstones;

    for (let i = 0; i < tombstones; i++) {
        const idx = (i * 15485863) % leafCount;
        ops.push({ kind: 'tombstone', index: idx });
    }
    for (let i = 0; i < appends; i++) {
        const h = Buffer.alloc(32);
        h.writeUInt32BE((leafCount + i) >>> 0, 24);
        h.writeUInt32BE((i * 2654435761) >>> 0, 28);
        ops.push({ kind: 'append', hash: h });
    }
    return ops;
}

function runFullRebuildOnce(baseLeaves: Buffer[], ops: BenchOp[]): number {
    const leaves = baseLeaves.slice();
    const tomb = Buffer.from(TOMBSTONE_HASH, 'hex');

    const t0 = performance.now();
    for (const op of ops) {
        if (op.kind === 'tombstone') {
            leaves[op.index] = tomb;
        } else {
            leaves.push(op.hash);
        }
    }
    const snapshot = new MerkleSnapshot(leaves, 1);
    void snapshot.root;
    return performance.now() - t0;
}

function runIncrementalOnce(baseLeaves: Buffer[], ops: BenchOp[]): number {
    const tomb = Buffer.from(TOMBSTONE_HASH, 'hex');
    const tree = IncrementalMerkleTree.fromLeaves(baseLeaves);

    // Benchmark commit mutation work only.
    // Tree construction corresponds to one-time snapshot hydration/setup,
    // not per-commit incremental update cost.
    const t0 = performance.now();

    for (const op of ops) {
        if (op.kind === 'tombstone') {
            tree.updateLeaf(op.index, tomb);
        } else {
            tree.appendLeaf(op.hash);
        }
    }

    const root = tree.root;
    expect(root).toMatch(/^[a-f0-9]{64}$/);
    return performance.now() - t0;
}

function estimateMemory(leafCount: number): { approxNodeMiB: number; approxLeafMiB: number; nodeOverheadRatio: number } {
    const capacity = nextPow2(Math.max(1, leafCount));
    const nodeCount = 2 * capacity - 1;
    const nodeBytes = nodeCount * 32;
    const leafBytes = leafCount * 32;
    return {
        approxNodeMiB: nodeBytes / (1024 * 1024),
        approxLeafMiB: leafBytes / (1024 * 1024),
        nodeOverheadRatio: leafBytes > 0 ? nodeBytes / leafBytes : 0,
    };
}

function runCase(leafCount: number, trials: number): BenchResult {
    const opCount = Math.max(16, Math.floor(Math.log10(leafCount) * 32));
    const base = buildBaseLeaves(leafCount);
    const ops = buildOps(leafCount, opCount);

    const full: number[] = [];
    const incr: number[] = [];

    for (let i = 0; i < trials; i++) {
        full.push(runFullRebuildOnce(base, ops));
        incr.push(runIncrementalOnce(base, ops));
    }

    const mem = estimateMemory(leafCount);
    const fullP50Ms = percentile(full, 50);
    const incrementalP50Ms = percentile(incr, 50);

    return {
        leafCount,
        trials,
        opCount,
        fullP50Ms,
        fullP95Ms: percentile(full, 95),
        incrementalP50Ms,
        incrementalP95Ms: percentile(incr, 95),
        speedupP50: fullP50Ms / Math.max(incrementalP50Ms, 0.000001),
        approxNodeMiB: mem.approxNodeMiB,
        approxLeafMiB: mem.approxLeafMiB,
        nodeOverheadRatio: mem.nodeOverheadRatio,
    };
}

describe('Incremental Merkle benchmark (Story 4.3)', () => {
    it('compares full rebuild vs incremental commit latency at 1K, 10K, 100K leaves', () => {
        const cases = [1_000, 10_000, 100_000];
        const results = cases.map(n => runCase(n, 5));

        console.table(results.map(r => ({
            leaves: r.leafCount,
            ops: r.opCount,
            full_p50_ms: r.fullP50Ms.toFixed(3),
            full_p95_ms: r.fullP95Ms.toFixed(3),
            incr_p50_ms: r.incrementalP50Ms.toFixed(3),
            incr_p95_ms: r.incrementalP95Ms.toFixed(3),
            speedup_p50: `${r.speedupP50.toFixed(2)}x`,
        })));

        console.table(results.map(r => ({
            leaves: r.leafCount,
            approx_leaf_mib: r.approxLeafMiB.toFixed(2),
            approx_node_mib: r.approxNodeMiB.toFixed(2),
            node_overhead_ratio: r.nodeOverheadRatio.toFixed(2),
        })));

        for (const r of results) {
            expect(r.fullP50Ms).toBeGreaterThan(0);
            expect(r.incrementalP50Ms).toBeGreaterThan(0);
            expect(r.nodeOverheadRatio).toBeGreaterThan(1);
        }

        const r10k = results.find(r => r.leafCount === 10_000)!;
        const r100k = results.find(r => r.leafCount === 100_000)!;
        expect(r10k.incrementalP50Ms).toBeLessThanOrEqual(r10k.fullP50Ms);
        expect(r100k.incrementalP50Ms).toBeLessThanOrEqual(r100k.fullP50Ms);
    // Benchmark runs ~4.5 s under parallel CI load; 20 s gives ample headroom.
    }, 20_000);

    it('optionally runs a 1M-leaf benchmark when MMPM_BENCH_INCLUDE_1M=1', () => {
        if (process.env.MMPM_BENCH_INCLUDE_1M !== '1') {
            console.log('Skipping 1M-leaf benchmark (set MMPM_BENCH_INCLUDE_1M=1 to enable).');
            expect(true).toBe(true);
            return;
        }

        const result = runCase(1_000_000, 1);
        console.table([
            {
                leaves: result.leafCount,
                ops: result.opCount,
                full_p50_ms: result.fullP50Ms.toFixed(3),
                incr_p50_ms: result.incrementalP50Ms.toFixed(3),
                speedup_p50: `${result.speedupP50.toFixed(2)}x`,
                approx_leaf_mib: result.approxLeafMiB.toFixed(2),
                approx_node_mib: result.approxNodeMiB.toFixed(2),
            },
        ]);

        expect(result.fullP50Ms).toBeGreaterThan(0);
        expect(result.incrementalP50Ms).toBeGreaterThan(0);
    }, 180000);
});
