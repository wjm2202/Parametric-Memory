import { describe, it, expect } from 'vitest';
import { MasterKernel } from '../master';
import { MerkleKernel } from '../merkle';

describe('MasterKernel', () => {
    it('masterRoot is the zero hash when no shards have been registered', () => {
        const master = new MasterKernel();
        expect(master.masterRoot).toBe('0');
    });

    it('getShardProof returns undefined when no kernel has been built', () => {
        const master = new MasterKernel();
        expect(master.getShardProof(0)).toBeUndefined();
    });

    it('masterRoot is a valid 64-char hex string after a shard is registered', () => {
        const master = new MasterKernel();
        const shard0Root = new MerkleKernel(['A', 'B']).root;
        master.updateShardRoot(0, shard0Root);
        expect(master.masterRoot).toMatch(/^[a-f0-9]{64}$/);
    });

    it('masterRoot changes when a shard root changes', () => {
        const master = new MasterKernel();
        const rootA = new MerkleKernel(['A', 'B']).root;
        const rootB = new MerkleKernel(['X', 'Y']).root;
        master.updateShardRoot(0, rootA);
        const masterBefore = master.masterRoot;
        master.updateShardRoot(0, rootB);
        expect(master.masterRoot).not.toBe(masterBefore);
    });

    it('two identical shard roots produce the same master root', () => {
        const root = new MerkleKernel(['A', 'B']).root;
        const masterA = new MasterKernel();
        const masterB = new MasterKernel();
        masterA.updateShardRoot(0, root);
        masterB.updateShardRoot(0, root);
        expect(masterA.masterRoot).toBe(masterB.masterRoot);
    });

    it('getShardProof returns a MerkleProof after a shard is registered', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root);
        const proof = master.getShardProof(0);
        expect(proof).toBeDefined();
        expect(proof!.leaf).toMatch(/^[a-f0-9]{64}$/);
        expect(proof!.root).toBe(master.masterRoot);
    });

    it('shard proof is valid via MerkleKernel.verifyProof', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A', 'B']).root);
        master.updateShardRoot(1, new MerkleKernel(['C', 'D']).root);
        for (let i = 0; i < 2; i++) {
            const proof = master.getShardProof(i);
            expect(proof).toBeDefined();
            expect(MerkleKernel.verifyProof(proof!)).toBe(true);
        }
    });

    it('shard proof root always equals masterRoot', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root);
        master.updateShardRoot(1, new MerkleKernel(['B']).root);
        const proof0 = master.getShardProof(0);
        const proof1 = master.getShardProof(1);
        expect(proof0!.root).toBe(master.masterRoot);
        expect(proof1!.root).toBe(master.masterRoot);
    });

    it('adding a second shard changes the master root', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root);
        const rootWith1 = master.masterRoot;
        master.updateShardRoot(1, new MerkleKernel(['B']).root);
        expect(master.masterRoot).not.toBe(rootWith1);
    });

    // ─── batchUpdateShardRoots ─────────────────────────────────────────────────

    it('batchUpdateShardRoots increments version exactly once regardless of shard count', () => {
        const master = new MasterKernel();
        const updates = new Map([
            [0, new MerkleKernel(['A', 'B']).root],
            [1, new MerkleKernel(['C', 'D']).root],
            [2, new MerkleKernel(['E', 'F']).root],
            [3, new MerkleKernel(['G', 'H']).root],
        ]);
        expect(master.currentVersion).toBe(0);
        master.batchUpdateShardRoots(updates);
        // 4 shards updated — should still be exactly 1 version bump
        expect(master.currentVersion).toBe(1);
    });

    it('batchUpdateShardRoots produces identical master root to sequential updateShardRoot', () => {
        const roots = [
            new MerkleKernel(['A', 'B']).root,
            new MerkleKernel(['C', 'D']).root,
            new MerkleKernel(['E', 'F']).root,
        ];

        // Sequential (old way)
        const sequential = new MasterKernel();
        roots.forEach((r, i) => sequential.updateShardRoot(i, r));

        // Batch (new way)
        const batched = new MasterKernel();
        batched.batchUpdateShardRoots(new Map(roots.map((r, i) => [i, r])));

        expect(batched.masterRoot).toBe(sequential.masterRoot);
    });

    it('batchUpdateShardRoots records the version in rootHistory', () => {
        const master = new MasterKernel();
        master.batchUpdateShardRoots(new Map([
            [0, new MerkleKernel(['A']).root],
            [1, new MerkleKernel(['B']).root],
        ]));
        expect(master.getRootAtVersion(1)).toBe(master.masterRoot);
        expect(master.getRootAtVersion(0)).toBeUndefined();
    });

    it('batchUpdateShardRoots shard proofs are valid after update', () => {
        const master = new MasterKernel();
        master.batchUpdateShardRoots(new Map([
            [0, new MerkleKernel(['A', 'B']).root],
            [1, new MerkleKernel(['C', 'D']).root],
        ]));
        for (let i = 0; i < 2; i++) {
            const proof = master.getShardProof(i);
            expect(proof).toBeDefined();
            expect(MerkleKernel.verifyProof(proof!)).toBe(true);
            expect(proof!.root).toBe(master.masterRoot);
        }
    });

    // ─── Snapshot version tracking (Story 1.5) ────────────────────────────────

    it('getShardSnapshotVersion returns undefined before any update', () => {
        const master = new MasterKernel();
        expect(master.getShardSnapshotVersion(0)).toBeUndefined();
    });

    it('getShardSnapshotVersion records the version passed to updateShardRoot', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root, 5);
        expect(master.getShardSnapshotVersion(0)).toBe(5);
    });

    it('updateShardRoot without snapshotVersion still applies (backward compat)', () => {
        const master = new MasterKernel();
        const root = new MerkleKernel(['A']).root;
        const applied = master.updateShardRoot(0, root);
        expect(applied).toBe(true);
        expect(master.masterRoot).toMatch(/^[a-f0-9]{64}$/);
        expect(master.getShardSnapshotVersion(0)).toBeUndefined();
    });

    it('updateShardRoot returns false and does not change root for a stale version', () => {
        const master = new MasterKernel();
        const root1 = new MerkleKernel(['A']).root;
        const root2 = new MerkleKernel(['B']).root;
        master.updateShardRoot(0, root1, 3);
        const masterAfterFirst = master.masterRoot;
        const versionAfterFirst = master.currentVersion;

        // stale: snapshotVersion 2 ≤ recorded 3
        const applied = master.updateShardRoot(0, root2, 2);
        expect(applied).toBe(false);
        expect(master.masterRoot).toBe(masterAfterFirst);
        expect(master.currentVersion).toBe(versionAfterFirst);
        expect(master.getShardSnapshotVersion(0)).toBe(3); // unchanged
    });

    it('updateShardRoot returns false for equal snapshot version (not strictly newer)', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root, 5);
        const vBefore = master.currentVersion;
        const applied = master.updateShardRoot(0, new MerkleKernel(['B']).root, 5);
        expect(applied).toBe(false);
        expect(master.currentVersion).toBe(vBefore);
    });

    it('updateShardRoot applies a strictly newer version', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root, 3);
        const applied = master.updateShardRoot(0, new MerkleKernel(['B']).root, 4);
        expect(applied).toBe(true);
        expect(master.getShardSnapshotVersion(0)).toBe(4);
    });

    it('batchUpdateShardRoots skips stale shards and only bumps version once', () => {
        const master = new MasterKernel();
        // Register shard 0 at snapshot version 5
        master.updateShardRoot(0, new MerkleKernel(['A']).root, 5);
        const vBefore = master.currentVersion;

        // Batch: shard 0 is stale (sv=3), shard 1 is new
        master.batchUpdateShardRoots(
            new Map([
                [0, new MerkleKernel(['STALE']).root],
                [1, new MerkleKernel(['C']).root],
            ]),
            new Map([[0, 3], [1, 1]])
        );

        // Shard 1 update should apply → one version bump
        expect(master.currentVersion).toBe(vBefore + 1);
        // Shard 0 snapshot version must still be 5
        expect(master.getShardSnapshotVersion(0)).toBe(5);
        // Shard 1 snapshot version recorded
        expect(master.getShardSnapshotVersion(1)).toBe(1);
    });

    it('batchUpdateShardRoots is a no-op when all updates are stale', () => {
        const master = new MasterKernel();
        master.updateShardRoot(0, new MerkleKernel(['A']).root, 10);
        const vBefore = master.currentVersion;
        const rootBefore = master.masterRoot;

        master.batchUpdateShardRoots(
            new Map([[0, new MerkleKernel(['STALE']).root]]),
            new Map([[0, 5]]) // stale
        );

        expect(master.currentVersion).toBe(vBefore);
        expect(master.masterRoot).toBe(rootBefore);
    });
});
