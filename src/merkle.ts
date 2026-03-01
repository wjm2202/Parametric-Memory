import { createHash } from 'crypto';
import { Hash, MerkleProof } from './types';

export class MerkleKernel {
    private leaves: Buffer[] = [];

    constructor(dataBlocks: string[]) {
        this.leaves = dataBlocks.map(d => this.hash(d));
        // Tree is not materialised in memory — root and proofs are computed on demand.
    }

    /**
     * Append new data blocks and rebuild the tree.
     * Returns the starting index of the newly added leaves.
     */
    addLeaves(dataBlocks: string[]): number {
        const startIdx = this.leaves.length;
        this.leaves.push(...dataBlocks.map(d => this.hash(d)));
        return startIdx;
    }

    private hash(data: string | Buffer): Buffer {
        return createHash('sha256').update(data).digest();
    }

    /**
     * Compute the Merkle root on demand — O(N) hashing, O(N) temporary
     * allocation that is released immediately after the call.
     * The full tree is never resident in memory.
     */
    get root(): Hash {
        if (this.leaves.length === 0) return '0'.repeat(64);
        let layer = this.leaves;
        while (layer.length > 1) {
            const next: Buffer[] = [];
            for (let i = 0; i < layer.length; i += 2) {
                next.push(this.hash(Buffer.concat([layer[i], layer[i + 1] || layer[i]])));
            }
            layer = next;
        }
        return layer[0].toString('hex');
    }

    getLeafHash(index: number): Hash {
        return this.leaves[index].toString('hex');
    }

    /**
     * Generate a Merkle proof by walking the tree level-by-level on demand.
     * Only O(log N) hashes are retained per call; no tree is stored.
     */
    getProof(index: number): MerkleProof {
        const auditPath: Hash[] = [];
        let layer = this.leaves;
        let currIdx = index;
        while (layer.length > 1) {
            const siblingIdx = currIdx % 2 === 0 ? currIdx + 1 : currIdx - 1;
            auditPath.push((layer[siblingIdx] || layer[currIdx]).toString('hex'));
            const next: Buffer[] = [];
            for (let i = 0; i < layer.length; i += 2) {
                next.push(this.hash(Buffer.concat([layer[i], layer[i + 1] || layer[i]])));
            }
            layer = next;
            currIdx = Math.floor(currIdx / 2);
        }
        return { leaf: this.getLeafHash(index), root: this.root, auditPath, index };
    }

    /**
     * Verify a Merkle proof by recomputing the root from the leaf and audit path.
     *
     * @param proof        The proof to verify (self-consistent check).
     * @param expectedRoot When provided, the recomputed root must also match this
     *                     authoritative value — prevents accepting a proof generated
     *                     from a previous or forked tree state.
     */
    static verifyProof(proof: MerkleProof, expectedRoot?: Hash): boolean {
        let current = Buffer.from(proof.leaf, 'hex');
        let idx = proof.index;

        for (const siblingHex of proof.auditPath) {
            const sibling = Buffer.from(siblingHex, 'hex');
            const isRight = idx % 2 === 1;
            const combined = isRight
                ? Buffer.concat([sibling, current])
                : Buffer.concat([current, sibling]);
            current = createHash('sha256').update(combined).digest();
            idx = Math.floor(idx / 2);
        }

        const recomputedRoot = current.toString('hex');
        if (expectedRoot !== undefined) {
            return recomputedRoot === proof.root && proof.root === expectedRoot;
        }
        return recomputedRoot === proof.root;
    }
}