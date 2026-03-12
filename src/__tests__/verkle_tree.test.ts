import { describe, it, expect } from 'vitest';
import {
    fieldAdd,
    fieldSub,
    fieldMul,
    fieldPow,
    fieldInv,
    FIELD_P,
    GROUP_ORDER,
    G,
    pointAdd,
    pointEq,
    scalarMul,
    pointNeg,
    multiScalarMul,
    compressPoint,
    decompressPoint,
    hashToCurve,
    pedersenCommit,
    precomputeGenerators,
    hashToScalar,
    ipaProve,
    ipaVerify,
    Transcript,
} from '../verkle/kzg';
import { VerkleTree, VERKLE_WIDTH } from '../verkle/verkle_tree';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers — use width 16 for fast tests (log₂(16) = 4 IPA rounds)
// ---------------------------------------------------------------------------

const TEST_WIDTH = 16;

function sha256hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function makeLeaves(count: number): string[] {
    return Array.from({ length: count }, (_, i) => sha256hex(`atom_${i}`));
}

// ---------------------------------------------------------------------------
// Field Arithmetic
// ---------------------------------------------------------------------------

describe('Verkle Field Arithmetic', () => {

    it('adds correctly mod p', () => {
        expect(fieldAdd(10n, 20n)).toBe(30n);
        expect(fieldAdd(FIELD_P - 1n, 1n)).toBe(0n);
        expect(fieldAdd(FIELD_P - 1n, 2n)).toBe(1n);
    });

    it('subtracts correctly mod p', () => {
        expect(fieldSub(20n, 10n)).toBe(10n);
        expect(fieldSub(0n, 1n)).toBe(FIELD_P - 1n);
    });

    it('multiplies correctly mod p', () => {
        expect(fieldMul(3n, 7n)).toBe(21n);
        expect(fieldMul(FIELD_P - 1n, FIELD_P - 1n)).toBe(1n); // (-1)(-1) = 1
    });

    it('computes modular inverse', () => {
        const a = 42n;
        const aInv = fieldInv(a);
        expect(fieldMul(a, aInv)).toBe(1n);
    });

    it('computes modular exponentiation', () => {
        expect(fieldPow(2n, 10n)).toBe(1024n);
        expect(fieldPow(7n, FIELD_P - 1n)).toBe(1n);
    });

    it('throws on inverse of zero', () => {
        expect(() => fieldInv(0n)).toThrow('Cannot invert zero');
    });
});

// ---------------------------------------------------------------------------
// Elliptic Curve Operations
// ---------------------------------------------------------------------------

describe('Verkle EC Operations (secp256k1)', () => {

    it('generator point is on the curve', () => {
        const y2 = fieldMul(G.y, G.y);
        const x3Plus7 = fieldAdd(fieldPow(G.x, 3n), 7n);
        expect(y2).toBe(x3Plus7);
    });

    it('point addition is commutative', () => {
        const P = scalarMul(42n, G);
        const Q = scalarMul(99n, G);
        expect(pointEq(pointAdd(P, Q), pointAdd(Q, P))).toBe(true);
    });

    it('scalar multiplication: nG + mG = (n+m)G', () => {
        const nG = scalarMul(123n, G);
        const mG = scalarMul(456n, G);
        expect(pointEq(pointAdd(nG, mG), scalarMul(579n, G))).toBe(true);
    });

    it('P + (-P) = infinity', () => {
        const P = scalarMul(7n, G);
        expect(pointAdd(P, pointNeg(P))).toBeNull();
    });

    it('GROUP_ORDER * G = infinity', () => {
        expect(scalarMul(GROUP_ORDER, G)).toBeNull();
    });

    it('point compression round-trips', () => {
        const P = scalarMul(12345n, G);
        expect(pointEq(P, decompressPoint(compressPoint(P)))).toBe(true);
    });

    it('infinity compresses to zero bytes', () => {
        expect(compressPoint(null)).toBe('00'.repeat(33));
        expect(decompressPoint('00'.repeat(33))).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Hash-to-Curve & Generators
// ---------------------------------------------------------------------------

describe('Verkle Generators', () => {

    it('hashToCurve produces valid curve points', () => {
        const P = hashToCurve('test_seed');
        const y2 = fieldMul(P.y, P.y);
        const x3Plus7 = fieldAdd(fieldPow(P.x, 3n), 7n);
        expect(y2).toBe(x3Plus7);
    });

    it('hashToCurve is deterministic', () => {
        expect(pointEq(hashToCurve('same'), hashToCurve('same'))).toBe(true);
    });

    it('different seeds → different points', () => {
        expect(pointEq(hashToCurve('a'), hashToCurve('b'))).toBe(false);
    });

    it('precomputeGenerators produces correct count of valid points', () => {
        const gens = precomputeGenerators(4);
        expect(gens).toHaveLength(4);
        for (const g of gens) {
            const y2 = fieldMul(g.y, g.y);
            expect(y2).toBe(fieldAdd(fieldPow(g.x, 3n), 7n));
        }
    });
});

// ---------------------------------------------------------------------------
// Pedersen Commitment
// ---------------------------------------------------------------------------

describe('Verkle Pedersen Commitment', () => {

    it('is deterministic', () => {
        const gens = precomputeGenerators(4);
        const v = [1n, 2n, 3n, 4n];
        expect(pointEq(pedersenCommit(v, gens), pedersenCommit(v, gens))).toBe(true);
    });

    it('changes when values change', () => {
        const gens = precomputeGenerators(4);
        expect(pointEq(
            pedersenCommit([1n, 2n, 3n, 4n], gens),
            pedersenCommit([1n, 2n, 3n, 5n], gens),
        )).toBe(false);
    });

    it('is homomorphic: C(a+b) = C(a) + C(b)', () => {
        const gens = precomputeGenerators(4);
        const a = [1n, 2n, 3n, 4n];
        const b = [5n, 6n, 7n, 8n];
        const ab = a.map((v, i) => (v + b[i]) % GROUP_ORDER);
        expect(pointEq(
            pedersenCommit(ab, gens),
            pointAdd(pedersenCommit(a, gens), pedersenCommit(b, gens)),
        )).toBe(true);
    });

    it('throws on mismatched lengths', () => {
        expect(() => pedersenCommit([1n, 2n], precomputeGenerators(4))).toThrow('Value count');
    });
});

// ---------------------------------------------------------------------------
// Fiat-Shamir Transcript
// ---------------------------------------------------------------------------

describe('Verkle Fiat-Shamir Transcript', () => {

    it('deterministic challenges', () => {
        const t1 = new Transcript('test');
        t1.absorbScalar(42n);
        const t2 = new Transcript('test');
        t2.absorbScalar(42n);
        expect(t1.challenge()).toBe(t2.challenge());
    });

    it('different inputs → different challenges', () => {
        const t1 = new Transcript('test');
        t1.absorbScalar(42n);
        const t2 = new Transcript('test');
        t2.absorbScalar(43n);
        expect(t1.challenge()).not.toBe(t2.challenge());
    });

    it('challenge is in the scalar field', () => {
        const t = new Transcript('test');
        t.absorb('deadbeef');
        const c = t.challenge();
        expect(c >= 0n && c < GROUP_ORDER).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// IPA Proof (width 4 for fast testing)
// ---------------------------------------------------------------------------

describe('Verkle IPA Proof', () => {

    it('proves and verifies opening at position 0', () => {
        const gens = precomputeGenerators(4);
        const vals = [10n, 20n, 30n, 40n];
        const C = pedersenCommit(vals, gens);
        const proof = ipaProve(vals, gens, 0, 10n);
        expect(proof.L).toHaveLength(2); // log₂(4) = 2
        expect(ipaVerify(C, gens, 0, 10n, proof)).toBe(true);
    });

    it('proves and verifies opening at last position', () => {
        const gens = precomputeGenerators(4);
        const vals = [10n, 20n, 30n, 40n];
        const C = pedersenCommit(vals, gens);
        const proof = ipaProve(vals, gens, 3, 40n);
        expect(ipaVerify(C, gens, 3, 40n, proof)).toBe(true);
    });

    it('rejects wrong value', () => {
        const gens = precomputeGenerators(4);
        const vals = [10n, 20n, 30n, 40n];
        const C = pedersenCommit(vals, gens);
        const proof = ipaProve(vals, gens, 0, 10n);
        expect(ipaVerify(C, gens, 0, 99n, proof)).toBe(false);
    });

    it('rejects wrong position', () => {
        const gens = precomputeGenerators(4);
        const vals = [10n, 20n, 30n, 40n];
        const C = pedersenCommit(vals, gens);
        const proof = ipaProve(vals, gens, 0, 10n);
        expect(ipaVerify(C, gens, 1, 10n, proof)).toBe(false);
    });

    it('rejects wrong commitment', () => {
        const gens = precomputeGenerators(4);
        const vals1 = [10n, 20n, 30n, 40n];
        const C2 = pedersenCommit([50n, 60n, 70n, 80n], gens);
        const proof = ipaProve(vals1, gens, 0, 10n);
        expect(ipaVerify(C2, gens, 0, 10n, proof)).toBe(false);
    });

    it('works with width-8 vector (all positions)', () => {
        const gens = precomputeGenerators(8);
        const vals = Array.from({ length: 8 }, (_, i) => BigInt(i + 1) * 100n);
        const C = pedersenCommit(vals, gens);
        for (let pos = 0; pos < 8; pos++) {
            const proof = ipaProve(vals, gens, pos, vals[pos]);
            expect(ipaVerify(C, gens, pos, vals[pos], proof)).toBe(true);
        }
    });

    it('throws on non-power-of-2 width', () => {
        const gens = precomputeGenerators(4);
        expect(() => ipaProve([1n, 2n, 3n], gens.slice(0, 3), 0, 1n)).toThrow('power of 2');
    });

    it('throws on value mismatch', () => {
        const gens = precomputeGenerators(4);
        expect(() => ipaProve([10n, 20n, 30n, 40n], gens, 0, 99n)).toThrow('Value mismatch');
    });
});

// ---------------------------------------------------------------------------
// Verkle Tree — Construction (width 16 for speed)
// ---------------------------------------------------------------------------

describe('VerkleTree', () => {

    it('constructs from leaves', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(tree.leafCount).toBe(4);
        expect(tree.root).not.toBe('00'.repeat(33));
    });

    it('empty tree has zero root', () => {
        const tree = VerkleTree.empty(TEST_WIDTH);
        expect(tree.leafCount).toBe(0);
        expect(tree.root).toBe('00'.repeat(33));
    });

    it('root changes on leaf update', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const oldRoot = tree.root;
        tree.updateLeaf(0, sha256hex('modified'));
        expect(tree.root).not.toBe(oldRoot);
    });

    it('root changes on append', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const oldRoot = tree.root;
        tree.appendLeaf(sha256hex('new_atom'));
        expect(tree.leafCount).toBe(5);
        expect(tree.root).not.toBe(oldRoot);
    });

    it('deterministic: same leaves → same root', () => {
        const leaves = makeLeaves(10);
        const t1 = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        const t2 = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        expect(t1.root).toBe(t2.root);
    });

    it('getLeafHash returns correct hash', () => {
        const leaves = makeLeaves(4);
        const tree = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        for (let i = 0; i < 4; i++) expect(tree.getLeafHash(i)).toBe(leaves[i]);
    });

    it('throws on out-of-bounds update', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(() => tree.updateLeaf(-1, 'abc')).toThrow('out of bounds');
        expect(() => tree.updateLeaf(4, 'abc')).toThrow('out of bounds');
    });

    it('depth 1 for leaves ≤ width', () => {
        expect(VerkleTree.fromLeaves(makeLeaves(1), TEST_WIDTH).depth).toBe(1);
        expect(VerkleTree.fromLeaves(makeLeaves(TEST_WIDTH), TEST_WIDTH).depth).toBe(1);
    });

    it('depth 2 for leaves > width', () => {
        expect(VerkleTree.fromLeaves(makeLeaves(TEST_WIDTH + 1), TEST_WIDTH).depth).toBe(2);
    });

    it('rejects non-power-of-2 width', () => {
        expect(() => VerkleTree.fromLeaves([], 15)).toThrow('power of 2');
    });
});

// ---------------------------------------------------------------------------
// Verkle Tree — Proofs
// ---------------------------------------------------------------------------

describe('VerkleTree Proofs', () => {

    it('generates valid proof for single leaf', () => {
        const leaves = makeLeaves(4);
        const tree = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        const proof = tree.getProof(0);
        expect(proof.proofVersion).toBe(2);
        expect(proof.leaf).toBe(leaves[0]);
        expect(proof.root).toBe(tree.root);
        expect(proof.openings).toHaveLength(proof.depth);
    });

    it('proof verifies correctly', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        expect(VerkleTree.verifyProof(proof)).toBe(true);
    });

    it('all leaves have valid proofs', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(8), TEST_WIDTH);
        for (let i = 0; i < 8; i++) {
            expect(VerkleTree.verifyProof(tree.getProof(i))).toBe(true);
        }
    });

    it('proof with expected root succeeds', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        expect(VerkleTree.verifyProof(proof, tree.root)).toBe(true);
    });

    it('proof with wrong expected root fails', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(VerkleTree.verifyProof(tree.getProof(0), '00'.repeat(33))).toBe(false);
    });

    it('tampered leaf hash invalidates proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        proof.leaf = sha256hex('tampered');
        expect(VerkleTree.verifyProof(proof)).toBe(false);
    });

    it('stale proof fails against new root', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        tree.updateLeaf(0, sha256hex('modified'));
        expect(VerkleTree.verifyProof(proof, tree.root)).toBe(false);
    });

    it('proof after update is valid', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        tree.updateLeaf(2, sha256hex('updated'));
        const proof = tree.getProof(2);
        expect(proof.leaf).toBe(sha256hex('updated'));
        expect(VerkleTree.verifyProof(proof)).toBe(true);
    });

    it('throws on out-of-bounds getProof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(() => tree.getProof(-1)).toThrow('out of bounds');
        expect(() => tree.getProof(4)).toThrow('out of bounds');
    });

    it('rejects wrong proofVersion', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        (proof as any).proofVersion = 1;
        expect(VerkleTree.verifyProof(proof)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Verkle Tree — Tombstoning
// ---------------------------------------------------------------------------

describe('VerkleTree Tombstoning', () => {

    const TOMBSTONE = '00'.repeat(32);

    it('tombstoned leaf produces valid proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        tree.updateLeaf(1, TOMBSTONE);
        const proof = tree.getProof(1);
        expect(proof.leaf).toBe(TOMBSTONE);
        expect(VerkleTree.verifyProof(proof)).toBe(true);
    });

    it('other proofs remain valid after tombstoning', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        tree.updateLeaf(1, TOMBSTONE);
        for (const i of [0, 2, 3]) {
            expect(VerkleTree.verifyProof(tree.getProof(i))).toBe(true);
        }
    });
});
