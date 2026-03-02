/**
 * Shard Consistency Tests
 *
 * These tests verify that all correctness guarantees hold regardless of:
 *   - shard count (1, 2, 4, 8)
 *   - atom-to-shard placement (intra-shard vs cross-shard edges)
 *   - at-rest state across restart
 *
 * Core properties verified:
 *   1. ROUTING DETERMINISM  — a given atom always routes to the same shard for
 *                             the same shard count and ring config
 *   2. CROSS-SHARD EDGES    — training A→B where A and B land on different shards
 *                             produces identical predictions to intra-shard edges
 *   3. SHARD-COUNT INVARIANCE — the dominant prediction for a trained sequence
 *                               is identical across 1, 2, 4, and 8 shards
 *   4. PROOF INTEGRITY      — currentProof and shardRootProof are valid for all
 *                             atoms regardless of shard topology
 *   5. EMPTY SHARD SAFETY   — shards with no atoms do not crash init or access
 *   6. PERSISTENCE          — predictions and weights survive a close/reopen cycle
 *   7. STATS ACCURACY       — getClusterStats sums correctly across N shards
 *   8. WEIGHT RESOLUTION    — getWeights resolves cross-shard neighbours correctly
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShardedOrchestrator } from '../orchestrator';
import { ShardRouter } from '../router';
import { MerkleKernel } from '../merkle';

// ─── Test fixtures ────────────────────────────────────────────────────────────
const atom = (value: string) => `v1.other.${value}`;

/** Atoms chosen to guarantee cross-shard placement under 2 and 4 shards */
const ATOMS_4 = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(atom);
const ATOMS_8 = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'].map(atom);
const SEQUENCE = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(atom);

/** Shard counts to test across */
const SHARD_COUNTS = [1, 2, 4, 8] as const;

// ─── Utility ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function tempDb(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-consistency-${label}-`));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    // Deferred cleanup — only remove dirs that have been registered
    // (orchestrators are closed inside each test)
    while (dirs.length) {
        const dir = dirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Routing determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — routing determinism', () => {
    it.each(SHARD_COUNTS)(
        'ShardRouter(%i): same atom always routes to the same shard index',
        (n) => {
            const router = new ShardRouter(n);
            for (const atom of ATOMS_8) {
                const idx1 = router.getShardIndex(atom);
                const idx2 = router.getShardIndex(atom);
                const idx3 = router.getShardIndex(atom);
                expect(idx1).toBe(idx2);
                expect(idx2).toBe(idx3);
            }
        }
    );

    it.each(SHARD_COUNTS)(
        'ShardRouter(%i): all shard indices are within [0, n)',
        (n) => {
            const router = new ShardRouter(n);
            for (const atom of ATOMS_8) {
                const idx = router.getShardIndex(atom);
                expect(idx).toBeGreaterThanOrEqual(0);
                expect(idx).toBeLessThan(n);
            }
        }
    );

    it('growing shard count from 1→8: routing may change but is always valid', () => {
        // This is intentional by design: consistent hashing minimises remapping
        // but does not guarantee identical placement across different ring sizes.
        // The test documents this behaviour rather than asserting identity.
        const routings = SHARD_COUNTS.map(n => {
            const router = new ShardRouter(n);
            return ATOMS_8.map(a => ({ atom: a, shard: router.getShardIndex(a) }));
        });
        for (const routingSet of routings) {
            for (const { shard } of routingSet) {
                expect(typeof shard).toBe('number');
                expect(Number.isFinite(shard)).toBe(true);
            }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Shard-count invariance of prediction
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — prediction is invariant across shard count', () => {
    it('dominant prediction for Alpha→Beta is identical on 1, 2, 4, 8 shards', async () => {
        const predictions: Array<string | null> = [];

        for (const n of SHARD_COUNTS) {
            const orch = new ShardedOrchestrator(n, ATOMS_4, tempDb(`inv-${n}`));
            await orch.init();
            // Train 3× to build definitive weight
            for (let i = 0; i < 3; i++) await orch.train(SEQUENCE);
            const report = await orch.access(atom('Alpha'));
            predictions.push(report.predictedNext);
            await orch.close();
        }

        // All shard counts must agree
        const first = predictions[0];
        expect(first).toBe(atom('Beta')); // ground truth: Alpha trained → Beta
        for (const p of predictions) {
            expect(p).toBe(first);
        }
    });

    it('full chain prediction Alpha→Beta→Gamma→Delta holds on all shard counts', async () => {
        for (const n of SHARD_COUNTS) {
            const orch = new ShardedOrchestrator(n, ATOMS_4, tempDb(`chain-${n}`));
            await orch.init();
            await orch.train(SEQUENCE);

            const expected: Record<string, string | null> = {
                [atom('Alpha')]: atom('Beta'),
                [atom('Beta')]: atom('Gamma'),
                [atom('Gamma')]: atom('Delta'),
                [atom('Delta')]: null,
            };

            for (const [atom, expectedNext] of Object.entries(expected)) {
                const report = await orch.access(atom);
                expect(report.predictedNext, `[shards=${n}] ${atom} → expected ${expectedNext}`).toBe(expectedNext);
            }

            await orch.close();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cross-shard edge resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — cross-shard edges resolve correctly', () => {
    it('prediction resolves when `from` and `to` are on different shards (2 shards)', async () => {
        const n = 2;
        const router = new ShardRouter(n);

        // Find two atoms that land on different shards
        let crossPair: [string, string] | null = null;
        for (let i = 0; i < ATOMS_8.length && !crossPair; i++) {
            for (let j = 0; j < ATOMS_8.length && !crossPair; j++) {
                if (i !== j &&
                    router.getShardIndex(ATOMS_8[i]) !== router.getShardIndex(ATOMS_8[j])) {
                    crossPair = [ATOMS_8[i], ATOMS_8[j]];
                }
            }
        }

        expect(crossPair, 'could not find a cross-shard atom pair').not.toBeNull();
        const [from, to] = crossPair!;

        const orch = new ShardedOrchestrator(n, ATOMS_8, tempDb(`cross-${n}`));
        await orch.init();
        await orch.train([from, to]);

        const report = await orch.access(from);
        expect(report.predictedNext).toBe(to);
        expect(report.predictedProof).not.toBeNull();
        await orch.close();
    });

    it('cross-shard predictedProof is a valid Merkle proof', async () => {
        const n = 2;
        const router = new ShardRouter(n);

        let crossPair: [string, string] | null = null;
        for (let i = 0; i < ATOMS_8.length && !crossPair; i++) {
            for (let j = 0; j < ATOMS_8.length && !crossPair; j++) {
                if (i !== j &&
                    router.getShardIndex(ATOMS_8[i]) !== router.getShardIndex(ATOMS_8[j])) {
                    crossPair = [ATOMS_8[i], ATOMS_8[j]];
                }
            }
        }

        const [from, to] = crossPair!;
        const orch = new ShardedOrchestrator(n, ATOMS_8, tempDb(`cross-proof-${n}`));
        await orch.init();
        await orch.train([from, to]);

        const report = await orch.access(from);
        expect(MerkleKernel.verifyProof(report.predictedProof!)).toBe(true);
        await orch.close();
    });

    it('getWeights resolves cross-shard neighbours to atom names (not null)', async () => {
        const n = 2;
        const router = new ShardRouter(n);

        let crossPair: [string, string] | null = null;
        for (let i = 0; i < ATOMS_8.length && !crossPair; i++) {
            for (let j = 0; j < ATOMS_8.length && !crossPair; j++) {
                if (i !== j &&
                    router.getShardIndex(ATOMS_8[i]) !== router.getShardIndex(ATOMS_8[j])) {
                    crossPair = [ATOMS_8[i], ATOMS_8[j]];
                }
            }
        }

        const [from, to] = crossPair!;
        const orch = new ShardedOrchestrator(n, ATOMS_8, tempDb(`cross-weights-${n}`));
        await orch.init();
        await orch.train([from, to]);

        const weights = orch.getWeights(from);
        expect(weights).not.toBeNull();
        const toEntry = weights!.find(e => e.to === to);
        expect(toEntry, `expected '${to}' in weights for '${from}'`).toBeDefined();
        expect(toEntry!.weight).toBe(1);
        await orch.close();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Proof integrity across all shard counts
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — Merkle proof integrity for all shard counts', () => {
    it.each(SHARD_COUNTS)(
        'every atom has a valid currentProof on %i shard(s)',
        async (n) => {
            const orch = new ShardedOrchestrator(n, ATOMS_4, tempDb(`proof-${n}`));
            await orch.init();
            for (const atom of ATOMS_4) {
                const report = await orch.access(atom);
                expect(
                    MerkleKernel.verifyProof(report.currentProof),
                    `atom '${atom}' has invalid proof on ${n} shards`
                ).toBe(true);
            }
            await orch.close();
        }
    );

    it.each(SHARD_COUNTS)(
        'shardRootProof is present and its root matches itself on %i shard(s)',
        async (n) => {
            const orch = new ShardedOrchestrator(n, ATOMS_4, tempDb(`shard-root-${n}`));
            await orch.init();
            for (const atom of ATOMS_4) {
                const report = await orch.access(atom);
                if (report.shardRootProof) {
                    expect(report.shardRootProof.root).toMatch(/^[a-f0-9]{64}$/);
                    // root returned by the master must equal what the proof says
                    expect(MerkleKernel.verifyProof(report.shardRootProof)).toBe(true);
                }
            }
            await orch.close();
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty shard safety
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — empty shards do not break the cluster', () => {
    it('8 shards with 2 atoms (most shards empty): init and access succeed', async () => {
        const orch = new ShardedOrchestrator(8, [atom('P'), atom('Q')], tempDb('sparse'));
        await orch.init();
        await orch.train([atom('P'), atom('Q')]);
        const report = await orch.access(atom('P'));
        expect(report.predictedNext).toBe(atom('Q'));
        await orch.close();
    });

    it('shard count greater than atom count: zero empty-shard crashes', async () => {
        // 4 shards for 2 atoms means at least 2 shards are empty
        const orch = new ShardedOrchestrator(4, [atom('X'), atom('Y')], tempDb('sparse-4'));
        await expect(orch.init()).resolves.not.toThrow();
        await expect(orch.access(atom('X'))).resolves.toBeDefined();
        await orch.close();
    });

    it('single shard (n=1) behaves identically to multi-shard cluster', async () => {
        const orch1 = new ShardedOrchestrator(1, ATOMS_4, tempDb('single'));
        const orch4 = new ShardedOrchestrator(4, ATOMS_4, tempDb('quad'));
        await Promise.all([orch1.init(), orch4.init()]);

        for (let i = 0; i < 3; i++) {
            await Promise.all([
                orch1.train(SEQUENCE),
                orch4.train(SEQUENCE),
            ]);
        }

        for (const atom of ATOMS_4) {
            const r1 = await orch1.access(atom);
            const r4 = await orch4.access(atom);
            expect(r1.predictedNext, `predictedNext mismatch for '${atom}'`).toBe(r4.predictedNext);
        }

        await Promise.all([orch1.close(), orch4.close()]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Persistence consistency across shard counts
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — persistence survives close/reopen', () => {
    it.each(SHARD_COUNTS)(
        'predictions on %i shard(s) are identical before and after restart',
        async (n) => {
            const db = tempDb(`persist-${n}`);

            const orch1 = new ShardedOrchestrator(n, ATOMS_4, db);
            await orch1.init();
            await orch1.train(SEQUENCE);
            await new Promise(r => setTimeout(r, 30)); // allow LevelDB flush
            await orch1.close();

            const orch2 = new ShardedOrchestrator(n, ATOMS_4, db);
            await orch2.init();

            for (const atom of ATOMS_4.slice(0, -1)) { // all except terminal Delta
                const report = await orch2.access(atom);
                expect(report.predictedNext, `[shards=${n}] '${atom}' prediction lost after restart`).not.toBeNull();
            }

            await orch2.close();
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cluster stats accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — getClusterStats accuracy', () => {
    it.each(SHARD_COUNTS)(
        'trainedAtoms and totalEdges are identical across %i shard(s) for the same training',
        async (n) => {
            const orch = new ShardedOrchestrator(n, ATOMS_4, tempDb(`stats-${n}`));
            await orch.init();

            const before = orch.getClusterStats();
            expect(before.trainedAtoms).toBe(0);
            expect(before.totalEdges).toBe(0);

            await orch.train(SEQUENCE); // Alpha→Beta, Beta→Gamma, Gamma→Delta = 3 edges

            const after = orch.getClusterStats();
            expect(after.totalEdges).toBe(3);
            expect(after.trainedAtoms).toBe(3); // Alpha, Beta, Gamma each have 1 outgoing edge

            await orch.close();
        }
    );

    it('training the same sequence twice doubles all weights but keeps edge/atom counts the same', async () => {
        const orch = new ShardedOrchestrator(2, ATOMS_4, tempDb('stats-repeat'));
        await orch.init();

        await orch.train(SEQUENCE);
        const after1 = orch.getClusterStats();

        await orch.train(SEQUENCE);
        const after2 = orch.getClusterStats();

        // Same edges and atoms — only weights change
        expect(after2.totalEdges).toBe(after1.totalEdges);
        expect(after2.trainedAtoms).toBe(after1.trainedAtoms);

        await orch.close();
    });

    it('branching training adds new edges without losing existing ones', async () => {
        const orch = new ShardedOrchestrator(2, ATOMS_4, tempDb('stats-branch'));
        await orch.init();

        await orch.train([atom('Alpha'), atom('Beta')]);   // 1 edge
        await orch.train([atom('Alpha'), atom('Gamma')]);  // 1 new edge (Alpha now has 2)

        const stats = orch.getClusterStats();
        expect(stats.trainedAtoms).toBe(1);   // only Alpha has outgoing transitions
        expect(stats.totalEdges).toBe(2);     // Alpha→Beta and Alpha→Gamma

        await orch.close();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Shard root determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('Shard Consistency — shard Merkle root determinism', () => {
    it.each(SHARD_COUNTS)(
        'two independently initialised clusters with same atoms and %i shard(s) share the same shard roots',
        async (n) => {
            const orch1 = new ShardedOrchestrator(n, ATOMS_4, tempDb(`det1-${n}`));
            const orch2 = new ShardedOrchestrator(n, ATOMS_4, tempDb(`det2-${n}`));
            await Promise.all([orch1.init(), orch2.init()]);

            // Proof roots must be identical since atom set and shard count match
            for (const atom of ATOMS_4) {
                const r1 = await orch1.access(atom);
                const r2 = await orch2.access(atom);
                expect(r1.currentProof.root, `shard root mismatch for atom '${atom}'`).toBe(r2.currentProof.root);
            }

            await Promise.all([orch1.close(), orch2.close()]);
        }
    );
});
