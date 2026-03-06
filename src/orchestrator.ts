import { ShardWorker } from './shard_worker';
import { MasterKernel } from './master';
import { ShardRouter } from './router';
import { DataAtom, Hash, MerkleProof, PredictionReport } from './types';
import { performance } from 'perf_hooks';
import { assertAtomV1, assertAtomsV1, ATOM_TYPES, parseAtomV1 } from './atom_schema';
import { TransitionPolicy } from './transition_policy';
import { warmPredictionFallbackTotal } from './metrics';

export type BatchAccessResult =
    | ({ ok: true } & PredictionReport)
    | {
        ok: false;
        item: DataAtom;
        statusCode: number;
        error: string;
    };

export class ShardedOrchestrator {
    private shards: Map<number, ShardWorker> = new Map();
    private hashToShard: Map<Hash, number> = new Map();
    private master: MasterKernel = new MasterKernel();
    private router: ShardRouter;
    private lastShard: number | null = null;
    private ready = false;
    private policy: TransitionPolicy = TransitionPolicy.default();
    private readonly pendingHighWaterMark: number;
    private readonly backpressureRetryAfterSec: number;
    /** Maps atom string → master version at which it was committed. */
    private readonly atomCommittedAtVersion: Map<string, number> = new Map();

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
        assertAtomsV1(data, 'constructor.data');
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
            worker.setPolicy(this.policy);
            this.shards.set(i, worker);
        }
    }

    setPolicy(policy: TransitionPolicy): void {
        this.policy = policy;
        for (const shard of this.shards.values()) {
            shard.setPolicy(policy);
        }
    }

    getPolicy(): TransitionPolicy {
        return this.policy;
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
        // Record committedAtVersion for all seed atoms (they become visible at version 1).
        const initVersion = this.master.currentVersion;
        for (const { atom } of this.listAtoms()) {
            if (!this.atomCommittedAtVersion.has(atom)) {
                this.atomCommittedAtVersion.set(atom, initVersion);
            }
        }
        this.rebuildHashIndex();
        this.ready = true;
    }

    async access(item: DataAtom): Promise<PredictionReport> {
        assertAtomV1(item, 'access.item');
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
            const resolved = this.resolveHashAcrossShards(result.predictedHash);
            if (resolved !== null) {
                predictedNext = resolved.atom;
                predictedProof = resolved.proof;
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

    async batchAccess(items: DataAtom[]): Promise<BatchAccessResult[]> {
        assertAtomsV1(items, 'batchAccess.items');
        if (items.length === 0) return [];

        const grouped = new Map<number, Array<{ index: number; item: DataAtom }>>();
        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            const shardIdx = this.router.getShardIndex(item);
            if (!grouped.has(shardIdx)) grouped.set(shardIdx, []);
            grouped.get(shardIdx)!.push({ index, item });
        }

        const results: BatchAccessResult[] = new Array(items.length);
        const treeVersion = this.master.currentVersion;

        await Promise.all(
            Array.from(grouped.entries()).map(async ([shardIdx, batch]) => {
                const shard = this.shards.get(shardIdx);
                if (!shard) {
                    for (const entry of batch) {
                        results[entry.index] = {
                            ok: false,
                            item: entry.item,
                            statusCode: 404,
                            error: `Shard ${shardIdx} not initialized for item ${entry.item}`,
                        };
                    }
                    return;
                }

                const shardResults = await shard.batchAccess(batch.map(entry => entry.item));
                for (let i = 0; i < shardResults.length; i++) {
                    const shardResult = shardResults[i];
                    const original = batch[i];

                    if (!shardResult.ok) {
                        results[original.index] = {
                            ok: false,
                            item: original.item,
                            statusCode: shardResult.statusCode,
                            error: shardResult.error,
                        };
                        continue;
                    }

                    const local = shardResult.result;
                    let predictedNext = local.next;
                    let predictedProof = local.nextProof;

                    if (predictedNext === null && local.predictedHash !== null) {
                        const resolved = this.resolveHashAcrossShards(local.predictedHash);
                        if (resolved !== null) {
                            predictedNext = resolved.atom;
                            predictedProof = resolved.proof;
                        }
                    }

                    results[original.index] = {
                        ok: true,
                        currentData: original.item,
                        currentProof: local.proof,
                        shardRootProof: this.master.getShardProof(shardIdx),
                        predictedNext,
                        predictedProof,
                        latencyMs: 0,
                        treeVersion,
                    };
                }
            })
        );

        return results;
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
        predictedNext: DataAtom | null;
        predictedProof: null;
        latencyMs: number;
        treeVersion: number;
        verified: false;
        shardId: number;
    } | null {
        const start = performance.now();
        const sIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(sIdx);
        if (!shard) return null;
        if (!shard.isPendingAtom(item)) return null;

        let predictedNext: DataAtom | null = null;
        if (!this.policy.isOpenPolicy()) {
            const parsed = parseAtomV1(item);
            if (parsed) {
                for (const toType of ATOM_TYPES) {
                    if (!this.policy.isAllowed(parsed.type, toType)) continue;
                    const candidate = shard.getBestAtomOfType(toType);
                    if (candidate !== null) {
                        predictedNext = candidate;
                        warmPredictionFallbackTotal.inc({ shard: String(sIdx) });
                        break;
                    }
                }
            }
        }

        return {
            currentData: item,
            currentProof: null,
            predictedNext,
            predictedProof: null,
            latencyMs: performance.now() - start,
            treeVersion: this.master.currentVersion,
            verified: false,
            shardId: sIdx,
        };
    }

    /**
     * Train/Reinforce a sequence across the sharded cluster.
     * Training writes to the Markov matrix only — completely decoupled
     * from the Merkle tree state.  No commit needed.
     */
    async train(sequence: string[]): Promise<void> {
        assertAtomsV1(sequence, 'train.sequence');
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
    getWeights(item: DataAtom): { to: DataAtom; weight: number; effectiveWeight: number; lastUpdatedMs: number | null }[] | null {
        const shardIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(shardIdx);
        if (!shard) return null;

        const raw = shard.getWeights(item);
        if (raw === null) return null;

        return raw.map(entry => {
            if (entry.to !== null) {
                return {
                    to: entry.to,
                    weight: entry.weight,
                    effectiveWeight: entry.effectiveWeight,
                    lastUpdatedMs: entry.lastUpdatedMs,
                };
            }
            const resolved = this.resolveHashAcrossShards(entry.toHash);
            if (resolved) {
                return {
                    to: resolved.atom,
                    weight: entry.weight,
                    effectiveWeight: entry.effectiveWeight,
                    lastUpdatedMs: entry.lastUpdatedMs,
                };
            }
            return null;
        }).filter((e): e is { to: DataAtom; weight: number; effectiveWeight: number; lastUpdatedMs: number | null } => e !== null);
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
        assertAtomsV1(atoms, 'addAtoms.atoms');
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

        // Record committedAtVersion for every newly-added atom.
        const newVersion = this.master.currentVersion;
        for (const [shardIdx, shardAtoms] of buckets.entries()) {
            const shard = this.shards.get(shardIdx);
            if (!shard) continue;
            for (const atom of shardAtoms) {
                this.atomCommittedAtVersion.set(atom, newVersion);
                const hash = shard.getHash(atom);
                if (hash) this.hashToShard.set(hash, shardIdx);
            }
        }

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
        assertAtomV1(atom, 'removeAtom.atom');
        const shardIdx = this.router.getShardIndex(atom);
        const shard = this.shards.get(shardIdx);
        if (!shard) throw new Error(`No shard found for atom '${atom}'.`);

        const record = shard.getAtomRecord(atom);
        if (!record) throw new Error(`Atom '${atom}' not found in this shard.`);

        await shard.tombstoneAtom(atom);
        await shard.commit();
        this.master.updateShardRoot(shardIdx, shard.getKernelRoot(), shard.snapshotVersion);
        this.hashToShard.delete(record.hash);
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

    /**
     * Inspect a single atom record, including shard and outgoing learned edges.
     */
    inspectAtom(atom: DataAtom): {
        atom: DataAtom;
        shard: number;
        index: number;
        status: 'active' | 'tombstoned';
        hash: Hash;
        committed: boolean;
        createdAtMs: number;
        committedAtVersion: number;
        treeVersion: number;
        outgoingTransitions: { to: DataAtom; weight: number; effectiveWeight: number; lastUpdatedMs: number | null }[];
    } | null {
        const shardIdx = this.router.getShardIndex(atom);
        const shard = this.shards.get(shardIdx);
        if (!shard) return null;

        const record = shard.getAtomRecord(atom);
        if (!record) return null;

        return {
            atom,
            shard: shardIdx,
            index: record.index,
            status: record.status,
            hash: record.hash,
            committed: record.committed,
            createdAtMs: record.createdAtMs,
            committedAtVersion: this.atomCommittedAtVersion.get(atom) ?? 0,
            treeVersion: this.master.currentVersion,
            outgoingTransitions: this.getWeights(atom) ?? [],
        };
    }

    /** Current master-tree version. */
    getMasterVersion(): number {
        return this.master.currentVersion;
    }

    /** Root hash recorded for a historical master version, if retained. */
    getMasterRootAtVersion(version: number): Hash | undefined {
        return this.master.getRootAtVersion(version);
    }

    /** Commit timestamp (Unix ms) recorded for a historical master version, if retained. */
    getMasterVersionTimestamp(version: number): number | undefined {
        return this.master.getVersionTimestamp(version);
    }

    /** Readiness state used by orchestrator probes and startup guards. */
    isReady(): boolean {
        return this.ready;
    }

    /** Close all shard LevelDB instances gracefully. */
    async close(): Promise<void> {
        this.ready = false;
        this.hashToShard.clear();
        for (const shard of this.shards.values()) {
            await shard.close();
        }
    }

    private rebuildHashIndex(): void {
        this.hashToShard.clear();
        for (const [shardIdx, shard] of this.shards.entries()) {
            for (const { atom, status } of shard.getAtoms()) {
                if (status !== 'active') continue;
                const hash = shard.getHash(atom);
                if (hash) this.hashToShard.set(hash, shardIdx);
            }
        }
    }

    private resolveHashAcrossShards(hash: Hash): { atom: DataAtom; proof: MerkleProof } | null {
        const shardIdx = this.hashToShard.get(hash);
        if (shardIdx === undefined) return null;
        const shard = this.shards.get(shardIdx);
        if (!shard) return null;

        const resolved = shard.resolveByHash(hash);
        if (!resolved) return null;
        if (shard.getHash(resolved.atom) === undefined) return null;
        return resolved;
    }
}
