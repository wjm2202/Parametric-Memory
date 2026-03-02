import { ClassicLevel as Level } from 'classic-level';
import { DataAtom, Hash, MerkleProof, TOMBSTONE_HASH } from './types';
import { MerkleSnapshot } from './merkle_snapshot';
import { PendingWrites } from './pending_writes';
import { EpochManager, ReadTicket } from './epoch';
import { ShardWAL } from './wal';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { logger } from './logger';
import { commitLatency, commitsTotal, epochTransitionsTotal, pendingWritesGauge } from './metrics';

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
 */
export class ShardWorker {
    // ─── Atom state ─────────────────────────────────────────────────────
    private data: DataAtom[];
    private dataIndex: Map<DataAtom, number>;
    private hashToIndex: Map<Hash, number> = new Map();

    // ─── Snapshot + concurrency ─────────────────────────────────────────
    private activeSnapshot: MerkleSnapshot;
    private pending: PendingWrites;
    private epoch: EpochManager = new EpochManager();

    // ─── Markov transitions ─────────────────────────────────────────────
    private transitions: Map<number, Map<Hash, number>> = new Map();

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
        }
    ) {
        this.dbPath = dbPath;
        this.data = dataBlocks.slice();
        this.dataIndex = new Map(dataBlocks.map((d, i) => [d, i]));

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
            this.dataIndex = new Map();
            for await (const [, value] of this.db.iterator({ gte: 'ai:', lte: 'ai:~' })) {
                const atom = value as string;
                this.dataIndex.set(atom, this.data.length);
                this.data.push(atom);
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
                    const idx = this.data.length;
                    this.data.push(entry.data);
                    this.dataIndex.set(entry.data, idx);
                    await this.db
                        .put(`ai:${String(idx).padStart(10, '0')}`, entry.data)
                        .catch((err: unknown) => logger.error({ err }, 'WAL recovery db.put error'));
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
            }

            // ── 9. Truncate WAL ──────────────────────────────────────────
            if (uncommitted.length > 0) await this.wal.truncate();

        } catch (err) {
            logger.error({ err, dbPath: this.dbPath }, 'Failed to initialize shard');
        }

        // ── 10. Auto-commit timer ─────────────────────────────────────────
        if (this.commitIntervalMs > 0) {
            this.commitTimer = setInterval(async () => {
                if (!this.pending.isEmpty() && !this.epoch.isCommitting) {
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
        if (this.pending.isEmpty()) return this.activeSnapshot.version;
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
            const { snapshot: newSnapshot, addedIndices } = this.pending.apply(this.activeSnapshot);
            for (const idx of addedIndices) {
                this.hashToIndex.set(newSnapshot.getLeafHash(idx), idx);
            }
            this.activeSnapshot = newSnapshot;
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
            if (this.dataIndex.has(atom)) continue;

            const idx = this.data.length;

            // 1. WAL first — fsync ensures we can recover from here
            await this.wal.writeAdd(atom, idx);

            // 2. In-memory state
            this.data.push(atom);
            this.dataIndex.set(atom, idx);

            // 3. Queue for snapshot commit
            this.pending.addLeaf(atom);

            // 4. LevelDB persist
            await this.db
                .put(`ai:${String(idx).padStart(10, '0')}`, atom)
                .catch((err: unknown) => logger.error({ err }, 'Shard persistence error (addAtoms)'));
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
            : createHash('sha256').update(atom).digest().toString('hex');

        // 1. WAL first
        await this.wal.writeTombstone(idx);

        // 2. In-memory
        this.tombstoned.add(idx);

        // 3. Queue for snapshot commit
        this.pending.tombstone(idx);

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
            return createHash('sha256').update(item).digest().toString('hex');
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

    async recordTransition(from: Hash, to: Hash) {
        const fromIdx = this.hashToIndex.get(from);
        if (fromIdx === undefined) return;
        if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
        const targets = this.transitions.get(fromIdx)!;
        const newWeight = (targets.get(to) || 0) + 1;
        targets.set(to, newWeight);
        await this.db
            .put(`w:${from}:${to}`, newWeight.toString())
            .catch((err: unknown) => logger.error({ err }, 'Shard persistence error'));
    }

    async access(item: DataAtom): Promise<{
        proof: MerkleProof;
        next: DataAtom | null;
        nextProof: MerkleProof | null;
        hash: Hash;
        predictedHash: Hash | null;
    }> {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) throw new Error(`Item ${item} not found in this shard.`);
        if (this.tombstoned.has(idx)) throw new Error(`Atom '${item}' has been tombstoned.`);

        const ticket: ReadTicket = this.epoch.beginRead();
        try {
            const snapshot = this.activeSnapshot;
            if (idx >= snapshot.leafCount) {
                throw new Error(
                    `Atom '${item}' is pending commit (index ${idx}, snapshot has ${snapshot.leafCount} leaves). Call commit() first.`
                );
            }

            const hash = snapshot.getLeafHash(idx);
            const proof = snapshot.getProof(idx);

            const targets = this.transitions.get(idx);
            let predictedHash: Hash | null = null;
            if (targets && targets.size > 0) {
                let bestHash: Hash | null = null;
                let bestWeight = -Infinity;
                for (const [h, w] of targets) {
                    const tIdx = this.hashToIndex.get(h);
                    if (tIdx !== undefined && this.tombstoned.has(tIdx)) continue;
                    if (w > bestWeight) { bestWeight = w; bestHash = h; }
                }
                predictedHash = bestHash;
            }

            let next: DataAtom | null = null;
            let nextProof: MerkleProof | null = null;
            if (predictedHash !== null) {
                const nIdx = this.hashToIndex.get(predictedHash);
                if (nIdx !== undefined && !this.tombstoned.has(nIdx) && nIdx < snapshot.leafCount) {
                    next = this.data[nIdx];
                    nextProof = snapshot.getProof(nIdx);
                }
            }

            return { proof, next, nextProof, hash, predictedHash };
        } finally {
            this.epoch.endRead(ticket);
        }
    }

    getStats(): { trainedAtoms: number; totalEdges: number } {
        let totalEdges = 0;
        for (const t of this.transitions.values()) totalEdges += t.size;
        return { trainedAtoms: this.transitions.size, totalEdges };
    }

    getWeights(item: DataAtom): { to: DataAtom | null; toHash: Hash; weight: number }[] | null {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) return null;
        const transitions = this.transitions.get(idx);
        if (!transitions || transitions.size === 0) return [];
        const result: { to: DataAtom | null; toHash: Hash; weight: number }[] = [];
        for (const [toHash, weight] of transitions) {
            const toIdx = this.hashToIndex.get(toHash);
            if (toIdx !== undefined && this.tombstoned.has(toIdx)) continue;
            result.push({ to: toIdx !== undefined ? this.data[toIdx] : null, toHash, weight });
        }
        result.sort((a, b) => b.weight - a.weight);
        return result;
    }

    async close(): Promise<void> {
        if (this.commitTimer) { clearInterval(this.commitTimer); this.commitTimer = null; }
        if (!this.pending.isEmpty()) {
            await this.commit().catch((err: unknown) => logger.error({ err }, 'Final commit failed during close'));
        }
        await this.wal.close();
        await this.db.close();
    }
}
