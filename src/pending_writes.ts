import { createHash } from 'crypto';
import { Hash, TOMBSTONE_HASH } from './types';
import { MerkleSnapshot } from './merkle_snapshot';
import { IncrementalMerkleTree } from './incremental_merkle';

/**
 * Represents a single pending operation (add or tombstone).
 * Operations are ordered and applied sequentially during commit.
 */
export type PendingOp =
    | { kind: 'add'; data: string }
    | { kind: 'tombstone'; index: number };

/**
 * PENDING WRITES — Accumulator for uncommitted mutations.
 *
 * Collects add/tombstone operations between commits.  When apply() is called,
 * it merges the pending ops with the current snapshot to produce a new
 * immutable MerkleSnapshot.
 *
 * Design:
 *   - Writers append to this buffer (single-writer, no lock needed).
 *   - Readers never see this buffer — they read from the active snapshot.
 *   - apply() is the only sync point with the snapshot lifecycle.
 */
export class PendingWrites {
    /** The snapshot version this buffer was started against. */
    readonly baseVersion: number;
    private ops: PendingOp[] = [];
    private addCount = 0;

    constructor(baseVersion: number) {
        this.baseVersion = baseVersion;
    }

    /**
     * Queue a new atom for addition.
     * Returns the expected index it will occupy after commit.
     */
    addLeaf(data: string): number {
        // Track queued adds incrementally to keep addLeaf O(1).
        const addCount = this.addCount;
        this.ops.push({ kind: 'add', data });
        this.addCount++;
        // Expected index = current snapshot leafCount + prior adds in this buffer
        // (actual index is resolved at apply time — this is a hint)
        return addCount;
    }

    /**
     * Queue a tombstone operation on an existing leaf index.
     */
    tombstone(index: number): void {
        this.ops.push({ kind: 'tombstone', index });
    }

    /**
     * True if no operations have been queued.
     */
    isEmpty(): boolean {
        return this.ops.length === 0;
    }

    /**
     * Number of queued operations.
     */
    get size(): number {
        return this.ops.length;
    }

    /**
     * Read-only access to queued operations (for WAL serialization).
     */
    getOps(): ReadonlyArray<PendingOp> {
        return this.ops;
    }

    /**
     * Apply all pending operations to the given snapshot, producing a new
     * immutable snapshot with an incremented version.
     *
     * Operations are applied in order:
     *   1. Tombstones replace the leaf at `index` with the zero sentinel.
     *   2. Adds append new leaf hashes to the end.
     *
     * Implementation: uses IncrementalMerkleTree to avoid a full O(N) rebuild.
     * Each tombstone costs O(log N) and each append costs O(log N) (amortised)
     * — the tree only rebuilds in full when appending pushes leafCount beyond
     * the current power-of-2 capacity, which is rare.
     *
     * The result is a brand-new MerkleSnapshot — the input is never mutated.
     *
     * @returns { snapshot, addedIndices } where addedIndices maps each add
     *          operation to its final leaf index in the new snapshot.
     */
    apply(snapshot: MerkleSnapshot): {
        snapshot: MerkleSnapshot;
        addedIndices: number[];
    } {
        if (this.ops.length === 0) {
            return { snapshot, addedIndices: [] };
        }

        const tree = IncrementalMerkleTree.fromSnapshot(snapshot);
        const tombstoneHash = Buffer.from(TOMBSTONE_HASH, 'hex');
        const addedIndices: number[] = [];

        for (const op of this.ops) {
            if (op.kind === 'tombstone') {
                if (op.index < 0 || op.index >= tree.leafCount) {
                    throw new RangeError(
                        `Tombstone index ${op.index} out of range (${tree.leafCount} leaves).`
                    );
                }
                tree.updateLeaf(op.index, tombstoneHash);
            } else {
                // 'add'
                const hash = createHash('sha256').update(op.data).digest();
                const newIndex = tree.leafCount;
                tree.appendLeaf(hash);
                addedIndices.push(newIndex);
            }
        }

        const newSnapshot = tree.toSnapshot(snapshot.version + 1);
        return { snapshot: newSnapshot, addedIndices };
    }

    /**
     * Discard all pending operations (e.g., after a failed commit).
     */
    clear(): void {
        this.ops = [];
        this.addCount = 0;
    }
}
