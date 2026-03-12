/**
 * AccessLog — Durable event log for HLR training data.
 *
 * Sprint 14: Records access, training, and bootstrap events as time-ordered
 * entries in LevelDB under the `al:` prefix.  Key: `al:<timestamp_pad15>`.
 * Value: JSON `{ atom, type, ts }`.
 *
 * Capped at MMPM_ACCESS_LOG_MAX entries (default 50K) with FIFO eviction:
 * oldest entries are deleted when the cap is exceeded.
 *
 * The log lives alongside atom data in the same StorageBackend per shard.
 * Query methods enable the training pipeline (tools/hlr) to extract data
 * without touching core shard logic.
 */

import type { StorageBackend } from './storage_backend';

// ─── Types ──────────────────────────────────────────────────────────────

export type AccessEventType = 'access' | 'train' | 'bootstrap';

export interface AccessLogEntry {
    atom: string;
    type: AccessEventType;
    ts: number; // epoch ms
}

export interface AccessLogOptions {
    /** Maximum number of log entries before FIFO eviction. Default 50_000. */
    maxEntries?: number;
}

// ─── Implementation ─────────────────────────────────────────────────────

const AL_PREFIX = 'al:';
const AL_UPPER  = 'al:~';
const PAD_LEN   = 15; // enough for epoch ms through year ~3170

export class AccessLog {
    private readonly storage: StorageBackend;
    private readonly maxEntries: number;
    private entryCount = 0;
    private initialized = false;

    constructor(storage: StorageBackend, options?: AccessLogOptions) {
        this.storage = storage;
        this.maxEntries = options?.maxEntries ?? 50_000;
    }

    /**
     * Count existing entries from storage.  Call once after storage.open().
     */
    async init(): Promise<void> {
        let count = 0;
        for await (const [_key] of this.storage.iterator({ gte: AL_PREFIX, lte: AL_UPPER })) {
            count++;
            void _key;
        }
        this.entryCount = count;
        this.initialized = true;
    }

    /**
     * Append an event to the log.
     * If the log exceeds maxEntries, evict the oldest entries.
     */
    async append(entry: AccessLogEntry): Promise<void> {
        const key = `${AL_PREFIX}${String(entry.ts).padStart(PAD_LEN, '0')}`;
        const value = JSON.stringify(entry);
        await this.storage.put(key, value);
        this.entryCount++;

        if (this.entryCount > this.maxEntries) {
            await this.evict();
        }
    }

    /**
     * Append multiple entries in a single batch write (no eviction between entries).
     */
    async appendBatch(entries: AccessLogEntry[]): Promise<void> {
        if (entries.length === 0) return;
        let batch = this.storage.batch();
        for (const entry of entries) {
            const key = `${AL_PREFIX}${String(entry.ts).padStart(PAD_LEN, '0')}`;
            batch = batch.put(key, JSON.stringify(entry));
        }
        await batch.write();
        this.entryCount += entries.length;

        if (this.entryCount > this.maxEntries) {
            await this.evict();
        }
    }

    /**
     * Query entries within a time range [fromTs, toTs] (inclusive).
     * Returns entries in chronological order.
     */
    async query(fromTs: number, toTs: number): Promise<AccessLogEntry[]> {
        const gteKey = `${AL_PREFIX}${String(fromTs).padStart(PAD_LEN, '0')}`;
        const lteKey = `${AL_PREFIX}${String(toTs).padStart(PAD_LEN, '0')}`;

        const results: AccessLogEntry[] = [];
        for await (const [, value] of this.storage.iterator({ gte: gteKey, lte: lteKey })) {
            try {
                const entry = JSON.parse(value) as AccessLogEntry;
                if (entry.atom && entry.type && typeof entry.ts === 'number') {
                    results.push(entry);
                }
            } catch {
                // skip malformed entries
            }
        }
        return results;
    }

    /**
     * Read all entries.  Returns in chronological order.
     */
    async readAll(): Promise<AccessLogEntry[]> {
        return this.query(0, Number.MAX_SAFE_INTEGER);
    }

    /**
     * Current number of entries (approximate — may drift if external writes happen).
     */
    get count(): number {
        return this.entryCount;
    }

    /**
     * FIFO eviction: remove oldest entries until count <= maxEntries.
     */
    private async evict(): Promise<void> {
        const overshoot = this.entryCount - this.maxEntries;
        if (overshoot <= 0) return;

        // Delete the oldest entries — they have the smallest keys
        let deleted = 0;
        let batch = this.storage.batch();
        for await (const [key] of this.storage.iterator({ gte: AL_PREFIX, lte: AL_UPPER })) {
            if (deleted >= overshoot) break;
            batch = batch.del(key);
            deleted++;
        }
        await batch.write();
        this.entryCount -= deleted;
    }
}
