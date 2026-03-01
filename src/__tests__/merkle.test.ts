import { describe, it, expect } from 'vitest';
import { MerkleKernel } from '../merkle';

describe('MerkleKernel', () => {
    const data = ['alpha', 'beta', 'gamma', 'delta'];

    it('builds a tree and produces a root hash', () => {
        const kernel = new MerkleKernel(data);
        expect(kernel.root).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces deterministic roots for identical data', () => {
        const a = new MerkleKernel(data);
        const b = new MerkleKernel(data);
        expect(a.root).toBe(b.root);
    });

    it('produces different roots for different data', () => {
        const a = new MerkleKernel(data);
        const b = new MerkleKernel(['x', 'y', 'z']);
        expect(a.root).not.toBe(b.root);
    });

    it('returns unique leaf hashes per index', () => {
        const kernel = new MerkleKernel(data);
        const hashes = data.map((_, i) => kernel.getLeafHash(i));
        expect(new Set(hashes).size).toBe(data.length);
    });

    it('generates a valid proof for each leaf', () => {
        const kernel = new MerkleKernel(data);
        for (let i = 0; i < data.length; i++) {
            const proof = kernel.getProof(i);
            expect(proof.leaf).toBe(kernel.getLeafHash(i));
            expect(proof.root).toBe(kernel.root);
            expect(proof.index).toBe(i);
            expect(MerkleKernel.verifyProof(proof)).toBe(true);
        }
    });

    it('verifyProof rejects a tampered leaf', () => {
        const kernel = new MerkleKernel(data);
        const proof = kernel.getProof(0);
        proof.leaf = 'ff'.repeat(32);
        expect(MerkleKernel.verifyProof(proof)).toBe(false);
    });

    it('verifyProof rejects a tampered audit path', () => {
        const kernel = new MerkleKernel(data);
        const proof = kernel.getProof(1);
        proof.auditPath[0] = 'aa'.repeat(32);
        expect(MerkleKernel.verifyProof(proof)).toBe(false);
    });

    it('handles a single-element tree', () => {
        const kernel = new MerkleKernel(['solo']);
        const proof = kernel.getProof(0);
        expect(MerkleKernel.verifyProof(proof)).toBe(true);
    });

    it('handles odd-count data', () => {
        const kernel = new MerkleKernel(['a', 'b', 'c']);
        for (let i = 0; i < 3; i++) {
            expect(MerkleKernel.verifyProof(kernel.getProof(i))).toBe(true);
        }
    });

    it('handles a large tree', () => {
        const bigData = Array.from({ length: 100 }, (_, i) => `item_${i}`);
        const kernel = new MerkleKernel(bigData);
        for (let i = 0; i < bigData.length; i++) {
            expect(MerkleKernel.verifyProof(kernel.getProof(i))).toBe(true);
        }
    });

    it('addLeaves appends and rebuilds', () => {
        const kernel = new MerkleKernel(['a', 'b']);
        const oldRoot = kernel.root;
        const startIdx = kernel.addLeaves(['c', 'd']);
        expect(startIdx).toBe(2);
        expect(kernel.root).not.toBe(oldRoot);
        for (let i = 0; i < 4; i++) {
            expect(MerkleKernel.verifyProof(kernel.getProof(i))).toBe(true);
        }
    });

    it('verifyProof with matching expectedRoot passes', () => {
        const kernel = new MerkleKernel(data);
        const proof = kernel.getProof(1);
        expect(MerkleKernel.verifyProof(proof, kernel.root)).toBe(true);
    });

    it('handles an empty data array without crashing (root is a zero-hash string)', () => {
        const kernel = new MerkleKernel([]);
        expect(typeof kernel.root).toBe('string');
        expect(kernel.root.length).toBeGreaterThan(0);
    });

    it('verifyProof rejects a self-consistent proof from a different (stale) tree', () => {
        // Build two independent trees — proof from tree A is self-consistent
        // but should fail when validated against tree B's authoritative root.
        const kernelA = new MerkleKernel(['alpha', 'beta', 'gamma', 'delta']);
        const kernelB = new MerkleKernel(['x', 'y', 'z', 'w']);
        const proofFromA = kernelA.getProof(0);
        // Self-consistent check still passes
        expect(MerkleKernel.verifyProof(proofFromA)).toBe(true);
        // But fails when held against kernel B's authoritative root
        expect(MerkleKernel.verifyProof(proofFromA, kernelB.root)).toBe(false);
    });
});
