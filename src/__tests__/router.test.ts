import { describe, it, expect } from 'vitest';
import { ShardRouter } from '../router';

describe('ShardRouter', () => {
    it('always returns 0 for a single-shard ring', () => {
        const router = new ShardRouter(1);
        expect(router.getShardIndex('anything')).toBe(0);
        expect(router.getShardIndex('hello world')).toBe(0);
    });

    it('returns a value within [0, numShards)', () => {
        const numShards = 8;
        const router = new ShardRouter(numShards);
        const items = Array.from({ length: 100 }, (_, i) => `item_${i}`);
        for (const item of items) {
            const idx = router.getShardIndex(item);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(numShards);
        }
    });

    it('is deterministic — same input always maps to the same shard', () => {
        const router = new ShardRouter(4);
        const item = 'deterministic-test';
        const first = router.getShardIndex(item);
        for (let i = 0; i < 10; i++) {
            expect(router.getShardIndex(item)).toBe(first);
        }
    });

    it('produces the same mapping when a new router is constructed with the same config', () => {
        const routerA = new ShardRouter(4);
        const routerB = new ShardRouter(4);
        const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
        for (const item of items) {
            expect(routerA.getShardIndex(item)).toBe(routerB.getShardIndex(item));
        }
    });

    it('distributes a large item set across more than one shard', () => {
        const router = new ShardRouter(4);
        const shardSet = new Set<number>();
        for (let i = 0; i < 100; i++) {
            shardSet.add(router.getShardIndex(`item_${i}_${Math.random()}`));
        }
        // With 100 items across 4 shards there should be at least 2 distinct shards
        expect(shardSet.size).toBeGreaterThan(1);
    });

    it('different items can map to different shards', () => {
        const router = new ShardRouter(4);
        const indices = new Set(['Node_A', 'Node_B', 'Node_C', 'Node_D', 'Step_1', 'Step_2',
            'alpha', 'beta', 'gamma', 'delta'].map(i => router.getShardIndex(i)));
        expect(indices.size).toBeGreaterThan(1);
    });

    it('handles two-shard ring — all indices are 0 or 1', () => {
        const router = new ShardRouter(2);
        for (let i = 0; i < 50; i++) {
            const idx = router.getShardIndex(`key_${i}`);
            expect([0, 1]).toContain(idx);
        }
    });
});
