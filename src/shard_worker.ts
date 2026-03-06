import { ClassicLevel as Level } from 'classic-level';
import { performance } from 'perf_hooks';
import { DataAtom, Hash, MerkleProof, TOMBSTONE_HASH } from './types';
import { MerkleSnapshot } from './merkle_snapshot';
import { PendingWrites } from './pending_writes';
import { EpochManager, ReadTicket } from './epoch';
import { ShardWAL } from './wal';
import { createHash } from 'crypto';
import { logger } from './logger';
import {
    commitLatency,
    commitsTotal,
    csrBuildMs,
    csrEdgeCount,
    epochTransitionsTotal,
    pendingWritesGauge,
    predictionTypeFilteredTotal,
} from './metrics';
import { assertAtomV1, AtomType, parseAtomV1 } from './atom_schema';
import { CsrTransitionMatrix } from './csr_matrix';
import { TransitionPolicy } from './transition_policy';

/** High-resolution Unix timestamp in ms (sub-millisecond precision). */
const hrnow = (): number => performance.timeOrigin + performance.now();

export type ShardAccessResult = {
    proof: MerkleProof;
    next: DataAtom | null;
    nextProof: MerkleProof | null;
    hash: Hash;
    predictedHash: Hash | null;
};

export type ShardBatchAccessItemResult =
    | {
        ok: true;
        item: DataAtom;
        result: ShardAccessResult;
    }
    | {
        ok: false;
        item: DataAtom;
        statusCode: number;
        error: string;
    };

/**
 * SHARD WORKER — v3 (Snapshot + Epoch + WAL)
 *
 * Adds crash durability via a Write-Ahead Log on top of the v2 snapshot model.
 *
 * Write order for addAtoms():
 *   1. WAL.writeAdd(atom)     ← fsync — survives crash from here onwards
 *   2. data/dataIndex updated in memory
 *   3. PendingWrites.addLeaf(atom)
 *   4. db.put(ai:..., atom)   ← LevelDB durable write
 *
 * Write order for tombstoneAtom():
 *   1. WAL.writeTombstone(index) ← fsync
 *   2. tombstoned.add(index)  in memory
 *   3. PendingWrites.tombstone(index)
 *   4. db.put(th:..., '1')    ← LevelDB durable write
 *
 * Commit():
 *   1. epoch.beginCommit()    ← waits for old-epoch readers to drain
 *   2. PendingWrites.apply()  → new MerkleSnapshot
 *   3. Atomic pointer swap
 *   4. epoch.endCommit()
 *   5. WAL.writeCommit()      ← fsync commit marker
 *   6. WAL.truncate()         ← file reset to empty
 *
 * Recovery (init()):
 *   1. Normal LevelDB rehydration (atoms, tombstones, weights)
 *   2. WAL.readUncommitted()  → entries after last COMMIT marker
 *   3. Replay: ADD entries → ensure atom in LevelDB + pending
 *              TOMBSTONE entries → ensure tombstone applied
 *   4. If any uncommitted entries existed → auto-commit + WAL truncate
 *
 * LevelDB key namespaces:
 *   w:<fromHash>:<toHash>  — Markov transition weight
 *   ai:<paddedIdx>         — All atoms (seeds + dynamically added)
 *   th:<hash>              — Tombstone marker
 *   ts:<paddedIdx>         — Atom creation timestamp (Unix ms, stored as string)
 */
export class ShardWorker {
    // ─── Atom state ─────────────────────────────────────────────────────
    private data: DataAtom[];
    private atomTypes: AtomType[];
    private atomHashes: Map<DataAtom, Hash>;
    private dataIndex: Map<DataAtom, number>;
    private hashToIndex: Map<Hash, number> = new Map();
    private atomCreatedAtMs: number[];

    // ─── Snapshot + concurrency ─────────────────────────────────────────
    private activeSnapshot: MerkleSnapshot;
    private retiredSnapshots: Map<number, MerkleSnapshot> = new Map();
    private pending: PendingWrites;
    private epoch: EpochManager = new EpochManager();

    // ─── Markov transitions ─────────────────────────────────────────────
    private transitions: Map<number, Map<Hash, number>> = new Map();
    private csrMatrix: CsrTransitionMatrix = CsrTransitionMatrix.empty(0);
    private csrDirty = false;
    private policy: TransitionPolicy = TransitionPolicy.default();
    private transitionUpdatedAt: Map<number, Map<Hash, number>> = new Map();
    private readonly confidenceHalfLifeMs: number;

    // ─── Tombstone tracking ─────────────────────────────────────────────
    private tombstoned: Set<number> = new Set();

    // ─── Persistence ────────────────────────────────────────────────────
    private db: Level<string, string>;
    private wal: ShardWAL;
    private readonly dbPath: string;

    // ─── Auto-commit configuration ──────────────────────────────────────
    private commitThreshold: number;
    private commitIntervalMs: number;
    private commitTimer: ReturnType<typeof setInterval> | null = null;
    private lastPendingMutationAtMs: number = 0;
    /** Metric label — e.g. '0', '1', '2', '3'. Defaults to dbPath suffix. */
    private readonly _shardId: string;

    constructor(
        dataBlocks: DataAtom[],
        dbPath: string,
        options?: {
            commitThreshold?: number;
            commitIntervalMs?: number;
            /** Numeric shard id used as a Prometheus label. */
            shardId?: number;
            /** Half-life for confidence decay in milliseconds (<=0 disables decay). */
            confidenceHalfLifeMs?: number;
        }
    ) {
        this.dbPath = dbPath;
        this.data = dataBlocks.slice();
        this.atomTypes = dataBlocks.map(atom => this.getAtomTypeOrThrow(atom));
        this.atomHashes = new Map();
        for (const atom of dataBlocks) {
            this.atomHashes.set(atom, createHash('sha256').update(atom).digest().toString('hex'));
        }
        this.dataIndex = new Map(dataBlocks.map((d, i) => [d, i]));
        this.atomCreatedAtMs = dataBlocks.map(() => Date.now());

        this.activeSnapshot = MerkleSnapshot.fromData(dataBlocks, 0);
        this.pending = new PendingWrites(0);

        this.db = new Level<string, string>(dbPath, {
            blockSize: 4096,
            cacheSize: 2 * 1024 * 1024,
        });

        const walCompactThresholdBytes = process.env.MMPM_WAL_COMPACT_THRESHOLD_BYTES
            ? parseInt(process.env.MMPM_WAL_COMPACT_THRESHOLD_BYTES, 10)
            : undefined;

        // WAL file sits alongside the LevelDB directory, not inside it,
        // to avoid any confusion with LevelDB's own internal .log files.
        this.wal = new ShardWAL(`${dbPath}.wal`, {
            compactThresholdBytes: walCompactThresholdBytes,
        });

        dataBlocks.forEach((_, i) => {
            this.hashToIndex.set(this.activeSnapshot.getLeafHash(i), i);
        });

        this.commitThreshold = options?.commitThreshold ?? Infinity;
        this.commitIntervalMs = options?.commitIntervalMs ?? 0;
        this._shardId = options?.shardId !== undefined
            ? String(options.shardId)
            : dbPath.replace(/.*[/\\]/, ''); // fallback: last path segment

        const envHalfLife = process.env.MMPM_CONFIDENCE_HALF_LIFE_MS
            ? parseInt(process.env.MMPM_CONFIDENCE_HALF_LIFE_MS, 10)
            : undefined;
        const configuredHalfLife = options?.confidenceHalfLifeMs ?? envHalfLife ?? (7 * 24 * 60 * 60 * 1000);
        this.confidenceHalfLifeMs = Number.isFinite(configuredHalfLife) ? configuredHalfLife : 0;
    }

    /**
     * Hydrate from LevelDB, replay any uncommitted WAL entries, build snapshot.
     *
     * Unified atom storage (Story 6.1):
     *   Seeds and dynamic atoms share the ai: LevelDB prefix.  On first init,
     *   seeds are written to LevelDB so that subsequent restarts need only
     *   scan ai: — no separate in-memory seed list required.
     *
     * Order:
     *   1.  Persist constructor seeds into LevelDB (idempotent batch put)
     *   2.  Load ALL atoms from ai: (single code path)
     *   3.  Collect tombstone hashes from th:
     *   4.  Collect weight entries from w: (resolved after hashToIndex built)
     *   5.  WAL replay — materialise any uncommitted ADD / TOMBSTONE ops
     *   6.  Build MerkleSnapshot from the final atom set
     *   7.  Apply tombstones and mark pending = v0
     *   8.  Resolve Markov weights into this.transitions
     *   9.  Truncate WAL if uncommitted entries existed
     *   10. Start auto-commit timer
     */
    async init() {
        try {
            await this.db.open(); await this.wal.open();
            this.retiredSnapshots.clear();

            // ── 1. Persist seeds to LevelDB ─────────────────────────────
            if (this.data.length > 0) {
                const batch = this.db.batch();
                for (let i = 0; i < this.data.length; i++) {
                    batch.put(`ai:${String(i).padStart(10, '0')}`, this.data[i]);
                }
                await batch.write();
            }

            // ── 2. Load ALL atoms from LevelDB ───────────────────────────
            this.data = [];
            this.atomTypes = [];
            this.atomHashes = new Map();
            this.dataIndex = new Map();
            this.atomCreatedAtMs = [];
            for await (const [, value] of this.db.iterator({ gte: 'ai:', lte: 'ai:~' })) {
                const atom = value as string;
                const parsed = parseAtomV1(atom);
                if (!parsed) {
                    throw new Error(
                        `Legacy atom '${atom}' found in ${this.dbPath}. Strict schema v1 is enabled; start with a fresh DB.`
                    );
                }
                this.dataIndex.set(atom, this.data.length);
                this.data.push(atom);
                this.atomTypes.push(parsed.type);
                this.atomHashes.set(atom, this.hashAtom(atom));
            }

            // Ensure every atom has a durable creation timestamp.
            // Missing/invalid ts: values are backfilled once and persisted.
            for (let i = 0; i < this.data.length; i++) {
                const tsKey = `ts:${String(i).padStart(10, '0')}`;
                let createdAtMs: number;
                try {
                    const raw = await this.db.get(tsKey);
                    if (raw === undefined) {
                        throw new Error(`Missing timestamp value for key ${tsKey}`);
                    }
                    const parsed = parseFloat(raw);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                        throw new Error(`Invalid timestamp value for key ${tsKey}`);
                    }
                    createdAtMs = parsed;
                } catch {
                    createdAtMs = hrnow();
                    await this.db.put(tsKey, String(createdAtMs))
                        .catch((err: unknown) => logger.error({ err }, 'Timestamp backfill persist error'));
                }
                this.atomCreatedAtMs[i] = createdAtMs;
            }

            // ── 3. Collect tombstone hashes ──────────────────────────────
            const tombstoneHashes = new Set<string>();
            for await (const [key] of this.db.iterator({ gte: 'th:', lte: 'th:~' })) {
                tombstoneHashes.add(key.slice(3));
            }

            // ── 4. Collect weight entries (resolved after hashToIndex) ───
            const rawWeights: Array<[string, string, number]> = [];
            for await (const [key, value] of this.db.iterator({ gte: 'w:', lte: 'w:~' })) {
                const parts = key.split(':');
                if (parts.length === 3) rawWeights.push([parts[1], parts[2], parseInt(value)]);
            }

            // ── 5. WAL replay ────────────────────────────────────────────
            // ADD entries not yet in LevelDB (crashed before db.put) are
            // added here so they're included in the snapshot build below.
            const walTombstoneIndices: number[] = [];
            const uncommitted = await this.wal.readUncommitted();
            for (const entry of uncommitted) {
                if (entry.op === 'ADD' && entry.data && !this.dataIndex.has(entry.data)) {
                    const parsed = parseAtomV1(entry.data);
                    if (!parsed) {
                        throw new Error(
                            `Invalid atom '${entry.data}' encountered during WAL recovery in ${this.dbPath}.`
                        );
                    }
                    const idx = this.data.length;
                    this.data.push(entry.data);
                    this.atomTypes.push(parsed.type);
                    this.atomHashes.set(entry.data, this.hashAtom(entry.data));
                    this.dataIndex.set(entry.data, idx);
                    const createdAtMs = Number.isFinite(entry.ts) && entry.ts > 0 ? entry.ts : Date.now();
                    this.atomCreatedAtMs[idx] = createdAtMs;
                    await this.db
                        .put(`ai:${String(idx).padStart(10, '0')}`, entry.data)
                        .catch((err: unknown) => logger.error({ err }, 'WAL recovery db.put error'));
                    await this.db
                        .put(`ts:${String(idx).padStart(10, '0')}`, String(createdAtMs))
                        .catch((err: unknown) => logger.error({ err }, 'WAL recovery timestamp persist error'));
                } else if (entry.op === 'TOMBSTONE' && entry.index !== undefined) {
                    walTombstoneIndices.push(entry.index);
                }
            }

            // ── 6. Build snapshot from the final atom set ────────────────
            this.activeSnapshot = MerkleSnapshot.fromData(this.data, 0);
            this.hashToIndex = new Map();
            for (let i = 0; i < this.data.length; i++) {
                this.hashToIndex.set(this.activeSnapshot.getLeafHash(i), i);
            }

            // ── 7. Apply tombstones ──────────────────────────────────────
            for (const hash of tombstoneHashes) {
                const idx = this.hashToIndex.get(hash);
                if (idx !== undefined) this.tombstoned.add(idx);
            }
            for (const idx of walTombstoneIndices) {
                if (!this.tombstoned.has(idx)) {
                    this.tombstoned.add(idx);
                    const hash = idx < this.activeSnapshot.leafCount
                        ? this.activeSnapshot.getLeafHash(idx) : '';
                    if (hash) {
                        await this.db.put(`th:${hash}`, '1')
                            .catch((err: unknown) => logger.error({ err }, 'WAL tombstone persist error'));
                    }
                }
            }
            if (this.tombstoned.size > 0) {
                const tombPending = new PendingWrites(0);
                for (const idx of this.tombstoned) tombPending.tombstone(idx);
                const { snapshot } = tombPending.apply(this.activeSnapshot);
                this.activeSnapshot = snapshot;
            }
            this.pending = new PendingWrites(this.activeSnapshot.version);

            // ── 8. Resolve Markov weights ────────────────────────────────
            for (const [fromHash, toHash, weight] of rawWeights) {
                const fromIdx = this.hashToIndex.get(fromHash);
                if (fromIdx === undefined) continue;
                if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
                this.transitions.get(fromIdx)!.set(toHash, weight);

                let updatedAtMs = Date.now();
                try {
                    const rawTs = await this.db.get(`wu:${fromHash}:${toHash}`);
                    if (rawTs !== undefined) {
                        const parsedTs = parseInt(rawTs, 10);
                        if (Number.isFinite(parsedTs) && parsedTs > 0) {
                            updatedAtMs = parsedTs;
                        }
                    }
                } catch {
                    // Legacy weight entries may not have timestamp metadata yet.
                }

                if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
                this.transitionUpdatedAt.get(fromIdx)!.set(toHash, updatedAtMs);
            }

            // Build CSR projection once on startup so read path is warm.
            this.rebuildCsrMatrix();
            this.csrDirty = false;

            // ── 9. Truncate WAL ──────────────────────────────────────────
            if (uncommitted.length > 0) await this.wal.truncate();

        } catch (err) {
            logger.error({ err, dbPath: this.dbPath }, 'Failed to initialize shard');
        }

        // ── 10. Auto-commit timer ─────────────────────────────────────────
        if (this.commitIntervalMs > 0) {
            this.commitTimer = setInterval(async () => {
                if (!this.pending.isEmpty() && !this.epoch.isCommitting) {
                    const sinceLastMutation = Date.now() - this.lastPendingMutationAtMs;
                    if (sinceLastMutation < this.commitIntervalMs) return;
                    await this.commit().catch((err: unknown) => logger.error({ err }, 'Auto-commit failed'));
                }
            }, this.commitIntervalMs);
        }
    }

    // ─── Snapshot & commit operations ───────────────────────────────────

    /**
     * Public commit: WAL-aware wrapper around commitInternal().
     * Writes the COMMIT marker and truncates the WAL after the swap.
     */
    async commit(): Promise<number> {
        if (this.pending.isEmpty()) {
            if (this.csrDirty) {
                this.rebuildCsrMatrix();
                this.csrDirty = false;
            }
            return this.activeSnapshot.version;
        }
        const version = await this.commitInternal();
        // Record the commit in the WAL and clear it — the snapshot is now durable
        await this.wal.writeCommit();
        await this.wal.truncate();
        return version;
    }

    /**
     * Internal commit: epoch-guarded snapshot swap, no WAL interaction.
     * Used during recovery to avoid double-writing WAL entries.
     */
    private async commitInternal(): Promise<number> {
        if (this.pending.isEmpty()) return this.activeSnapshot.version;

        const start = performance.now();
        await this.epoch.beginCommit();
        try {
            const hasTombstones = this.pending.getOps().some(op => op.kind === 'tombstone');
            const { snapshot: newSnapshot, addedIndices } = this.pending.apply(this.activeSnapshot);
            const previousSnapshot = this.activeSnapshot;
            for (const idx of addedIndices) {
                this.hashToIndex.set(newSnapshot.getLeafHash(idx), idx);
            }
            this.activeSnapshot = newSnapshot;
            this.retireSnapshot(previousSnapshot);
            if (hasTombstones || this.csrDirty) {
                const csrBuildStart = performance.now();
                this.rebuildCsrMatrix();
                csrBuildMs.observe({ shard: this._shardId }, performance.now() - csrBuildStart);
                this.csrDirty = false;
            } else {
                // Keep metric series present even when rebuild is intentionally
                // skipped for add-only commits.
                csrBuildMs.observe({ shard: this._shardId }, 0);
            }
            this.pending = new PendingWrites(newSnapshot.version);
        } finally {
            this.epoch.endCommit();
        }

        const latencyMs = performance.now() - start;
        commitLatency.observe({ shard: this._shardId }, latencyMs);
        commitsTotal.inc({ shard: this._shardId });
        epochTransitionsTotal.inc({ shard: this._shardId });
        pendingWritesGauge.set({ shard: this._shardId }, 0);

        return this.activeSnapshot.version;
    }

    get snapshotVersion(): number { return this.activeSnapshot.version; }
    get pendingCount(): number { return this.pending.size; }
    /** Expose epoch commit/reader state for cluster health reporting. */
    getEpochStatus() { return this.epoch.getStatus(); }
    getSnapshotRefStatus(): {
        activeVersion: number;
        activeRefCount: number;
        retired: Array<{ version: number; refCount: number }>;
    } {
        this.collectRetiredSnapshots();
        return {
            activeVersion: this.activeSnapshot.version,
            activeRefCount: this.activeSnapshot.refCount,
            retired: Array.from(this.retiredSnapshots.values())
                .map(s => ({ version: s.version, refCount: s.refCount }))
                .sort((a, b) => a.version - b.version),
        };
    }

    // ─── Dynamic atom management ────────────────────────────────────────

    /**
     * Register new atoms at runtime.
     *
     * Write order: WAL → memory → PendingWrites → LevelDB
     * The WAL write ensures the atom is recoverable even if we crash before
     * the LevelDB write completes.
     */
    async addAtoms(atoms: DataAtom[]): Promise<void> {
        for (const atom of atoms) {
            assertAtomV1(atom, 'addAtoms.atom');
            if (this.dataIndex.has(atom)) continue;

            const idx = this.data.length;
            const createdAtMs = hrnow();

            // 1. WAL first — fsync ensures we can recover from here
            await this.wal.writeAdd(atom, idx);

            // 2. In-memory state
            this.data.push(atom);
            this.atomTypes.push(this.getAtomTypeOrThrow(atom));
            this.atomHashes.set(atom, this.hashAtom(atom));
            this.dataIndex.set(atom, idx);
            this.atomCreatedAtMs[idx] = createdAtMs;

            // 3. Queue for snapshot commit
            this.pending.addLeaf(atom);
            this.lastPendingMutationAtMs = Date.now();

            // 4. LevelDB persist
            await this.db
                .put(`ai:${String(idx).padStart(10, '0')}`, atom)
                .catch((err: unknown) => logger.error({ err }, 'Shard persistence error (addAtoms)'));
            await this.db
                .put(`ts:${String(idx).padStart(10, '0')}`, String(createdAtMs))
                .catch((err: unknown) => logger.error({ err }, 'Shard persistence error (addAtoms ts)'));
        }

        if (this.pending.size >= this.commitThreshold && !this.epoch.isCommitting) {
            await this.commit();
        } else {
            pendingWritesGauge.set({ shard: this._shardId }, this.pending.size);
        }
    }

    /**
     * Soft-delete an atom.
     *
     * Write order: WAL → tombstoned set → PendingWrites → LevelDB
     */
    async tombstoneAtom(atom: DataAtom): Promise<void> {
        const idx = this.dataIndex.get(atom);
        if (idx === undefined) throw new Error(`Atom '${atom}' not found in this shard.`);
        if (this.tombstoned.has(idx)) return;

        const hash = this.activeSnapshot.leafCount > idx
            ? this.activeSnapshot.getLeafHash(idx)
            : this.hashAtom(atom);

        // 1. WAL first
        await this.wal.writeTombstone(idx);

        // 2. In-memory
        this.tombstoned.add(idx);

        // 3. Queue for snapshot commit
        this.pending.tombstone(idx);
        this.csrDirty = true;
        this.lastPendingMutationAtMs = Date.now();

        // 4. LevelDB persist
        await this.db
            .put(`th:${hash}`, '1')
            .catch((err: unknown) => logger.error({ err }, 'Shard persistence error (tombstone)'));
    }

    getAtoms(): { atom: DataAtom; status: 'active' | 'tombstoned' }[] {
        return this.data.map((atom, idx) => ({
            atom,
            status: this.tombstoned.has(idx) ? 'tombstoned' : 'active',
        }));
    }

    /**
     * Inspect a single atom record as stored in this shard.
     */
    getAtomRecord(item: DataAtom): {
        atom: DataAtom;
        index: number;
        status: 'active' | 'tombstoned';
        hash: Hash;
        committed: boolean;
        createdAtMs: number;
    } | null {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) return null;
        return {
            atom: item,
            index: idx,
            status: this.tombstoned.has(idx) ? 'tombstoned' : 'active',
            hash: this.hashAtom(item),
            committed: idx < this.activeSnapshot.leafCount,
            createdAtMs: this.atomCreatedAtMs[idx] ?? 0,
        };
    }

    /**
     * Return atoms that are in PendingWrites (added but not yet committed).
     * These are visible in hash lookups but not yet in the Merkle snapshot.
     */
    getPendingAtoms(): DataAtom[] {
        const committed = this.activeSnapshot.leafCount;
        return this.data.slice(committed);
    }

    /** True when atom exists but is still pending commit (no proof available yet). */
    isPendingAtom(item: DataAtom): boolean {
        const idx = this.dataIndex.get(item);
        if (idx === undefined || this.tombstoned.has(idx)) return false;
        return idx >= this.activeSnapshot.leafCount;
    }

    // ─── Read path (snapshot-based, epoch-guarded) ──────────────────────

    getHash(item: DataAtom): Hash | undefined {
        const idx = this.dataIndex.get(item);
        if (idx === undefined || this.tombstoned.has(idx)) return undefined;
        if (idx >= this.activeSnapshot.leafCount) {
            return this.hashAtom(item);
        }
        return this.activeSnapshot.getLeafHash(idx);
    }

    getAtomByHash(hash: Hash): DataAtom | undefined {
        const idx = this.hashToIndex.get(hash);
        return idx !== undefined ? this.data[idx] : undefined;
    }

    resolveByHash(hash: Hash): { atom: DataAtom; proof: MerkleProof } | null {
        const idx = this.hashToIndex.get(hash);
        if (idx === undefined) return null;
        if (idx >= this.activeSnapshot.leafCount) return null;
        return { atom: this.data[idx], proof: this.activeSnapshot.getProof(idx) };
    }

    getKernelRoot(): Hash { return this.activeSnapshot.root; }
    getCsrMatrix(): CsrTransitionMatrix { return this.csrMatrix; }
    setPolicy(policy: TransitionPolicy): void { this.policy = policy; }
    getPolicy(): TransitionPolicy { return this.policy; }

    getBestAtomOfType(type: AtomType): DataAtom | null {
        const snapshot = this.activeSnapshot;
        const incomingWeightByIndex = new Map<number, number>();

        for (const [fromIdx, targets] of this.transitions) {
            for (const [toHash, weight] of targets) {
                const toIdx = this.hashToIndex.get(toHash);
                if (toIdx === undefined) continue;
                if (!this.isCandidateIndexReadable(snapshot, toIdx)) continue;
                const effective = this.getEffectiveTransitionWeight(fromIdx, toHash, weight);
                incomingWeightByIndex.set(toIdx, (incomingWeightByIndex.get(toIdx) ?? 0) + effective);
            }
        }

        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let idx = 0; idx < snapshot.leafCount; idx++) {
            if (this.tombstoned.has(idx)) continue;
            if (this.atomTypes[idx] !== type) continue;

            const score = incomingWeightByIndex.get(idx) ?? 0;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = idx;
            }
        }

        return bestIdx >= 0 ? this.data[bestIdx] : null;
    }

    async recordTransition(from: Hash, to: Hash) {
        const fromIdx = this.hashToIndex.get(from);
        if (fromIdx === undefined) return;
        if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
        if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
        const targets = this.transitions.get(fromIdx)!;
        const targetsUpdatedAt = this.transitionUpdatedAt.get(fromIdx)!;
        const newWeight = (targets.get(to) || 0) + 1;
        const updatedAtMs = Date.now();
        targets.set(to, newWeight);
        targetsUpdatedAt.set(to, updatedAtMs);
        this.csrDirty = true;
        await this.db
            .put(`w:${from}:${to}`, newWeight.toString())
            .catch((err: unknown) => logger.error({ err }, 'Shard persistence error'));
        await this.db
            .put(`wu:${from}:${to}`, updatedAtMs.toString())
            .catch((err: unknown) => logger.error({ err }, 'Shard confidence timestamp persistence error'));
    }

    async access(item: DataAtom): Promise<ShardAccessResult> {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) throw new Error(`Item ${item} not found in this shard.`);
        if (this.tombstoned.has(idx)) throw new Error(`Atom '${item}' has been tombstoned.`);

        const ticket: ReadTicket = this.epoch.beginRead();
        const snapshot = this.activeSnapshot;
        this.acquireSnapshotReference(snapshot);
        try {
            if (idx >= snapshot.leafCount) {
                throw new Error(
                    `Atom '${item}' is pending commit (index ${idx}, snapshot has ${snapshot.leafCount} leaves). Call commit() first.`
                );
            }

            return this.buildAccessResult(snapshot, idx);
        } finally {
            this.releaseSnapshotReference(snapshot);
            this.epoch.endRead(ticket);
        }
    }

    async batchAccess(items: DataAtom[]): Promise<ShardBatchAccessItemResult[]> {
        if (items.length === 0) return [];

        const ticket: ReadTicket = this.epoch.beginRead();
        const snapshot = this.activeSnapshot;
        this.acquireSnapshotReference(snapshot);
        try {
            const results: ShardBatchAccessItemResult[] = [];

            for (const item of items) {
                const idx = this.dataIndex.get(item);
                if (idx === undefined) {
                    results.push({
                        ok: false,
                        item,
                        statusCode: 404,
                        error: `Item ${item} not found in this shard.`,
                    });
                    continue;
                }
                if (this.tombstoned.has(idx)) {
                    results.push({
                        ok: false,
                        item,
                        statusCode: 404,
                        error: `Atom '${item}' has been tombstoned.`,
                    });
                    continue;
                }
                if (idx >= snapshot.leafCount) {
                    results.push({
                        ok: false,
                        item,
                        statusCode: 404,
                        error: `Atom '${item}' is pending commit (index ${idx}, snapshot has ${snapshot.leafCount} leaves). Call commit() first.`,
                    });
                    continue;
                }

                results.push({
                    ok: true,
                    item,
                    result: this.buildAccessResult(snapshot, idx),
                });
            }

            return results;
        } finally {
            this.releaseSnapshotReference(snapshot);
            this.epoch.endRead(ticket);
        }
    }

    private buildAccessResult(snapshot: MerkleSnapshot, idx: number): ShardAccessResult {
        const hash = snapshot.getLeafHash(idx);
        const proof = snapshot.getProof(idx);

        let predictedHash: Hash | null = null;
        let predictedIdx = -1;
        let policyFiltered = false;

        if (this.policy.isOpenPolicy()) {
            if (this.isConfidenceDecayEnabled()) {
                predictedHash = this.getPredictedHashFromMap(idx);
            } else if (this.csrMatrix.atomCount === 0) {
                predictedHash = this.getPredictedHashFromMap(idx);
            } else {
                const topIdx = this.csrMatrix.getTopPrediction(idx);
                if (topIdx >= 0 && !this.tombstoned.has(topIdx) && topIdx < snapshot.leafCount) {
                    predictedHash = snapshot.getLeafHash(topIdx);
                    predictedIdx = topIdx;
                } else {
                    predictedHash = this.getPredictedHashFromMap(idx);
                }
            }

            if (predictedIdx < 0 && predictedHash !== null) {
                const localIdx = this.hashToIndex.get(predictedHash);
                if (localIdx !== undefined && this.isCandidateIndexReadable(snapshot, localIdx)) {
                    predictedIdx = localIdx;
                }
            }
        } else {
            const policySelection = this.selectPolicyConstrainedIndex(snapshot, idx);
            predictedIdx = policySelection.index;
            policyFiltered = policySelection.filtered;
            predictedHash = predictedIdx >= 0 ? snapshot.getLeafHash(predictedIdx) : null;
        }

        if (policyFiltered) {
            predictionTypeFilteredTotal.inc({ shard: this._shardId });
        }

        let next: DataAtom | null = null;
        let nextProof: MerkleProof | null = null;
        if (predictedIdx >= 0) {
            next = this.data[predictedIdx];
            nextProof = snapshot.getProof(predictedIdx);
        }

        return { proof, next, nextProof, hash, predictedHash };
    }

    private selectPolicyConstrainedIndex(snapshot: MerkleSnapshot, fromIdx: number): { index: number; filtered: boolean } {
        const fromType = this.atomTypes[fromIdx];
        if (!fromType) return { index: -1, filtered: false };

        let firstCandidatePos = 0;
        let sawCandidate = false;

        if (!this.isConfidenceDecayEnabled() && this.csrMatrix.atomCount > 0) {
            for (const edge of this.csrMatrix.getEdges(fromIdx)) {
                const candidateIdx = edge.toIdx;
                if (!this.isCandidateIndexReadable(snapshot, candidateIdx)) continue;

                sawCandidate = true;
                const toType = this.atomTypes[candidateIdx];
                if (toType && this.policy.isAllowed(fromType, toType)) {
                    return { index: candidateIdx, filtered: firstCandidatePos > 0 };
                }
                firstCandidatePos++;
            }
            if (sawCandidate) return { index: -1, filtered: true };
        }

        const targets = this.transitions.get(fromIdx);
        if (!targets || targets.size === 0) return { index: -1, filtered: false };

        let bestOverallIdx = -1;
        let bestOverallWeight = -Infinity;
        let bestAllowedIdx = -1;
        let bestAllowedWeight = -Infinity;
        let hasReadableCandidate = false;

        for (const [candidateHash, weight] of targets) {
            const candidateIdx = this.hashToIndex.get(candidateHash);
            if (candidateIdx === undefined) continue;
            if (!this.isCandidateIndexReadable(snapshot, candidateIdx)) continue;
            hasReadableCandidate = true;

            const effectiveWeight = this.getEffectiveTransitionWeight(fromIdx, candidateHash, weight);

            if (
                effectiveWeight > bestOverallWeight ||
                (effectiveWeight === bestOverallWeight && (bestOverallIdx < 0 || candidateIdx < bestOverallIdx))
            ) {
                bestOverallWeight = effectiveWeight;
                bestOverallIdx = candidateIdx;
            }

            const toType = this.atomTypes[candidateIdx];
            if (!toType || !this.policy.isAllowed(fromType, toType)) continue;

            if (
                effectiveWeight > bestAllowedWeight ||
                (effectiveWeight === bestAllowedWeight && (bestAllowedIdx < 0 || candidateIdx < bestAllowedIdx))
            ) {
                bestAllowedWeight = effectiveWeight;
                bestAllowedIdx = candidateIdx;
            }
        }

        if (!hasReadableCandidate) return { index: -1, filtered: false };
        if (bestAllowedIdx < 0) return { index: -1, filtered: true };
        return { index: bestAllowedIdx, filtered: bestAllowedIdx !== bestOverallIdx };
    }

    private isCandidateIndexReadable(snapshot: MerkleSnapshot, idx: number): boolean {
        return idx >= 0 && idx < snapshot.leafCount && !this.tombstoned.has(idx);
    }

    private getPredictedHashFromMap(fromIdx: number): Hash | null {
        const targets = this.transitions.get(fromIdx);
        if (!targets || targets.size === 0) return null;

        let bestHash: Hash | null = null;
        let bestWeight = -Infinity;
        for (const [candidateHash, weight] of targets) {
            const toIdx = this.hashToIndex.get(candidateHash);
            if (toIdx !== undefined && this.tombstoned.has(toIdx)) continue;
            const effectiveWeight = this.getEffectiveTransitionWeight(fromIdx, candidateHash, weight);
            if (effectiveWeight > bestWeight) {
                bestWeight = effectiveWeight;
                bestHash = candidateHash;
            }
        }
        return bestHash;
    }

    private rebuildCsrMatrix(): void {
        if (this.data.length === 0) {
            this.csrMatrix = CsrTransitionMatrix.empty(0);
            csrEdgeCount.set({ shard: this._shardId }, 0);
            return;
        }

        const filteredTransitions = new Map<number, Map<Hash, number>>();
        for (const [fromIdx, targets] of this.transitions) {
            if (this.tombstoned.has(fromIdx)) continue;

            let filteredTargets: Map<Hash, number> | null = null;
            for (const [toHash, weight] of targets) {
                const toIdx = this.hashToIndex.get(toHash);
                if (toIdx !== undefined && this.tombstoned.has(toIdx)) continue;
                if (!filteredTargets) filteredTargets = new Map<Hash, number>();
                filteredTargets.set(toHash, weight);
            }

            if (filteredTargets && filteredTargets.size > 0) {
                filteredTransitions.set(fromIdx, filteredTargets);
            }
        }

        this.csrMatrix = CsrTransitionMatrix.build(
            filteredTransitions,
            this.hashToIndex,
            this.data.length,
        );
        csrEdgeCount.set({ shard: this._shardId }, this.csrMatrix.edgeCount);
    }

    getStats(): { trainedAtoms: number; totalEdges: number } {
        let totalEdges = 0;
        for (const t of this.transitions.values()) totalEdges += t.size;
        return { trainedAtoms: this.transitions.size, totalEdges };
    }

    getWeights(item: DataAtom): { to: DataAtom | null; toHash: Hash; weight: number; effectiveWeight: number; lastUpdatedMs: number | null }[] | null {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) return null;
        const transitions = this.transitions.get(idx);
        if (!transitions || transitions.size === 0) return [];
        const result: { to: DataAtom | null; toHash: Hash; weight: number; effectiveWeight: number; lastUpdatedMs: number | null }[] = [];
        for (const [toHash, weight] of transitions) {
            const toIdx = this.hashToIndex.get(toHash);
            if (toIdx !== undefined && this.tombstoned.has(toIdx)) continue;
            const lastUpdatedMs = this.transitionUpdatedAt.get(idx)?.get(toHash) ?? null;
            result.push({
                to: toIdx !== undefined ? this.data[toIdx] : null,
                toHash,
                weight,
                effectiveWeight: this.getEffectiveTransitionWeight(idx, toHash, weight),
                lastUpdatedMs,
            });
        }
        result.sort((a, b) => b.effectiveWeight - a.effectiveWeight || b.weight - a.weight);
        return result;
    }

    private isConfidenceDecayEnabled(): boolean {
        return this.confidenceHalfLifeMs > 0;
    }

    private getEffectiveTransitionWeight(fromIdx: number, toHash: Hash, rawWeight: number): number {
        if (!this.isConfidenceDecayEnabled()) return rawWeight;
        const updatedAt = this.transitionUpdatedAt.get(fromIdx)?.get(toHash);
        if (updatedAt === undefined) return rawWeight;

        const elapsedMs = Math.max(0, Date.now() - updatedAt);
        const decayFactor = Math.pow(0.5, elapsedMs / this.confidenceHalfLifeMs);
        return rawWeight * decayFactor;
    }

    async close(): Promise<void> {
        if (this.commitTimer) { clearInterval(this.commitTimer); this.commitTimer = null; }
        if (!this.pending.isEmpty()) {
            await this.commit().catch((err: unknown) => logger.error({ err }, 'Final commit failed during close'));
        }
        await this.wal.close();
        await this.db.close();
        this.collectRetiredSnapshots();
    }

    private acquireSnapshotReference(snapshot: MerkleSnapshot): void {
        snapshot.acquireRef();
    }

    private releaseSnapshotReference(snapshot: MerkleSnapshot): void {
        const remaining = snapshot.releaseRef();
        if (remaining === 0 && snapshot.isRetired) {
            this.retiredSnapshots.delete(snapshot.version);
        }
    }

    private retireSnapshot(snapshot: MerkleSnapshot): void {
        snapshot.markRetired();
        if (snapshot.refCount > 0) {
            this.retiredSnapshots.set(snapshot.version, snapshot);
        } else {
            this.retiredSnapshots.delete(snapshot.version);
        }
    }

    private collectRetiredSnapshots(): void {
        for (const [version, snapshot] of this.retiredSnapshots) {
            if (snapshot.refCount === 0) {
                this.retiredSnapshots.delete(version);
            }
        }
    }

    private getAtomTypeOrThrow(atom: DataAtom): AtomType {
        const parsed = parseAtomV1(atom);
        if (!parsed) {
            throw new Error(`Invalid atom '${atom}' in shard ${this.dbPath}. Expected schema v1.`);
        }
        return parsed.type;
    }

    private hashAtom(atom: DataAtom): Hash {
        const cached = this.atomHashes.get(atom);
        if (cached !== undefined) return cached;
        const computed = createHash('sha256').update(atom).digest().toString('hex');
        this.atomHashes.set(atom, computed);
        return computed;
    }
}
