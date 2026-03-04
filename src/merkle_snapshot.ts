import { createHash } from 'crypto';
import { Hash, MerkleProof, TOMBSTONE_HASH } from './types';

const ZERO_BUFFER = Buffer.alloc(32);

/**
 * MERKLE SNAPSHOT — Immutable, versioned Merkle tree state.
 *
 * A snapshot holds a frozen copy of the leaf array and lazily computes
 * the root and proofs on demand.  Once created, no method mutates the
 * internal state — callers can safely read from a snapshot while a new
 * one is being assembled in the background.
 *
 * Design invariant: every public method is pure.  Mutations happen
 * exclusively through PendingWrites.apply(snapshot) → new snapshot.
 */
export class MerkleSnapshot {
    /** Immutable leaf array — never modified after construction. */
    readonly leaves: ReadonlyArray<Buffer>;
    /** Monotonically increasing version counter. */
    readonly version: number;

    /** Lazily-computed root hash (cached after first access). */
    private _root: Hash | null = null;
    /**
     * Lazily-computed cached internal node array (heap-indexed binary tree).
     * Used for O(log N) proof generation without full tree recomputation.
     * Built once on first getProof() call, then reused.
     */
    private _nodes: Buffer[] | null = null;
    /** Number of in-flight readers currently holding this snapshot. */
    private _refCount: number = 0;
    /** Whether this snapshot has been superseded by a newer active snapshot. */
    private _retired: boolean = false;

    constructor(leaves: Buffer[], version: number) {
        // Defensive freeze: shallow copy so caller can't mutate our array
        this.leaves = Object.freeze([...leaves]);
        this.version = version;
    }

    // ─── Static factory helpers ─────────────────────────────────────────

    /**
     * Create the initial snapshot from raw data strings.
     * Used once at shard startup.
     */
    static fromData(dataBlocks: string[], version: number = 0): MerkleSnapshot {
        const leaves = dataBlocks.map(d =>
            createHash('sha256').update(d).digest()
        );
        return new MerkleSnapshot(leaves, version);
    }

    /**
     * Create an empty snapshot (version 0).
     */
    static empty(): MerkleSnapshot {
        return new MerkleSnapshot([], 0);
    }

    // ─── Read-only accessors ────────────────────────────────────────────

    get leafCount(): number {
        return this.leaves.length;
    }

    get refCount(): number {
        return this._refCount;
    }

    get isRetired(): boolean {
        return this._retired;
    }

    acquireRef(): void {
        this._refCount++;
    }

    releaseRef(): number {
        if (this._refCount <= 0) {
            throw new Error(`Snapshot v${this.version} refcount underflow.`);
        }
        this._refCount--;
        return this._refCount;
    }

    markRetired(): void {
        this._retired = true;
    }

    /**
     * Compute the Merkle root on demand.  Cached after first call.
     * O(N) on first access, O(1) thereafter.
     */
    get root(): Hash {
        if (this._root !== null) return this._root;
        if (this.leaves.length === 0) {
            this._root = '0'.repeat(64);
            return this._root;
        }
        this.buildNodeCache();
        this._root = this._nodes![0].toString('hex');
        return this._root;
    }

    getLeafHash(index: number): Hash {
        if (index < 0 || index >= this.leaves.length) {
            throw new RangeError(`Leaf index ${index} out of range (snapshot has ${this.leaves.length} leaves).`);
        }
        return this.leaves[index].toString('hex');
    }

    /**
     * Generate a Merkle proof for leaf at `index`.
     * Uses the cached internal node array for O(log N) proof extraction.
     */
    getProof(index: number): MerkleProof {
        if (index < 0 || index >= this.leaves.length) {
            throw new RangeError(`Leaf index ${index} out of range (snapshot has ${this.leaves.length} leaves).`);
        }
        this.buildNodeCache();

        const n = this.nextPow2(this.leaves.length);
        const nodes = this._nodes!;
        // n is always a power of two, so proof depth is log2(n).
        let depth = 0;
        for (let p = n; p > 1; p >>= 1) depth++;
        const auditPath = new Array<Hash>(depth);
        let level = 0;
        let pos = n - 1 + index; // position of leaf in heap array

        while (pos > 0) {
            // Sibling is the other child of the same parent
            const sibling = pos % 2 === 0 ? pos - 1 : pos + 1;
            // With zero-padding every slot up to 2n-2 is explicitly allocated,
            // so the sibling is always within bounds — fall back to a zero
            // buffer only as a defensive guard.
            const siblingNode = sibling < nodes.length ? nodes[sibling] : ZERO_BUFFER;
            auditPath[level++] = siblingNode.toString('hex');
            pos = Math.floor((pos - 1) / 2); // parent
        }

        return {
            leaf: this.leaves[index].toString('hex'),
            root: this.root,
            auditPath,
            index,
        };
    }

    /**
     * Verify a Merkle proof (static — works without a snapshot instance).
     * Delegates to the same algorithm as MerkleKernel.verifyProof.
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

    // ─── Internal helpers ───────────────────────────────────────────────

    private hash(data: Buffer): Buffer {
        return createHash('sha256').update(data).digest();
    }

    /**
     * Smallest power of 2 ≥ n.  Used to size the heap-indexed node array.
     */
    private nextPow2(n: number): number {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    /**
     * Build the full heap-indexed node array.
     * nodes[0]          = root
     * nodes[n-1 .. 2n-2] = leaves (zero-padded to next power of 2)
     *
     * Padding strategy: slots beyond the real leaf count are filled with
     * 32 zero bytes.  This matches IncrementalMerkleTree so that both
     * classes produce the same root for identical leaf data, enabling
     * O(log N) incremental updates in PendingWrites.apply().
     *
     * This is computed once per snapshot and cached.  The cost is O(N)
     * which is the same as the old MerkleKernel.root getter, but we
     * also get O(log N) proof generation from the cache.
     */
    private buildNodeCache(): void {
        if (this._nodes !== null) return;

        const n = this.nextPow2(this.leaves.length);
        const totalNodes = 2 * n - 1;
        const nodes = new Array<Buffer>(totalNodes);
        const zeroPad = Buffer.alloc(32);

        // Fill leaf slots — real leaves first, then zero padding
        for (let i = 0; i < n; i++) {
            nodes[n - 1 + i] = i < this.leaves.length
                ? this.leaves[i]
                : zeroPad;
        }

        // Build internal nodes bottom-up
        for (let i = n - 2; i >= 0; i--) {
            const left = nodes[2 * i + 1];
            const right = nodes[2 * i + 2];
            nodes[i] = this.hash(Buffer.concat([left, right]));
        }

        this._nodes = nodes;
    }
}
