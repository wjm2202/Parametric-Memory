/**
 * Consolidation Cycle — Sprint 15.3
 *
 * Background process inspired by hippocampal consolidation (sleep replay).
 * Runs periodically to:
 *   1. Reclassify all atoms by current HLR features
 *   2. Promote cold → warm if recently accessed
 *   3. Demote warm → cold if stale
 *   4. "Replay" top-N hot atoms by re-training their Markov arcs
 *      (hippocampal replay analogy — strengthens important memories)
 *
 * The consolidation cycle does NOT move atoms between storage backends.
 * It updates tier metadata and performs hippocampal replay training.
 *
 * Two-phase safety for tier transitions:
 *   - Write new tier FIRST, then delete old tier (if applicable)
 *   - A crash between write and delete produces a harmless duplicate
 *     (cleaned up on next consolidation)
 *
 * Configuration:
 *   MMPM_CONSOLIDATION_INTERVAL_MS — cycle interval (default: 3600000 = 1 hour)
 *   MMPM_CONSOLIDATION_REPLAY_TOP_N — number of hot atoms to replay (default: 10)
 *   MMPM_CONSOLIDATION_ENABLED — '0' to disable (default: '1')
 */

import type { StorageBackend } from './storage_backend';
import type { HlrFeatures } from './hlr';
import {
    TierEngine,
    TierClassification,
    TierSummary,
    Tier,
    tierKey,
    encodeTier,
    decodeTier,
    TIER_PREFIX,
} from './tier_engine';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ConsolidationOptions {
    /** Interval between consolidation cycles in ms. Default: 3600000 (1 hour). */
    intervalMs?: number;
    /** Number of hot atoms to replay per cycle. Default: 10. */
    replayTopN?: number;
    /** Clock function returning epoch ms. */
    clock?: () => number;
}

export interface ConsolidationResult {
    /** Total atoms classified. */
    classified: number;
    /** Atoms promoted (cold → warm or warm → hot). */
    promoted: number;
    /** Atoms demoted (hot → warm or warm → cold). */
    demoted: number;
    /** Atoms replayed (hippocampal replay — Markov arcs re-trained). */
    replayed: number;
    /** Tier summary after consolidation. */
    summary: TierSummary;
    /** Duration of the consolidation cycle in ms. */
    durationMs: number;
    /** Timestamp when consolidation completed. */
    completedAtMs: number;
}

/**
 * Interface for the shard worker methods needed by consolidation.
 * This avoids a circular dependency — consolidation only depends on this interface,
 * not on the full ShardWorker class.
 */
export interface ConsolidationShardInterface {
    /** Get total atom count (including tombstoned). */
    getAtomCount(): number;
    /** Check if an atom index is tombstoned. */
    isTombstoned(index: number): boolean;
    /** Get HLR features for an atom index. */
    getHlrFeatures(index: number): HlrFeatures;
    /** Get the last access timestamp for an atom index. */
    getLastAccessedMs(index: number): number;
    /** Get the storage backend for tier metadata persistence. */
    getStorage(): StorageBackend;
    /**
     * Replay Markov arcs for a set of atom indices.
     * The consolidation cycle calls this to re-train transitions for hot atoms.
     * Implementation should re-train outgoing edges for each atom.
     */
    replayMarkovArcs(indices: number[]): Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────────────────

export class ConsolidationCycle {
    private readonly engine: TierEngine;
    private readonly shard: ConsolidationShardInterface;
    private readonly replayTopN: number;
    private readonly clock: () => number;

    /** In-memory cache of current tier assignments. */
    private tierCache: Map<number, Tier> = new Map();
    /** Last consolidation result for diagnostics. */
    private lastResult: ConsolidationResult | null = null;
    /** Whether a consolidation is currently running. */
    private running = false;

    constructor(
        engine: TierEngine,
        shard: ConsolidationShardInterface,
        options?: ConsolidationOptions,
    ) {
        this.engine = engine;
        this.shard = shard;
        this.replayTopN = options?.replayTopN ?? 10;
        this.clock = options?.clock ?? (() => Date.now());
    }

    /**
     * Load existing tier assignments from storage.
     * Called during shard init to warm the tier cache.
     */
    async loadTiers(): Promise<void> {
        const storage = this.shard.getStorage();
        this.tierCache.clear();

        for await (const [key, value] of storage.iterator({ gte: `${TIER_PREFIX}`, lte: `${TIER_PREFIX}~` })) {
            const idxStr = key.slice(TIER_PREFIX.length);
            const idx = parseInt(idxStr, 10);
            const tier = decodeTier(value);
            if (Number.isFinite(idx) && tier !== null) {
                this.tierCache.set(idx, tier);
            }
        }
    }

    /**
     * Run a full consolidation cycle.
     *
     * Steps:
     *   1. Build atom feature vectors
     *   2. Classify all atoms
     *   3. Detect promotions and demotions
     *   4. Persist tier changes (two-phase: write new → delete old)
     *   5. Hippocampal replay for top-N hot atoms
     *   6. Update in-memory tier cache
     */
    async run(): Promise<ConsolidationResult> {
        if (this.running) {
            throw new Error('Consolidation cycle already running');
        }
        this.running = true;
        const startMs = this.clock();

        try {
            const nowMs = this.clock();
            const atomCount = this.shard.getAtomCount();
            const storage = this.shard.getStorage();

            // ── 1. Build atom features ────────────────────────────────────
            const atomData: Array<{ features: HlrFeatures; lastAccessedMs: number } | null> = [];
            for (let i = 0; i < atomCount; i++) {
                if (this.shard.isTombstoned(i)) {
                    atomData.push(null);
                    continue;
                }
                atomData.push({
                    features: this.shard.getHlrFeatures(i),
                    lastAccessedMs: this.shard.getLastAccessedMs(i),
                });
            }

            // ── 2. Classify all atoms ─────────────────────────────────────
            const classifications = this.engine.classifyAll(atomData, nowMs);
            const summary = this.engine.summarize(classifications);

            // ── 3. Detect promotions and demotions ─────────────────────────
            const promotions = this.engine.getPromotionCandidates(classifications, this.tierCache);
            const demotions = this.engine.getDemotionCandidates(classifications, this.tierCache);

            // ── 4. Persist tier changes (two-phase) ────────────────────────
            // Write all new tier values in a single batch for efficiency.
            // This is safe because:
            //   - Writing a new tier value is idempotent
            //   - If we crash after writing but before updating the cache,
            //     the next consolidation will re-classify correctly
            let batch = storage.batch();
            for (const c of classifications) {
                batch = batch.put(tierKey(c.index), encodeTier(c.tier));
            }
            await batch.write();

            // ── 5. Hippocampal replay for top-N hot atoms ──────────────────
            const replayCandidates = this.engine.getReplayCandidates(classifications, this.replayTopN);
            const replayIndices = replayCandidates.map(c => c.index);
            if (replayIndices.length > 0) {
                await this.shard.replayMarkovArcs(replayIndices);
            }

            // ── 6. Update in-memory tier cache ─────────────────────────────
            this.tierCache.clear();
            for (const c of classifications) {
                this.tierCache.set(c.index, c.tier);
            }

            const durationMs = this.clock() - startMs;

            const result: ConsolidationResult = {
                classified: classifications.length,
                promoted: promotions.length,
                demoted: demotions.length,
                replayed: replayIndices.length,
                summary,
                durationMs,
                completedAtMs: this.clock(),
            };

            this.lastResult = result;

            logger.info(
                {
                    classified: result.classified,
                    promoted: result.promoted,
                    demoted: result.demoted,
                    replayed: result.replayed,
                    hot: summary.hot,
                    warm: summary.warm,
                    cold: summary.cold,
                    durationMs: result.durationMs,
                },
                'Consolidation cycle complete',
            );

            return result;
        } finally {
            this.running = false;
        }
    }

    /**
     * Classify a single atom and persist immediately.
     * Called during commit for newly added or modified atoms.
     */
    async classifyAndPersist(
        index: number,
        features: HlrFeatures,
        lastAccessedMs: number,
        storage: StorageBackend,
        nowMs: number,
    ): Promise<Tier> {
        const tier = this.engine.classify(features, lastAccessedMs, nowMs);
        await storage.put(tierKey(index), encodeTier(tier));
        this.tierCache.set(index, tier);
        return tier;
    }

    /**
     * Batch classify and persist multiple atoms.
     * More efficient than calling classifyAndPersist in a loop.
     */
    async batchClassifyAndPersist(
        atoms: Array<{ index: number; features: HlrFeatures; lastAccessedMs: number }>,
        storage: StorageBackend,
        nowMs: number,
    ): Promise<Map<number, Tier>> {
        const results = new Map<number, Tier>();
        if (atoms.length === 0) return results;

        let batch = storage.batch();
        for (const { index, features, lastAccessedMs } of atoms) {
            const tier = this.engine.classify(features, lastAccessedMs, nowMs);
            batch = batch.put(tierKey(index), encodeTier(tier));
            this.tierCache.set(index, tier);
            results.set(index, tier);
        }
        await batch.write();
        return results;
    }

    /** Get the current tier for an atom index. */
    getTier(index: number): Tier | undefined {
        return this.tierCache.get(index);
    }

    /** Get all current tier assignments. */
    getAllTiers(): ReadonlyMap<number, Tier> {
        return this.tierCache;
    }

    /** Get the last consolidation result. */
    getLastResult(): ConsolidationResult | null {
        return this.lastResult;
    }

    /** Check if a consolidation is currently running. */
    isRunning(): boolean {
        return this.running;
    }

    /** Get tier summary from the cache without running a full cycle. */
    getCachedSummary(): TierSummary {
        const summary: TierSummary = { hot: 0, warm: 0, cold: 0, total: 0 };
        for (const tier of this.tierCache.values()) {
            summary[tier]++;
            summary.total++;
        }
        return summary;
    }
}

/**
 * Parse consolidation options from environment variables.
 */
export function parseConsolidationOptionsFromEnv(): ConsolidationOptions {
    const intervalMs = parseInt(process.env.MMPM_CONSOLIDATION_INTERVAL_MS ?? '', 10);
    const replayTopN = parseInt(process.env.MMPM_CONSOLIDATION_REPLAY_TOP_N ?? '', 10);
    return {
        intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
        replayTopN: Number.isFinite(replayTopN) && replayTopN > 0 ? replayTopN : undefined,
    };
}
