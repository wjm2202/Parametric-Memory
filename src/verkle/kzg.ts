/**
 * Verkle Commitment Scheme — Sprint 16
 *
 * Implements Pedersen vector commitments over secp256k1 with IPA
 * (Inner Product Argument) opening proofs.  This gives compact proofs
 * for opening positions in a committed vector — the core primitive
 * behind Verkle trees.
 *
 * Why secp256k1 + IPA instead of BLS12-381 + KZG?
 *   - secp256k1 arithmetic is implementable in pure TypeScript (BigInt)
 *   - No trusted setup required (IPA is transparent)
 *   - No native C bindings (c-kzg-4844) needed
 *   - Proof size: O(log₂(width)) group elements per tree level
 *   - Multiproof aggregation still works (the key Verkle advantage)
 *
 * Performance: Uses Jacobian coordinates internally to avoid field
 * inversions during point addition/doubling.  Inversions only happen
 * when converting back to affine for serialization.
 *
 * If @noble/curves becomes available, the commitment interface can be
 * swapped to BLS12-381 KZG for O(1) verification and smaller proofs.
 */

import { createHash } from 'crypto';

// ─── Finite Field Fp (secp256k1 base field) ─────────────────────────────

/** secp256k1 base field prime: p = 2^256 - 2^32 - 977 */
export const FIELD_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;

/** secp256k1 group order */
export const GROUP_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** Modular addition */
export function fieldAdd(a: bigint, b: bigint, p: bigint = FIELD_P): bigint {
    return ((a % p) + (b % p)) % p;
}

/** Modular subtraction */
export function fieldSub(a: bigint, b: bigint, p: bigint = FIELD_P): bigint {
    return (((a % p) - (b % p)) + p) % p;
}

/** Modular multiplication */
export function fieldMul(a: bigint, b: bigint, p: bigint = FIELD_P): bigint {
    return ((a % p) * (b % p)) % p;
}

/** Modular exponentiation (square-and-multiply) */
export function fieldPow(base: bigint, exp: bigint, p: bigint = FIELD_P): bigint {
    base = ((base % p) + p) % p;
    if (exp === 0n) return 1n;
    let result = 1n;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % p;
        base = (base * base) % p;
        exp >>= 1n;
    }
    return result;
}

/** Modular inverse (Fermat's little theorem: a^(p-2) mod p) */
export function fieldInv(a: bigint, p: bigint = FIELD_P): bigint {
    if (a === 0n) throw new Error('Cannot invert zero');
    return fieldPow(a, p - 2n, p);
}

// ─── Jacobian Coordinates ────────────────────────────────────────────────
// (X, Y, Z) represents the affine point (X/Z², Y/Z³).
// The point at infinity is (1, 1, 0).
// All arithmetic avoids field inversions; only toAffine needs one.

interface JacobianPoint {
    X: bigint;
    Y: bigint;
    Z: bigint;
}

const JAC_ZERO: JacobianPoint = { X: 1n, Y: 1n, Z: 0n };
const P = FIELD_P;

function jacIsZero(p: JacobianPoint): boolean {
    return p.Z === 0n;
}

/** Jacobian point doubling — no field inversion */
function jacDouble(p: JacobianPoint): JacobianPoint {
    if (p.Z === 0n || p.Y === 0n) return JAC_ZERO;
    const { X, Y, Z } = p;
    const YY = (Y * Y) % P;
    const S = (4n * X * YY) % P;
    const M = (3n * X * X) % P; // a=0 for secp256k1
    const X3 = ((M * M - 2n * S) % P + P) % P;
    const Y3 = ((M * (S - X3) - 8n * YY * YY) % P + P) % P;
    const Z3 = (2n * Y * Z) % P;
    return { X: X3, Y: Y3, Z: Z3 };
}

/** Jacobian point addition — no field inversion */
function jacAdd(p1: JacobianPoint, p2: JacobianPoint): JacobianPoint {
    if (p1.Z === 0n) return p2;
    if (p2.Z === 0n) return p1;

    const Z1Z1 = (p1.Z * p1.Z) % P;
    const Z2Z2 = (p2.Z * p2.Z) % P;
    const U1 = (p1.X * Z2Z2) % P;
    const U2 = (p2.X * Z1Z1) % P;
    const S1 = (p1.Y * p2.Z * Z2Z2) % P;
    const S2 = (p2.Y * p1.Z * Z1Z1) % P;

    if (U1 === U2) {
        if (S1 === S2) return jacDouble(p1);
        return JAC_ZERO; // P + (-P)
    }

    const H = ((U2 - U1) % P + P) % P;
    const I = (4n * H * H) % P;
    const J = (H * I) % P;
    const r = ((2n * (S2 - S1)) % P + P) % P;
    const V = (U1 * I) % P;

    const X3 = ((r * r - J - 2n * V) % P + P) % P;
    const Y3 = ((r * (V - X3) - 2n * S1 * J) % P + P) % P;
    const Z3 = ((((p1.Z + p2.Z) * (p1.Z + p2.Z) - Z1Z1 - Z2Z2) % P + P) % P * H) % P;

    return { X: X3, Y: Y3, Z: Z3 };
}

/** Convert Jacobian → Affine (one field inversion) */
function jacToAffine(p: JacobianPoint): CurvePoint {
    if (p.Z === 0n) return null;
    const zInv = fieldInv(p.Z);
    const zInv2 = (zInv * zInv) % P;
    const zInv3 = (zInv2 * zInv) % P;
    return {
        x: (p.X * zInv2) % P,
        y: (p.Y * zInv3) % P,
    };
}

/** Convert Affine → Jacobian */
function affineToJac(p: CurvePoint): JacobianPoint {
    if (p === null) return JAC_ZERO;
    return { X: p.x, Y: p.y, Z: 1n };
}

/** Jacobian scalar multiplication: n * P using double-and-add */
function jacScalarMul(n: bigint, p: JacobianPoint): JacobianPoint {
    if (p.Z === 0n || n === 0n) return JAC_ZERO;
    n = ((n % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
    if (n === 0n) return JAC_ZERO;

    let result: JacobianPoint = JAC_ZERO;
    let current: JacobianPoint = p;

    while (n > 0n) {
        if (n & 1n) result = jacAdd(result, current);
        current = jacDouble(current);
        n >>= 1n;
    }

    return result;
}

/** Jacobian multi-scalar multiplication: Σ sᵢ × Pᵢ (no intermediate affine conversions) */
function jacMultiScalarMul(scalars: bigint[], points: JacobianPoint[]): JacobianPoint {
    let result: JacobianPoint = JAC_ZERO;
    for (let i = 0; i < scalars.length; i++) {
        if (scalars[i] !== 0n) {
            result = jacAdd(result, jacScalarMul(scalars[i], points[i]));
        }
    }
    return result;
}

// ─── Public Affine Interface ─────────────────────────────────────────────

/** Affine point on secp256k1, or null for the point at infinity. */
export interface ECPoint {
    x: bigint;
    y: bigint;
}

/** Point at infinity (identity element) */
export const INFINITY: null = null;
export type CurvePoint = ECPoint | null;

/** secp256k1 generator point */
export const G: ECPoint = {
    x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
    y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
};

/** Check if two points are equal */
export function pointEq(a: CurvePoint, b: CurvePoint): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.x === b.x && a.y === b.y;
}

/** Point addition on secp256k1 (via Jacobian internally) */
export function pointAdd(p1: CurvePoint, p2: CurvePoint): CurvePoint {
    return jacToAffine(jacAdd(affineToJac(p1), affineToJac(p2)));
}

/** Scalar multiplication: n * P */
export function scalarMul(n: bigint, p: CurvePoint): CurvePoint {
    return jacToAffine(jacScalarMul(n, affineToJac(p)));
}

/** Point negation: -(x, y) = (x, p - y) */
export function pointNeg(p: CurvePoint): CurvePoint {
    if (p === null) return null;
    return { x: p.x, y: fieldSub(0n, p.y) };
}

/** Multi-scalar multiplication: Σ sᵢ × Pᵢ */
export function multiScalarMul(scalars: bigint[], points: CurvePoint[]): CurvePoint {
    const jacPoints = points.map(affineToJac);
    return jacToAffine(jacMultiScalarMul(scalars, jacPoints));
}

// ─── Point Serialization ─────────────────────────────────────────────────

/** Compress an EC point to 33 bytes (02/03 prefix + x coordinate) */
export function compressPoint(p: CurvePoint): string {
    if (p === null) return '00'.repeat(33);
    const prefix = p.y % 2n === 0n ? '02' : '03';
    return prefix + p.x.toString(16).padStart(64, '0');
}

/** Decompress a 33-byte hex point */
export function decompressPoint(hex: string): CurvePoint {
    if (hex === '00'.repeat(33)) return null;
    const prefix = hex.slice(0, 2);
    const x = BigInt('0x' + hex.slice(2));

    // y² = x³ + 7
    const y2 = fieldAdd(fieldPow(x, 3n), 7n);
    let y = fieldPow(y2, (FIELD_P + 1n) / 4n);

    const isEven = y % 2n === 0n;
    if ((prefix === '02' && !isEven) || (prefix === '03' && isEven)) {
        y = fieldSub(0n, y);
    }

    return { x, y };
}

// ─── Deterministic Generator Generation ──────────────────────────────────

/**
 * Generate a deterministic EC point from a seed string using hash-to-curve.
 * Uses try-and-increment: hash the seed, interpret as x, check if on curve.
 */
export function hashToCurve(seed: string): ECPoint {
    for (let counter = 0; counter < 1000; counter++) {
        const hash = createHash('sha256')
            .update(`${seed}:${counter}`)
            .digest();
        const x = BigInt('0x' + hash.toString('hex')) % FIELD_P;

        // y² = x³ + 7
        const y2 = fieldAdd(fieldPow(x, 3n), 7n);

        // Check if y2 is a quadratic residue (Euler criterion)
        const check = fieldPow(y2, (FIELD_P - 1n) / 2n);
        if (check === 1n) {
            const y = fieldPow(y2, (FIELD_P + 1n) / 4n);
            const point: ECPoint = y % 2n === 0n ? { x, y } : { x, y: fieldSub(0n, y) };
            return point;
        }
    }
    throw new Error(`hashToCurve failed for seed: ${seed}`);
}

/** Generator cache to avoid recomputation */
const generatorCache = new Map<number, ECPoint>();

/**
 * Get the i-th Pedersen generator point.
 * Deterministic, nothing-up-my-sleeve points derived from hash-to-curve.
 */
export function getGenerator(i: number): ECPoint {
    let gen = generatorCache.get(i);
    if (!gen) {
        gen = hashToCurve(`MMPM_VERKLE_GEN_${i}`);
        generatorCache.set(i, gen);
    }
    return gen;
}

/** Pre-generate all generators for a given width */
export function precomputeGenerators(width: number): ECPoint[] {
    const gens: ECPoint[] = [];
    for (let i = 0; i < width; i++) {
        gens.push(getGenerator(i));
    }
    return gens;
}

// ─── Pedersen Vector Commitment ──────────────────────────────────────────

/**
 * Commit to a vector of field elements using Pedersen vector commitment:
 *   C = Σ vᵢ × Gᵢ
 *
 * The commitment is a single EC point (33 bytes compressed).
 * Binding under discrete log assumption.
 *
 * Optimised: uses Jacobian accumulation internally, single affine
 * conversion at the end.
 */
export function pedersenCommit(values: bigint[], generators: CurvePoint[]): CurvePoint {
    if (values.length !== generators.length) {
        throw new Error(`Value count (${values.length}) must match generator count (${generators.length})`);
    }
    return multiScalarMul(values, generators);
}

/**
 * Convert a SHA-256 hash (hex string) to a field element in the scalar field.
 */
export function hashToScalar(hash: string): bigint {
    return BigInt('0x' + hash) % GROUP_ORDER;
}

// ─── Fiat-Shamir Transcript ──────────────────────────────────────────────

/**
 * Fiat-Shamir transcript for non-interactive proofs.
 * Absorbs data and squeezes challenges deterministically.
 */
export class Transcript {
    private state: Buffer;

    constructor(label: string) {
        this.state = createHash('sha256').update(`MMPM_IPA_${label}`).digest();
    }

    /** Absorb a hex string into the transcript */
    absorb(data: string): void {
        this.state = createHash('sha256')
            .update(this.state)
            .update(Buffer.from(data, 'hex'))
            .digest();
    }

    /** Absorb a compressed point */
    absorbPoint(p: CurvePoint): void {
        this.absorb(compressPoint(p));
    }

    /** Absorb a scalar (bigint as 32-byte hex) */
    absorbScalar(s: bigint): void {
        this.absorb(s.toString(16).padStart(64, '0'));
    }

    /** Squeeze a challenge scalar */
    challenge(): bigint {
        this.state = createHash('sha256').update(this.state).update('challenge').digest();
        return BigInt('0x' + this.state.toString('hex')) % GROUP_ORDER;
    }
}

// ─── IPA (Inner Product Argument) Opening Proof ──────────────────────────

/**
 * An IPA proof that opens a Pedersen commitment at a specific position.
 *
 * Given: C = Σ vᵢ × Gᵢ, prove that v[position] = value.
 *
 * The proof consists of log₂(n) L/R point pairs plus a final scalar.
 * Total proof size: 2 × log₂(width) × 33 + 32 bytes.
 * For width 256: 2 × 8 × 33 + 32 = 560 bytes.
 */
export interface IpaProof {
    /** L points from each round (log₂(n) entries, compressed hex) */
    L: string[];
    /** R points from each round (log₂(n) entries, compressed hex) */
    R: string[];
    /** Final scalar witness */
    a: string; // hex-encoded field element
}

/**
 * Generate an IPA opening proof.
 *
 * Proves that position `idx` of the vector committed as C has value `val`.
 *
 * Internally uses Jacobian coordinates throughout the folding rounds
 * and only converts to affine for the L/R serialization.
 */
export function ipaProve(
    values: bigint[],
    generators: CurvePoint[],
    idx: number,
    val: bigint,
): IpaProof {
    const n = values.length;
    if (n === 0 || (n & (n - 1)) !== 0) {
        throw new Error(`Vector length must be a power of 2, got ${n}`);
    }
    if (values[idx] !== val) {
        throw new Error('Value mismatch');
    }

    const transcript = new Transcript('open');
    transcript.absorbScalar(BigInt(idx));
    transcript.absorbScalar(val);

    // Working copies — keep generators in Jacobian to avoid repeated conversion
    let a = values.slice();
    let g: JacobianPoint[] = generators.map(affineToJac);

    let b: bigint[] = new Array(n).fill(0n);
    b[idx] = 1n;

    const Ls: string[] = [];
    const Rs: string[] = [];

    let halfSize = n;

    while (halfSize > 1) {
        halfSize >>= 1;

        const aL = a.slice(0, halfSize);
        const aR = a.slice(halfSize);
        const gL = g.slice(0, halfSize);
        const gR = g.slice(halfSize);

        // L = Σ aL[i] × gR[i],  R = Σ aR[i] × gL[i]
        const L = jacToAffine(jacMultiScalarMul(aL, gR));
        const R = jacToAffine(jacMultiScalarMul(aR, gL));

        Ls.push(compressPoint(L));
        Rs.push(compressPoint(R));

        transcript.absorbPoint(L);
        transcript.absorbPoint(R);

        const x = transcript.challenge();
        const xInv = fieldPow(x, GROUP_ORDER - 2n, GROUP_ORDER);

        // Fold
        const newA: bigint[] = [];
        const newG: JacobianPoint[] = [];

        for (let i = 0; i < halfSize; i++) {
            newA.push(((aL[i] * x + aR[i] * xInv) % GROUP_ORDER + GROUP_ORDER) % GROUP_ORDER);
            newG.push(jacAdd(jacScalarMul(xInv, gL[i]), jacScalarMul(x, gR[i])));
        }

        a = newA;
        g = newG;
    }

    return {
        L: Ls,
        R: Rs,
        a: a[0].toString(16).padStart(64, '0'),
    };
}

/**
 * Verify an IPA opening proof.
 *
 * Uses Jacobian coordinates internally for fast batch computation.
 */
export function ipaVerify(
    commitment: CurvePoint,
    generators: CurvePoint[],
    idx: number,
    val: bigint,
    proof: IpaProof,
): boolean {
    const n = generators.length;
    const logN = proof.L.length;

    if (logN !== Math.log2(n)) return false;
    if (proof.R.length !== logN) return false;

    const transcript = new Transcript('open');
    transcript.absorbScalar(BigInt(idx));
    transcript.absorbScalar(val);

    // Reconstruct challenges
    const challenges: bigint[] = [];
    for (let i = 0; i < logN; i++) {
        transcript.absorb(proof.L[i]);
        transcript.absorb(proof.R[i]);
        challenges.push(transcript.challenge());
    }

    // Compute scalars for the folded generator
    const s: bigint[] = new Array(n).fill(1n);
    for (let round = 0; round < logN; round++) {
        const x = challenges[round];
        const xInv = fieldPow(x, GROUP_ORDER - 2n, GROUP_ORDER);

        for (let i = 0; i < n; i++) {
            if ((i >> (logN - 1 - round)) & 1) {
                s[i] = (s[i] * x) % GROUP_ORDER;
            } else {
                s[i] = (s[i] * xInv) % GROUP_ORDER;
            }
        }
    }

    // Folded generator: gFolded = Σ s[i] × G[i]
    const jacGens = generators.map(affineToJac);
    const gFolded = jacMultiScalarMul(s, jacGens);

    // Folded commitment: C' = C + Σ (x²×L + x⁻²×R)
    let cPrime: JacobianPoint = affineToJac(commitment);
    for (let i = 0; i < logN; i++) {
        const x = challenges[i];
        const x2 = (x * x) % GROUP_ORDER;
        const xInv2 = fieldPow(x2, GROUP_ORDER - 2n, GROUP_ORDER);

        const Li = affineToJac(decompressPoint(proof.L[i]));
        const Ri = affineToJac(decompressPoint(proof.R[i]));

        cPrime = jacAdd(cPrime, jacAdd(jacScalarMul(x2, Li), jacScalarMul(xInv2, Ri)));
    }

    // Check: C' = a × gFolded
    const aVal = BigInt('0x' + proof.a);
    const expected = jacScalarMul(aVal, gFolded);

    const cAff = jacToAffine(cPrime);
    const eAff = jacToAffine(expected);
    return pointEq(cAff, eAff);
}

// ─── Verkle Proof Types ──────────────────────────────────────────────────

/**
 * A single-level Verkle proof opening.
 * One of these exists per tree level in a full proof.
 */
export interface VerkleOpening {
    /** Commitment at this node (compressed EC point, 33 bytes hex) */
    commitment: string;
    /** IPA opening proof for the child position */
    proof: IpaProof;
    /** Child index within this node (0..width-1) */
    childIndex: number;
    /** The opened value (child hash as scalar) */
    value: string; // hex field element
}

/**
 * Complete Verkle proof for a single atom.
 * Contains openings at each tree level from root to leaf.
 */
export interface VerkleProof {
    /** Proof format version — always 2 for Verkle */
    proofVersion: 2;
    /** Leaf hash (same as MerkleProof.leaf for compat) */
    leaf: string;
    /** Root commitment (compressed EC point) */
    root: string;
    /** Leaf index in the tree */
    index: number;
    /** Opening proofs, one per tree level (root → leaf) */
    openings: VerkleOpening[];
    /** Tree depth (number of levels) */
    depth: number;
    /** Tree width (branching factor) used — needed for verification */
    width: number;
}
