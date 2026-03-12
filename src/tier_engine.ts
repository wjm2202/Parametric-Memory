/**
 * Tier Classification Engine — Sprint 15
 *
 * Classifies atoms into Hot/Warm/Cold storage tiers based on HLR half-life
 * and access recency, inspired by hippocampal consolidation in the brain.
 *
 * Tier definitions:
 *   Hot:  Recently accessed (within hotAccessWindowMs) AND half-life < hotHalfLifeThresholdMs
 *   Warm: Half-life between hot and cold thresholds
 *   Cold: Half-life > coldHalfLifeThresholdMs OR no access in coldAccessWindowMs
 *
 * Classification runs during commit.  Tier metadata is persisted to LevelDB
 * under the `tier:<pad10>` prefix storing 'h', 'w', or 'c'.
 *
 * The tier classification does NOT move atoms between storage backends.
 * All atoms remain in the same LevelDB instance.  Tier metadata is used by
 * the consolidation cycle (Sprint 15.3) to prioritise hippocampal replay
 * and identify candidates for demotion.
 */

import type { HlrFeatures } from './hlr';
import { HalfLifeModel } from './hlr';

// ─── Types ──────────────────────────────────────────────────────────────

export type Tier = 'hot' | 'warm' | 'cold';

export interface TierClassification {
    index: number;
    tier: Tier;
    halfLifeMs: number;
    lastAccessedMs: number;
}

export interface TierThresholds {
    /** Half-life below this → eligible for hot (also needs recent access). Default: 3 days. */
    hotHalfLifeThresholdMs?: number;
    /** Accessed within this window → eligible for hot. Default: 24 hours. */
    hotAccessWindowMs?: number;
    /** Half-life above this → cold. Default: 14 days. */
    coldHalfLifeThresholdMs?: number;
    /** No access within this window → cold regardless of half-life. Default: 30 days. */
    coldAccessWindowMs?: number;
}

export interface TierSummary {
    hot: number;
    warm: number;
    cold: number;
    total: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_THRESHOLDS: Required<TierThresholds> = {
    hotHalfLifeThresholdMs: 3 * MS_PER_DAY,
    hotAccessWindowMs: 1 * MS_PER_DAY,
    coldHalfLifeThresholdMs: 14 * MS_PER_DAY,
    coldAccessWindowMs: 30 * MS_PER_DAY,
};

export const TIER_PREFIX = 'tier:';
const PAD_LEN = 10;

// ─── Engine ─────────────────────────────────────────────────────────────

export class TierEngine {
    private readonly thresholds: Required<TierThresholds>;
    private readonly hlrModel: HalfLifeModel | null;

    constructor(hlrModel: HalfLifeModel | null, thresholds?: TierThresholds) {
        this.hlrModel = hlrModel;
        this.thresholds = {
            ...DEFAULT_THRESHOLDS,
            ...thresholds,
        };
    }

    /**
     * Classify a single atom into a tier.
     *
     * @param features       HLR features for half-life computation
     * @param lastAccessedMs Epoch ms of last access (0 if never accessed)
     * @param nowMs          Current time in epoch ms
     */
    classify(features: HlrFeatures, lastAccessedMs: number, nowMs: number): Tier {
        const halfLifeMs = this.getHalfLife(features);
        const timeSinceAccess = lastAccessedMs > 0 ? nowMs - lastAccessedMs : Infinity;

        // Cold: no access in coldAccessWindowMs OR half-life exceeds cold threshold
        if (timeSinceAccess > this.thresholds.coldAccessWindowMs) {
            return 'cold';
        }
        if (halfLifeMs > this.thresholds.coldHalfLifeThresholdMs && timeSinceAccess > this.thresholds.hotAccessWindowMs) {
            return 'cold';
        }

        // Hot: recently accessed AND short half-life
        if (halfLifeMs < this.thresholds.hotHalfLifeThresholdMs &&
            timeSinceAccess <= this.thresholds.hotAccessWindowMs) {
            return 'hot';
        }

        // Everything else is warm
        return 'warm';
    }

    /**
     * Classify all atoms in a shard.
     *
     * @param atoms Array of { features, lastAccessedMs } for each atom index.
     *              Tombstoned atoms should be excluded (pass null).
     * @param nowMs Current time in epoch ms
     */
    classifyAll(
        atoms: Array<{ features: HlrFeatures; lastAccessedMs: number } | null>,
        nowMs: number,
    ): TierClassification[] {
        const results: TierClassification[] = [];

        for (let i = 0; i < atoms.length; i++) {
            const atom = atoms[i];
            if (atom === null) continue; // tombstoned — skip

            const halfLifeMs = this.getHalfLife(atom.features);
            const tier = this.classify(atom.features, atom.lastAccessedMs, nowMs);

            results.push({
                index: i,
                tier,
                halfLifeMs,
                lastAccessedMs: atom.lastAccessedMs,
            });
        }

        return results;
    }

    /**
     * Compute tier summary counts from classifications.
     */
    summarize(classifications: TierClassification[]): TierSummary {
        const summary: TierSummary = { hot: 0, warm: 0, cold: 0, total: 0 };
        for (const c of classifications) {
            summary[c.tier]++;
            summary.total++;
        }
        return summary;
    }

    /**
     * Get atoms that should be promoted (cold → warm) due to recent access.
     * An atom should be promoted if it was classified cold but has been
     * accessed within the hot access window recently.
     */
    getPromotionCandidates(
        classifications: TierClassification[],
        previousTiers: Map<number, Tier>,
    ): TierClassification[] {
        return classifications.filter(c => {
            const prev = previousTiers.get(c.index);
            return prev === 'cold' && c.tier !== 'cold';
        });
    }

    /**
     * Get atoms that should be demoted (warm → cold or hot → warm/cold).
     */
    getDemotionCandidates(
        classifications: TierClassification[],
        previousTiers: Map<number, Tier>,
    ): TierClassification[] {
        const tierRank: Record<Tier, number> = { hot: 2, warm: 1, cold: 0 };
        return classifications.filter(c => {
            const prev = previousTiers.get(c.index);
            if (prev === undefined) return false;
            return tierRank[c.tier] < tierRank[prev];
        });
    }

    /**
     * Get the top-N hottest atoms by half-life (shortest half-life = most active).
     * Used for hippocampal replay — these atoms get their Markov arcs re-trained.
     */
    getReplayCandidates(classifications: TierClassification[], topN: number): TierClassification[] {
        const hot = classifications.filter(c => c.tier === 'hot');
        hot.sort((a, b) => a.halfLifeMs - b.halfLifeMs); // shortest half-life first
        return hot.slice(0, topN);
    }

    /**
     * Compute half-life for an atom.  Falls back to base half-life if no HLR model.
     */
    getHalfLife(features: HlrFeatures): number {
        if (this.hlrModel) {
            return this.hlrModel.getHalfLife(features);
        }
        // No HLR model — use a heuristic based on access count
        // More accesses = longer half-life (1 day base, +1 day per 10 accesses, capped at 90 days)
        const baseDays = 1 + features.accessCount / 10;
        return Math.min(baseDays * MS_PER_DAY, 90 * MS_PER_DAY);
    }

    /** Expose thresholds for diagnostics. */
    getThresholds(): Readonly<Required<TierThresholds>> {
        return { ...this.thresholds };
    }
}

// ─── Persistence helpers ────────────────────────────────────────────────

/** Generate the LevelDB key for a tier entry. */
export function tierKey(index: number): string {
    return `${TIER_PREFIX}${String(index).padStart(PAD_LEN, '0')}`;
}

/** Encode a tier as a single character for storage. */
export function encodeTier(tier: Tier): string {
    return tier[0]; // 'h', 'w', 'c'
}

/** Decode a stored tier character back to a Tier. */
export function decodeTier(stored: string): Tier | null {
    switch (stored) {
        case 'h': return 'hot';
        case 'w': return 'warm';
        case 'c': return 'cold';
        default: return null;
    }
}

/**
 * Parse tier thresholds from environment variables.
 *
 * Env vars:
 *   MMPM_TIER_HOT_HALF_LIFE_MS    — default: 259200000 (3 days)
 *   MMPM_TIER_HOT_ACCESS_WINDOW_MS — default: 86400000 (24h)
 *   MMPM_TIER_COLD_HALF_LIFE_MS   — default: 1209600000 (14 days)
 *   MMPM_TIER_COLD_ACCESS_WINDOW_MS — default: 2592000000 (30 days)
 */
export function parseThresholdsFromEnv(): TierThresholds {
    const result: TierThresholds = {};
    const parse = (envVar: string): number | undefined => {
        const raw = process.env[envVar];
        if (!raw) return undefined;
        const num = parseInt(raw, 10);
        return Number.isFinite(num) && num > 0 ? num : undefined;
    };
    result.hotHalfLifeThresholdMs = parse('MMPM_TIER_HOT_HALF_LIFE_MS');
    result.hotAccessWindowMs = parse('MMPM_TIER_HOT_ACCESS_WINDOW_MS');
    result.coldHalfLifeThresholdMs = parse('MMPM_TIER_COLD_HALF_LIFE_MS');
    result.coldAccessWindowMs = parse('MMPM_TIER_COLD_ACCESS_WINDOW_MS');
    return result;
}
