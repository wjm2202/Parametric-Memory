import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { mkdirSync } from 'fs';

/**
 * WRITE-AHEAD LOG (WAL) — Per-shard crash durability.
 *
 * The WAL records every structural mutation (ADD atom, TOMBSTONE atom) before
 * it is applied in memory or persisted to LevelDB.  After a successful commit(),
 * a COMMIT marker is written and the WAL is truncated.
 *
 * Crash recovery flow (ShardWorker.init):
 *   1. Open the WAL file.
 *   2. Read all entries.  If the last entry is not COMMIT, the previous run
 *      crashed between writes and commit — entries after the last COMMIT are
 *      "uncommitted" and must be replayed.
 *   3. Replay uncommitted entries: re-apply LevelDB writes and queue into
 *      PendingWrites, then auto-commit to rebuild the correct snapshot.
 *   4. Truncate the WAL.
 *
 * Format: newline-delimited JSON (NDJSON).
 * Each line is a self-contained entry with a checksum to detect corruption.
 *
 *   {"seq":1,"ts":1700000000000,"op":"ADD","data":"atom_text","ck":"abcdef12"}
 *   {"seq":2,"ts":1700000000001,"op":"TOMBSTONE","index":3,"ck":"12abcdef"}
 *   {"seq":3,"ts":1700000000002,"op":"COMMIT","ck":"deadbeef"}
 *
 * Durability guarantee: every entry is flushed with fsync before the
 * corresponding in-memory/LevelDB change is made, so a crash at any point
 * leaves the WAL in a state we can replay from.
 */

export type WalOpKind = 'ADD' | 'TOMBSTONE' | 'COMMIT';

export interface WalEntry {
    seq: number;
    ts: number;
    op: WalOpKind;
    data?: string;    // ADD: atom text
    index?: number;   // ADD/TOMBSTONE: leaf index when available
    ck: string;       // sha256(seq+ts+op+payload) truncated to 8 hex chars
}

function checksum(entry: Omit<WalEntry, 'ck'>): string {
    const payload = JSON.stringify({
        seq: entry.seq,
        ts: entry.ts,
        op: entry.op,
        data: entry.data,
        index: entry.index,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 8);
}

export class ShardWAL {
    private readonly filePath: string;
    private readonly compactThresholdBytes: number;
    private readonly statCheckIntervalBytes: number;
    private fd: fsp.FileHandle | null = null;
    private seq: number = 0;
    private bytesSinceLastStat: number = 0;
    private batchBuffer: WalEntry[] = [];

    /**
     * @param walFilePath  Full path to the WAL file, e.g. "./mmpm-db/shard_0.wal"
     *                     The parent directory is created automatically.
     */
    constructor(
        walFilePath: string,
        options?: {
            compactThresholdBytes?: number;
            statCheckIntervalBytes?: number;
        }
    ) {
        this.filePath = walFilePath;
        this.compactThresholdBytes = options?.compactThresholdBytes ?? 256 * 1024;
        const requestedInterval = options?.statCheckIntervalBytes;
        if (requestedInterval !== undefined && requestedInterval > 0) {
            this.statCheckIntervalBytes = requestedInterval;
        } else {
            this.statCheckIntervalBytes = Math.max(1, Math.min(4096, this.compactThresholdBytes));
        }
        const dir = join(walFilePath, '..');
        try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    }

    /**
     * Open (or create) the WAL file for appending.
     * Safe to call multiple times — no-op if already open.
     */
    async open(): Promise<void> {
        if (this.fd) return;
        // 'a+' = append + read; creates if not exists
        this.fd = await fsp.open(this.filePath, 'a+');
        this.bytesSinceLastStat = 0;
    }

    /**
     * Write an ADD entry and fsync.
     * Call BEFORE updating in-memory state and BEFORE LevelDB write.
     */
    async writeAdd(data: string, index?: number): Promise<void> {
        const entry: WalEntry = {
            seq: ++this.seq,
            ts: Date.now(),
            op: 'ADD',
            data,
            index,
            ck: '',
        };
        entry.ck = checksum(entry);
        await this.appendLine(entry);
    }

    /**
     * Write a TOMBSTONE entry and fsync.
     * Call BEFORE updating in-memory state and BEFORE LevelDB write.
     */
    async writeTombstone(index: number): Promise<void> {
        const entry: WalEntry = {
            seq: ++this.seq,
            ts: Date.now(),
            op: 'TOMBSTONE',
            index,
            ck: '',
        };
        entry.ck = checksum(entry);
        await this.appendLine(entry);
    }

    /**
     * Write a COMMIT marker and fsync.
     * Call AFTER the snapshot swap completes.
     * Followed immediately by truncate() to keep the file small.
     */
    async writeCommit(): Promise<void> {
        const entry: WalEntry = {
            seq: ++this.seq,
            ts: Date.now(),
            op: 'COMMIT',
            ck: '',
        };
        entry.ck = checksum(entry);
        await this.appendLine(entry);
    }

    // ─── Batched writes (group commit) ────────────────────────────────

    /**
     * Buffer an ADD entry without fsyncing.
     * Call flushBatch() after all entries are buffered to fsync once.
     */
    writeAddBatched(data: string, index?: number): void {
        const entry: WalEntry = {
            seq: ++this.seq,
            ts: Date.now(),
            op: 'ADD',
            data,
            index,
            ck: '',
        };
        entry.ck = checksum(entry);
        this.batchBuffer.push(entry);
    }

    /**
     * Buffer a TOMBSTONE entry without fsyncing.
     * Call flushBatch() after all entries are buffered to fsync once.
     */
    writeTombstoneBatched(index: number): void {
        const entry: WalEntry = {
            seq: ++this.seq,
            ts: Date.now(),
            op: 'TOMBSTONE',
            index,
            ck: '',
        };
        entry.ck = checksum(entry);
        this.batchBuffer.push(entry);
    }

    /**
     * Flush all buffered entries in a single write() + single fsync().
     * This is the group commit: N entries, 1 fsync instead of N fsyncs.
     * Returns the number of entries flushed.
     */
    async flushBatch(): Promise<number> {
        const count = this.batchBuffer.length;
        if (count === 0) return 0;

        if (!this.fd) await this.open();

        const payload = this.batchBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        await this.fd!.write(payload);
        await this.fd!.sync();

        this.bytesSinceLastStat += Buffer.byteLength(payload, 'utf8');
        this.batchBuffer = [];

        await this.compactIfNeeded();
        return count;
    }

    /**
     * Number of entries currently buffered (not yet fsynced).
     */
    get pendingBatchSize(): number {
        return this.batchBuffer.length;
    }

    /**
     * Read all entries from the WAL file and return only uncommitted ones.
     *
     * "Uncommitted" = entries after the last COMMIT marker (or all entries
     * if no COMMIT has ever been written).
     *
     * Entries with invalid checksums are silently dropped (corruption defence).
     * If the file doesn't exist or is empty, returns [].
     */
    async readUncommitted(): Promise<WalEntry[]> {
        const allEntries = await this.readAllEntries();
        return this.getUncommittedEntries(allEntries);
    }

    /**
     * Truncate the WAL file to zero bytes.
     * Called after a successful commit so the file doesn't grow unboundedly.
     * The COMMIT marker itself is proof the data is safely in the snapshot
     * and LevelDB — the WAL entries are no longer needed.
     */
    async truncate(): Promise<void> {
        if (this.fd) {
            await this.fd.truncate(0);
            await this.fd.sync();
        } else {
            try {
                await fsp.truncate(this.filePath, 0);
            } catch { /* file may not exist */ }
        }
        this.seq = 0;
        this.bytesSinceLastStat = 0;
    }

    async close(): Promise<void> {
        if (this.fd) {
            await this.fd.close();
            this.fd = null;
        }
        this.bytesSinceLastStat = 0;
    }

    // ─── Private ────────────────────────────────────────────────────────

    private async appendLine(entry: WalEntry): Promise<void> {
        if (!this.fd) await this.open();
        const line = JSON.stringify(entry) + '\n';
        await this.fd!.write(line);
        // fsync: flush OS page cache to storage device before returning.
        // This is the guarantee that the entry survives a process crash.
        await this.fd!.sync();
        this.bytesSinceLastStat += Buffer.byteLength(line, 'utf8');
        await this.compactIfNeeded();
    }

    private async readAllEntries(): Promise<WalEntry[]> {
        let raw: string;
        try {
            raw = await fsp.readFile(this.filePath, 'utf-8');
        } catch {
            return [];
        }

        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        const allEntries: WalEntry[] = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as WalEntry;
                const { ck, ...rest } = entry;
                if (checksum(rest as Omit<WalEntry, 'ck'>) !== ck) continue;
                allEntries.push(entry);
            } catch {
                continue;
            }
        }
        return allEntries;
    }

    private getUncommittedEntries(allEntries: WalEntry[]): WalEntry[] {
        let lastCommitIdx = -1;
        for (let i = allEntries.length - 1; i >= 0; i--) {
            if (allEntries[i].op === 'COMMIT') {
                lastCommitIdx = i;
                break;
            }
        }
        return allEntries.slice(lastCommitIdx + 1);
    }

    private compactEntries(allEntries: WalEntry[]): WalEntry[] {
        const uncommitted = this.getUncommittedEntries(allEntries);
        const compacted: Array<WalEntry | null> = [];
        const addPosByIndex = new Map<number, number>();
        const addPosByData = new Map<string, number>();
        const tombstonedIndices = new Set<number>();

        for (const entry of uncommitted) {
            if (entry.op === 'ADD') {
                if (entry.data && addPosByData.has(entry.data)) continue;
                const pos = compacted.push(entry) - 1;
                if (entry.index !== undefined) addPosByIndex.set(entry.index, pos);
                if (entry.data) addPosByData.set(entry.data, pos);
                continue;
            }

            if (entry.op === 'TOMBSTONE') {
                if (entry.index === undefined) continue;

                const addPos = addPosByIndex.get(entry.index);
                if (addPos !== undefined) {
                    const addEntry = compacted[addPos];
                    if (addEntry?.data) addPosByData.delete(addEntry.data);
                    compacted[addPos] = null;
                    addPosByIndex.delete(entry.index);
                    continue;
                }

                if (tombstonedIndices.has(entry.index)) continue;
                tombstonedIndices.add(entry.index);
                compacted.push(entry);
            }
        }

        return compacted.filter((e): e is WalEntry => e !== null);
    }

    private async compactIfNeeded(): Promise<void> {
        if (!this.fd || this.compactThresholdBytes <= 0) return;
        if (this.bytesSinceLastStat < this.statCheckIntervalBytes) return;
        this.bytesSinceLastStat = 0;

        const stat = await this.fd.stat();
        if (stat.size <= this.compactThresholdBytes) return;

        const allEntries = await this.readAllEntries();
        const compacted = this.compactEntries(allEntries);
        const payload = compacted.length > 0
            ? `${compacted.map(e => JSON.stringify(e)).join('\n')}\n`
            : '';

        await this.fd.truncate(0);
        if (payload.length > 0) {
            await this.fd.writeFile(payload, 'utf-8');
        }
        await this.fd.sync();
        this.bytesSinceLastStat = 0;

        const maxSeq = compacted.reduce((mx, e) => Math.max(mx, e.seq), 0);
        if (maxSeq > this.seq) this.seq = maxSeq;
    }
}
