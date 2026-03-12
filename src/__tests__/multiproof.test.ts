import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { VerkleTree } from '../verkle/verkle_tree';
import {
    aggregateProofs,
    verifyMultiproof,
    estimateMultiproofSize,
    estimateMerkleEquivalentSize,
} from '../verkle/multiproof';

const TEST_WIDTH = 16;

function sha256hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}
function makeLeaves(count: number): string[] {
    return Array.from({ length: count }, (_, i) => sha256hex(`atom_${i}`));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe('Verkle Multiproof Aggregation', () => {

    it('aggregates two proofs from same tree', () => {
        const leaves = makeLeaves(8);
        const tree = VerkleTree.fromLeaves(leaves, TEST_WIDTH);
        const multi = aggregateProofs([tree.getProof(0), tree.getProof(1)]);
        expect(multi.proofVersion).toBe(2);
        expect(multi.root).toBe(tree.root);
        expect(multi.indices).toEqual([0, 1]);
        expect(multi.leaves).toEqual([leaves[0], leaves[1]]);
    });

    it('deduplicates shared commitments', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(8), TEST_WIDTH);
        const multi = aggregateProofs([0, 1, 2, 3].map(i => tree.getProof(i)));
        // depth-1 tree: all share one root commitment
        expect(multi.levelOpenings[0]).toHaveLength(1);
    });

    it('throws on empty array', () => {
        expect(() => aggregateProofs([])).toThrow('Cannot aggregate zero proofs');
    });

    it('throws on mismatched roots', () => {
        const t1 = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        // Use different atom names to get a different root
        const t2 = VerkleTree.fromLeaves(
            Array.from({ length: 4 }, (_, i) => sha256hex(`other_atom_${i}`)),
            TEST_WIDTH,
        );
        expect(() => aggregateProofs([t1.getProof(0), t2.getProof(0)])).toThrow('same root');
    });

    it('handles single proof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const multi = aggregateProofs([tree.getProof(0)]);
        expect(multi.indices).toEqual([0]);
    });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe('Verkle Multiproof Verification', () => {

    it('verifies a valid multiproof', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(8), TEST_WIDTH);
        const multi = aggregateProofs([0, 3, 7].map(i => tree.getProof(i)));
        expect(verifyMultiproof(multi)).toBe(true);
    });

    it('verifies with expected root', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const multi = aggregateProofs([0, 1].map(i => tree.getProof(i)));
        expect(verifyMultiproof(multi, tree.root)).toBe(true);
    });

    it('rejects wrong expected root', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const multi = aggregateProofs([0, 1].map(i => tree.getProof(i)));
        expect(verifyMultiproof(multi, '00'.repeat(33))).toBe(false);
    });

    it('rejects wrong proofVersion', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const multi = aggregateProofs([tree.getProof(0)]);
        (multi as any).proofVersion = 1;
        expect(verifyMultiproof(multi)).toBe(false);
    });

    it('rejects mismatched index/leaf count', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(4), TEST_WIDTH);
        const multi = aggregateProofs([0, 1].map(i => tree.getProof(i)));
        multi.indices.push(99);
        expect(verifyMultiproof(multi)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Size Estimation
// ---------------------------------------------------------------------------

describe('Verkle Multiproof Size', () => {

    it('estimates multiproof size > 0', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(8), TEST_WIDTH);
        const multi = aggregateProofs([0, 1, 2, 3].map(i => tree.getProof(i)));
        expect(estimateMultiproofSize(multi)).toBeGreaterThan(0);
    });

    it('multiproof smaller than sum of individuals (shared commitments)', () => {
        const tree = VerkleTree.fromLeaves(makeLeaves(8), TEST_WIDTH);
        const proofs = [0, 1, 2, 3].map(i => tree.getProof(i));
        const multi = aggregateProofs(proofs);
        const multiSize = estimateMultiproofSize(multi);
        const individualSize = proofs.length * (
            33 + 4 + 32 + tree.depth * (33 + 2 * 4 * 33 + 32 + 1 + 32) // per-level for width-16
        );
        expect(multiSize).toBeLessThan(individualSize);
    });

    it('Merkle equivalent size is reasonable', () => {
        const merkleSize = estimateMerkleEquivalentSize(10, 2);
        expect(merkleSize).toBe(10 * (32 + 32 + 4 + 16 * 32));
    });
});
