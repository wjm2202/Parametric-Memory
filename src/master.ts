import { MerkleKernel } from './merkle';
import { Hash, MerkleProof } from './types';

export class MasterKernel {
    private shardRoots: Hash[] = [];
    private kernel: MerkleKernel | null = null;

    updateShardRoot(shardIdx: number, newRoot: Hash) {
        this.shardRoots[shardIdx] = newRoot;
        // Re-build the master tree whenever a child shard changes its root
        this.kernel = new MerkleKernel(this.shardRoots);
    }

    get masterRoot(): Hash {
        return this.kernel ? this.kernel.root : "0";
    }

    getShardProof(shardIdx: number): MerkleProof | undefined {
        return this.kernel?.getProof(shardIdx);
    }
}