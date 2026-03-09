import { createHash } from 'crypto';

/**
 * Jump Consistent Hash — maps items to shards with zero memory overhead,
 * near-perfect distribution, and O(ln n) time.
 *
 * Reference: Lamping & Veach, "A Fast, Minimal Memory, Consistent Hash
 * Algorithm" (Google, 2014). arXiv:1406.2294
 *
 * Properties:
 *   - Deterministic: same input always maps to the same shard.
 *   - Uniform: items are evenly distributed across shards.
 *   - Monotone: when increasing shard count from N to N+1, only ~1/(N+1)
 *     of items move to the new shard.
 *   - Stateless: no ring, no virtual nodes, no sorted arrays.
 *
 * Limitation: shards must be numbered 0..N-1 (no arbitrary removal).
 * MMPM satisfies this — SHARD_COUNT is set at deploy time.
 */
export class ShardRouter {
    private readonly numShards: number;

    constructor(numShards: number) {
        if (numShards < 1) throw new RangeError('numShards must be >= 1');
        this.numShards = numShards;
    }

    /**
     * Map an atom (or any string) to a shard index in [0, numShards).
     *
     * Uses a 64-bit seed derived from SHA-256 of the item, then runs the
     * Jump hash algorithm.
     */
    public getShardIndex(item: string): number {
        if (this.numShards === 1) return 0;
        const seed = this.hashToSeed(item);
        return jumpHash(seed, this.numShards);
    }

    /**
     * Derive a 64-bit seed from the item string.
     * Uses first 8 bytes of SHA-256 interpreted as a BigInt.
     */
    private hashToSeed(str: string): bigint {
        const digest = createHash('sha256').update(str).digest();
        // Read first 8 bytes as unsigned 64-bit big-endian
        return digest.readBigUInt64BE(0);
    }
}

/**
 * Jump Consistent Hash algorithm (Lamping & Veach 2014).
 *
 * Given a 64-bit key and a number of buckets, returns a bucket index
 * in [0, numBuckets) with near-perfect uniformity.
 *
 * The algorithm uses a linear congruential generator seeded by the key
 * to produce a sequence of "jump" points.  Each jump either stays at
 * the current bucket or moves to a new one, with probability calibrated
 * so that the final distribution is uniform.
 */
function jumpHash(key: bigint, numBuckets: number): number {
    let b = -1n;
    let j = 0n;
    const n = BigInt(numBuckets);

    while (j < n) {
        b = j;
        // Linear congruential step: key = key * 2862933555777941757 + 1
        key = BigInt.asUintN(64, key * 2862933555777941757n + 1n);
        // j = (b + 1) * (2^31 / ((key >> 33) + 1))
        const shifted = Number(key >> 33n) + 1;
        j = BigInt(Math.floor((Number(b) + 1) * (2147483648.0 / shifted)));
    }

    return Number(b);
}
