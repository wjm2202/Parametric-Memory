import { performance } from 'perf_hooks';
import { MerkleKernel } from './merkle';
import { Hash, MerkleProof } from './types';

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

    private recordVersionAfterRootChange(): void {
        // Re-build the master tree whenever child shard roots change.
        this.kernel = new MerkleKernel(this.shardRoots);
        this._version++;
        this.rootHistory.set(this._version, this.kernel.root);
        this.versionTimestampHistory.set(this._version, hrnow());

        // Evict the oldest entries once the history window is exceeded.
        const evictVersion = this._version - this.HISTORY_WINDOW;
        if (evictVersion > 0) {
            this.rootHistory.delete(evictVersion);
            this.versionTimestampHistory.delete(evictVersion);
        }
    }
}