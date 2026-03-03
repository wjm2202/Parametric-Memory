import { createHash } from 'crypto';

export class ShardRouter {
    private ring: Map<number, number> = new Map();
    private sortedKeys: number[] = [];
    private vNodes: number = 64; // Balance factor

    constructor(numShards: number) {
        for (let i = 0; i < numShards; i++) {
            this.addShardToRing(i);
        }
        // Build path optimization: sort once after all virtual nodes are inserted.
        this.sortedKeys.sort((a, b) => a - b);
    }

    private addShardToRing(shardIdx: number) {
        for (let i = 0; i < this.vNodes; i++) {
            // Generate 64 virtual points for each physical shard
            const hash = this.hashToNumber(`shard:${shardIdx}:vnode:${i}`);
            this.ring.set(hash, shardIdx);
            this.sortedKeys.push(hash);
        }
    }

    public getShardIndex(item: string): number {
        if (this.sortedKeys.length === 0) return 0;
        const hash = this.hashToNumber(item);

        // Find the first node on the ring that is >= our item hash
        let low = 0, high = this.sortedKeys.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.sortedKeys[mid] < hash) low = mid + 1;
            else high = mid - 1;
        }

        const key = this.sortedKeys[low % this.sortedKeys.length];
        return this.ring.get(key)!;
    }

    private hashToNumber(str: string): number {
        return createHash('md5').update(str).digest().readUInt32BE(0);
    }
}