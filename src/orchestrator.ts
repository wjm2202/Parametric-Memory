import { ShardWorker } from './shard_worker';
import { MasterKernel } from './master';
import { ShardRouter } from './router';
import { DataAtom, PredictionReport } from './types';
import { performance } from 'perf_hooks';

export class ShardedOrchestrator {
    private shards: Map<number, ShardWorker> = new Map();
    private master: MasterKernel = new MasterKernel();
    private router: ShardRouter;
    private lastShard: number | null = null;
    private ready = false;
    private readonly pendingHighWaterMark: number;
    private readonly backpressureRetryAfterSec: number;

    constructor(
        numShards: number,
        data: DataAtom[],
        dbBasePath: string = './mmpm-db',
        options?: {
            /**
             * Auto-commit after this many pending writes accumulate per shard.
             * Overridden by env var MMPM_COMMIT_THRESHOLD if set.
             */
            commitThreshold?: number;
            /**
             * Auto-commit every N milliseconds per shard (0 = disabled).
             * Overridden by env var MMPM_COMMIT_INTERVAL_MS if set.
             */
            commitIntervalMs?: number;
            /**
             * Backpressure threshold for total pending writes.
             * Combined pressure = shard pending writes + pipeline queue depth.
             */
            pendingHighWaterMark?: number;
            /**
             * Retry-After seconds returned when backpressure rejects /atoms.
             */
            backpressureRetryAfterSec?: number;
        }
    ) {
        const parsePositiveInt = (raw?: string): number | undefined => {
            if (!raw) return undefined;
            const parsed = parseInt(raw, 10);
            if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
            return parsed;
        };

        // Env vars take precedence over constructor options
        const envThreshold = process.env.MMPM_COMMIT_THRESHOLD
            ? parseInt(process.env.MMPM_COMMIT_THRESHOLD, 10)
            : undefined;
        const envIntervalMs = process.env.MMPM_COMMIT_INTERVAL_MS
            ? parseInt(process.env.MMPM_COMMIT_INTERVAL_MS, 10)
            : undefined;
        const envPendingHighWaterMark = parsePositiveInt(process.env.MMPM_PENDING_HIGH_WATER_MARK);
        const envRetryAfterSec = parsePositiveInt(process.env.MMPM_BACKPRESSURE_RETRY_AFTER_SEC);

        const commitThreshold = envThreshold ?? options?.commitThreshold;
        const commitIntervalMs = envIntervalMs ?? options?.commitIntervalMs;
        this.pendingHighWaterMark = envPendingHighWaterMark ?? options?.pendingHighWaterMark ?? 1000;
        this.backpressureRetryAfterSec = envRetryAfterSec ?? options?.backpressureRetryAfterSec ?? 1;

        this.router = new ShardRouter(numShards);
        const buckets: Map<number, DataAtom[]> = new Map();

        // 1. Group data using Consistent Hashing
        data.forEach(item => {
            const idx = this.router.getShardIndex(item);
            if (!buckets.has(idx)) buckets.set(idx, []);
            buckets.get(idx)!.push(item);
        });

        // 2. Initialize Shards, forwarding scheduling policy
        for (let i = 0; i < numShards; i++) {
            const shardData = buckets.get(i) || [];
            const worker = new ShardWorker(shardData, `${dbBasePath}/shard_${i}`, {
                commitThreshold,
                commitIntervalMs,
                shardId: i,
            });
            this.shards.set(i, worker);
        }
    }

    async init() {
        this.ready = false;
        // Initialise all shards in parallel — they write to independent LevelDB
        // instances so there is no contention between them.
        await Promise.all(
            Array.from(this.shards.entries()).map(([, shard]) => shard.init())
        );
        // Collect all roots + shard snapshot versions and update the master in
        // one pass (single rebuild, single version bump) rather than N rebuilds.
        const rootUpdates = new Map<number, string>();
        const shardVersions = new Map<number, number>();
        for (const [id, shard] of this.shards.entries()) {
            rootUpdates.set(id, shard.getKernelRoot());
            shardVersions.set(id, shard.snapshotVersion);
        }
        this.master.batchUpdateShardRoots(rootUpdates, shardVersions);
        this.ready = true;
    }

    async access(item: DataAtom): Promise<PredictionReport> {
        const start = performance.now();
        const sIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(sIdx);

        if (!shard) throw new Error(`Shard ${sIdx} not initialized for item ${item}`);

        const result = await shard.access(item);

        // Record inter-shard transitions (lastShard tracking only)
        if (this.lastShard !== null && this.lastShard !== sIdx) {
            // no-op: globalMatrix removed (6.3) — tracking preserved for routing heuristics
        }

        this.lastShard = sIdx;

        // Resolve cross-shard predictions: if the local shard couldn't resolve
        // the predicted hash to an atom, search the shard that owns it.
        let predictedNext = result.next;
        let predictedProof = result.nextProof;

        if (predictedNext === null && result.predictedHash !== null) {
            for (const otherShard of this.shards.values()) {
                const resolved = otherShard.resolveByHash(result.predictedHash);
                if (resolved !== null) {
                    // Skip tombstoned atoms — getHash() returns undefined for tombstoned
                    if (otherShard.getHash(resolved.atom) === undefined) break;
                    predictedNext = resolved.atom;
                    predictedProof = resolved.proof;
                    break;
                }
            }
        }

        return {
            currentData: item,
            currentProof: result.proof,
            shardRootProof: this.master.getShardProof(sIdx),
            predictedNext,
            predictedProof,
            latencyMs: performance.now() - start,
            treeVersion: this.master.currentVersion,
        };
    }

    /**
     * Optional warm-read path for pending atoms (Story 5.5).
     * Returns unverified data (no proof) only when the atom exists but has not
     * yet been committed into a snapshot.
     */
    tryWarmRead(item: DataAtom): {
        currentData: DataAtom;
        currentProof: null;
        shardRootProof?: undefined;
        predictedNext: null;
        predictedProof: null;
        latencyMs: number;
        treeVersion: number;
        verified: false;
    } | null {
        const start = performance.now();
        const sIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(sIdx);
        if (!shard) return null;
        if (!shard.isPendingAtom(item)) return null;

        return {
            currentData: item,
            currentProof: null,
            predictedNext: null,
            predictedProof: null,
            latencyMs: performance.now() - start,
            treeVersion: this.master.currentVersion,
            verified: false,
        };
    }

    /**
     * Train/Reinforce a sequence across the sharded cluster.
     * Training writes to the Markov matrix only — completely decoupled
     * from the Merkle tree state.  No commit needed.
     */
    async train(sequence: string[]): Promise<void> {
        for (let i = 0; i < sequence.length - 1; i++) {
            const from = sequence[i];
            const to = sequence[i + 1];

            const fromShardIdx = this.router.getShardIndex(from);
            const shard = this.shards.get(fromShardIdx);

            if (shard) {
                const toShardIdx = this.router.getShardIndex(to);
                const toShard = this.shards.get(toShardIdx);

                const fromHash = shard.getHash(from);
                const toHash = toShard?.getHash(to);

                if (fromHash && toHash) {
                    await shard.recordTransition(fromHash, toHash);
                }
            }
        }
    }

    /**
     * Aggregate trained-atom and edge counts across all shards.
     */
    getClusterStats(): { trainedAtoms: number; totalEdges: number } {
        let trainedAtoms = 0;
        let totalEdges = 0;
        for (const shard of this.shards.values()) {
            const s = shard.getStats();
            trainedAtoms += s.trainedAtoms;
            totalEdges += s.totalEdges;
        }
        return { trainedAtoms, totalEdges };
    }

    /**
     * Return a live health snapshot for every shard plus cluster-level stats.
     * Consumed by GET /health (Story 7.4).
     */
    getClusterHealth() {
        return {
            treeVersion: this.master.currentVersion,
            pendingHighWaterMark: this.pendingHighWaterMark,
            shards: Array.from(this.shards.entries()).map(([id, shard]) => {
                const epoch = shard.getEpochStatus();
                const totalActiveReaders = Object.values(epoch.activeReadersByEpoch)
                    .reduce((sum, n) => sum + n, 0);
                return {
                    id,
                    pendingWrites: shard.pendingCount,
                    snapshotVersion: shard.snapshotVersion,
                    isCommitting: epoch.isCommitting,
                    activeReaders: totalActiveReaders,
                };
            }),
            clusterStats: this.getClusterStats(),
        };
    }

    /** Total uncommitted writes currently buffered inside shards. */
    getTotalShardPendingWrites(): number {
        let total = 0;
        for (const shard of this.shards.values()) total += shard.pendingCount;
        return total;
    }

    /** Backpressure decision for incoming /atoms writes. */
    getWriteAdmission(pipelineQueueDepth: number, incomingAtoms: number): {
        accept: boolean;
        retryAfterSec: number;
        totalShardPendingWrites: number;
        projectedPendingWrites: number;
        highWaterMark: number;
    } {
        const totalShardPendingWrites = this.getTotalShardPendingWrites();
        const projectedPendingWrites = totalShardPendingWrites + pipelineQueueDepth + incomingAtoms;
        return {
            accept: projectedPendingWrites <= this.pendingHighWaterMark,
            retryAfterSec: this.backpressureRetryAfterSec,
            totalShardPendingWrites,
            projectedPendingWrites,
            highWaterMark: this.pendingHighWaterMark,
        };
    }

    /**
     * Return the outgoing weight map for an atom.
     */
    getWeights(item: DataAtom): { to: DataAtom; weight: number }[] | null {
        const shardIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(shardIdx);
        if (!shard) return null;

        const raw = shard.getWeights(item);
        if (raw === null) return null;

        return raw.map(entry => {
            if (entry.to !== null) return { to: entry.to, weight: entry.weight };
            for (const other of this.shards.values()) {
                const resolved = other.resolveByHash(entry.toHash);
                if (resolved) return { to: resolved.atom, weight: entry.weight };
            }
            return null;
        }).filter((e): e is { to: DataAtom; weight: number } => e !== null);
    }

    /**
     * Register new atoms at runtime.
     *
     * Routes each atom to its shard, then adds and commits all affected shards
     * in parallel — shard operations are independent so there is no reason to
     * serialise them. After all commits complete, a single batchUpdateShardRoots()
     * call rebuilds the master kernel once and increments the version once,
     * rather than N rebuilds for N shards.
     *
     * @returns The new master treeVersion after all atoms are committed.
     */
    async addAtoms(atoms: DataAtom[]): Promise<number> {
        // Group atoms by their target shard
        const buckets = new Map<number, DataAtom[]>();
        for (const atom of atoms) {
            const shardIdx = this.router.getShardIndex(atom);
            if (!buckets.has(shardIdx)) buckets.set(shardIdx, []);
            buckets.get(shardIdx)!.push(atom);
        }

        // Add + commit all affected shards in parallel
        await Promise.all(
            Array.from(buckets.entries()).map(async ([shardIdx, shardAtoms]) => {
                const shard = this.shards.get(shardIdx);
                if (shard) {
                    await shard.addAtoms(shardAtoms);
                    await shard.commit();
                }
            })
        );

        // Single master rebuild + single version bump for the whole batch
        const rootUpdates = new Map<number, string>();
        const shardVersions = new Map<number, number>();
        for (const shardIdx of buckets.keys()) {
            const shard = this.shards.get(shardIdx);
            if (shard) {
                rootUpdates.set(shardIdx, shard.getKernelRoot());
                shardVersions.set(shardIdx, shard.snapshotVersion);
            }
        }
        this.master.batchUpdateShardRoots(rootUpdates, shardVersions);
        return this.master.currentVersion;
    }

    /**
     * Soft-delete an atom by tombstoning it on its owning shard.
     * Commits the shard immediately and updates the master root.
     *
     * @returns The new master treeVersion.
     * @throws  Error if the atom is not registered on any shard.
     */
    async removeAtom(atom: DataAtom): Promise<number> {
        const shardIdx = this.router.getShardIndex(atom);
        const shard = this.shards.get(shardIdx);
        if (!shard) throw new Error(`No shard found for atom '${atom}'.`);
        await shard.tombstoneAtom(atom);
        await shard.commit();
        this.master.updateShardRoot(shardIdx, shard.getKernelRoot(), shard.snapshotVersion);
        return this.master.currentVersion;
    }

    /**
     * Return every atom registered across all shards with its live status.
     */
    listAtoms(): { atom: DataAtom; status: 'active' | 'tombstoned' }[] {
        const result: { atom: DataAtom; status: 'active' | 'tombstoned' }[] = [];
        for (const shard of this.shards.values()) {
            result.push(...shard.getAtoms());
        }
        return result;
    }

    /** Current master-tree version. */
    getMasterVersion(): number {
        return this.master.currentVersion;
    }

    /** Readiness state used by orchestrator probes and startup guards. */
    isReady(): boolean {
        return this.ready;
    }

    /** Close all shard LevelDB instances gracefully. */
    async close(): Promise<void> {
        this.ready = false;
        for (const shard of this.shards.values()) {
            await shard.close();
        }
    }
}
