import { describe, it, expect } from 'vitest';
import { ShardRouter } from '../router';

describe('ShardRouter (Jump Hash)', () => {
    // -----------------------------------------------------------------------
    // Contract tests — same API guarantees as the old ring hash
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Jump hash specific tests
    // -----------------------------------------------------------------------

    it('throws on numShards < 1', () => {
        expect(() => new ShardRouter(0)).toThrow();
        expect(() => new ShardRouter(-1)).toThrow();
    });

    it('achieves near-perfect distribution across 4 shards with 10K items', () => {
        const numShards = 4;
        const router = new ShardRouter(numShards);
        const counts = new Array(numShards).fill(0);
        const N = 10_000;

        for (let i = 0; i < N; i++) {
            counts[router.getShardIndex(`atom_${i}`)]++;
        }

        const expected = N / numShards; // 2500
        for (let s = 0; s < numShards; s++) {
            const deviation = Math.abs(counts[s] - expected) / expected;
            // Jump hash guarantees < 0.1% deviation; we allow 5% for safety
            expect(deviation).toBeLessThan(0.05);
        }
    });

    it('monotonicity — adding a shard moves only ~1/(N+1) items', () => {
        const N = 4;
        const routerOld = new ShardRouter(N);
        const routerNew = new ShardRouter(N + 1);
        const totalItems = 10_000;
        let moved = 0;

        for (let i = 0; i < totalItems; i++) {
            const item = `monotone_${i}`;
            if (routerOld.getShardIndex(item) !== routerNew.getShardIndex(item)) {
                moved++;
            }
        }

        const movedRatio = moved / totalItems;
        // Theory: exactly 1/(N+1) = 20% should move. Allow up to 25%.
        expect(movedRatio).toBeGreaterThan(0.10);
        expect(movedRatio).toBeLessThan(0.25);
    });

    it('handles real MMPM atom names correctly', () => {
        const router = new ShardRouter(4);
        const atoms = [
            'v1.fact.merkle_tree_sha256_heap_indexed_binary',
            'v1.procedure.store_memory_before_creating_files',
            'v1.state.sprint_step_1_bm25_search_pending',
            'v1.event.security_review_completed_dt_2026_03_09',
            'v1.relation.mmpm_search_upgrade_path_jaccard_to_bm25',
        ];
        for (const atom of atoms) {
            const idx = router.getShardIndex(atom);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(4);
        }
    });

    it('large shard count (64 shards) still distributes well', () => {
        const numShards = 64;
        const router = new ShardRouter(numShards);
        const seen = new Set<number>();
        for (let i = 0; i < 10_000; i++) {
            seen.add(router.getShardIndex(`item_${i}`));
        }
        // Should hit at least 90% of shards with 10K items
        expect(seen.size).toBeGreaterThan(numShards * 0.9);
    });
});
