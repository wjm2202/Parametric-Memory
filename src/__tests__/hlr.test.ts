import { describe, it, expect } from 'vitest';
import { HalfLifeModel, extractProvenance, parseThetaFromEnv, HlrFeatures } from '../hlr';

// Default base half-life: 7 days in ms
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('HalfLifeModel', () => {
    describe('correction persistence — human corrections should have long half-lives', () => {
        it('well-trained human procedure has ≥3× base half-life', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const features: HlrFeatures = {
                accessCount: 5,
                trainingPasses: 3,
                atomType: 'procedure',
                provenance: 'human',
            };
            const hl = model.getHalfLife(features);
            // With θ = [0.1, 0.15, 0.3, 0.4]:
            // dot = 0.1*5 + 0.15*3 + 0.3*1 + 0.4*1 = 0.5 + 0.45 + 0.3 + 0.4 = 1.65
            // h = base * 2^1.65 ≈ base * 3.14
            expect(hl).toBeGreaterThan(SEVEN_DAYS_MS * 3);
        });
    });

    describe('speculative decay — unused atoms should decay at or below base rate', () => {
        it('untouched default atom has base-rate half-life', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const features: HlrFeatures = {
                accessCount: 0,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            };
            const hl = model.getHalfLife(features);
            // dot = 0.1*0 + 0.15*0 + 0.3*0 + 0.4*(-1) = -0.4
            // h = base * 2^(-0.4) ≈ base * 0.758
            // Untouched default atoms decay FASTER than base
            expect(hl).toBeLessThan(SEVEN_DAYS_MS);
        });

        it('after 7 days, untouched atom has < 50% effective weight', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const features: HlrFeatures = {
                accessCount: 0,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            };
            const effectiveWeight = model.computeEffectiveWeight(3, SEVEN_DAYS_MS, features);
            // Since hl < 7 days for this atom, after 7 days it should be well below 50%
            expect(effectiveWeight).toBeLessThan(3 * 0.5);
        });
    });

    describe('type stratification — procedure > fact > state', () => {
        it('procedure has longest half-life, state has shortest (same access/training)', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const base = { accessCount: 2, trainingPasses: 1, provenance: 'default' as const };

            const procHl = model.getHalfLife({ ...base, atomType: 'procedure' });
            const factHl = model.getHalfLife({ ...base, atomType: 'fact' });
            const stateHl = model.getHalfLife({ ...base, atomType: 'state' });

            expect(procHl).toBeGreaterThan(factHl);
            expect(factHl).toBeGreaterThan(stateHl);
        });
    });

    describe('feature independence', () => {
        it('incrementing accessCount increases half-life', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const base: HlrFeatures = {
                accessCount: 0,
                trainingPasses: 1,
                atomType: 'fact',
                provenance: 'default',
            };
            const hl0 = model.getHalfLife({ ...base, accessCount: 0 });
            const hl5 = model.getHalfLife({ ...base, accessCount: 5 });
            expect(hl5).toBeGreaterThan(hl0);
        });

        it('incrementing trainingPasses increases half-life', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const base: HlrFeatures = {
                accessCount: 2,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            };
            const hl0 = model.getHalfLife({ ...base, trainingPasses: 0 });
            const hl5 = model.getHalfLife({ ...base, trainingPasses: 5 });
            expect(hl5).toBeGreaterThan(hl0);
        });

        it('human provenance gives longer half-life than default', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const base: HlrFeatures = {
                accessCount: 1,
                trainingPasses: 1,
                atomType: 'fact',
                provenance: 'default',
            };
            const hlDefault = model.getHalfLife({ ...base, provenance: 'default' });
            const hlHuman = model.getHalfLife({ ...base, provenance: 'human' });
            expect(hlHuman).toBeGreaterThan(hlDefault);
        });
    });

    describe('max half-life clamp', () => {
        it('extremely high features are clamped to max', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS, undefined, 30 * 24 * 60 * 60 * 1000); // 30 day max
            const features: HlrFeatures = {
                accessCount: 100,
                trainingPasses: 100,
                atomType: 'procedure',
                provenance: 'human',
            };
            const hl = model.getHalfLife(features);
            expect(hl).toBe(30 * 24 * 60 * 60 * 1000);
        });
    });

    describe('computeEffectiveWeight', () => {
        it('returns rawWeight when elapsedMs is 0', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const features: HlrFeatures = {
                accessCount: 0,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            };
            expect(model.computeEffectiveWeight(10, 0, features)).toBe(10);
        });

        it('returns ~half rawWeight at exactly one half-life', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS);
            const features: HlrFeatures = {
                accessCount: 0,
                trainingPasses: 0,
                atomType: 'fact',
                provenance: 'default',
            };
            const hl = model.getHalfLife(features);
            const ew = model.computeEffectiveWeight(10, hl, features);
            expect(ew).toBeCloseTo(5, 1); // 10 * 0.5^1 = 5
        });
    });

    describe('custom theta', () => {
        it('zeroed theta gives base half-life for all atoms', () => {
            const model = new HalfLifeModel(SEVEN_DAYS_MS, { access: 0, training: 0, type: 0, provenance: 0 });
            const featuresA: HlrFeatures = {
                accessCount: 100, trainingPasses: 50, atomType: 'procedure', provenance: 'human',
            };
            const featuresB: HlrFeatures = {
                accessCount: 0, trainingPasses: 0, atomType: 'state', provenance: 'default',
            };
            expect(model.getHalfLife(featuresA)).toBe(SEVEN_DAYS_MS);
            expect(model.getHalfLife(featuresB)).toBe(SEVEN_DAYS_MS);
        });
    });
});

describe('extractProvenance', () => {
    it('identifies _src_human suffix', () => {
        expect(extractProvenance('v1.procedure.correct_spelling_src_human')).toBe('human');
    });

    it('identifies _src_test suffix', () => {
        expect(extractProvenance('v1.fact.some_thing_src_test')).toBe('test');
    });

    it('identifies _src_research suffix', () => {
        expect(extractProvenance('v1.fact.bm25_outperforms_jaccard_src_research')).toBe('research');
    });

    it('returns default for no suffix', () => {
        expect(extractProvenance('v1.fact.plain_atom')).toBe('default');
    });
});

describe('parseThetaFromEnv', () => {
    it('parses valid theta string', () => {
        const result = parseThetaFromEnv('access:0.2,training:0.3,type:0.1,provenance:0.5');
        expect(result).toEqual({ access: 0.2, training: 0.3, type: 0.1, provenance: 0.5 });
    });

    it('returns undefined for empty/undefined input', () => {
        expect(parseThetaFromEnv(undefined)).toBeUndefined();
        expect(parseThetaFromEnv('')).toBeUndefined();
    });

    it('handles partial theta', () => {
        const result = parseThetaFromEnv('access:0.5');
        expect(result).toEqual({ access: 0.5 });
    });

    it('ignores invalid values', () => {
        const result = parseThetaFromEnv('access:notanumber,training:0.2');
        expect(result).toEqual({ training: 0.2 });
    });
});
