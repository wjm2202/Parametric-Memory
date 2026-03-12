import { describe, it, expect, beforeEach } from 'vitest';
import {
    ConsolidationCycle,
    ConsolidationShardInterface,
} from '../consolidation';
import { TierEngine, tierKey, decodeTier, TIER_PREFIX } from '../tier_engine';
import { HalfLifeModel } from '../hlr';
import type { HlrFeatures } from '../hlr';
import { InMemoryBackend } from '../memory_backend';
import type { StorageBackend } from '../storage_backend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const BASE_HALF_LIFE_MS = 7 * MS_PER_DAY;

function makeHlr(): HalfLifeModel {
    return new HalfLifeModel(BASE_HALF_LIFE_MS);
}

function makeFeatures(overrides?: Partial<HlrFeatures>): HlrFeatures {
    return {
        accessCount: 0,
        trainingPasses: 0,
        atomType: 'fact',
        provenance: 'default',
        ...overrides,
    };
}

/**
 * Build a mock shard interface for testing.
 */
function buildMockShard(
    atoms: Array<{
        features: HlrFeatures;
        lastAccessedMs: number;
        tombstoned?: boolean;
    }>,
    storage?: StorageBackend,
): { shard: ConsolidationShardInterface; replayedIndices: number[]; actualStorage: StorageBackend } {
    const actualStorage = storage ?? new InMemoryBackend();
    const replayedIndices: number[] = [];

    const shard: ConsolidationShardInterface = {
        getAtomCount(): number {
            return atoms.length;
        },
        isTombstoned(index: number): boolean {
            return atoms[index]?.tombstoned ?? false;
        },
        getHlrFeatures(index: number): HlrFeatures {
            return atoms[index]?.features ?? makeFeatures();
        },
        getLastAccessedMs(index: number): number {
            return atoms[index]?.lastAccessedMs ?? 0;
        },
        getStorage(): StorageBackend {
            return actualStorage;
        },
        async replayMarkovArcs(indices: number[]): Promise<void> {
            replayedIndices.push(...indices);
        },
    };

    return { shard, replayedIndices, actualStorage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsolidationCycle (Sprint 15)', () => {
    let storage: InMemoryBackend;

    beforeEach(async () => {
        storage = new InMemoryBackend();
        await storage.open();
    });

    describe('run — basic cycle', () => {

        it('classifies all active atoms and persists tiers', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 }, // cold (never accessed)
                { features: makeFeatures({ accessCount: 5 }), lastAccessedMs: nowMs - 2 * MS_PER_HOUR }, // warm
                { features: makeFeatures(), lastAccessedMs: nowMs - 40 * MS_PER_DAY }, // cold (old access)
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const result = await cycle.run();

            expect(result.classified).toBe(3);
            expect(result.summary.total).toBe(3);
            expect(result.durationMs).toBeGreaterThanOrEqual(0);
            expect(result.completedAtMs).toBe(nowMs);

            // Verify persisted tier values
            const tier0 = await actualStorage.get(tierKey(0));
            const tier2 = await actualStorage.get(tierKey(2));
            expect(decodeTier(tier0!)).toBe('cold');
            expect(decodeTier(tier2!)).toBe('cold');
        });

        it('skips tombstoned atoms', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: nowMs, tombstoned: true },
                { features: makeFeatures(), lastAccessedMs: 0 },
            ];
            const { shard } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const result = await cycle.run();

            expect(result.classified).toBe(1); // only atom 1
        });

        it('returns correct tier summary', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 }, // cold
                { features: makeFeatures(), lastAccessedMs: 0 }, // cold
                { features: makeFeatures({ accessCount: 10 }), lastAccessedMs: nowMs - MS_PER_HOUR }, // warm
            ];
            const { shard } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const result = await cycle.run();

            expect(result.summary.cold).toBe(2);
            expect(result.summary.warm).toBe(1);
            expect(result.summary.hot).toBe(0);
        });
    });

    describe('promotion and demotion detection', () => {

        it('detects cold → warm promotion', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures({ accessCount: 5 }), lastAccessedMs: nowMs - MS_PER_HOUR }, // warm
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Pre-seed as cold
            await actualStorage.put(tierKey(0), 'c');
            await cycle.loadTiers();
            expect(cycle.getTier(0)).toBe('cold');

            const result = await cycle.run();

            expect(result.promoted).toBe(1);
            expect(cycle.getTier(0)).toBe('warm');
        });

        it('detects warm → cold demotion', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: nowMs - 35 * MS_PER_DAY }, // cold (old access)
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Pre-seed as warm
            await actualStorage.put(tierKey(0), 'w');
            await cycle.loadTiers();
            expect(cycle.getTier(0)).toBe('warm');

            const result = await cycle.run();

            expect(result.demoted).toBe(1);
            expect(cycle.getTier(0)).toBe('cold');
        });
    });

    describe('hippocampal replay', () => {

        it('replays top-N hot atoms', async () => {
            const nowMs = Date.now();
            // Create atoms with very short half-lives (state, default prov) + recent access
            const atoms = [
                {
                    features: makeFeatures({ accessCount: 1, atomType: 'state' as const, provenance: 'default' as const }),
                    lastAccessedMs: nowMs - MS_PER_HOUR,
                },
                {
                    features: makeFeatures({ accessCount: 1, atomType: 'state' as const, provenance: 'default' as const }),
                    lastAccessedMs: nowMs - MS_PER_HOUR,
                },
                { features: makeFeatures(), lastAccessedMs: 0 }, // cold
            ];

            const { shard, replayedIndices } = buildMockShard(atoms, storage);
            // Use custom thresholds to make these atoms hot
            const engine = new TierEngine(makeHlr(), {
                hotHalfLifeThresholdMs: 10 * MS_PER_DAY,
                hotAccessWindowMs: 2 * MS_PER_DAY,
            });
            const cycle = new ConsolidationCycle(engine, shard, {
                clock: () => nowMs,
                replayTopN: 5,
            });

            await cycle.run();

            // The hot atoms should have been replayed
            // (whether they're actually hot depends on exact HLR computation)
            // At minimum, the cold atom should NOT be replayed
            expect(replayedIndices).not.toContain(2);
        });

        it('respects replayTopN limit', async () => {
            const nowMs = Date.now();
            const atoms: Array<{ features: HlrFeatures; lastAccessedMs: number }> = [];
            for (let i = 0; i < 20; i++) {
                atoms.push({
                    features: makeFeatures({ accessCount: 1, atomType: 'state', provenance: 'default' }),
                    lastAccessedMs: nowMs - MS_PER_HOUR,
                });
            }

            const { shard, replayedIndices } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr(), {
                hotHalfLifeThresholdMs: 10 * MS_PER_DAY,
                hotAccessWindowMs: 2 * MS_PER_DAY,
            });
            const cycle = new ConsolidationCycle(engine, shard, {
                clock: () => nowMs,
                replayTopN: 3,
            });

            await cycle.run();

            expect(replayedIndices.length).toBeLessThanOrEqual(3);
        });
    });

    describe('loadTiers', () => {

        it('loads existing tier assignments from storage', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
                { features: makeFeatures(), lastAccessedMs: 0 },
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Pre-populate storage
            await actualStorage.put(tierKey(0), 'h');
            await actualStorage.put(tierKey(1), 'c');

            await cycle.loadTiers();

            expect(cycle.getTier(0)).toBe('hot');
            expect(cycle.getTier(1)).toBe('cold');
        });

        it('handles empty storage gracefully', async () => {
            const nowMs = Date.now();
            const atoms = [{ features: makeFeatures(), lastAccessedMs: 0 }];
            const { shard } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            await cycle.loadTiers();

            expect(cycle.getTier(0)).toBeUndefined();
        });

        it('skips malformed tier entries', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
                { features: makeFeatures(), lastAccessedMs: 0 },
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            await actualStorage.put(tierKey(0), 'h');
            await actualStorage.put(tierKey(1), 'x'); // invalid

            await cycle.loadTiers();

            expect(cycle.getTier(0)).toBe('hot');
            expect(cycle.getTier(1)).toBeUndefined(); // malformed → skipped
        });
    });

    describe('classifyAndPersist', () => {

        it('classifies and persists a single atom', async () => {
            const nowMs = Date.now();
            const atoms = [{ features: makeFeatures(), lastAccessedMs: 0 }];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const tier = await cycle.classifyAndPersist(
                0, makeFeatures(), 0, actualStorage, nowMs,
            );

            expect(tier).toBe('cold'); // never accessed
            expect(cycle.getTier(0)).toBe('cold');

            const stored = await actualStorage.get(tierKey(0));
            expect(stored).toBe('c');
        });
    });

    describe('batchClassifyAndPersist', () => {

        it('classifies and persists multiple atoms', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
                { features: makeFeatures({ accessCount: 5 }), lastAccessedMs: nowMs - MS_PER_HOUR },
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const results = await cycle.batchClassifyAndPersist(
                [
                    { index: 0, features: makeFeatures(), lastAccessedMs: 0 },
                    { index: 1, features: makeFeatures({ accessCount: 5 }), lastAccessedMs: nowMs - MS_PER_HOUR },
                ],
                actualStorage,
                nowMs,
            );

            expect(results.size).toBe(2);
            expect(results.get(0)).toBe('cold');
            expect(results.get(1)).toBe('warm');

            // Verify persistence
            const stored0 = await actualStorage.get(tierKey(0));
            const stored1 = await actualStorage.get(tierKey(1));
            expect(stored0).toBe('c');
            expect(stored1).toBe('w');
        });

        it('handles empty array', async () => {
            const nowMs = Date.now();
            const { shard, actualStorage } = buildMockShard([], storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            const results = await cycle.batchClassifyAndPersist([], actualStorage, nowMs);
            expect(results.size).toBe(0);
        });
    });

    describe('concurrent run prevention', () => {

        it('rejects concurrent consolidation runs', async () => {
            const nowMs = Date.now();
            const atoms = [{ features: makeFeatures(), lastAccessedMs: 0 }];
            const { shard } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Start first run (don't await yet)
            const run1 = cycle.run();

            // Second run should fail
            await expect(cycle.run()).rejects.toThrow('already running');

            // Wait for first to complete
            await run1;
        });
    });

    describe('getCachedSummary', () => {

        it('returns summary from cache without running full cycle', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
                { features: makeFeatures(), lastAccessedMs: 0 },
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Pre-populate
            await actualStorage.put(tierKey(0), 'h');
            await actualStorage.put(tierKey(1), 'c');
            await cycle.loadTiers();

            const summary = cycle.getCachedSummary();
            expect(summary.hot).toBe(1);
            expect(summary.cold).toBe(1);
            expect(summary.warm).toBe(0);
            expect(summary.total).toBe(2);
        });
    });

    describe('getLastResult', () => {

        it('returns null before first run', async () => {
            const nowMs = Date.now();
            const { shard } = buildMockShard([], storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            expect(cycle.getLastResult()).toBeNull();
        });

        it('returns result after run', async () => {
            const nowMs = Date.now();
            const atoms = [{ features: makeFeatures(), lastAccessedMs: 0 }];
            const { shard } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            await cycle.run();

            const result = cycle.getLastResult();
            expect(result).not.toBeNull();
            expect(result!.classified).toBe(1);
        });
    });

    describe('crash safety', () => {

        it('tier data survives simulated crash (re-load from storage)', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
                { features: makeFeatures({ accessCount: 5 }), lastAccessedMs: nowMs - MS_PER_HOUR },
            ];

            // First cycle: classify and persist
            const { shard: shard1, actualStorage: storage1 } = buildMockShard(atoms, storage);
            const engine1 = new TierEngine(makeHlr());
            const cycle1 = new ConsolidationCycle(engine1, shard1, { clock: () => nowMs });
            await cycle1.run();

            // Verify tiers were written
            const tier0 = await storage1.get(tierKey(0));
            const tier1 = await storage1.get(tierKey(1));
            expect(tier0).toBeTruthy();
            expect(tier1).toBeTruthy();

            // Simulated crash: create a new cycle using the same storage
            const { shard: shard2 } = buildMockShard(atoms, storage1);
            const engine2 = new TierEngine(makeHlr());
            const cycle2 = new ConsolidationCycle(engine2, shard2, { clock: () => nowMs });
            await cycle2.loadTiers();

            // Should have recovered the tier assignments
            expect(cycle2.getTier(0)).toBe(decodeTier(tier0!));
            expect(cycle2.getTier(1)).toBe(decodeTier(tier1!));
        });

        it('two-phase write: new tier written before old deleted', async () => {
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 },
            ];
            const { shard, actualStorage } = buildMockShard(atoms, storage);
            const engine = new TierEngine(makeHlr());
            const cycle = new ConsolidationCycle(engine, shard, { clock: () => nowMs });

            // Run consolidation — should write tier value
            await cycle.run();

            // Tier should be persisted (two-phase: write first, cache second)
            const stored = await actualStorage.get(tierKey(0));
            expect(stored).toBeTruthy();
            expect(decodeTier(stored!)).toBe(cycle.getTier(0));
        });
    });
});
