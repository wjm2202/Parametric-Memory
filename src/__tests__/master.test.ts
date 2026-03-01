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
});
