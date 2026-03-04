import { describe, it, expect } from 'vitest';
import { MerkleSnapshot } from '../merkle_snapshot';
import { MerkleKernel } from '../merkle';

describe('MerkleSnapshot', () => {
    const data = ['alpha', 'beta', 'gamma', 'delta'];

    it('builds from data and produces a root hash', () => {
        const snap = MerkleSnapshot.fromData(data);
        expect(snap.root).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces deterministic roots for identical data', () => {
        const a = MerkleSnapshot.fromData(data);
        const b = MerkleSnapshot.fromData(data);
        expect(a.root).toBe(b.root);
    });

    it('produces different roots for different data', () => {
        const a = MerkleSnapshot.fromData(data);
        const b = MerkleSnapshot.fromData(['x', 'y', 'z']);
        expect(a.root).not.toBe(b.root);
    });

    it('returns unique leaf hashes per index', () => {
        const snap = MerkleSnapshot.fromData(data);
        const hashes = data.map((_, i) => snap.getLeafHash(i));
        expect(new Set(hashes).size).toBe(data.length);
    });

    it('generates valid proofs for each leaf', () => {
        const snap = MerkleSnapshot.fromData(data);
        for (let i = 0; i < data.length; i++) {
            const proof = snap.getProof(i);
            expect(proof.leaf).toBe(snap.getLeafHash(i));
            expect(proof.root).toBe(snap.root);
            expect(proof.index).toBe(i);
            expect(MerkleSnapshot.verifyProof(proof)).toBe(true);
        }
    });

    it('verifyProof rejects a tampered leaf', () => {
        const snap = MerkleSnapshot.fromData(data);
        const proof = snap.getProof(0);
        proof.leaf = 'ff'.repeat(32);
        expect(MerkleSnapshot.verifyProof(proof)).toBe(false);
    });

    it('verifyProof rejects a tampered audit path', () => {
        const snap = MerkleSnapshot.fromData(data);
        const proof = snap.getProof(1);
        proof.auditPath[0] = 'aa'.repeat(32);
        expect(MerkleSnapshot.verifyProof(proof)).toBe(false);
    });

    it('handles a single-element tree', () => {
        const snap = MerkleSnapshot.fromData(['solo']);
        const proof = snap.getProof(0);
        expect(MerkleSnapshot.verifyProof(proof)).toBe(true);
    });

    it('handles odd-count data', () => {
        const snap = MerkleSnapshot.fromData(['a', 'b', 'c']);
        for (let i = 0; i < 3; i++) {
            expect(MerkleSnapshot.verifyProof(snap.getProof(i))).toBe(true);
        }
    });

    it('handles a large tree (100 elements)', () => {
        const bigData = Array.from({ length: 100 }, (_, i) => `item_${i}`);
        const snap = MerkleSnapshot.fromData(bigData);
        for (let i = 0; i < bigData.length; i++) {
            expect(MerkleSnapshot.verifyProof(snap.getProof(i))).toBe(true);
        }
    });

    it('handles an empty snapshot', () => {
        const snap = MerkleSnapshot.empty();
        expect(snap.leafCount).toBe(0);
        expect(snap.root).toBe('0'.repeat(64));
    });

    it('verifyProof with matching expectedRoot passes', () => {
        const snap = MerkleSnapshot.fromData(data);
        const proof = snap.getProof(1);
        expect(MerkleSnapshot.verifyProof(proof, snap.root)).toBe(true);
    });

    it('verifyProof rejects proof from a different tree when expectedRoot is given', () => {
        const snapA = MerkleSnapshot.fromData(['alpha', 'beta', 'gamma', 'delta']);
        const snapB = MerkleSnapshot.fromData(['x', 'y', 'z', 'w']);
        const proofFromA = snapA.getProof(0);
        expect(MerkleSnapshot.verifyProof(proofFromA)).toBe(true);
        expect(MerkleSnapshot.verifyProof(proofFromA, snapB.root)).toBe(false);
    });

    it('is immutable — leaves array cannot be modified', () => {
        const snap = MerkleSnapshot.fromData(data);
        const originalRoot = snap.root;
        // Attempt to modify via the readonly property (TypeScript prevents this
        // at compile time, but we verify at runtime too)
        expect(Object.isFrozen(snap.leaves)).toBe(true);
        expect(snap.root).toBe(originalRoot);
    });

    it('tracks version number', () => {
        const snap = MerkleSnapshot.fromData(data, 42);
        expect(snap.version).toBe(42);
    });

    it('getLeafHash throws on out-of-range index', () => {
        const snap = MerkleSnapshot.fromData(data);
        expect(() => snap.getLeafHash(-1)).toThrow(RangeError);
        expect(() => snap.getLeafHash(100)).toThrow(RangeError);
    });

    it('getProof throws on out-of-range index', () => {
        const snap = MerkleSnapshot.fromData(data);
        expect(() => snap.getProof(-1)).toThrow(RangeError);
        expect(() => snap.getProof(100)).toThrow(RangeError);
    });

    it('tracks reference counts via acquireRef()/releaseRef()', () => {
        const snap = MerkleSnapshot.fromData(data);
        expect(snap.refCount).toBe(0);

        snap.acquireRef();
        snap.acquireRef();
        expect(snap.refCount).toBe(2);

        expect(snap.releaseRef()).toBe(1);
        expect(snap.releaseRef()).toBe(0);
        expect(snap.refCount).toBe(0);
    });

    it('marks snapshots retired and prevents refcount underflow', () => {
        const snap = MerkleSnapshot.fromData(data);
        expect(snap.isRetired).toBe(false);
        snap.markRetired();
        expect(snap.isRetired).toBe(true);
        expect(() => snap.releaseRef()).toThrow(/underflow/i);
    });

    // Cross-validate: snapshot proofs should be verifiable by the old MerkleKernel
    it('produces proofs compatible with MerkleKernel.verifyProof', () => {
        const snap = MerkleSnapshot.fromData(data);
        for (let i = 0; i < data.length; i++) {
            const proof = snap.getProof(i);
            expect(MerkleKernel.verifyProof(proof)).toBe(true);
        }
    });
});
