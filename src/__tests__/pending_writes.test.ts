import { describe, it, expect } from 'vitest';
import { PendingWrites } from '../pending_writes';
import { MerkleSnapshot } from '../merkle_snapshot';
import { TOMBSTONE_HASH } from '../types';

describe('PendingWrites', () => {
    const baseData = ['alpha', 'beta', 'gamma', 'delta'];

    it('starts empty', () => {
        const pw = new PendingWrites(0);
        expect(pw.isEmpty()).toBe(true);
        expect(pw.size).toBe(0);
    });

    it('tracks add operations', () => {
        const pw = new PendingWrites(0);
        pw.addLeaf('epsilon');
        pw.addLeaf('zeta');
        expect(pw.isEmpty()).toBe(false);
        expect(pw.size).toBe(2);
    });

    it('tracks tombstone operations', () => {
        const pw = new PendingWrites(0);
        pw.tombstone(1);
        expect(pw.isEmpty()).toBe(false);
        expect(pw.size).toBe(1);
    });

    it('apply with adds produces a new snapshot with more leaves', () => {
        const snap = MerkleSnapshot.fromData(baseData, 5);
        const pw = new PendingWrites(5);
        pw.addLeaf('epsilon');
        pw.addLeaf('zeta');

        const { snapshot: newSnap, addedIndices } = pw.apply(snap);
        expect(newSnap.leafCount).toBe(6);
        expect(newSnap.version).toBe(6);
        expect(addedIndices).toEqual([4, 5]);

        // All proofs should be valid in the new snapshot
        for (let i = 0; i < 6; i++) {
            expect(MerkleSnapshot.verifyProof(newSnap.getProof(i))).toBe(true);
        }
    });

    it('apply with tombstone produces correct zero-leaf', () => {
        const snap = MerkleSnapshot.fromData(baseData, 0);
        const pw = new PendingWrites(0);
        pw.tombstone(1); // tombstone 'beta'

        const { snapshot: newSnap } = pw.apply(snap);
        expect(newSnap.leafCount).toBe(4); // same count
        expect(newSnap.getLeafHash(1)).toBe(TOMBSTONE_HASH);
        expect(newSnap.root).not.toBe(snap.root); // root changed
    });

    it('apply with mixed ops works correctly', () => {
        const snap = MerkleSnapshot.fromData(baseData, 0);
        const pw = new PendingWrites(0);
        pw.tombstone(0); // tombstone 'alpha'
        pw.addLeaf('epsilon'); // add new

        const { snapshot: newSnap, addedIndices } = pw.apply(snap);
        expect(newSnap.leafCount).toBe(5);
        expect(newSnap.getLeafHash(0)).toBe(TOMBSTONE_HASH);
        expect(addedIndices).toEqual([4]);

        // All proofs valid
        for (let i = 0; i < 5; i++) {
            expect(MerkleSnapshot.verifyProof(newSnap.getProof(i))).toBe(true);
        }
    });

    it('apply on empty pending returns same snapshot', () => {
        const snap = MerkleSnapshot.fromData(baseData, 3);
        const pw = new PendingWrites(3);
        const { snapshot: result, addedIndices } = pw.apply(snap);
        expect(result).toBe(snap); // same reference
        expect(addedIndices).toEqual([]);
    });

    it('apply throws on out-of-range tombstone', () => {
        const snap = MerkleSnapshot.fromData(baseData, 0);
        const pw = new PendingWrites(0);
        pw.tombstone(99);
        expect(() => pw.apply(snap)).toThrow(RangeError);
    });

    it('clear removes all pending operations', () => {
        const pw = new PendingWrites(0);
        pw.addLeaf('x');
        pw.tombstone(0);
        expect(pw.size).toBe(2);
        pw.clear();
        expect(pw.isEmpty()).toBe(true);
        expect(pw.size).toBe(0);
    });

    it('getOps returns read-only view of operations', () => {
        const pw = new PendingWrites(0);
        pw.addLeaf('x');
        pw.tombstone(2);
        const ops = pw.getOps();
        expect(ops).toHaveLength(2);
        expect(ops[0]).toEqual({ kind: 'add', data: 'x' });
        expect(ops[1]).toEqual({ kind: 'tombstone', index: 2 });
    });

    it('does not mutate the input snapshot', () => {
        const snap = MerkleSnapshot.fromData(baseData, 0);
        const originalRoot = snap.root;
        const originalCount = snap.leafCount;

        const pw = new PendingWrites(0);
        pw.addLeaf('new');
        pw.tombstone(0);
        pw.apply(snap);

        // Original snapshot unchanged
        expect(snap.root).toBe(originalRoot);
        expect(snap.leafCount).toBe(originalCount);
    });

    it('new snapshot version increments by 1', () => {
        const snap = MerkleSnapshot.fromData(baseData, 7);
        const pw = new PendingWrites(7);
        pw.addLeaf('x');
        const { snapshot: newSnap } = pw.apply(snap);
        expect(newSnap.version).toBe(8);
    });
});
