import { createHash } from 'crypto';
import { Hash, MerkleProof } from './types';
import { MerkleSnapshot } from './merkle_snapshot';

const ZERO_BUFFER = Buffer.alloc(32); // 32 zero bytes — zero-padding sentinel

/**
 * INCREMENTAL MERKLE TREE — Mutable, heap-indexed binary tree.
 *
 * Motivation
 * ----------
 * MerkleSnapshot rebuilds the entire node array from scratch every time
 * PendingWrites.apply() produces a new snapshot.  For large shards with many
 * atoms, this is O(N) per commit even when only a tiny fraction of leaves
 * change.
 *
 * IncrementalMerkleTree maintains a live, mutable node array and supports
 * in-place updates and appends:
 *
 *   updateLeaf(index, hash)  O(log N)   — tombstone or update one leaf
 *   appendLeaf(hash)         O(log N)   — add a new leaf within capacity
 *                            O(N)       — rare: only when tree doubles
 *
 * Padding strategy: zero-padding
 * --------------------------------
 * Padded leaf slots (indices ≥ leafCount, < capacity) hold 32 zero bytes.
 * This makes appends purely O(log N): only the new leaf slot and its ancestor
 * path need recomputation; all remaining padded zero slots stay untouched.
 *
 * MerkleSnapshot.buildNodeCache() has been updated to use the same zero-
 * padding strategy so that roots produced by both classes agree for identical
 * leaf data.
 *
 * Node layout (heap-indexed)
 * --------------------------
 *   nodes[0]          = root
 *   nodes[n-1 .. 2n-2] = leaf level (n = nextPow2(capacity))
 *   nodes[i]          = SHA-256(nodes[2i+1] ‖ nodes[2i+2])
 */
export class IncrementalMerkleTree {
    /** Heap-indexed node array; length = 2 * capacity - 1. */
    private nodes: Buffer[];
    /** Real leaf values — never includes padding. */
    private _leaves: Buffer[];
    /** Next power-of-2 ≥ initial leaf count.  The tree expands by doubling. */
    private capacity: number;

    private constructor(nodes: Buffer[], leaves: Buffer[], capacity: number) {
        this.nodes = nodes;
        this._leaves = leaves;
        this.capacity = capacity;
    }

    // ─── Static factories ───────────────────────────────────────────────

    /**
     * Build a new tree from a raw leaf array.
     * O(N) — full bottom-up construction.
     */
    static fromLeaves(leaves: Buffer[]): IncrementalMerkleTree {
        const capacity = IncrementalMerkleTree.nextPow2(leaves.length || 1);
        const nodes = IncrementalMerkleTree.buildNodes(leaves, capacity);
        return new IncrementalMerkleTree(nodes, leaves.slice(), capacity);
    }

    /**
     * Build a new tree from an existing immutable snapshot.
     * Clones the leaf array — does not share buffers with the snapshot.
     */
    static fromSnapshot(snapshot: MerkleSnapshot): IncrementalMerkleTree {
        return IncrementalMerkleTree.fromLeaves([...snapshot.leaves]);
    }

    // ─── Mutating operations ────────────────────────────────────────────

    /**
     * Replace the hash at `index` with `newLeafHash`.
     * O(log N) — walks the ancestor path from the leaf up to the root.
     *
     * Typical use: apply a tombstone TOMBSTONE_HASH to an existing leaf.
     */
    updateLeaf(index: number, newLeafHash: Buffer): void {
        if (index < 0 || index >= this._leaves.length) {
            throw new RangeError(
                `Leaf index ${index} out of range (tree has ${this._leaves.length} leaves).`
            );
        }
        this._leaves[index] = newLeafHash;
        this.propagateUp(this.capacity - 1 + index, newLeafHash);
    }

    /**
     * Append a new leaf at the end of the tree.
     *
     * - If there is room within the current capacity: O(log N).
     *   The new leaf occupies a previously-zero slot; only its ancestor
     *   path is recomputed.
     * - If the tree is at capacity: O(N) full rebuild (capacity doubles).
     *   This is amortised O(log N) per append over the lifetime of the tree.
     */
    appendLeaf(leafHash: Buffer): void {
        const newCount = this._leaves.length + 1;
        if (newCount > this.capacity) {
            // Rare path: double capacity, full O(N) rebuild.
            this._leaves.push(leafHash);
            const newCapacity = IncrementalMerkleTree.nextPow2(newCount);
            this.nodes = IncrementalMerkleTree.buildNodes(this._leaves, newCapacity);
            this.capacity = newCapacity;
        } else {
            // Common path: slot was zero-padded; update it and walk up.
            const pos = this.capacity - 1 + this._leaves.length;
            this._leaves.push(leafHash);
            this.propagateUp(pos, leafHash);
        }
    }

    // ─── Read-only accessors ────────────────────────────────────────────

    get leafCount(): number {
        return this._leaves.length;
    }

    get root(): Hash {
        if (this._leaves.length === 0) return '0'.repeat(64);
        return this.nodes[0].toString('hex');
    }

    /**
     * Generate a Merkle proof for leaf at `index`.
     * O(log N) — reads directly from the cached node array.
     */
    getProof(index: number): MerkleProof {
        if (index < 0 || index >= this._leaves.length) {
            throw new RangeError(
                `Leaf index ${index} out of range (tree has ${this._leaves.length} leaves).`
            );
        }

        const auditPath: Hash[] = [];
        let pos = this.capacity - 1 + index;

        while (pos > 0) {
            const sibling = pos % 2 === 0 ? pos - 1 : pos + 1;
            const siblingBuf = sibling < this.nodes.length ? this.nodes[sibling] : ZERO_BUFFER;
            auditPath.push(siblingBuf.toString('hex'));
            pos = Math.floor((pos - 1) / 2);
        }

        return {
            leaf: this._leaves[index].toString('hex'),
            root: this.root,
            auditPath,
            index,
        };
    }

    /**
     * Materialise the current tree state as an immutable MerkleSnapshot.
     * The snapshot shares no mutable state with this tree.
     */
    toSnapshot(version: number): MerkleSnapshot {
        return new MerkleSnapshot(this._leaves, version);
    }

    // ─── Private helpers ────────────────────────────────────────────────

    /**
     * Recompute the node at `pos` and propagate changes up to the root.
     *
     * @param pos     Heap index of the starting node (a leaf).
     * @param value   New hash value for that node.
     */
    private propagateUp(pos: number, value: Buffer): void {
        this.nodes[pos] = value;
        while (pos > 0) {
            pos = Math.floor((pos - 1) / 2); // parent
            const left = this.nodes[2 * pos + 1];
            const right = this.nodes[2 * pos + 2];
            this.nodes[pos] = createHash('sha256')
                .update(Buffer.concat([left, right]))
                .digest();
        }
    }

    /**
     * Full bottom-up construction of the node array for any leaf set.
     * Pads missing slots with ZERO_BUFFER.
     */
    private static buildNodes(leaves: Buffer[], capacity: number): Buffer[] {
        const totalNodes = 2 * capacity - 1;
        const nodes = new Array<Buffer>(totalNodes);

        // Fill leaf level — real leaves first, then zero padding
        for (let i = 0; i < capacity; i++) {
            nodes[capacity - 1 + i] = i < leaves.length ? leaves[i] : ZERO_BUFFER;
        }

        // Build internal nodes bottom-up
        for (let i = capacity - 2; i >= 0; i--) {
            nodes[i] = createHash('sha256')
                .update(Buffer.concat([nodes[2 * i + 1], nodes[2 * i + 2]]))
                .digest();
        }

        return nodes;
    }

    private static nextPow2(n: number): number {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }
}
