/**
 * Half-Life Regression (HLR) — adaptive per-atom confidence decay.
 *
 * Instead of a single global half-life for all Markov transition weights,
 * HLR computes a per-atom half-life based on observable features:
 *   - accessCount:    how many times the atom has been retrieved
 *   - trainingPasses: sum of outgoing transition weights (proxy for reinforcement)
 *   - typeBias:       +1 for procedure, 0 for fact, -1 for state/event
 *   - provenanceBias: +1 for _src_human, 0 for _src_test, -1 for default
 *
 * Formula:
 *   h(atom) = baseHalfLifeMs × 2^(θ · x)
 *
 * where θ = [θ_access, θ_training, θ_type, θ_provenance] and x is the
 * feature vector.  This means frequently accessed, well-trained, human-sourced
 * procedures have LONGER half-lives (decay slower), while untouched speculative
 * findings decay at the base rate or faster.
 *
 * Reference: Settles & Meeder, "A Trainable Spaced Repetition Model for
 * Language Learning" (ACL 2016).
 */

import { AtomType, parseAtomV1 } from './atom_schema';

export interface HlrFeatures {
    accessCount: number;
    trainingPasses: number;
    atomType: AtomType;
    provenance: 'human' | 'test' | 'research' | 'default';
}

export interface HlrTheta {
    access: number;
    training: number;
    type: number;
    provenance: number;
}

const DEFAULT_THETA: HlrTheta = {
    access: 0.1,       // each access adds ~7% to the exponent
    training: 0.15,    // each training pass adds ~11%
    type: 0.3,         // procedure vs state is a 0.6 swing
    provenance: 0.4,   // human vs default is a 0.8 swing
};

export class HalfLifeModel {
    private readonly baseHalfLifeMs: number;
    private readonly theta: HlrTheta;
    /** Maximum half-life clamp to prevent unbounded growth (90 days). */
    private readonly maxHalfLifeMs: number;

    constructor(baseHalfLifeMs: number, theta?: Partial<HlrTheta>, maxHalfLifeMs?: number) {
        this.baseHalfLifeMs = baseHalfLifeMs;
        this.theta = { ...DEFAULT_THETA, ...theta };
        this.maxHalfLifeMs = maxHalfLifeMs ?? 90 * 24 * 60 * 60 * 1000; // 90 days
    }

    /**
     * Compute the half-life for a specific atom based on its features.
     * Returns milliseconds.
     */
    getHalfLife(features: HlrFeatures): number {
        const x = this.featureVector(features);
        const dotProduct =
            this.theta.access * x[0] +
            this.theta.training * x[1] +
            this.theta.type * x[2] +
            this.theta.provenance * x[3];

        const halfLife = this.baseHalfLifeMs * Math.pow(2, dotProduct);
        return Math.min(halfLife, this.maxHalfLifeMs);
    }

    /**
     * Compute the effective weight after decay using per-atom half-life.
     */
    computeEffectiveWeight(rawWeight: number, elapsedMs: number, features: HlrFeatures): number {
        const halfLife = this.getHalfLife(features);
        if (halfLife <= 0) return rawWeight;
        const decayFactor = Math.pow(0.5, elapsedMs / halfLife);
        return rawWeight * decayFactor;
    }

    private featureVector(features: HlrFeatures): [number, number, number, number] {
        return [
            features.accessCount,
            features.trainingPasses,
            typeBias(features.atomType),
            provenanceBias(features.provenance),
        ];
    }

    /** Expose theta for diagnostics. */
    get weights(): Readonly<HlrTheta> { return { ...this.theta }; }
}

/** Map atom type to a numerical bias. Procedures persist longest, states/events shortest. */
function typeBias(type: AtomType): number {
    switch (type) {
        case 'procedure': return 1;
        case 'fact':      return 0;
        case 'relation':  return 0;
        case 'state':     return -1;
        case 'event':     return -1;
        case 'other':     return -0.5;
        default:          return 0;
    }
}

/** Extract provenance from atom name suffix conventions. */
export function extractProvenance(atomName: string): 'human' | 'test' | 'research' | 'default' {
    if (atomName.endsWith('_src_human'))    return 'human';
    if (atomName.endsWith('_src_test'))     return 'test';
    if (atomName.endsWith('_src_research')) return 'research';
    return 'default';
}

/** Map provenance to a numerical bias. Human corrections persist longest. */
function provenanceBias(prov: 'human' | 'test' | 'research' | 'default'): number {
    switch (prov) {
        case 'human':    return 1;
        case 'test':     return 0;
        case 'research': return -0.5;
        case 'default':  return -1;
    }
}

/**
 * Parse HLR theta from an environment variable string.
 * Format: "access:0.1,training:0.15,type:0.3,provenance:0.4"
 */
export function parseThetaFromEnv(raw: string | undefined): Partial<HlrTheta> | undefined {
    if (!raw) return undefined;
    const result: Partial<HlrTheta> = {};
    for (const pair of raw.split(',')) {
        const [key, val] = pair.split(':');
        const num = parseFloat(val);
        if (!Number.isFinite(num)) continue;
        if (key === 'access')     result.access = num;
        if (key === 'training')   result.training = num;
        if (key === 'type')       result.type = num;
        if (key === 'provenance') result.provenance = num;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
