/**
 * StorageBackend — Abstract key-value storage interface.
 *
 * Sprint 8: Decouples shard_worker.ts from LevelDB internals so that
 * future sprints (ARC cache, tiered storage, RocksDB migration) can
 * swap or wrap the storage layer without touching shard logic.
 *
 * Contract:
 *   - Keys and values are UTF-8 strings.
 *   - `get()` returns `undefined` for missing keys (never throws LEVEL_NOT_FOUND).
 *   - `iterator()` yields [key, value] pairs in **byte order** (ASCII lexicographic
 *     for the key namespaces used by MMPM: ai:, ac:, th:, ts:, w:, wu:).
 *   - `batch()` returns a chainable batch object; nothing is persisted until `write()`.
 */

/** Chainable batch operations — accumulated in memory, flushed atomically by `write()`. */
export interface BatchOp {
    put(key: string, value: string): BatchOp;
    del(key: string): BatchOp;
    write(): Promise<void>;
}

/** Range scan options for `iterator()`. Both bounds are inclusive. */
export interface IteratorOptions {
    gte?: string;
    lte?: string;
}

/**
 * Core storage abstraction. Implementations:
 *   - LevelDbBackend  (production — wraps classic-level)
 *   - InMemoryBackend (testing — sorted Map, no disk I/O)
 *   - CachedBackend   (Sprint 11 — ARC cache decorator)
 *   - TieredBackend   (Sprint 15 — hot/warm/cold)
 */
export interface StorageBackend {
    /** Open the backing store (create directories, acquire locks, etc.). */
    open(): Promise<void>;

    /** Close the backing store, flushing any pending writes. */
    close(): Promise<void>;

    /**
     * Read a single key.
     * @returns The value string, or `undefined` if the key does not exist.
     *          MUST NOT throw for missing keys.
     */
    get(key: string): Promise<string | undefined>;

    /** Write a single key-value pair. */
    put(key: string, value: string): Promise<void>;

    /** Delete a single key. No-op if the key does not exist. */
    del(key: string): Promise<void>;

    /**
     * Create a batch operation.
     * Accumulated puts/dels are applied atomically when `write()` is called.
     */
    batch(): BatchOp;

    /**
     * Iterate over a key range in **byte order** (lexicographic for ASCII).
     *
     * Both `gte` and `lte` are inclusive bounds.  If omitted, the scan
     * covers all keys from the start/end of the keyspace.
     *
     * Implementations MUST yield keys in the same order as LevelDB's default
     * byte-order comparator.  For ASCII-only keys (which MMPM uses exclusively),
     * this is equivalent to JavaScript's `<` / `>` string comparison.
     */
    iterator(opts?: IteratorOptions): AsyncIterable<[string, string]>;
}
