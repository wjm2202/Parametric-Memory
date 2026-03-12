import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { MerkleSnapshot } from '../merkle_snapshot';
import { VerkleTree } from '../verkle/verkle_tree';
import {
    isVerkleProof,
    isMerkleProof,
    getProofVersion,
    verifyUnifiedProof,
    validateProofShape,
    annotateMerkleProof,
} from '../verkle/proof_compat';
import type { MerkleProof } from '../types';

const TEST_WIDTH = 16;

function sha256hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}
function makeLeaves(count: number): string[] {
    return Array.from({ length: count }, (_, i) => sha256hex(`atom_${i}`));
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

describe('Verkle Migration — Type Guards', () => {

    it('identifies Merkle proof (no proofVersion)', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c']);
        const proof = snap.getProof(0);
        expect(isMerkleProof(proof as any)).toBe(true);
        expect(isVerkleProof(proof as any)).toBe(false);
        expect(getProofVersion(proof as any)).toBe(1);
    });

    it('identifies annotated Merkle proof', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c']);
        const annotated = annotateMerkleProof(snap.getProof(0));
        expect(annotated.proofVersion).toBe(1);
        expect(isMerkleProof(annotated)).toBe(true);
    });

    it('identifies Verkle proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        expect(isVerkleProof(proof)).toBe(true);
        expect(isMerkleProof(proof as any)).toBe(false);
        expect(getProofVersion(proof)).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Unified Verification
// ---------------------------------------------------------------------------

describe('Verkle Migration — Unified Verification', () => {

    it('verifies Merkle proof', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
        expect(verifyUnifiedProof(snap.getProof(0) as any)).toBe(true);
    });

    it('verifies Verkle proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(verifyUnifiedProof(tree.getProof(0))).toBe(true);
    });

    it('verifies Merkle proof with expected root', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
        expect(verifyUnifiedProof(snap.getProof(0) as any, snap.root)).toBe(true);
    });

    it('verifies Verkle proof with expected root', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(verifyUnifiedProof(tree.getProof(0), tree.root)).toBe(true);
    });

    it('rejects tampered Merkle proof', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
        const proof = snap.getProof(0);
        proof.leaf = sha256hex('tampered');
        expect(verifyUnifiedProof(proof as any)).toBe(false);
    });

    it('rejects tampered Verkle proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const proof = tree.getProof(0);
        proof.leaf = sha256hex('tampered');
        expect(verifyUnifiedProof(proof)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Proof Shape Validation
// ---------------------------------------------------------------------------

describe('Verkle Migration — Proof Shape Validation', () => {

    it('validates Merkle proof shape', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
        expect(validateProofShape(snap.getProof(0))).toBeNull();
    });

    it('validates Verkle proof shape', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        expect(validateProofShape(tree.getProof(0))).toBeNull();
    });

    it('rejects null', () => {
        expect(validateProofShape(null)).toBe('Proof must be a non-null object');
    });

    it('rejects Merkle missing leaf', () => {
        expect(validateProofShape({ root: 'x', index: 0, auditPath: [] }))
            .toBe('Merkle proof requires leaf (string)');
    });

    it('rejects Verkle missing openings', () => {
        expect(validateProofShape({
            proofVersion: 2, leaf: 'x', root: 'x', index: 0, depth: 1,
        })).toBe('Verkle proof requires openings (array)');
    });

    it('rejects Verkle missing depth', () => {
        expect(validateProofShape({
            proofVersion: 2, leaf: 'x', root: 'x', index: 0, openings: [],
        })).toBe('Verkle proof requires depth (number)');
    });
});

// ---------------------------------------------------------------------------
// Mixed V1/V2 Scenarios
// ---------------------------------------------------------------------------

describe('Verkle Migration — Mixed Proof Scenarios', () => {

    it('handles both proof types simultaneously', () => {
        const data = ['atom_0', 'atom_1', 'atom_2', 'atom_3'];
        const snap = MerkleSnapshot.fromData(data);
        const merkleProof = snap.getProof(0);

        const leaves = data.map(d => sha256hex(d));
        const tree = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        const verkleProof = tree.getProof(0);

        expect(verifyUnifiedProof(merkleProof as any)).toBe(true);
        expect(verifyUnifiedProof(verkleProof)).toBe(true);
        expect(getProofVersion(merkleProof as any)).toBe(1);
        expect(getProofVersion(verkleProof)).toBe(2);
    });

    it('annotated Merkle proof retains verifiability', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
        const proof = snap.getProof(0);
        const annotated = annotateMerkleProof(proof);
        expect(verifyUnifiedProof(annotated)).toBe(true);
        expect(MerkleSnapshot.verifyProof(proof)).toBe(true);
    });

    it('Verkle tree has lower depth for same leaf count', () => {
        // 16 atoms: binary Merkle depth = 4, Verkle (width-16) depth = 1
        const tree = VerkleTree.fromLeaves(makeLeaves(16), TEST_WIDTH);
        expect(tree.depth).toBe(1);
    });
});
