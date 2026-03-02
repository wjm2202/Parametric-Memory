import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { IncrementalMerkleTree } from '../incremental_merkle';
import { MerkleSnapshot } from '../merkle_snapshot';
import { TOMBSTONE_HASH } from '../types';

// ─── helpers ──────────────────────────────────────────────────────────────────

function hashStr(s: string): Buffer {
    return createHash('sha256').update(s).digest();
}

function leaves(...strs: string[]): Buffer[] {
    return strs.map(hashStr);
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe('IncrementalMerkleTree', () => {
    describe('fromLeaves', () => {
        it('produces a 64-char hex root for non-empty leaves', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            expect(tree.root).toMatch(/^[a-f0-9]{64}$/);
        });

        it('produces the zero root for an empty leaf set', () => {
            const tree = IncrementalMerkleTree.fromLeaves([]);
            expect(tree.root).toBe('0'.repeat(64));
        });

        it('root matches the equivalent MerkleSnapshot root', () => {
            const data = ['alpha', 'beta', 'gamma', 'delta'];
            const snap = MerkleSnapshot.fromData(data);
            const tree = IncrementalMerkleTree.fromLeaves([...snap.leaves]);
            expect(tree.root).toBe(snap.root);
        });

        it('root matches MerkleSnapshot for odd-count leaves', () => {
            const snap = MerkleSnapshot.fromData(['x', 'y', 'z']);
            const tree = IncrementalMerkleTree.fromLeaves([...snap.leaves]);
            expect(tree.root).toBe(snap.root);
        });

        it('root matches MerkleSnapshot for a single leaf', () => {
            const snap = MerkleSnapshot.fromData(['solo']);
            const tree = IncrementalMerkleTree.fromLeaves([...snap.leaves]);
            expect(tree.root).toBe(snap.root);
        });

        it('root matches MerkleSnapshot for a power-of-2 leaf count', () => {
            const data = Array.from({ length: 8 }, (_, i) => `item_${i}`);
            const snap = MerkleSnapshot.fromData(data);
            const tree = IncrementalMerkleTree.fromLeaves([...snap.leaves]);
            expect(tree.root).toBe(snap.root);
        });

        it('root matches MerkleSnapshot for a large tree (100 leaves)', () => {
            const data = Array.from({ length: 100 }, (_, i) => `atom_${i}`);
            const snap = MerkleSnapshot.fromData(data);
            const tree = IncrementalMerkleTree.fromLeaves([...snap.leaves]);
            expect(tree.root).toBe(snap.root);
        });

        it('deterministic: same leaves → same root', () => {
            const ls = leaves('a', 'b', 'c', 'd');
            expect(IncrementalMerkleTree.fromLeaves(ls).root)
                .toBe(IncrementalMerkleTree.fromLeaves(ls).root);
        });
    });

    describe('fromSnapshot', () => {
        it('root equals the snapshot root', () => {
            const snap = MerkleSnapshot.fromData(['p', 'q', 'r']);
            const tree = IncrementalMerkleTree.fromSnapshot(snap);
            expect(tree.root).toBe(snap.root);
        });

        it('mutating the tree does not affect the source snapshot', () => {
            const snap = MerkleSnapshot.fromData(['a', 'b', 'c']);
            const before = snap.root;
            const tree = IncrementalMerkleTree.fromSnapshot(snap);
            tree.updateLeaf(0, Buffer.from(TOMBSTONE_HASH, 'hex'));
            expect(snap.root).toBe(before);
        });
    });

    // ─── updateLeaf ────────────────────────────────────────────────────────────

    describe('updateLeaf', () => {
        it('changes the root when a leaf is replaced', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            const before = tree.root;
            tree.updateLeaf(0, hashStr('UPDATED'));
            expect(tree.root).not.toBe(before);
        });

        it('root returns to original when leaf is restored', () => {
            const orig = hashStr('a');
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            const before = tree.root;
            tree.updateLeaf(0, hashStr('x'));
            tree.updateLeaf(0, orig);
            expect(tree.root).toBe(before);
        });

        it('updating one leaf does not affect siblings', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            // proof for leaf 2 before update of leaf 0
            tree.updateLeaf(0, hashStr('NEW'));
            const proof = tree.getProof(2);
            // proof.leaf should still be hash of 'c'
            expect(proof.leaf).toBe(hashStr('c').toString('hex'));
        });

        it('applying tombstone produces same root as PendingWrites.apply()', async () => {
            const { PendingWrites } = await import('../pending_writes');
            const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
            const pw = new PendingWrites(snap.version);
            pw.tombstone(1);
            const { snapshot: newSnap } = pw.apply(snap);

            const tree = IncrementalMerkleTree.fromSnapshot(snap);
            tree.updateLeaf(1, Buffer.from(TOMBSTONE_HASH, 'hex'));

            expect(tree.root).toBe(newSnap.root);
        });

        it('throws RangeError for out-of-bounds index', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b'));
            expect(() => tree.updateLeaf(2, hashStr('x'))).toThrow(RangeError);
            expect(() => tree.updateLeaf(-1, hashStr('x'))).toThrow(RangeError);
        });

        it('all leaf indices produce valid proofs after update', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd', 'e'));
            tree.updateLeaf(2, hashStr('CHANGED'));
            for (let i = 0; i < tree.leafCount; i++) {
                const proof = tree.getProof(i);
                expect(MerkleSnapshot.verifyProof(proof)).toBe(true);
            }
        });
    });

    // ─── appendLeaf ───────────────────────────────────────────────────────────

    describe('appendLeaf — within capacity', () => {
        it('leafCount increments after append', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            tree.appendLeaf(hashStr('d'));
            expect(tree.leafCount).toBe(4);
        });

        it('root changes after append', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            const before = tree.root;
            tree.appendLeaf(hashStr('d'));
            expect(tree.root).not.toBe(before);
        });

        it('root matches a fresh tree built with the same leaves', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            tree.appendLeaf(hashStr('d'));
            const expected = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            expect(tree.root).toBe(expected.root);
        });

        it('root matches MerkleSnapshot after append within capacity', () => {
            // capacity after 3 leaves = 4; appending a 4th stays within capacity
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            tree.appendLeaf(hashStr('d'));
            const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd']);
            expect(tree.root).toBe(snap.root);
        });

        it('incremental appends produce the same root as a single-shot build', () => {
            const tree = IncrementalMerkleTree.fromLeaves([]);
            const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
            for (const s of items) tree.appendLeaf(hashStr(s));
            const expected = IncrementalMerkleTree.fromLeaves(leaves(...items));
            expect(tree.root).toBe(expected.root);
        });

        it('proof is valid for newly appended leaf', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            tree.appendLeaf(hashStr('d'));
            const proof = tree.getProof(3);
            expect(MerkleSnapshot.verifyProof(proof)).toBe(true);
        });

        it('all proofs remain valid after multiple appends within capacity', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b'));
            tree.appendLeaf(hashStr('c'));
            tree.appendLeaf(hashStr('d')); // reaches capacity (4)
            for (let i = 0; i < tree.leafCount; i++) {
                expect(MerkleSnapshot.verifyProof(tree.getProof(i))).toBe(true);
            }
        });
    });

    describe('appendLeaf — capacity doubling', () => {
        it('appending past a power-of-2 boundary expands correctly', () => {
            // Start with exactly 4 leaves (capacity = 4), then push to 5 → capacity doubles to 8
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            tree.appendLeaf(hashStr('e'));
            expect(tree.leafCount).toBe(5);
            const expected = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd', 'e'));
            expect(tree.root).toBe(expected.root);
        });

        it('root matches MerkleSnapshot after capacity doubling', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            tree.appendLeaf(hashStr('e'));
            const snap = MerkleSnapshot.fromData(['a', 'b', 'c', 'd', 'e']);
            expect(tree.root).toBe(snap.root);
        });

        it('all proofs valid after capacity doubling', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            tree.appendLeaf(hashStr('e'));
            tree.appendLeaf(hashStr('f'));
            for (let i = 0; i < tree.leafCount; i++) {
                expect(MerkleSnapshot.verifyProof(tree.getProof(i))).toBe(true);
            }
        });
    });

    // ─── toSnapshot ───────────────────────────────────────────────────────────

    describe('toSnapshot', () => {
        it('snapshot root equals tree root', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            const snap = tree.toSnapshot(42);
            expect(snap.root).toBe(tree.root);
        });

        it('snapshot version is set correctly', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a'));
            expect(tree.toSnapshot(7).version).toBe(7);
        });

        it('snapshot is immutable: mutating tree after toSnapshot does not change snapshot', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b'));
            const snap = tree.toSnapshot(1);
            const rootBefore = snap.root;
            tree.updateLeaf(0, hashStr('CHANGED'));
            expect(snap.root).toBe(rootBefore);
        });

        it('proofs generated from snapshot verify correctly', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c', 'd'));
            tree.updateLeaf(2, Buffer.from(TOMBSTONE_HASH, 'hex'));
            const snap = tree.toSnapshot(3);
            for (let i = 0; i < snap.leafCount; i++) {
                expect(MerkleSnapshot.verifyProof(snap.getProof(i))).toBe(true);
            }
        });
    });

    // ─── getProof ────────────────────────────────────────────────────────────

    describe('getProof', () => {
        it('proof verifies for every leaf in a 7-element tree', () => {
            const tree = IncrementalMerkleTree.fromLeaves(
                Array.from({ length: 7 }, (_, i) => hashStr(`item_${i}`))
            );
            for (let i = 0; i < tree.leafCount; i++) {
                expect(MerkleSnapshot.verifyProof(tree.getProof(i))).toBe(true);
            }
        });

        it('proof root equals tree root', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b', 'c'));
            for (let i = 0; i < tree.leafCount; i++) {
                expect(tree.getProof(i).root).toBe(tree.root);
            }
        });

        it('throws RangeError for out-of-bounds index', () => {
            const tree = IncrementalMerkleTree.fromLeaves(leaves('a', 'b'));
            expect(() => tree.getProof(2)).toThrow(RangeError);
            expect(() => tree.getProof(-1)).toThrow(RangeError);
        });
    });
});
