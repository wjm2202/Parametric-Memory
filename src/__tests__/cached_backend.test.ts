import { describe, it, expect, beforeEach } from 'vitest';
import { CachedStorageBackend } from '../cached_backend';
import { InMemoryBackend } from '../memory_backend';

// ─── Helpers ─────────────────────────────────────────────────────────

let inner: InMemoryBackend;
let cached: CachedStorageBackend;

beforeEach(async () => {
    inner = new InMemoryBackend();
    await inner.open();
    cached = new CachedStorageBackend(inner, { cacheSize: 16 });
    await cached.open();
});

// ─── Basic get/put ───────────────────────────────────────────────────

describe('CachedStorageBackend — Basic operations', () => {
    it('get returns undefined for missing key', async () => {
        expect(await cached.get('missing')).toBeUndefined();
    });

    it('put then get retrieves value', async () => {
        await cached.put('a', '1');
        expect(await cached.get('a')).toBe('1');
    });

    it('put overwrites existing value', async () => {
        await cached.put('a', '1');
        await cached.put('a', '2');
        expect(await cached.get('a')).toBe('2');
    });

    it('del removes value', async () => {
        await cached.put('a', '1');
        await cached.del('a');
        expect(await cached.get('a')).toBeUndefined();
    });

    it('cached reads match uncached reads', async () => {
        // Write directly to inner backend
        await inner.put('x', 'direct');

        // First read — cache miss, goes to inner
        expect(await cached.get('x')).toBe('direct');

        // Second read — cache hit
        expect(await cached.get('x')).toBe('direct');

        const stats = cached.cacheStats();
        expect(stats.hits).toBeGreaterThanOrEqual(1);
    });
});

// ─── Cache invalidation on mutations ─────────────────────────────────

describe('CachedStorageBackend — Invalidation', () => {
    it('put invalidates stale cache entry', async () => {
        await cached.put('a', '1');
        await cached.get('a'); // populate cache

        // Update through cached backend
        await cached.put('a', '2');
        expect(await cached.get('a')).toBe('2');

        // Also verify inner has the new value
        expect(await inner.get('a')).toBe('2');
    });

    it('del invalidates cache entry', async () => {
        await cached.put('a', '1');
        await cached.get('a'); // populate cache

        await cached.del('a');
        expect(await cached.get('a')).toBeUndefined();
        expect(await inner.get('a')).toBeUndefined();
    });

    it('negative cache: missing key is cached as undefined', async () => {
        // First read — miss (inner doesn't have it)
        expect(await cached.get('noexist')).toBeUndefined();

        // Write directly to inner (bypass cache)
        await inner.put('noexist', 'surprise');

        // Cached backend should return undefined (negative cache hit)
        // This is correct behavior — the cache is consistent with what
        // it knows. The user must go through cached.put() to update.
        const result = await cached.get('noexist');
        // Note: this returns undefined because the negative cache entry is still valid
        // This is by design — direct writes to inner bypass the cache
        expect(result).toBeUndefined();
    });
});

// ─── Batch operations ────────────────────────────────────────────────

describe('CachedStorageBackend — Batch invalidation', () => {
    it('batch put invalidates cache on write()', async () => {
        // Pre-populate cache
        await cached.put('a', '1');
        await cached.put('b', '2');
        await cached.get('a');
        await cached.get('b');

        // Batch update
        const batch = cached.batch();
        batch.put('a', '10');
        batch.put('b', '20');
        batch.put('c', '30');
        await batch.write();

        // All values should reflect the batch update
        expect(await cached.get('a')).toBe('10');
        expect(await cached.get('b')).toBe('20');
        expect(await cached.get('c')).toBe('30');

        // Inner should also have the values
        expect(await inner.get('a')).toBe('10');
        expect(await inner.get('b')).toBe('20');
        expect(await inner.get('c')).toBe('30');
    });

    it('batch del invalidates cache on write()', async () => {
        await cached.put('a', '1');
        await cached.put('b', '2');
        await cached.get('a');
        await cached.get('b');

        const batch = cached.batch();
        batch.del('a');
        await batch.write();

        expect(await cached.get('a')).toBeUndefined();
        expect(await cached.get('b')).toBe('2');
    });

    it('mixed batch put+del invalidates correctly', async () => {
        await cached.put('a', '1');
        await cached.put('b', '2');
        await cached.put('c', '3');

        const batch = cached.batch();
        batch.put('a', '100');
        batch.del('b');
        batch.put('d', '400');
        await batch.write();

        expect(await cached.get('a')).toBe('100');
        expect(await cached.get('b')).toBeUndefined();
        expect(await cached.get('c')).toBe('3');
        expect(await cached.get('d')).toBe('400');
    });

    it('batch write-through: cache has new values immediately', async () => {
        const batch = cached.batch();
        batch.put('x', 'val');
        await batch.write();

        // The cache should have been updated via write-through
        const stats1 = cached.cacheStats();
        const sizeAfterBatch = stats1.size;

        // This get should be a cache hit
        expect(await cached.get('x')).toBe('val');
        const stats2 = cached.cacheStats();
        expect(stats2.hits).toBeGreaterThan(stats1.hits);
    });
});

// ─── Iterator bypasses cache ─────────────────────────────────────────

describe('CachedStorageBackend — Iterator', () => {
    it('iterator returns all entries from backing store', async () => {
        await cached.put('a', '1');
        await cached.put('b', '2');
        await cached.put('c', '3');

        const entries: [string, string][] = [];
        for await (const pair of cached.iterator()) {
            entries.push(pair);
        }

        expect(entries).toEqual([['a', '1'], ['b', '2'], ['c', '3']]);
    });

    it('iterator respects range options', async () => {
        await cached.put('a', '1');
        await cached.put('b', '2');
        await cached.put('c', '3');
        await cached.put('d', '4');

        const entries: [string, string][] = [];
        for await (const pair of cached.iterator({ gte: 'b', lte: 'c' })) {
            entries.push(pair);
        }

        expect(entries).toEqual([['b', '2'], ['c', '3']]);
    });
});

// ─── Cache stats ─────────────────────────────────────────────────────

describe('CachedStorageBackend — Cache stats', () => {
    it('reports hits and misses correctly', async () => {
        await cached.put('a', '1');

        // First get after put — should be a hit (write-through)
        await cached.get('a');
        // Get missing key — miss
        await cached.get('missing');

        const stats = cached.cacheStats();
        expect(stats.hits).toBeGreaterThanOrEqual(1);
        expect(stats.misses).toBeGreaterThanOrEqual(1);
    });

    it('cacheStats returns ArcCacheStats shape', async () => {
        const stats = cached.cacheStats();
        expect(stats).toHaveProperty('size');
        expect(stats).toHaveProperty('capacity');
        expect(stats).toHaveProperty('hits');
        expect(stats).toHaveProperty('misses');
        expect(stats).toHaveProperty('evictions');
        expect(stats).toHaveProperty('p');
    });
});

// ─── Consistency: cached reads always match inner ────────────────────

describe('CachedStorageBackend — Consistency guarantee', () => {
    it('100 sequential put/get/del operations stay consistent', async () => {
        for (let i = 0; i < 100; i++) {
            const key = `k${i % 20}`;
            const value = `v${i}`;

            if (i % 5 === 0) {
                await cached.del(key);
                expect(await cached.get(key)).toBeUndefined();
                expect(await inner.get(key)).toBeUndefined();
            } else {
                await cached.put(key, value);
                expect(await cached.get(key)).toBe(value);
                expect(await inner.get(key)).toBe(value);
            }
        }
    });

    it('batch operations maintain cached/inner consistency', async () => {
        // Do 10 batches of 10 operations each
        for (let b = 0; b < 10; b++) {
            const batch = cached.batch();
            for (let i = 0; i < 10; i++) {
                const key = `k${b * 10 + i}`;
                batch.put(key, `batch${b}_val${i}`);
            }
            await batch.write();
        }

        // Verify all 100 keys are consistent
        for (let b = 0; b < 10; b++) {
            for (let i = 0; i < 10; i++) {
                const key = `k${b * 10 + i}`;
                const expected = `batch${b}_val${i}`;
                expect(await cached.get(key)).toBe(expected);
                expect(await inner.get(key)).toBe(expected);
            }
        }
    });
});
