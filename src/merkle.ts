import { createHash } from 'crypto';
import { Hash, MerkleProof } from './types';

export class MerkleKernel {
    private leaves: Buffer[] = [];
    private tree: Buffer[][] = [];

    constructor(dataBlocks: string[]) {
        this.leaves = dataBlocks.map(d => this.hash(d));
        this.buildTree();
    }

    /**
     * Append new data blocks and rebuild the tree.
     * Returns the starting index of the newly added leaves.
     */
    addLeaves(dataBlocks: string[]): number {
        const startIdx = this.leaves.length;
        this.leaves.push(...dataBlocks.map(d => this.hash(d)));
        this.buildTree();
        return startIdx;
    }

    private hash(data: string | Buffer): Buffer {
        return createHash('sha256').update(data).digest();
    }

    private buildTree(): void {
        let layer = this.leaves;
        this.tree = [layer];
        while (layer.length > 1) {
            const nextLayer: Buffer[] = [];
            for (let i = 0; i < layer.length; i += 2) {
                const left = layer[i];
                const right = layer[i + 1] || left;
                nextLayer.push(this.hash(Buffer.concat([left, right])));
            }
            layer = nextLayer;
            this.tree.push(layer);
        }
    }

    get root(): Hash {
        const top = this.tree[this.tree.length - 1];
        if (!top || top.length === 0) return '0'.repeat(64);
        return top[0].toString('hex');
    }

    getLeafHash(index: number): Hash {
        return this.leaves[index].toString('hex');
    }

    getProof(index: number): MerkleProof {
        const auditPath: Hash[] = [];
        let currIdx = index;
        for (let i = 0; i < this.tree.length - 1; i++) {
            const layer = this.tree[i];
            const siblingIdx = (currIdx % 2 === 1) ? currIdx - 1 : currIdx + 1;
            auditPath.push((layer[siblingIdx] || layer[currIdx]).toString('hex'));
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