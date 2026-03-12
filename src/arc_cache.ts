/**
 * ARC (Adaptive Replacement Cache) — Sprint 11
 *
 * Implements the ARC algorithm from "ARC: A Self-Tuning, Low Overhead
 * Replacement Cache" (Megiddo & Modha, 2003).
 *
 * ARC dynamically balances between recency (T1/B1) and frequency (T2/B2)
 * by adapting the parameter `p` based on observed access patterns.
 * This makes it ideal for MMPM's mixed workload: bootstrap bursts (hot,
 * frequency-dominated) followed by scattered writes (warm, recency-dominated).
 *
 * Four lists:
 *   T1 — Recent cache entries (seen once recently)
 *   T2 — Frequent cache entries (seen at least twice recently)
 *   B1 — Ghost entries evicted from T1 (recency history)
 *   B2 — Ghost entries evicted from T2 (frequency history)
 *
 * Invariant: |T1| + |T2| ≤ c  (cache capacity)
 * Invariant: |T1| + |B1| + |T2| + |B2| ≤ 2c
 *
 * No external dependencies.
 */

export interface ArcCacheStats {
    /** Current number of cached entries (|T1| + |T2|). */
    size: number;
    /** Maximum cache capacity. */
    capacity: number;
    /** Total cache hits. */
    hits: number;
    /** Total cache misses. */
    misses: number;
    /** Total evictions from cache (T1 or T2). */
    evictions: number;
    /** Current adaptive parameter p (target size for T1). */
    p: number;
    /** Current |T1|. */
    t1Size: number;
    /** Current |T2|. */
    t2Size: number;
    /** Current |B1| (ghost). */
    b1Size: number;
    /** Current |B2| (ghost). */
    b2Size: number;
}

/**
 * Doubly-linked list node for O(1) insertion/removal.
 */
class LruNode<K, V> {
    key: K;
    value: V | undefined; // undefined for ghost entries
    prev: LruNode<K, V> | null = null;
    next: LruNode<K, V> | null = null;

    constructor(key: K, value?: V) {
        this.key = key;
        this.value = value;
    }
}

/**
 * Doubly-linked list with O(1) push-to-front, remove, pop-from-back.
 */
class DoublyLinkedList<K, V> {
    private head: LruNode<K, V> | null = null;
    private tail: LruNode<K, V> | null = null;
    private _size = 0;

    get size(): number {
        return this._size;
    }

    /** Add node to front (MRU position). */
    pushFront(node: LruNode<K, V>): void {
        node.prev = null;
        node.next = this.head;
        if (this.head) this.head.prev = node;
        this.head = node;
        if (!this.tail) this.tail = node;
        this._size++;
    }

    /** Remove a specific node. */
    remove(node: LruNode<K, V>): void {
        if (node.prev) node.prev.next = node.next;
        else this.head = node.next;
        if (node.next) node.next.prev = node.prev;
        else this.tail = node.prev;
        node.prev = null;
        node.next = null;
        this._size--;
    }

    /** Remove and return the tail node (LRU position). Returns null if empty. */
    popBack(): LruNode<K, V> | null {
        if (!this.tail) return null;
        const node = this.tail;
        this.remove(node);
        return node;
    }

    /** Iterate keys from MRU to LRU. */
    *keys(): Generator<K> {
        let node = this.head;
        while (node) {
            yield node.key;
            node = node.next;
        }
    }
}

export class ArcCache<K = string, V = string> {
    private readonly c: number; // capacity
    private p: number = 0;     // adaptive target for |T1|

    // Cache directories (contain actual values)
    private readonly t1 = new DoublyLinkedList<K, V>();
    private readonly t2 = new DoublyLinkedList<K, V>();

    // Ghost directories (keys only, no values)
    private readonly b1 = new DoublyLinkedList<K, V>();
    private readonly b2 = new DoublyLinkedList<K, V>();

    // Key → node lookups for O(1) membership testing
    private readonly t1Map = new Map<K, LruNode<K, V>>();
    private readonly t2Map = new Map<K, LruNode<K, V>>();
    private readonly b1Map = new Map<K, LruNode<K, V>>();
    private readonly b2Map = new Map<K, LruNode<K, V>>();

    // Stats
    private _hits = 0;
    private _misses = 0;
    private _evictions = 0;

    constructor(capacity: number) {
        if (capacity < 1) throw new Error('ARC cache capacity must be >= 1');
        this.c = capacity;
    }

    /**
     * Look up a key.
     * @returns The cached value, or undefined on miss.
     */
    get(key: K): V | undefined {
        // Case I: key in T1 — move to T2 MRU (promote to frequent)
        const t1Node = this.t1Map.get(key);
        if (t1Node) {
            this.t1.remove(t1Node);
            this.t1Map.delete(key);
            this.t2.pushFront(t1Node);
            this.t2Map.set(key, t1Node);
            this._hits++;
            return t1Node.value;
        }

        // Case II: key in T2 — move to T2 MRU
        const t2Node = this.t2Map.get(key);
        if (t2Node) {
            this.t2.remove(t2Node);
            this.t2.pushFront(t2Node);
            this._hits++;
            return t2Node.value;
        }

        // Miss — key not in cache
        this._misses++;
        return undefined;
    }

    /**
     * Insert or update a key-value pair.
     *
     * If key is already cached, updates the value and promotes it.
     * If key is a ghost hit (B1/B2), adapts p and inserts into T2.
     * Otherwise inserts into T1.
     */
    put(key: K, value: V): void {
        // Already in T1 — promote to T2
        const t1Node = this.t1Map.get(key);
        if (t1Node) {
            t1Node.value = value;
            this.t1.remove(t1Node);
            this.t1Map.delete(key);
            this.t2.pushFront(t1Node);
            this.t2Map.set(key, t1Node);
            return;
        }

        // Already in T2 — move to MRU
        const t2Node = this.t2Map.get(key);
        if (t2Node) {
            t2Node.value = value;
            this.t2.remove(t2Node);
            this.t2.pushFront(t2Node);
            return;
        }

        // Ghost hit in B1 — increase p (favour recency), insert into T2
        const b1Node = this.b1Map.get(key);
        if (b1Node) {
            const delta = Math.max(1, Math.floor(this.b2.size / Math.max(1, this.b1.size)));
            this.p = Math.min(this.p + delta, this.c);

            // Remove ghost
            this.b1.remove(b1Node);
            this.b1Map.delete(key);

            // Make room
            this.replace(false);

            // Insert into T2
            b1Node.value = value;
            this.t2.pushFront(b1Node);
            this.t2Map.set(key, b1Node);
            return;
        }

        // Ghost hit in B2 — decrease p (favour frequency), insert into T2
        const b2Node = this.b2Map.get(key);
        if (b2Node) {
            const delta = Math.max(1, Math.floor(this.b1.size / Math.max(1, this.b2.size)));
            this.p = Math.max(this.p - delta, 0);

            // Remove ghost
            this.b2.remove(b2Node);
            this.b2Map.delete(key);

            // Make room
            this.replace(true);

            // Insert into T2
            b2Node.value = value;
            this.t2.pushFront(b2Node);
            this.t2Map.set(key, b2Node);
            return;
        }

        // Complete miss — not in T1, T2, B1, or B2
        const cacheSize = this.t1.size + this.t2.size;

        if (this.t1.size + this.b1.size >= this.c) {
            // B1 is full — evict LRU from B1
            if (this.b1.size > 0) {
                const evicted = this.b1.popBack()!;
                this.b1Map.delete(evicted.key);
            }
            this.replace(false);
        } else if (cacheSize >= this.c) {
            // Total directories exceed 2c — evict from B2
            if (this.t1.size + this.b1.size + this.t2.size + this.b2.size >= 2 * this.c) {
                if (this.b2.size > 0) {
                    const evicted = this.b2.popBack()!;
                    this.b2Map.delete(evicted.key);
                }
            }
            this.replace(false);
        }

        // Insert into T1 (recent, seen once)
        const node = new LruNode<K, V>(key, value);
        this.t1.pushFront(node);
        this.t1Map.set(key, node);
    }

    /**
     * Delete a key from the cache (and ghosts).
     * Used for cache invalidation on mutations.
     */
    delete(key: K): boolean {
        const t1Node = this.t1Map.get(key);
        if (t1Node) {
            this.t1.remove(t1Node);
            this.t1Map.delete(key);
            return true;
        }

        const t2Node = this.t2Map.get(key);
        if (t2Node) {
            this.t2.remove(t2Node);
            this.t2Map.delete(key);
            return true;
        }

        // Also clean ghosts to prevent stale ghost hits
        const b1Node = this.b1Map.get(key);
        if (b1Node) {
            this.b1.remove(b1Node);
            this.b1Map.delete(key);
            return false; // was ghost, not cached
        }

        const b2Node = this.b2Map.get(key);
        if (b2Node) {
            this.b2.remove(b2Node);
            this.b2Map.delete(key);
            return false;
        }

        return false;
    }

    /** Check if a key is in the cache (T1 or T2). Does not count as an access. */
    has(key: K): boolean {
        return this.t1Map.has(key) || this.t2Map.has(key);
    }

    /** Current cache size (|T1| + |T2|). */
    get size(): number {
        return this.t1.size + this.t2.size;
    }

    /** Cache statistics snapshot. */
    stats(): ArcCacheStats {
        return {
            size: this.size,
            capacity: this.c,
            hits: this._hits,
            misses: this._misses,
            evictions: this._evictions,
            p: this.p,
            t1Size: this.t1.size,
            t2Size: this.t2.size,
            b1Size: this.b1.size,
            b2Size: this.b2.size,
        };
    }

    /** Hit ratio (hits / (hits + misses)). Returns 0 if no accesses. */
    get hitRatio(): number {
        const total = this._hits + this._misses;
        return total > 0 ? this._hits / total : 0;
    }

    /**
     * ARC REPLACE subroutine.
     * Evicts one entry from T1 or T2 to make room for a new entry.
     * @param inB2 — true if the triggering key was found in B2 (biases toward evicting from T1).
     */
    private replace(inB2: boolean): void {
        const cacheSize = this.t1.size + this.t2.size;
        if (cacheSize < this.c) return; // no eviction needed

        if (this.t1.size > 0 &&
            (this.t1.size > this.p || (inB2 && this.t1.size === Math.floor(this.p)))) {
            // Evict LRU from T1, move to B1 ghost
            const evicted = this.t1.popBack()!;
            this.t1Map.delete(evicted.key);
            evicted.value = undefined; // release value memory
            this.b1.pushFront(evicted);
            this.b1Map.set(evicted.key, evicted);
        } else if (this.t2.size > 0) {
            // Evict LRU from T2, move to B2 ghost
            const evicted = this.t2.popBack()!;
            this.t2Map.delete(evicted.key);
            evicted.value = undefined;
            this.b2.pushFront(evicted);
            this.b2Map.set(evicted.key, evicted);
        } else if (this.t1.size > 0) {
            // Fallback: T2 is empty, evict from T1
            const evicted = this.t1.popBack()!;
            this.t1Map.delete(evicted.key);
            evicted.value = undefined;
            this.b1.pushFront(evicted);
            this.b1Map.set(evicted.key, evicted);
        }
        this._evictions++;
    }
}
