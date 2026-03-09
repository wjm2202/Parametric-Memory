import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { MerkleKernel } from './merkle';
import { ConsistencyProof, Hash, MerkleProof } from './types';

const hrnow = (): number => performance.timeOrigin + performance.now();

export class MasterKernel {
    private shardRoots: Hash[] = [];
    private kernel: MerkleKernel | null = null;
    /** Monotonically increasing counter — incremented on every updateShardRoot call. */
    private _version: number = 0;
    /**
     * Maps masterVersion → masterRoot at that version.
     * Capped to the last HISTORY_WINDOW versions to bound memory usage.
     */
    private readonly rootHistory: Map<number, Hash> = new Map();
    private readonly versionTimestampHistory: Map<number, number> = new Map();
    /**
     * Maps masterVersion → snapshot of shard roots at that version.
     * Required for consistency proofs: verifier recomputes master root from shard roots.
     * Evicted alongside rootHistory entries.
     */
    private readonly shardRootSnapshots: Map<number, Hash[]> = new Map();
    private readonly HISTORY_WINDOW = 100;
    /**
     * Records the snapshot version that produced each shard's current root.
     * Used to detect and reject stale out-of-order updates.
     */
    private readonly shardSnapshotVersions: Map<number, number> = new Map();

    /** Current master-tree version. Stamped into every PredictionReport. */
    get currentVersion(): number {
        return this._version;
    }

    /**
     * Look up the authoritative master root for a specific tree version.
     * Returns undefined if the version has been evicted from the history window
     * (i.e. more than HISTORY_WINDOW structural changes have occurred since).
     */
    getRootAtVersion(v: number): Hash | undefined {
        return this.rootHistory.get(v);
    }

    /**
     * Lookup commit timestamp (Unix ms) associated with a master version.
     */
    getVersionTimestamp(v: number): number | undefined {
        return this.versionTimestampHistory.get(v);
    }

    /**
     * Returns the snapshot version whose root is currently registered for
     * the given shard, or undefined if the shard has never been updated.
     */
    getShardSnapshotVersion(shardIdx: number): number | undefined {
        return this.shardSnapshotVersions.get(shardIdx);
    }

    /**
     * Update a single shard root.
     *
     * @param snapshotVersion  The shard's snapshot version that produced this
     *   root.  When provided, updates whose snapshotVersion is ≤ the currently
     *   recorded version are treated as stale and silently ignored — this
     *   prevents a slow shard from overwriting a newer committed root.
     * @returns true if the update was applied, false if it was rejected as stale.
     */
    updateShardRoot(shardIdx: number, newRoot: Hash, snapshotVersion?: number): boolean {
        if (snapshotVersion !== undefined) {
            const recorded = this.shardSnapshotVersions.get(shardIdx);
            if (recorded !== undefined && snapshotVersion <= recorded) {
                return false; // stale — ignore
            }
            this.shardSnapshotVersions.set(shardIdx, snapshotVersion);
        }
        this.shardRoots[shardIdx] = newRoot;
        this.recordVersionAfterRootChange();
        return true;
    }

    /**
     * Batch update multiple shard roots in a single master-tree rebuild.
     *
     * When multiple shards are committed in parallel (e.g. addAtoms() routing
     * across N shards), calling updateShardRoot() N times would:
     *   - Rebuild the master MerkleKernel N times — O(N²) wasted work
     *   - Create N intermediate versions in rootHistory — noisy and misleading
     *
     * This method applies all root updates, rebuilds the kernel exactly once,
     * and increments the version exactly once — one logical operation, one version.
     *
     * Stale detection: if `shardVersions` is provided, entries whose snapshot
     * version is ≤ the currently recorded value for that shard are skipped.
     *
     * @param updates       Map of shardIndex → new root hash
     * @param shardVersions Optional map of shardIndex → shard snapshot version
     *                      used to detect and skip stale updates.
     */
    batchUpdateShardRoots(updates: Map<number, Hash>, shardVersions?: Map<number, number>): void {
        let anyApplied = false;
        for (const [shardIdx, newRoot] of updates) {
            if (shardVersions !== undefined) {
                const sv = shardVersions.get(shardIdx);
                if (sv !== undefined) {
                    const recorded = this.shardSnapshotVersions.get(shardIdx);
                    if (recorded !== undefined && sv <= recorded) continue; // stale
                    this.shardSnapshotVersions.set(shardIdx, sv);
                }
            }
            this.shardRoots[shardIdx] = newRoot;
            anyApplied = true;
        }
        if (!anyApplied) return;
        this.recordVersionAfterRootChange();
    }

    get masterRoot(): Hash {
        return this.kernel ? this.kernel.root : "0";
    }

    getShardProof(shardIdx: number): MerkleProof | undefined {
        return this.kernel?.getProof(shardIdx);
    }

    // -----------------------------------------------------------------------
    // Consistency Proofs
    // -----------------------------------------------------------------------

    /**
     * Generate a consistency proof between two master-tree versions.
     *
     * The proof contains the shard-root snapshots at both versions, allowing
     * an independent verifier to recompute both master roots and confirm
     * the tree evolved legitimately.
     *
     * @throws RangeError if either version is outside the history window.
     */
    getConsistencyProof(fromVersion: number, toVersion: number): ConsistencyProof {
        if (fromVersion >= toVersion) {
            throw new RangeError(`fromVersion (${fromVersion}) must be less than toVersion (${toVersion})`);
        }

        const fromRoot = this.rootHistory.get(fromVersion);
        const toRoot = this.rootHistory.get(toVersion);
        if (fromRoot === undefined) {
            throw new RangeError(`fromVersion ${fromVersion} is outside the history window (oldest: ${this.oldestVersion})`);
        }
        if (toRoot === undefined) {
            throw new RangeError(`toVersion ${toVersion} is outside the history window (newest: ${this._version})`);
        }

        const fromShardRoots = this.shardRootSnapshots.get(fromVersion);
        const toShardRoots = this.shardRootSnapshots.get(toVersion);
        if (!fromShardRoots || !toShardRoots) {
            throw new RangeError('Shard root snapshots missing for requested versions');
        }

        const fromTimestamp = this.versionTimestampHistory.get(fromVersion) ?? 0;
        const toTimestamp = this.versionTimestampHistory.get(toVersion) ?? 0;

        // Collect intermediate roots for chain-of-custody audit
        const intermediateRoots: Array<{ version: number; root: Hash }> = [];
        for (let v = fromVersion + 1; v < toVersion; v++) {
            const root = this.rootHistory.get(v);
            if (root !== undefined) {
                intermediateRoots.push({ version: v, root });
            }
        }

        return {
            fromVersion,
            toVersion,
            fromRoot,
            toRoot,
            fromTimestamp,
            toTimestamp,
            fromShardRoots: [...fromShardRoots],
            toShardRoots: [...toShardRoots],
            intermediateRoots,
        };
    }

    /**
     * Verify a consistency proof independently.
     *
     * Recomputes both master roots from the provided shard-root snapshots
     * and checks they match the stated hashes.  Also verifies the
     * intermediate chain is monotonically ordered.
     *
     * This is a static method — can be called without access to the server's
     * state, making it suitable for client-side verification.
     */
    static verifyConsistencyProof(proof: ConsistencyProof): { valid: boolean; reason?: string } {
        // 1. Version ordering
        if (proof.fromVersion >= proof.toVersion) {
            return { valid: false, reason: 'fromVersion must be less than toVersion' };
        }

        // 2. Recompute master root from fromShardRoots
        const recomputedFrom = MasterKernel.computeMasterRoot(proof.fromShardRoots);
        if (recomputedFrom !== proof.fromRoot) {
            return {
                valid: false,
                reason: `fromRoot mismatch: stated ${proof.fromRoot.slice(0, 16)}... recomputed ${recomputedFrom.slice(0, 16)}...`,
            };
        }

        // 3. Recompute master root from toShardRoots
        const recomputedTo = MasterKernel.computeMasterRoot(proof.toShardRoots);
        if (recomputedTo !== proof.toRoot) {
            return {
                valid: false,
                reason: `toRoot mismatch: stated ${proof.toRoot.slice(0, 16)}... recomputed ${recomputedTo.slice(0, 16)}...`,
            };
        }

        // 4. Verify intermediate chain is monotonically ordered
        let prevVersion = proof.fromVersion;
        for (const { version } of proof.intermediateRoots) {
            if (version <= prevVersion) {
                return {
                    valid: false,
                    reason: `Intermediate chain not monotonic at version ${version}`,
                };
            }
            prevVersion = version;
        }

        // 5. Verify timestamps are non-decreasing
        if (proof.toTimestamp < proof.fromTimestamp) {
            return {
                valid: false,
                reason: 'toTimestamp is earlier than fromTimestamp',
            };
        }

        return { valid: true };
    }

    /**
     * Compute a master Merkle root from shard roots — mirrors the internal
     * MerkleKernel construction.  Used for independent proof verification.
     */
    static computeMasterRoot(shardRoots: Hash[]): Hash {
        if (shardRoots.length === 0) return '0'.repeat(64);
        const kernel = new MerkleKernel(shardRoots);
        return kernel.root;
    }

    /** The oldest version still in the history window. */
    get oldestVersion(): number {
        const oldest = this._version - this.HISTORY_WINDOW + 1;
        return Math.max(1, oldest);
    }

    /** Current tree head: version + root + timestamp. */
    get treeHead(): { version: number; root: Hash; timestamp: number } {
        return {
            version: this._version,
            root: this.masterRoot,
            timestamp: this.versionTimestampHistory.get(this._version) ?? 0,
        };
    }

    private recordVersionAfterRootChange(): void {
        // Re-build the master tree whenever child shard roots change.
        this.kernel = new MerkleKernel(this.shardRoots);
        this._version++;
        this.rootHistory.set(this._version, this.kernel.root);
        this.versionTimestampHistory.set(this._version, hrnow());
        // Snapshot shard roots for consistency proofs
        this.shardRootSnapshots.set(this._version, [...this.shardRoots]);

        // Evict the oldest entries once the history window is exceeded.
        const evictVersion = this._version - this.HISTORY_WINDOW;
        if (evictVersion > 0) {
            this.rootHistory.delete(evictVersion);
            this.versionTimestampHistory.delete(evictVersion);
            this.shardRootSnapshots.delete(evictVersion);
        }
    }
}