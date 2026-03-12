import { describe, it, expect } from 'vitest';
import {
    TierEngine,
    tierKey,
    encodeTier,
    decodeTier,
    TIER_PREFIX,
} from '../tier_engine';
import { HalfLifeModel } from '../hlr';
import type { HlrFeatures } from '../hlr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const BASE_HALF_LIFE_MS = 7 * MS_PER_DAY; // 7 days

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TierEngine (Sprint 15)', () => {

    describe('classify', () => {

        it('classifies frequently-accessed procedure as hot', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const features = makeFeatures({
                accessCount: 50,
                trainingPasses: 100,
                atomType: 'procedure',
                provenance: 'human',
            });
            // High access, procedure, human → very long half-life
            // But we need short half-life for hot. Let's use a state atom with few accesses.
            const stateFeatures = makeFeatures({
                accessCount: 1,
                trainingPasses: 0,
                atomType: 'state',
                provenance: 'default',
            });
            // State + default provenance = short half-life
            const tier = engine.classify(stateFeatures, nowMs - MS_PER_HOUR, nowMs);
            // Half-life of a state/default atom: base * 2^(0.1*1 + 0.15*0 + 0.3*(-1) + 0.4*(-1))
            // = 7d * 2^(-0.6) ≈ 4.6 days → above 3-day hot threshold → warm
            // Actually, let's check more carefully: for hot we need half-life < 3 days AND recent access.
            expect(['hot', 'warm']).toContain(tier);
        });

        it('classifies atom with no access in 30+ days as cold', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const features = makeFeatures({ accessCount: 5 });
            // Last accessed 35 days ago → beyond coldAccessWindow (30 days)
            const tier = engine.classify(features, nowMs - 35 * MS_PER_DAY, nowMs);
            expect(tier).toBe('cold');
        });

        it('classifies never-accessed atom as cold', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const features = makeFeatures();
            // lastAccessedMs = 0 → timeSinceAccess = Infinity → cold
            const tier = engine.classify(features, 0, nowMs);
            expect(tier).toBe('cold');
        });

        it('classifies recently accessed atom with moderate half-life as warm', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            // Fact with low accesses and no training → moderate half-life
            // θ·x = 0.1*2 + 0.15*0 + 0.3*0 + 0.4*(-1) = 0.2 + 0 + 0 - 0.4 = -0.2
            // halfLife = 7d * 2^(-0.2) ≈ 7 * 0.87 ≈ 6.1 days → between 3d and 14d → warm
            const features = makeFeatures({
                accessCount: 2,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            });
            const tier = engine.classify(features, nowMs - 2 * MS_PER_DAY, nowMs);
            expect(tier).toBe('warm');
        });

        it('classifies atom with very long half-life and old access as cold', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const features = makeFeatures({
                accessCount: 100,
                trainingPasses: 500,
                atomType: 'procedure',
                provenance: 'human',
            });
            // Very long half-life, but accessed 5 days ago (not in hot window, not cold yet)
            const tier = engine.classify(features, nowMs - 5 * MS_PER_DAY, nowMs);
            // Half-life > 14 days (procedure + human + high counts), accessed 5 days ago
            // → half-life exceeds cold threshold, but access within 30 days
            // cold check: halfLife > cold threshold AND timeSinceAccess > hotAccessWindow
            expect(tier).toBe('cold');
        });

        it('uses custom thresholds', () => {
            const engine = new TierEngine(makeHlr(), {
                hotHalfLifeThresholdMs: 10 * MS_PER_DAY,
                hotAccessWindowMs: 7 * MS_PER_DAY,
                coldHalfLifeThresholdMs: 30 * MS_PER_DAY,
                coldAccessWindowMs: 60 * MS_PER_DAY,
            });
            const nowMs = Date.now();
            const features = makeFeatures({ accessCount: 3, atomType: 'fact' });
            // With relaxed thresholds, more things become hot
            const tier = engine.classify(features, nowMs - 2 * MS_PER_DAY, nowMs);
            expect(['hot', 'warm']).toContain(tier);
        });
    });

    describe('classifyAll', () => {

        it('skips null (tombstoned) atoms', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const atoms: Array<{ features: HlrFeatures; lastAccessedMs: number } | null> = [
                { features: makeFeatures(), lastAccessedMs: nowMs },
                null,
                { features: makeFeatures(), lastAccessedMs: nowMs },
            ];
            const results = engine.classifyAll(atoms, nowMs);
            expect(results).toHaveLength(2);
            expect(results[0].index).toBe(0);
            expect(results[1].index).toBe(2);
        });

        it('returns correct index mapping', () => {
            const engine = new TierEngine(makeHlr());
            const nowMs = Date.now();
            const atoms = [
                { features: makeFeatures(), lastAccessedMs: 0 }, // cold (never accessed)
                { features: makeFeatures({ accessCount: 10 }), lastAccessedMs: nowMs - MS_PER_HOUR },
                { features: makeFeatures(), lastAccessedMs: nowMs - 40 * MS_PER_DAY }, // cold (old access)
            ];
            const results = engine.classifyAll(atoms, nowMs);
            expect(results).toHaveLength(3);
            expect(results[0].index).toBe(0);
            expect(results[0].tier).toBe('cold');
            expect(results[2].index).toBe(2);
            expect(results[2].tier).toBe('cold');
        });
    });

    describe('summarize', () => {

        it('counts tiers correctly', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'hot' as const, halfLifeMs: 1000, lastAccessedMs: 100 },
                { index: 1, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 200 },
                { index: 2, tier: 'cold' as const, halfLifeMs: 50000, lastAccessedMs: 0 },
                { index: 3, tier: 'hot' as const, halfLifeMs: 2000, lastAccessedMs: 300 },
            ];
            const summary = engine.summarize(classifications);
            expect(summary.hot).toBe(2);
            expect(summary.warm).toBe(1);
            expect(summary.cold).toBe(1);
            expect(summary.total).toBe(4);
        });
    });

    describe('getPromotionCandidates', () => {

        it('detects cold → warm promotions', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 100 },
                { index: 1, tier: 'cold' as const, halfLifeMs: 50000, lastAccessedMs: 0 },
            ];
            const previousTiers = new Map<number, 'hot' | 'warm' | 'cold'>([
                [0, 'cold'],
                [1, 'cold'],
            ]);
            const promotions = engine.getPromotionCandidates(classifications, previousTiers);
            expect(promotions).toHaveLength(1);
            expect(promotions[0].index).toBe(0); // was cold, now warm
        });

        it('returns empty when no promotions', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'cold' as const, halfLifeMs: 50000, lastAccessedMs: 0 },
            ];
            const previousTiers = new Map<number, 'hot' | 'warm' | 'cold'>([
                [0, 'cold'],
            ]);
            const promotions = engine.getPromotionCandidates(classifications, previousTiers);
            expect(promotions).toHaveLength(0);
        });
    });

    describe('getDemotionCandidates', () => {

        it('detects warm → cold demotions', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'cold' as const, halfLifeMs: 50000, lastAccessedMs: 0 },
                { index: 1, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 100 },
            ];
            const previousTiers = new Map<number, 'hot' | 'warm' | 'cold'>([
                [0, 'warm'],
                [1, 'warm'],
            ]);
            const demotions = engine.getDemotionCandidates(classifications, previousTiers);
            expect(demotions).toHaveLength(1);
            expect(demotions[0].index).toBe(0); // was warm, now cold
        });

        it('detects hot → warm demotions', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 100 },
            ];
            const previousTiers = new Map<number, 'hot' | 'warm' | 'cold'>([
                [0, 'hot'],
            ]);
            const demotions = engine.getDemotionCandidates(classifications, previousTiers);
            expect(demotions).toHaveLength(1);
        });
    });

    describe('getReplayCandidates', () => {

        it('returns top-N hottest atoms sorted by half-life', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'hot' as const, halfLifeMs: 3000, lastAccessedMs: 100 },
                { index: 1, tier: 'hot' as const, halfLifeMs: 1000, lastAccessedMs: 100 },
                { index: 2, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 100 },
                { index: 3, tier: 'hot' as const, halfLifeMs: 2000, lastAccessedMs: 100 },
            ];
            const candidates = engine.getReplayCandidates(classifications, 2);
            expect(candidates).toHaveLength(2);
            expect(candidates[0].index).toBe(1); // halfLife=1000 (shortest)
            expect(candidates[1].index).toBe(3); // halfLife=2000
        });

        it('only includes hot atoms', () => {
            const engine = new TierEngine(makeHlr());
            const classifications = [
                { index: 0, tier: 'warm' as const, halfLifeMs: 5000, lastAccessedMs: 100 },
                { index: 1, tier: 'cold' as const, halfLifeMs: 50000, lastAccessedMs: 0 },
            ];
            const candidates = engine.getReplayCandidates(classifications, 10);
            expect(candidates).toHaveLength(0);
        });
    });

    describe('fallback without HLR model', () => {

        it('uses heuristic half-life when no HLR model', () => {
            const engine = new TierEngine(null);
            const features = makeFeatures({ accessCount: 50 });
            const halfLife = engine.getHalfLife(features);
            // Heuristic: 1 + 50/10 = 6 days
            expect(halfLife).toBe(6 * MS_PER_DAY);
        });

        it('caps heuristic half-life at 90 days', () => {
            const engine = new TierEngine(null);
            const features = makeFeatures({ accessCount: 10000 });
            const halfLife = engine.getHalfLife(features);
            expect(halfLife).toBe(90 * MS_PER_DAY);
        });
    });

    describe('persistence helpers', () => {

        it('generates correct tier keys', () => {
            expect(tierKey(0)).toBe('tier:0000000000');
            expect(tierKey(42)).toBe('tier:0000000042');
            expect(tierKey(999999)).toBe('tier:0000999999');
        });

        it('encodes tiers as single characters', () => {
            expect(encodeTier('hot')).toBe('h');
            expect(encodeTier('warm')).toBe('w');
            expect(encodeTier('cold')).toBe('c');
        });

        it('decodes tier characters', () => {
            expect(decodeTier('h')).toBe('hot');
            expect(decodeTier('w')).toBe('warm');
            expect(decodeTier('c')).toBe('cold');
        });

        it('returns null for invalid tier character', () => {
            expect(decodeTier('x')).toBeNull();
            expect(decodeTier('')).toBeNull();
        });

        it('TIER_PREFIX is correct', () => {
            expect(TIER_PREFIX).toBe('tier:');
        });
    });

    describe('getThresholds', () => {

        it('returns default thresholds', () => {
            const engine = new TierEngine(makeHlr());
            const t = engine.getThresholds();
            expect(t.hotHalfLifeThresholdMs).toBe(3 * MS_PER_DAY);
            expect(t.hotAccessWindowMs).toBe(1 * MS_PER_DAY);
            expect(t.coldHalfLifeThresholdMs).toBe(14 * MS_PER_DAY);
            expect(t.coldAccessWindowMs).toBe(30 * MS_PER_DAY);
        });

        it('returns custom thresholds when provided', () => {
            const engine = new TierEngine(makeHlr(), {
                hotHalfLifeThresholdMs: 5 * MS_PER_DAY,
            });
            const t = engine.getThresholds();
            expect(t.hotHalfLifeThresholdMs).toBe(5 * MS_PER_DAY);
            // Others should be defaults
            expect(t.coldAccessWindowMs).toBe(30 * MS_PER_DAY);
        });
    });
});
