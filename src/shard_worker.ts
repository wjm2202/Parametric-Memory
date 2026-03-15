import { performance } from 'perf_hooks';
import { DataAtom, Hash, MerkleProof, TOMBSTONE_HASH } from './types';
import { MerkleSnapshot } from './merkle_snapshot';
import { PendingWrites } from './pending_writes';
import { StorageBackend } from './storage_backend';
import { LevelDbBackend } from './leveldb_backend';
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
import { HalfLifeModel, extractProvenance, parseThetaFromEnv } from './hlr';
import { PpmModel } from './ppm';
import { AccessLog } from './access_log';
import { TierEngine, parseThresholdsFromEnv } from './tier_engine';
import {
    ConsolidationCycle,
    ConsolidationShardInterface,
    ConsolidationResult,
    parseConsolidationOptionsFromEnv,
} from './consolidation';
import type { Tier } from './tier_engine';

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
 *   ac:<paddedIdx>         — Access count
 *   la:<paddedIdx>         — Last access timestamp (Sprint 15)
 *   tier:<paddedIdx>       — Tier classification: h|w|c (Sprint 15)
 *   ppm:<context>          — PPM trie node (Sprint 13)
 *   al:<padTimestamp>      — Access log entry (Sprint 14)
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

    // ─── HLR: adaptive per-atom decay ─────────────────────────────────
    private accessCounts: Map<number, number> = new Map();
    private readonly hlrModel: HalfLifeModel | null;
    /** Provenance cache per atom index (extracted once from atom name). */
    private atomProvenances: Array<'human' | 'test' | 'research' | 'default'> = [];

    // ─── PPM: variable-order Markov prediction ──────────────────────
    private readonly ppmModel: PpmModel | null;

    // ─── Access log: HLR training data (Sprint 14) ───────────────────
    private readonly accessLog: AccessLog | null;

    // ─── Tier classification & consolidation (Sprint 15) ──────────────
    private readonly tierEngine: TierEngine | null;
    private readonly consolidation: ConsolidationCycle | null;
    private consolidationTimer: ReturnType<typeof setInterval> | null = null;
    private readonly consolidationIntervalMs: number;
    /**
     * Minimum interval between per-commit tier classifications (ms).
     * Prevents O(n) LevelDB batch writes on every commit when commits are
     * frequent (e.g. per-atom ingestion).  Default: 30 000 ms (30 s).
     * Set via MMPM_TIER_CLASSIFY_INTERVAL_MS.
     */
    private readonly tierClassifyIntervalMs: number;
    private lastTierClassifyAtMs: number = 0;

    // ─── Last access timestamp per atom (for tier classification) ─────
    private lastAccessedAtMs: Map<number, number> = new Map();

    // ─── Tombstone tracking ─────────────────────────────────────────────
    private tombstoned: Set<number> = new Set();

    // ─── Batched transition writes (group commit) ─────────────────────
    private pendingTransitionBatch: Array<{ key: string; value: string }> = [];

    // ─── STDP: Spike-Timing-Dependent Plasticity (Sprint 12) ─────────
    /**
     * Time constant for STDP exponential decay (ms).
     * Training within tauMs of the last transition update gives full weight.
     * Default: 300_000 ms = 5 minutes.  Set to 0 to disable STDP (classic +1).
     */
    private readonly stdpTauMs: number;

    // ─── Active forgetting / pruning (Sprint 12) ─────────────────────
    /** Whether background pruning is enabled. Default: false. */
    private readonly pruneEnabled: boolean;
    /** Minimum age (ms) before a transition is eligible for pruning. */
    private readonly pruneStaleDays: number;
    /** Effective weight threshold below which stale transitions are pruned. */
    private readonly pruneWeightThreshold: number;

    // ─── Persistence ────────────────────────────────────────────────────
    private storage: StorageBackend;
    private wal: ShardWAL;
    private readonly dbPath: string;

    // ─── Auto-commit configuration ──────────────────────────────────────
    private commitThreshold: number;
    private commitIntervalMs: number;
    private commitTimer: ReturnType<typeof setInterval> | null = null;
    private lastPendingMutationAtMs: number = 0;
    /** Metric label — e.g. '0', '1', '2', '3'. Defaults to dbPath suffix. */
    private readonly _shardId: string;

    /**
     * Unified clock function for all timestamps (creation, transition, decay).
     * Defaults to `hrnow()` (sub-millisecond precision via performance API).
     * Inject a custom clock for deterministic testing.
     */
    private readonly clock: () => number;

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
            /** Custom clock function returning Unix ms. Defaults to sub-ms hrnow(). */
            clock?: () => number;
            /** Custom storage backend. Defaults to LevelDbBackend(dbPath). */
            storage?: StorageBackend;
            /** STDP time constant in ms. Training within this window gives full weight. 0 = disabled (classic +1). Default: 300000. */
            stdpTauMs?: number;
            /** Enable background pruning of stale transitions. Default: false. */
            pruneEnabled?: boolean;
            /** Age in days before a transition becomes prune-eligible. Default: 30. */
            pruneStaleDays?: number;
            /** Effective weight threshold for pruning. Default: 0.1. */
            pruneWeightThreshold?: number;
        }
    ) {
        this.clock = options?.clock ?? hrnow;
        this.dbPath = dbPath;
        this.data = dataBlocks.slice();
        this.atomTypes = dataBlocks.map(atom => this.getAtomTypeOrThrow(atom));
        this.atomHashes = new Map();
        for (const atom of dataBlocks) {
            this.atomHashes.set(atom, createHash('sha256').update(atom).digest().toString('hex'));
        }
        this.dataIndex = new Map(dataBlocks.map((d, i) => [d, i]));
        this.atomCreatedAtMs = dataBlocks.map(() => this.clock());

        this.activeSnapshot = MerkleSnapshot.fromData(dataBlocks, 0);
        this.pending = new PendingWrites(0);

        this.storage = options?.storage ?? new LevelDbBackend(dbPath);

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

        // HLR: adaptive per-atom half-life.  Enabled when base half-life > 0
        // and MMPM_HLR_ENABLED is not explicitly '0'.
        const hlrEnabled = (process.env.MMPM_HLR_ENABLED ?? '1') !== '0';
        if (hlrEnabled && this.confidenceHalfLifeMs > 0) {
            const theta = parseThetaFromEnv(process.env.MMPM_HLR_THETA);
            this.hlrModel = new HalfLifeModel(this.confidenceHalfLifeMs, theta);
        } else {
            this.hlrModel = null;
        }
        // Initialise provenance cache for seed atoms
        this.atomProvenances = dataBlocks.map(atom => extractProvenance(atom));

        // PPM: variable-order Markov.  Enabled unless MMPM_PPM_ENABLED=0.
        // Sprint 13: PPM trie is now persisted to LevelDB on commit.
        const ppmEnabled = (process.env.MMPM_PPM_ENABLED ?? '1') !== '0';
        if (ppmEnabled) {
            const maxOrder = parseInt(process.env.MMPM_PPM_MAX_ORDER ?? '3', 10);
            const escapeThreshold = parseFloat(process.env.MMPM_PPM_ESCAPE_THRESHOLD ?? '0.3');
            const maxNodes = parseInt(process.env.MMPM_PPM_MAX_NODES ?? '100000', 10);
            this.ppmModel = new PpmModel({ maxOrder, escapeThreshold, maxNodes });
        } else {
            this.ppmModel = null;
        }

        // Sprint 14: Access log for HLR training data.  Enabled unless MMPM_ACCESS_LOG_ENABLED=0.
        const accessLogEnabled = (process.env.MMPM_ACCESS_LOG_ENABLED ?? '1') !== '0';
        if (accessLogEnabled) {
            const maxEntries = parseInt(process.env.MMPM_ACCESS_LOG_MAX ?? '50000', 10);
            this.accessLog = new AccessLog(this.storage, { maxEntries });
        } else {
            this.accessLog = null;
        }

        // Sprint 15: Tier classification engine.  Enabled unless MMPM_TIER_ENABLED=0.
        const tierEnabled = (process.env.MMPM_TIER_ENABLED ?? '1') !== '0';
        if (tierEnabled) {
            const thresholds = parseThresholdsFromEnv();
            this.tierEngine = new TierEngine(this.hlrModel, thresholds);

            const envTierClassifyInterval = parseInt(process.env.MMPM_TIER_CLASSIFY_INTERVAL_MS ?? '', 10);
            this.tierClassifyIntervalMs = Number.isFinite(envTierClassifyInterval) && envTierClassifyInterval >= 0
                ? envTierClassifyInterval
                : 30_000; // Default: 30s — prevents O(n) writes on every commit
            const consolidationOpts = parseConsolidationOptionsFromEnv();
            this.consolidationIntervalMs = consolidationOpts.intervalMs ?? 60 * 60 * 1000; // 1 hour
            const shardInterface = this.buildConsolidationInterface();
            this.consolidation = new ConsolidationCycle(this.tierEngine, shardInterface, {
                ...consolidationOpts,
                clock: this.clock,
            });
        } else {
            this.tierEngine = null;
            this.consolidation = null;
            this.consolidationIntervalMs = 0;
            this.tierClassifyIntervalMs = 0;
        }

        // STDP: Spike-Timing-Dependent Plasticity (Sprint 12)
        // Default: 0 (disabled, classic +1). Set MMPM_STDP_TAU_MS=300000 in production.
        const envTau = parseInt(process.env.MMPM_STDP_TAU_MS ?? '', 10);
        this.stdpTauMs = options?.stdpTauMs ?? (Number.isFinite(envTau) && envTau > 0 ? envTau : 0);

        // Active forgetting / pruning (Sprint 12)
        this.pruneEnabled = options?.pruneEnabled ?? (process.env.MMPM_PRUNE_ENABLED === '1');
        this.pruneStaleDays = options?.pruneStaleDays ?? parseInt(process.env.MMPM_PRUNE_STALE_DAYS ?? '30', 10);
        this.pruneWeightThreshold = options?.pruneWeightThreshold ?? 0.1;
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
            await this.storage.open(); await this.wal.open();
            this.retiredSnapshots.clear();

            // ── 1. Persist seeds to LevelDB ─────────────────────────────
            if (this.data.length > 0) {
                const batch = this.storage.batch();
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
            for await (const [, value] of this.storage.iterator({ gte: 'ai:', lte: 'ai:~' })) {
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
                    const raw = await this.storage.get(tsKey);
                    if (raw === undefined) {
                        throw new Error(`Missing timestamp value for key ${tsKey}`);
                    }
                    const parsed = parseFloat(raw);
                    if (!Number.isFinite(parsed) || parsed <= 0) {
                        throw new Error(`Invalid timestamp value for key ${tsKey}`);
                    }
                    createdAtMs = parsed;
                } catch {
                    createdAtMs = this.clock();
                    await this.storage.put(tsKey, String(createdAtMs))
                        .catch((err: unknown) => logger.error({ err }, 'Timestamp backfill persist error'));
                }
                this.atomCreatedAtMs[i] = createdAtMs;
            }

            // ── 3. Collect tombstone hashes ──────────────────────────────
            const tombstoneHashes = new Set<string>();
            for await (const [key] of this.storage.iterator({ gte: 'th:', lte: 'th:~' })) {
                tombstoneHashes.add(key.slice(3));
            }

            // ── 4. Collect weight entries (resolved after hashToIndex) ───
            //
            // Key formats (two generations):
            //   Legacy  w:<fromHash64>:<toHash64>   131-char random-ordered key
            //   Current w:<fromIdx10>:<toHash64>     77-char idx-ordered key
            //
            // Storing the from-atom's zero-padded shard index instead of its
            // 64-char SHA-256 hash provides:
            //   • 40 % smaller keys (77 vs 131 bytes per w: + wu: pair)
            //   • Lexicographic locality — all outgoing edges for a given atom
            //     are contiguous in the keyspace, enabling O(out-degree) range
            //     scans vs O(total weights) full scans
            //   • Better LevelDB compaction — sequential idx writes cluster
            //     into fewer SST blocks vs random-looking hash prefixes
            //
            // Legacy keys are migrated transparently on first startup.
            const rawWeights: Array<[number, string, number]> = [];   // [fromIdx, toHash, weight]
            const legacyKeys: Array<[string, string, string, number]> = []; // [wKey, fromHash, toHash, weight]

            for await (const [key, value] of this.storage.iterator({ gte: 'w:', lte: 'w:~' })) {
                const parts = key.split(':');
                if (parts.length !== 3) continue;
                const weight = parseInt(value, 10);
                if (parts[1].length === 64) {
                    // Legacy format: w:<fromHash64>:<toHash64>
                    legacyKeys.push([key, parts[1], parts[2], weight]);
                } else {
                    // Current format: w:<fromIdx10>:<toHash64>
                    rawWeights.push([parseInt(parts[1], 10), parts[2], weight]);
                }
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
                    const createdAtMs = Number.isFinite(entry.ts) && entry.ts > 0 ? entry.ts : this.clock();
                    this.atomCreatedAtMs[idx] = createdAtMs;
                    await this.storage
                        .put(`ai:${String(idx).padStart(10, '0')}`, entry.data)
                        .catch((err: unknown) => logger.error({ err }, 'WAL recovery db.put error'));
                    await this.storage
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
                        await this.storage.put(`th:${hash}`, '1')
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

            // ── 8a. Migrate legacy weight keys ───────────────────────────
            // Runs once when upgrading from hash-keyed to idx-keyed format.
            if (legacyKeys.length > 0) {
                logger.info(
                    { count: legacyKeys.length, shard: this._shardId },
                    'Migrating legacy w:<hash>:<hash> weight keys to w:<idx>:<hash> format'
                );
                for (const [oldWKey, fromHash, toHash, weight] of legacyKeys) {
                    const fromIdx = this.hashToIndex.get(fromHash);
                    if (fromIdx === undefined) {
                        // Atom not present in this shard — stale key, drop it
                        await this.storage.del(oldWKey)
                            .catch((err: unknown) => logger.error({ err }, 'Migration: del stale legacy w: key'));
                        continue;
                    }

                    const newWKey  = `w:${String(fromIdx).padStart(10, '0')}:${toHash}`;
                    const oldTsKey = `wu:${fromHash}:${toHash}`;
                    const newTsKey = `wu:${String(fromIdx).padStart(10, '0')}:${toHash}`;

                    // Write new key then delete old — idempotent if interrupted
                    await this.storage.put(newWKey, String(weight))
                        .catch((err: unknown) => logger.error({ err }, 'Migration: write new w: key'));
                    await this.storage.del(oldWKey)
                        .catch((err: unknown) => logger.error({ err }, 'Migration: del old w: key'));

                    // Migrate timestamp key if it exists
                    let tsVal: string | undefined;
                    try { tsVal = await this.storage.get(oldTsKey); } catch { /* missing is fine */ }
                    if (tsVal !== undefined) {
                        await this.storage.put(newTsKey, tsVal)
                            .catch((err: unknown) => logger.error({ err }, 'Migration: write new wu: key'));
                        await this.storage.del(oldTsKey)
                            .catch((err: unknown) => logger.error({ err }, 'Migration: del old wu: key'));
                    }

                    rawWeights.push([fromIdx, toHash, weight]);
                }
                logger.info({ shard: this._shardId }, 'Weight key migration complete');
            }

            // ── 8b. Resolve Markov weights ───────────────────────────────
            // Scan all wu: timestamp keys in a single iterator pass instead of
            // issuing one db.get() per weight — turns O(N) random-access reads
            // into a single sequential sweep, cutting startup I/O significantly.
            const wuMap = new Map<string, number>();
            for await (const [key, value] of this.storage.iterator({ gte: 'wu:', lte: 'wu:~' })) {
                const parsed = parseInt(value, 10);
                if (Number.isFinite(parsed) && parsed > 0) wuMap.set(key, parsed);
            }

            const nowMs = this.clock();
            for (const [fromIdx, toHash, weight] of rawWeights) {
                if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
                this.transitions.get(fromIdx)!.set(toHash, weight);

                const tsKey = `wu:${String(fromIdx).padStart(10, '0')}:${toHash}`;
                const updatedAtMs = wuMap.get(tsKey) ?? nowMs;

                if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
                this.transitionUpdatedAt.get(fromIdx)!.set(toHash, updatedAtMs);
            }

            // ── 8c. Hydrate access counts & provenance for HLR ───────────
            this.accessCounts = new Map();
            for await (const [key, value] of this.storage.iterator({ gte: 'ac:', lte: 'ac:~' })) {
                const idx = parseInt(key.slice(3), 10);
                const count = parseInt(value, 10);
                if (Number.isFinite(idx) && Number.isFinite(count) && count > 0) {
                    this.accessCounts.set(idx, count);
                }
            }
            this.atomProvenances = this.data.map(atom => extractProvenance(atom));

            // ── 8d. Restore PPM trie from LevelDB (Sprint 13) ────────────
            if (this.ppmModel) {
                const ppmEntries = new Map<string, string>();
                for await (const [key, value] of this.storage.iterator({ gte: 'ppm:', lte: 'ppm:~' })) {
                    ppmEntries.set(key, value);
                }
                if (ppmEntries.size > 0) {
                    this.ppmModel.deserialize(ppmEntries);
                    const warnings = this.ppmModel.verify();
                    if (warnings.length > 0) {
                        logger.warn(
                            { shard: this._shardId, warnings },
                            'PPM trie integrity warnings — clearing and starting fresh'
                        );
                        this.ppmModel.clear();
                    } else {
                        logger.info(
                            { shard: this._shardId, nodeCount: this.ppmModel.getStats().nodeCount },
                            'PPM trie restored from LevelDB'
                        );
                    }
                }
            }

            // ── 8e. Initialize access log (Sprint 14) ─────────────────────
            if (this.accessLog) {
                await this.accessLog.init();
                logger.info(
                    { shard: this._shardId, entries: this.accessLog.count },
                    'Access log initialized'
                );
            }

            // ── 8f. Load tier metadata & last-access timestamps (Sprint 15) ──
            this.lastAccessedAtMs = new Map();
            for await (const [key, value] of this.storage.iterator({ gte: 'la:', lte: 'la:~' })) {
                const idx = parseInt(key.slice(3), 10);
                const ts = parseInt(value, 10);
                if (Number.isFinite(idx) && Number.isFinite(ts) && ts > 0) {
                    this.lastAccessedAtMs.set(idx, ts);
                }
            }
            if (this.consolidation) {
                await this.consolidation.loadTiers();
                logger.info(
                    { shard: this._shardId, tiers: this.consolidation.getCachedSummary() },
                    'Tier metadata loaded'
                );
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
                    const sinceLastMutation = this.clock() - this.lastPendingMutationAtMs;
                    if (sinceLastMutation < this.commitIntervalMs) return;
                    await this.commit().catch((err: unknown) => logger.error({ err }, 'Auto-commit failed'));
                }
            }, this.commitIntervalMs);
        }

        // ── 11. Consolidation timer (Sprint 15) ──────────────────────────
        if (this.consolidation && this.consolidationIntervalMs > 0) {
            this.consolidationTimer = setInterval(async () => {
                if (this.consolidation && !this.consolidation.isRunning()) {
                    await this.consolidation.run().catch(
                        (err: unknown) => logger.error({ err, shard: this._shardId }, 'Consolidation cycle failed'),
                    );
                }
            }, this.consolidationIntervalMs);
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

        // Sprint 13: Persist PPM trie if it has been modified since last save
        if (this.ppmModel?.dirty) {
            await this.persistPpmTrie().catch(
                (err: unknown) => logger.error({ err, shard: this._shardId }, 'PPM trie persistence failed'),
            );
        }

        // Sprint 15: Classify tiers for all active atoms during commit.
        // Throttled: only runs when tierClassifyIntervalMs has elapsed since
        // the last classification.  Prevents O(n) LevelDB batch writes on
        // every commit under high-frequency ingestion.
        if (this.consolidation) {
            const nowMs = this.clock();
            if (nowMs - this.lastTierClassifyAtMs >= this.tierClassifyIntervalMs) {
                this.lastTierClassifyAtMs = nowMs;
                const atomsToClassify: Array<{ index: number; features: import('./hlr').HlrFeatures; lastAccessedMs: number }> = [];
                for (let i = 0; i < this.data.length; i++) {
                    if (this.tombstoned.has(i)) continue;
                    atomsToClassify.push({
                        index: i,
                        features: this.getHlrFeatures(i),
                        lastAccessedMs: this.lastAccessedAtMs.get(i) ?? this.atomCreatedAtMs[i] ?? 0,
                    });
                }
                await this.consolidation.batchClassifyAndPersist(atomsToClassify, this.storage, nowMs).catch(
                    (err: unknown) => logger.error({ err, shard: this._shardId }, 'Tier classification failed'),
                );
            }
        }

        // Sprint 12: Active forgetting — prune stale transitions during commit
        if (this.pruneEnabled) {
            await this.pruneStaleTransitions().catch(
                (err: unknown) => logger.error({ err, shard: this._shardId }, 'Prune stale transitions failed'),
            );
        }

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
        // Group commit: buffer all WAL entries, then single fsync + single storage batch
        const toAdd: Array<{ atom: DataAtom; idx: number; createdAtMs: number }> = [];
        for (const atom of atoms) {
            assertAtomV1(atom, 'addAtoms.atom');
            if (this.dataIndex.has(atom)) continue;

            const idx = this.data.length;
            const createdAtMs = this.clock();

            // 1a. Buffer WAL entry (no fsync yet)
            this.wal.writeAddBatched(atom, idx);

            // 2. In-memory state
            this.data.push(atom);
            this.atomTypes.push(this.getAtomTypeOrThrow(atom));
            this.atomHashes.set(atom, this.hashAtom(atom));
            this.dataIndex.set(atom, idx);
            this.atomCreatedAtMs[idx] = createdAtMs;
            this.atomProvenances[idx] = extractProvenance(atom);

            // 3. Queue for snapshot commit
            this.pending.addLeaf(atom);
            this.lastPendingMutationAtMs = this.clock();

            toAdd.push({ atom, idx, createdAtMs });
        }

        if (toAdd.length > 0) {
            // 1b. Single WAL fsync for all entries
            await this.wal.flushBatch();

            // 4. Single storage batch for all atoms + timestamps
            try {
                let batch = this.storage.batch();
                for (const { atom, idx, createdAtMs } of toAdd) {
                    const idxStr = String(idx).padStart(10, '0');
                    batch = batch.put(`ai:${idxStr}`, atom);
                    batch = batch.put(`ts:${idxStr}`, String(createdAtMs));
                }
                await batch.write();
            } catch (err: unknown) {
                logger.error({ err }, 'Shard persistence error (addAtoms batch)');
            }
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
        this.lastPendingMutationAtMs = this.clock();

        // 4. LevelDB persist
        await this.storage
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

    /**
     * Train the PPM model with a sequence of leaf hashes.
     * Called by the orchestrator with the full hash sequence (may include
     * cross-shard hashes — the PPM trie handles unknown symbols gracefully).
     */
    trainPpm(hashSequence: Hash[]): void {
        if (this.ppmModel && hashSequence.length >= 2) {
            this.ppmModel.train(hashSequence);
        }
    }

    /**
     * Sprint 14: Log a training event for HLR training data.
     * Called from orchestrator.train() with the atom names in the sequence.
     */
    logTrainEvents(atomNames: string[]): void {
        if (!this.accessLog) return;
        const ts = this.clock();
        const entries = atomNames.map(atom => ({ atom, type: 'train' as const, ts }));
        this.accessLog.appendBatch(entries)
            .catch((err: unknown) => logger.error({ err }, 'Access log train event error'));
    }

    /** Sprint 14: Expose access log for diagnostics / training pipeline. */
    getAccessLog(): AccessLog | null {
        return this.accessLog;
    }

    /** Sprint 15: Expose tier classification for an atom. */
    getAtomTier(atom: DataAtom): Tier | undefined {
        const idx = this.dataIndex.get(atom);
        if (idx === undefined) return undefined;
        return this.consolidation?.getTier(idx);
    }

    /** Sprint 15: Get tier summary. */
    getTierSummary(): { hot: number; warm: number; cold: number; total: number } | null {
        return this.consolidation?.getCachedSummary() ?? null;
    }

    /** Sprint 15: Get last consolidation result. */
    getLastConsolidationResult(): ConsolidationResult | null {
        return this.consolidation?.getLastResult() ?? null;
    }

    /** Sprint 15: Run consolidation cycle manually. */
    async runConsolidation(): Promise<ConsolidationResult | null> {
        if (!this.consolidation) return null;
        return this.consolidation.run();
    }

    /**
     * Sprint 15: Build the ConsolidationShardInterface adapter.
     * Bridges between the ShardWorker and the ConsolidationCycle without
     * exposing the full ShardWorker to consolidation.ts.
     */
    private buildConsolidationInterface(): ConsolidationShardInterface {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        return {
            getAtomCount(): number {
                return self.data.length;
            },
            isTombstoned(index: number): boolean {
                return self.tombstoned.has(index);
            },
            getHlrFeatures(index: number): import('./hlr').HlrFeatures {
                return self.getHlrFeatures(index);
            },
            getLastAccessedMs(index: number): number {
                return self.lastAccessedAtMs.get(index) ?? self.atomCreatedAtMs[index] ?? 0;
            },
            getStorage(): StorageBackend {
                return self.storage;
            },
            async replayMarkovArcs(indices: number[]): Promise<void> {
                // Hippocampal replay: for each hot atom, re-train its strongest
                // outgoing Markov transition with a fresh timestamp.
                // This refreshes the decay timer on important connections.
                for (const fromIdx of indices) {
                    const targets = self.transitions.get(fromIdx);
                    if (!targets || targets.size === 0) continue;

                    // Find the strongest outgoing edge
                    let bestHash: string | null = null;
                    let bestWeight = -Infinity;
                    for (const [toHash, weight] of targets) {
                        const effectiveWeight = self.getEffectiveTransitionWeight(fromIdx, toHash, weight);
                        if (effectiveWeight > bestWeight) {
                            bestWeight = effectiveWeight;
                            bestHash = toHash;
                        }
                    }

                    if (bestHash !== null) {
                        // Refresh the timestamp — this counters decay
                        const nowMs = self.clock();
                        const updatedAtMap = self.transitionUpdatedAt.get(fromIdx);
                        if (updatedAtMap) {
                            updatedAtMap.set(bestHash, nowMs);
                        }
                        // Persist refreshed timestamp
                        const idxStr = String(fromIdx).padStart(10, '0');
                        await self.storage
                            .put(`wu:${idxStr}:${bestHash}`, nowMs.toString())
                            .catch((err: unknown) => logger.error({ err }, 'Replay timestamp persist error'));
                    }
                }
            },
        };
    }

    /** Get PPM model statistics (for diagnostics). */
    getPpmStats(): { maxOrder: number; escapeThreshold: number; nodeCount: number; historyLength: number } | null {
        return this.ppmModel?.getStats() ?? null;
    }

    /**
     * Compute the STDP weight delta for a transition from a given atom.
     *
     * STDP (Spike-Timing-Dependent Plasticity):
     *   delta = max(1, round(1000 * exp(-dt / tau)))
     *
     * where dt = now - lastTransitionUpdateTime(fromIdx).
     * If STDP is disabled (tau = 0), returns 1000 (equivalent to classic +1 at 1000x scale).
     *
     * The 1000x multiplier gives sub-millisecond precision when quantized to integer.
     * Minimum delta is 1 — no trained transition ever has zero weight.
     */
    private computeStdpDelta(fromIdx: number): number {
        if (this.stdpTauMs <= 0) return 1; // STDP disabled — classic +1

        const nowMs = this.clock();
        // Use the most recent transition update time for this atom (any edge)
        const updatedAtMap = this.transitionUpdatedAt.get(fromIdx);
        let lastUpdateMs = 0;
        if (updatedAtMap && updatedAtMap.size > 0) {
            for (const ts of updatedAtMap.values()) {
                if (ts > lastUpdateMs) lastUpdateMs = ts;
            }
        }
        // Fall back to atom creation time if no transitions exist
        if (lastUpdateMs === 0) {
            lastUpdateMs = this.atomCreatedAtMs[fromIdx] ?? nowMs;
        }

        const dt = Math.max(0, nowMs - lastUpdateMs);
        const raw = Math.exp(-dt / this.stdpTauMs);
        return Math.max(1, Math.round(raw * 1000));
    }

    async recordTransition(from: Hash, to: Hash) {
        const fromIdx = this.hashToIndex.get(from);
        if (fromIdx === undefined) return;
        if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
        if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
        const targets = this.transitions.get(fromIdx)!;
        const targetsUpdatedAt = this.transitionUpdatedAt.get(fromIdx)!;
        const delta = this.computeStdpDelta(fromIdx);
        const newWeight = (targets.get(to) || 0) + delta;
        const updatedAtMs = this.clock();
        targets.set(to, newWeight);
        targetsUpdatedAt.set(to, updatedAtMs);
        this.csrDirty = true;
        // Use fromIdx (10-digit zero-padded) rather than the 64-char hash so
        // all outgoing edges from a given atom are lexicographically adjacent,
        // improving compaction locality and cutting key size by ~40%.
        const idxStr = String(fromIdx).padStart(10, '0');
        await this.storage
            .put(`w:${idxStr}:${to}`, newWeight.toString())
            .catch((err: unknown) => logger.error({ err }, 'Shard persistence error'));
        await this.storage
            .put(`wu:${idxStr}:${to}`, updatedAtMs.toString())
            .catch((err: unknown) => logger.error({ err }, 'Shard confidence timestamp persistence error'));
    }

    /**
     * Buffer a transition in memory without writing to storage.
     * In-memory maps are updated immediately (so subsequent recordTransitionBatched
     * calls see cumulative weights), but storage writes are deferred until
     * flushTransitionBatch() is called — a single storage.batch().write() for
     * all buffered edges. This reduces per-edge I/O from 2 puts to 0, with
     * a single batch write at the end.
     *
     * Uses STDP delta: recent training gives full weight, distant training diminishes.
     */
    recordTransitionBatched(from: Hash, to: Hash): void {
        const fromIdx = this.hashToIndex.get(from);
        if (fromIdx === undefined) return;
        if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
        if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
        const targets = this.transitions.get(fromIdx)!;
        const targetsUpdatedAt = this.transitionUpdatedAt.get(fromIdx)!;
        const delta = this.computeStdpDelta(fromIdx);
        const newWeight = (targets.get(to) || 0) + delta;
        const updatedAtMs = this.clock();
        targets.set(to, newWeight);
        targetsUpdatedAt.set(to, updatedAtMs);
        this.csrDirty = true;
        const idxStr = String(fromIdx).padStart(10, '0');
        this.pendingTransitionBatch.push(
            { key: `w:${idxStr}:${to}`, value: newWeight.toString() },
            { key: `wu:${idxStr}:${to}`, value: updatedAtMs.toString() },
        );
    }

    /**
     * Flush all buffered transition writes in a single storage batch operation.
     * Returns the number of individual put operations written.
     */
    async flushTransitionBatch(): Promise<number> {
        const ops = this.pendingTransitionBatch;
        if (ops.length === 0) return 0;
        try {
            let batch = this.storage.batch();
            for (const op of ops) {
                batch = batch.put(op.key, op.value);
            }
            await batch.write();
        } catch (err: unknown) {
            logger.error({ err }, 'flushTransitionBatch storage error');
        }
        const count = ops.length;
        this.pendingTransitionBatch = [];
        return count;
    }

    async access(item: DataAtom, opts?: { skipSideEffects?: boolean }): Promise<ShardAccessResult> {
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

            return this.buildAccessResult(snapshot, idx, opts?.skipSideEffects);
        } finally {
            this.releaseSnapshotReference(snapshot);
            this.epoch.endRead(ticket);
        }
    }

    async batchAccess(items: DataAtom[], opts?: { skipSideEffects?: boolean }): Promise<ShardBatchAccessItemResult[]> {
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
                    result: this.buildAccessResult(snapshot, idx, opts?.skipSideEffects),
                });
            }

            return results;
        } finally {
            this.releaseSnapshotReference(snapshot);
            this.epoch.endRead(ticket);
        }
    }

    private buildAccessResult(snapshot: MerkleSnapshot, idx: number, skipSideEffects = false): ShardAccessResult {
        if (!skipSideEffects) {
            // HLR: increment access count (fire-and-forget persistence)
            const newCount = (this.accessCounts.get(idx) ?? 0) + 1;
            this.accessCounts.set(idx, newCount);
            const acKey = `ac:${String(idx).padStart(10, '0')}`;
            this.storage.put(acKey, String(newCount))
                .catch((err: unknown) => logger.error({ err }, 'Access count persist error'));

            // Sprint 15: Track last-access timestamp for tier classification
            const nowMs = this.clock();
            this.lastAccessedAtMs.set(idx, nowMs);
            const laKey = `la:${String(idx).padStart(10, '0')}`;
            this.storage.put(laKey, String(Math.round(nowMs)))
                .catch((err: unknown) => logger.error({ err }, 'Last-access timestamp persist error'));

            // Sprint 14: Log access event for HLR training data
            if (this.accessLog && idx < this.data.length) {
                this.accessLog.append({ atom: this.data[idx], type: 'access', ts: this.clock() })
                    .catch((err: unknown) => logger.error({ err }, 'Access log append error'));
            }
        }

        const hash = snapshot.getLeafHash(idx);
        const proof = snapshot.getProof(idx);

        if (!skipSideEffects) {
            // PPM: record this access in the running history for context-aware prediction
            if (this.ppmModel) {
                this.ppmModel.recordAccess(hash);
            }
        }

        let predictedHash: Hash | null = null;
        let predictedIdx = -1;
        let policyFiltered = false;

        if (this.policy.isOpenPolicy()) {
            // PPM: try variable-order prediction first (higher-order context)
            if (this.ppmModel) {
                const tombstoneHashes = new Set<string>();
                for (const tIdx of this.tombstoned) {
                    if (tIdx < snapshot.leafCount) tombstoneHashes.add(snapshot.getLeafHash(tIdx));
                }
                const ppmPrediction = this.ppmModel.predict(tombstoneHashes);
                if (ppmPrediction && ppmPrediction.order >= 2) {
                    // Only use PPM when it has genuine higher-order context (order ≥ 2)
                    // Order-1 is equivalent to our existing first-order Markov with decay
                    const ppmIdx = this.hashToIndex.get(ppmPrediction.predicted);
                    if (ppmIdx !== undefined && this.isCandidateIndexReadable(snapshot, ppmIdx)) {
                        predictedHash = ppmPrediction.predicted;
                        predictedIdx = ppmIdx;
                    }
                }
            }

            // Fall back to first-order Markov if PPM didn't produce a result
            if (predictedHash === null) {
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

    /**
     * Sprint 12: Active forgetting — prune stale, low-weight transitions.
     *
     * A transition is pruned when BOTH conditions are met:
     *   1. Not updated in `pruneStaleDays` days
     *   2. Effective weight (after HLR/global decay) below `pruneWeightThreshold`
     *
     * High-weight transitions survive regardless of age.
     * Only prunes weights — atoms are only removed by explicit tombstone.
     */
    async pruneStaleTransitions(): Promise<number> {
        const nowMs = this.clock();
        const staleThresholdMs = this.pruneStaleDays * 24 * 60 * 60 * 1000;
        const keysToDelete: string[] = [];
        const inMemoryDeletes: Array<{ fromIdx: number; toHash: Hash }> = [];

        for (const [fromIdx, targets] of this.transitions) {
            const updatedAtMap = this.transitionUpdatedAt.get(fromIdx);
            if (!targets || targets.size === 0) continue;

            for (const [toHash, rawWeight] of targets) {
                const updatedAt = updatedAtMap?.get(toHash) ?? 0;
                const age = nowMs - updatedAt;
                if (age < staleThresholdMs) continue; // not stale

                const effectiveWeight = this.getEffectiveTransitionWeight(fromIdx, toHash, rawWeight);
                if (effectiveWeight >= this.pruneWeightThreshold) continue; // still strong

                // Both conditions met — mark for pruning
                const idxStr = String(fromIdx).padStart(10, '0');
                keysToDelete.push(`w:${idxStr}:${toHash}`);
                keysToDelete.push(`wu:${idxStr}:${toHash}`);
                inMemoryDeletes.push({ fromIdx, toHash });
            }
        }

        if (keysToDelete.length === 0) return 0;

        // Batch delete from storage
        let batch = this.storage.batch();
        for (const key of keysToDelete) {
            batch = batch.del(key);
        }
        await batch.write();

        // Delete from in-memory maps
        for (const { fromIdx, toHash } of inMemoryDeletes) {
            this.transitions.get(fromIdx)?.delete(toHash);
            this.transitionUpdatedAt.get(fromIdx)?.delete(toHash);
            // Clean up empty maps
            if (this.transitions.get(fromIdx)?.size === 0) {
                this.transitions.delete(fromIdx);
                this.transitionUpdatedAt.delete(fromIdx);
            }
        }

        if (inMemoryDeletes.length > 0) {
            this.csrDirty = true;
        }

        logger.info(
            { shard: this._shardId, pruned: inMemoryDeletes.length },
            'Pruned stale transitions',
        );

        return inMemoryDeletes.length;
    }

    /**
     * Sprint 13: Persist the PPM trie to LevelDB.
     *
     * Strategy: serialize the full trie to a flat key-value map, then
     * write all entries in a single batch.  Old ppm: keys are deleted first
     * to handle node removal (e.g. after pruning).
     *
     * If the trie exceeds maxNodes, prune before serializing.
     */
    private async persistPpmTrie(): Promise<void> {
        if (!this.ppmModel) return;

        // Prune if over the node cap
        this.ppmModel.prune();

        const entries = this.ppmModel.serialize();
        let batch = this.storage.batch();

        // Delete all existing ppm: keys first (clean slate)
        for await (const [key] of this.storage.iterator({ gte: 'ppm:', lte: 'ppm:~' })) {
            batch = batch.del(key);
        }

        // Write new entries
        for (const [key, value] of entries) {
            batch = batch.put(key, value);
        }

        await batch.write();

        logger.info(
            { shard: this._shardId, ppmEntries: entries.size },
            'PPM trie persisted to LevelDB'
        );
    }

    private isConfidenceDecayEnabled(): boolean {
        return this.confidenceHalfLifeMs > 0;
    }

    private getEffectiveTransitionWeight(fromIdx: number, toHash: Hash, rawWeight: number): number {
        if (!this.isConfidenceDecayEnabled()) return rawWeight;
        const updatedAt = this.transitionUpdatedAt.get(fromIdx)?.get(toHash);
        if (updatedAt === undefined) return rawWeight;

        const elapsedMs = Math.max(0, this.clock() - updatedAt);

        // HLR: use per-atom half-life if model is available
        if (this.hlrModel) {
            const features = this.getHlrFeatures(fromIdx);
            return this.hlrModel.computeEffectiveWeight(rawWeight, elapsedMs, features);
        }

        // Fallback: global half-life
        const decayFactor = Math.pow(0.5, elapsedMs / this.confidenceHalfLifeMs);
        return rawWeight * decayFactor;
    }

    /** Build HLR features for a given atom index. */
    private getHlrFeatures(idx: number): import('./hlr').HlrFeatures {
        const outgoing = this.transitions.get(idx);
        let trainingPasses = 0;
        if (outgoing) {
            for (const w of outgoing.values()) trainingPasses += w;
        }
        return {
            accessCount: this.accessCounts.get(idx) ?? 0,
            trainingPasses,
            atomType: this.atomTypes[idx] ?? 'other',
            provenance: this.atomProvenances[idx] ?? 'default',
        };
    }

    // ─── Full-fidelity export ──────────────────────────────────────────

    /**
     * Export all shard state as portable NDJSON records.
     *
     * Records are fully resolved: weight keys (which use shard-local indices
     * internally) are mapped back to atom names so the export is portable
     * across shard count / routing changes.
     *
     * An optional `hashResolver` resolves toHash values that point to atoms
     * on OTHER shards (cross-shard transitions).  The orchestrator provides
     * this to produce a globally complete export.
     *
     * Record types:
     *   atom          — atom name, hash, index, createdAtMs, status
     *   weight        — fromAtom, toAtom, toHash, raw weight, updatedAtMs
     *   access_count  — atom name, access count
     */
    exportFull(hashResolver?: (hash: Hash) => DataAtom | null): string[] {
        const lines: string[] = [];

        // 1. Atoms (active + tombstoned)
        for (let idx = 0; idx < this.data.length; idx++) {
            const atom = this.data[idx];
            const hash = this.atomHashes.get(atom) ?? this.hashAtom(atom);
            lines.push(JSON.stringify({
                type: 'atom',
                atom,
                index: idx,
                hash,
                createdAtMs: this.atomCreatedAtMs[idx] ?? 0,
                status: this.tombstoned.has(idx) ? 'tombstoned' : 'active',
            }));
        }

        // 2. Weights — resolve index-based keys to atom names
        for (const [fromIdx, targets] of this.transitions) {
            const fromAtom = fromIdx < this.data.length ? this.data[fromIdx] : null;
            if (!fromAtom) continue; // orphaned index — skip

            for (const [toHash, weight] of targets) {
                // Try local resolution first
                let toAtom: DataAtom | null = null;
                const toIdx = this.hashToIndex.get(toHash);
                if (toIdx !== undefined && toIdx < this.data.length) {
                    toAtom = this.data[toIdx];
                }
                // Fall back to cross-shard resolver
                if (toAtom === null && hashResolver) {
                    toAtom = hashResolver(toHash);
                }

                const updatedAtMs = this.transitionUpdatedAt.get(fromIdx)?.get(toHash) ?? null;

                lines.push(JSON.stringify({
                    type: 'weight',
                    fromAtom,
                    toHash,
                    toAtom, // null if unresolvable — import will re-resolve
                    weight,
                    updatedAtMs,
                }));
            }
        }

        // 3. Access counts
        for (const [idx, count] of this.accessCounts) {
            const atom = idx < this.data.length ? this.data[idx] : null;
            if (!atom || count <= 0) continue;
            lines.push(JSON.stringify({
                type: 'access_count',
                atom,
                count,
            }));
        }

        return lines;
    }

    // ─── Full-fidelity import ───────────────────────────────────────────

    /**
     * Import atoms, weights, and access counts from portable NDJSON records
     * produced by exportFull().
     *
     * Import order:
     *   1. Atoms — addAtoms() for any not already present, skip duplicates
     *   2. Commit — ensure atoms are in the snapshot so hashToIndex is populated
     *   3. Weights — resolve atom names to local indices and write to LevelDB
     *   4. Access counts — merge (max) with existing counts
     *
     * @returns Summary of what was imported.
     */
    async importFull(lines: string[]): Promise<{
        atomsImported: number;
        atomsSkipped: number;
        weightsImported: number;
        weightsSkipped: number;
        accessCountsImported: number;
        errors: string[];
    }> {
        const atomRecords: Array<{ atom: string; createdAtMs: number; status: string }> = [];
        const weightRecords: Array<{ fromAtom: string; toHash: string; toAtom: string | null; weight: number; updatedAtMs: number | null }> = [];
        const accessRecords: Array<{ atom: string; count: number }> = [];
        const errors: string[] = [];

        // Parse records
        for (const line of lines) {
            try {
                const rec = JSON.parse(line);
                if (rec.type === 'atom') atomRecords.push(rec);
                else if (rec.type === 'weight') weightRecords.push(rec);
                else if (rec.type === 'access_count') accessRecords.push(rec);
            } catch {
                errors.push(`JSON parse error: ${line.slice(0, 80)}`);
            }
        }

        // 1. Import atoms
        let atomsImported = 0;
        let atomsSkipped = 0;
        const newAtoms: DataAtom[] = [];
        const atomTimestamps: Map<string, number> = new Map();

        for (const rec of atomRecords) {
            atomTimestamps.set(rec.atom, rec.createdAtMs);
            if (this.dataIndex.has(rec.atom)) {
                atomsSkipped++;
                continue;
            }
            const parsed = parseAtomV1(rec.atom);
            if (!parsed) {
                errors.push(`Invalid atom: ${rec.atom.slice(0, 80)}`);
                continue;
            }
            newAtoms.push(rec.atom);
        }

        if (newAtoms.length > 0) {
            // Use addAtoms with preserved timestamps
            for (const atom of newAtoms) {
                const idx = this.data.length;
                this.data.push(atom);
                const parsedAtom = parseAtomV1(atom);
                this.atomTypes.push(parsedAtom?.type ?? 'other');
                const hash = this.hashAtom(atom);
                this.atomHashes.set(atom, hash);
                this.dataIndex.set(atom, idx);
                const createdAtMs = atomTimestamps.get(atom) ?? this.clock();
                this.atomCreatedAtMs[idx] = createdAtMs;
                this.atomProvenances.push(extractProvenance(atom));

                // WAL + LevelDB
                await this.wal.writeAdd(atom).catch((err: unknown) =>
                    logger.error({ err }, 'importFull WAL writeAdd error'));
                const padIdx = String(idx).padStart(10, '0');
                await this.storage.put(`ai:${padIdx}`, atom);
                await this.storage.put(`ts:${padIdx}`, String(createdAtMs));

                this.pending.addLeaf(atom);
                this.lastPendingMutationAtMs = this.clock();
                atomsImported++;
            }

            // Commit so hashToIndex is populated for weight resolution
            await this.commit();
        }

        // Apply tombstones for atoms marked tombstoned in export
        for (const rec of atomRecords) {
            if (rec.status === 'tombstoned') {
                const idx = this.dataIndex.get(rec.atom);
                if (idx !== undefined && !this.tombstoned.has(idx)) {
                    await this.tombstoneAtom(rec.atom);
                }
            }
        }
        if (!this.pending.isEmpty()) await this.commit();

        // 2. Import weights
        let weightsImported = 0;
        let weightsSkipped = 0;

        for (const rec of weightRecords) {
            const fromIdx = this.dataIndex.get(rec.fromAtom);
            if (fromIdx === undefined) {
                weightsSkipped++;
                continue;
            }

            // Resolve toHash: if toAtom is provided, compute its hash
            let toHash = rec.toHash;
            if (rec.toAtom) {
                const resolvedIdx = this.dataIndex.get(rec.toAtom);
                if (resolvedIdx !== undefined && resolvedIdx < this.activeSnapshot.leafCount) {
                    toHash = this.activeSnapshot.getLeafHash(resolvedIdx);
                } else if (resolvedIdx !== undefined) {
                    toHash = this.hashAtom(rec.toAtom);
                }
                // If toAtom isn't in this shard, keep original toHash
            }

            // Write transition to memory
            if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
            const existing = this.transitions.get(fromIdx)!.get(toHash) ?? 0;
            this.transitions.get(fromIdx)!.set(toHash, Math.max(existing, rec.weight));

            if (rec.updatedAtMs !== null) {
                if (!this.transitionUpdatedAt.has(fromIdx)) this.transitionUpdatedAt.set(fromIdx, new Map());
                const existingTs = this.transitionUpdatedAt.get(fromIdx)!.get(toHash) ?? 0;
                this.transitionUpdatedAt.get(fromIdx)!.set(toHash, Math.max(existingTs, rec.updatedAtMs));
            }

            // Persist to LevelDB
            const padFrom = String(fromIdx).padStart(10, '0');
            const weight = Math.max(existing, rec.weight);
            await this.storage.put(`w:${padFrom}:${toHash}`, String(weight));
            if (rec.updatedAtMs !== null) {
                const tsVal = this.transitionUpdatedAt.get(fromIdx)?.get(toHash) ?? rec.updatedAtMs;
                await this.storage.put(`wu:${padFrom}:${toHash}`, String(tsVal));
            }

            weightsImported++;
        }

        // 3. Import access counts (merge: take max)
        let accessCountsImported = 0;
        for (const rec of accessRecords) {
            const idx = this.dataIndex.get(rec.atom);
            if (idx === undefined || rec.count <= 0) continue;

            const existing = this.accessCounts.get(idx) ?? 0;
            const merged = Math.max(existing, rec.count);
            this.accessCounts.set(idx, merged);
            await this.storage.put(`ac:${idx}`, String(merged));
            accessCountsImported++;
        }

        // Rebuild CSR since transitions changed
        if (weightsImported > 0) {
            this.rebuildCsrMatrix();
            this.csrDirty = false;
        }

        return { atomsImported, atomsSkipped, weightsImported, weightsSkipped, accessCountsImported, errors };
    }

    async close(): Promise<void> {
        if (this.commitTimer) { clearInterval(this.commitTimer); this.commitTimer = null; }
        if (!this.pending.isEmpty()) {
            await this.commit().catch((err: unknown) => logger.error({ err }, 'Final commit failed during close'));
        }
        await this.wal.close();
        await this.storage.close();
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
