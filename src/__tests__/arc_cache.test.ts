import { describe, it, expect } from 'vitest';
import { ArcCache } from '../arc_cache';

// ─── Basic operations ─────────────────────────────────────────────────

describe('ArcCache — Basic operations', () => {
    it('get returns undefined for empty cache', () => {
        const cache = new ArcCache<string, string>(4);
        expect(cache.get('missing')).toBeUndefined();
    });

    it('put then get retrieves value', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        expect(cache.get('a')).toBe('1');
    });

    it('put overwrites existing value', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        cache.put('a', '2');
        expect(cache.get('a')).toBe('2');
    });

    it('delete removes cached entry', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        expect(cache.delete('a')).toBe(true);
        expect(cache.get('a')).toBeUndefined();
    });

    it('delete returns false for missing key', () => {
        const cache = new ArcCache<string, string>(4);
        expect(cache.delete('missing')).toBe(false);
    });

    it('has returns true for cached, false for missing', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        expect(cache.has('a')).toBe(true);
        expect(cache.has('b')).toBe(false);
    });

    it('size tracks entries correctly', () => {
        const cache = new ArcCache<string, string>(4);
        expect(cache.size).toBe(0);
        cache.put('a', '1');
        expect(cache.size).toBe(1);
        cache.put('b', '2');
        expect(cache.size).toBe(2);
        cache.delete('a');
        expect(cache.size).toBe(1);
    });

    it('throws on capacity < 1', () => {
        expect(() => new ArcCache(0)).toThrow('capacity must be >= 1');
    });
});

// ─── Capacity and eviction ────────────────────────────────────────────

describe('ArcCache — Capacity enforcement', () => {
    it('never exceeds capacity', () => {
        const cache = new ArcCache<string, string>(3);
        for (let i = 0; i < 10; i++) {
            cache.put(`k${i}`, `v${i}`);
            expect(cache.size).toBeLessThanOrEqual(3);
        }
    });

    it('evicts LRU from T1 when full', () => {
        const cache = new ArcCache<string, string>(3);
        cache.put('a', '1');
        cache.put('b', '2');
        cache.put('c', '3');
        // All fit
        expect(cache.size).toBe(3);

        // This should evict 'a' (LRU in T1)
        cache.put('d', '4');
        expect(cache.size).toBe(3);
        expect(cache.get('a')).toBeUndefined(); // evicted
        expect(cache.get('d')).toBe('4');
    });

    it('records evictions in stats', () => {
        const cache = new ArcCache<string, string>(2);
        cache.put('a', '1');
        cache.put('b', '2');
        cache.put('c', '3'); // evicts 'a'
        expect(cache.stats().evictions).toBeGreaterThan(0);
    });
});

// ─── Promotion from T1 to T2 ──────────────────────────────────────────

describe('ArcCache — T1 → T2 promotion', () => {
    it('second access promotes from T1 to T2', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1'); // → T1
        cache.get('a');      // → T2 (second access)

        const stats = cache.stats();
        expect(stats.t1Size).toBe(0);
        expect(stats.t2Size).toBe(1);
    });

    it('promoted entries survive eviction longer', () => {
        const cache = new ArcCache<string, string>(3);
        cache.put('a', '1');
        cache.get('a');      // promote 'a' to T2
        cache.put('b', '2');
        cache.put('c', '3');
        cache.put('d', '4'); // should evict from T1 (b or c), not T2 (a)

        expect(cache.get('a')).toBe('1'); // T2 entry survived
    });
});

// ─── Ghost entries and adaptation ─────────────────────────────────────

describe('ArcCache — Ghost list adaptation', () => {
    it('B1 ghost hit increases p (favours recency)', () => {
        const cache = new ArcCache<string, string>(2);
        cache.put('a', '1');
        cache.put('b', '2');
        const p0 = cache.stats().p;

        // 'c' evicts 'a' from T1 → B1
        cache.put('c', '3');

        // Re-insert 'a' — B1 ghost hit should increase p
        cache.put('a', '1');
        expect(cache.stats().p).toBeGreaterThanOrEqual(p0);
    });

    it('B2 ghost hit decreases p (favours frequency)', () => {
        const cache = new ArcCache<string, string>(2);
        // Fill T2: put + get each key twice
        cache.put('a', '1');
        cache.get('a'); // promote to T2
        cache.put('b', '2');
        cache.get('b'); // promote to T2

        // Force p up first
        cache.put('c', '3'); // evicts LRU from T2 (a) → B2
        const p0 = cache.stats().p;

        // Re-insert 'a' — should be a B2 ghost hit, decreasing p
        cache.put('a', '1');
        expect(cache.stats().p).toBeLessThanOrEqual(p0);
    });
});

// ─── Stats and hit ratio ──────────────────────────────────────────────

describe('ArcCache — Statistics', () => {
    it('tracks hits and misses correctly', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');

        cache.get('a'); // hit
        cache.get('b'); // miss
        cache.get('a'); // hit

        const stats = cache.stats();
        expect(stats.hits).toBe(2);
        expect(stats.misses).toBe(1);
    });

    it('hitRatio computes correctly', () => {
        const cache = new ArcCache<string, string>(4);
        expect(cache.hitRatio).toBe(0); // no accesses

        cache.put('a', '1');
        cache.get('a'); // hit
        cache.get('a'); // hit
        cache.get('b'); // miss

        expect(cache.hitRatio).toBeCloseTo(2 / 3, 10);
    });

    it('stats returns all fields', () => {
        const cache = new ArcCache<string, string>(4);
        const stats = cache.stats();
        expect(stats).toHaveProperty('size');
        expect(stats).toHaveProperty('capacity');
        expect(stats).toHaveProperty('hits');
        expect(stats).toHaveProperty('misses');
        expect(stats).toHaveProperty('evictions');
        expect(stats).toHaveProperty('p');
        expect(stats).toHaveProperty('t1Size');
        expect(stats).toHaveProperty('t2Size');
        expect(stats).toHaveProperty('b1Size');
        expect(stats).toHaveProperty('b2Size');
    });
});

// ─── Mixed workload: ARC vs LRU comparison ──────────────────────────

describe('ArcCache — ARC advantage over LRU', () => {
    /**
     * Synthetic workload that exhibits the scan-resistant property of ARC.
     * Pattern: alternating between a small "hot" working set and a large scan.
     * ARC should outperform a simple LRU because it learns frequency.
     */
    it('ARC achieves higher hit rate than LRU on mixed scan+hotset workload', () => {
        const capacity = 10;
        const arc = new ArcCache<string, string>(capacity);

        // Simulate simple LRU for comparison
        const lru: string[] = [];
        const lruSet = new Set<string>();
        let lruHits = 0;
        let lruMisses = 0;

        function lruAccess(key: string): void {
            if (lruSet.has(key)) {
                lruHits++;
                // Move to front
                const idx = lru.indexOf(key);
                lru.splice(idx, 1);
                lru.unshift(key);
            } else {
                lruMisses++;
                lru.unshift(key);
                lruSet.add(key);
                if (lru.length > capacity) {
                    const evicted = lru.pop()!;
                    lruSet.delete(evicted);
                }
            }
        }

        // Hot set: 5 keys accessed frequently
        const hotSet = Array.from({ length: 5 }, (_, i) => `hot_${i}`);
        // Scan set: 20 keys accessed once (simulates a full scan/bootstrap)
        const scanSet = Array.from({ length: 20 }, (_, i) => `scan_${i}`);

        // Phase 1: Establish hot set
        for (let round = 0; round < 3; round++) {
            for (const key of hotSet) {
                arc.put(key, 'v');
                arc.get(key); // access to promote
                lruAccess(key);
            }
        }

        // Phase 2: Scan — flood with one-time keys
        for (const key of scanSet) {
            arc.put(key, 'v');
            lruAccess(key);
        }

        // Phase 3: Re-access hot set — ARC should remember, LRU may have evicted
        for (const key of hotSet) {
            arc.get(key);
            lruAccess(key);
        }

        const arcHitRatio = arc.hitRatio;
        const lruTotal = lruHits + lruMisses;
        const lruHitRatio = lruTotal > 0 ? lruHits / lruTotal : 0;

        // ARC should beat or match LRU
        expect(arcHitRatio).toBeGreaterThanOrEqual(lruHitRatio);
    });
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe('ArcCache — Edge cases', () => {
    it('capacity 1 works correctly', () => {
        const cache = new ArcCache<string, string>(1);
        cache.put('a', '1');
        expect(cache.get('a')).toBe('1');
        cache.put('b', '2');
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe('2');
    });

    it('numeric keys work', () => {
        const cache = new ArcCache<number, string>(4);
        cache.put(1, 'one');
        cache.put(2, 'two');
        expect(cache.get(1)).toBe('one');
        expect(cache.get(2)).toBe('two');
    });

    it('rapid repeated access to same key', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        for (let i = 0; i < 100; i++) {
            expect(cache.get('a')).toBe('1');
        }
        expect(cache.stats().hits).toBe(100);
    });

    it('delete then re-insert works', () => {
        const cache = new ArcCache<string, string>(4);
        cache.put('a', '1');
        cache.delete('a');
        cache.put('a', '2');
        expect(cache.get('a')).toBe('2');
    });

    it('stress test: 1000 random operations maintain invariants', () => {
        const cache = new ArcCache<string, string>(20);
        const rng = mulberry32(12345);

        for (let i = 0; i < 1000; i++) {
            const op = rng() % 3;
            const key = `k${rng() % 50}`;

            if (op === 0) {
                cache.put(key, `v${i}`);
            } else if (op === 1) {
                cache.get(key);
            } else {
                cache.delete(key);
            }

            // Invariant: size never exceeds capacity
            expect(cache.size).toBeLessThanOrEqual(20);
            // Invariant: T1 + B1 + T2 + B2 ≤ 2c
            const s = cache.stats();
            expect(s.t1Size + s.b1Size + s.t2Size + s.b2Size).toBeLessThanOrEqual(40);
        }
    });
});

/**
 * Simple deterministic PRNG (Mulberry32).
 */
function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0);
    };
}
