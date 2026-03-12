/**
 * CachedStorageBackend — Sprint 11
 *
 * Decorator that wraps any StorageBackend with an ARC cache on get().
 * Invalidates on put(), del(), and batch().write().
 * Iterator bypasses cache (range scans go direct to backing store).
 *
 * Critical invariant: every mutation path must invalidate affected keys.
 * A stale cache entry is a silent correctness bug.
 */

import { StorageBackend, BatchOp, IteratorOptions } from './storage_backend';
import { ArcCache, ArcCacheStats } from './arc_cache';

export interface CachedBackendOptions {
    /** ARC cache capacity (number of key-value pairs). Default: 4096. */
    cacheSize?: number;
}

export class CachedStorageBackend implements StorageBackend {
    private readonly inner: StorageBackend;
    private readonly cache: ArcCache<string, string>;

    constructor(inner: StorageBackend, options?: CachedBackendOptions) {
        this.inner = inner;
        const size = options?.cacheSize ?? 4096;
        this.cache = new ArcCache<string, string>(size);
    }

    async open(): Promise<void> {
        return this.inner.open();
    }

    async close(): Promise<void> {
        return this.inner.close();
    }

    /**
     * Cached read. Checks ARC cache first, falls through to backing store.
     * Caches the result on miss (including undefined for missing keys — negative cache).
     */
    async get(key: string): Promise<string | undefined> {
        // Check cache — we use a sentinel for "key does not exist" vs "not cached"
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached === TOMBSTONE_SENTINEL ? undefined : cached;
        }

        // Cache miss — read from backing store
        const value = await this.inner.get(key);

        // Cache the result (including negative lookups)
        this.cache.put(key, value ?? TOMBSTONE_SENTINEL);

        return value;
    }

    /** Write-through: update backing store then invalidate cache. */
    async put(key: string, value: string): Promise<void> {
        await this.inner.put(key, value);
        // Update cache eagerly (write-through, not just invalidation)
        this.cache.put(key, value);
    }

    /** Delete: remove from backing store then invalidate cache. */
    async del(key: string): Promise<void> {
        await this.inner.del(key);
        this.cache.delete(key);
    }

    /**
     * Returns a CachedBatchOp that tracks all keys mutated during the batch
     * and invalidates them from the cache when write() is called.
     *
     * This is critical: the inner batch().write() bypasses individual put/del,
     * so we must intercept and invalidate all affected keys.
     */
    batch(): BatchOp {
        const innerBatch = this.inner.batch();
        const cache = this.cache;
        const mutatedKeys: Array<{ key: string; value?: string }> = [];

        const wrapper: BatchOp = {
            put(key: string, value: string): BatchOp {
                innerBatch.put(key, value);
                mutatedKeys.push({ key, value });
                return wrapper;
            },
            del(key: string): BatchOp {
                innerBatch.del(key);
                mutatedKeys.push({ key });
                return wrapper;
            },
            async write(): Promise<void> {
                await innerBatch.write();
                // Invalidate all keys touched by this batch
                for (const op of mutatedKeys) {
                    if (op.value !== undefined) {
                        // Write-through: update cache with new value
                        cache.put(op.key, op.value);
                    } else {
                        // Delete: remove from cache
                        cache.delete(op.key);
                    }
                }
            },
        };

        return wrapper;
    }

    /** Iterator bypasses cache — range scans go direct to backing store. */
    iterator(opts?: IteratorOptions): AsyncIterable<[string, string]> {
        return this.inner.iterator(opts);
    }

    /** ARC cache statistics snapshot. */
    cacheStats(): ArcCacheStats {
        return this.cache.stats();
    }

    /** Expose the underlying ARC cache for metrics reporting. */
    get arcCache(): ArcCache<string, string> {
        return this.cache;
    }
}

/**
 * Sentinel value used to cache negative lookups (key does not exist).
 * This prevents repeated backing-store reads for missing keys.
 * Must be a string that can never be a valid stored value.
 */
const TOMBSTONE_SENTINEL = '\x00__MMPM_CACHE_NEGATIVE__\x00';
