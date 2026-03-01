import { createHash } from 'crypto';
import { MerkleProof, PredictionReport } from './types';

// Helper: hash a hex-string the same way MerkleKernel hashes its leaf data
function hashString(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

export class MMPMValidator {
    /**
     * The Master Root is the "Source of Truth." 
     * In production, this would be hardcoded or pulled from a 
     * trusted, immutable location (like a blockchain or a signed config).
     */
    private readonly masterRoot: string;

    constructor(masterRoot: string) {
        this.masterRoot = masterRoot;
    }

    /**
     * Validates a single Merkle Proof
     */
    public verifyProof(itemHash: string, proof: MerkleProof): boolean {
        let computedHash = Buffer.from(itemHash, 'hex');
        let idx = proof.index;

        for (const siblingHash of proof.auditPath) {
            const sibling = Buffer.from(siblingHash, 'hex');

            // idx tracks position at each tree level — must be advanced per-level
            // so left/right assignment is correct all the way up the path
            const combined = (idx % 2 === 0)
                ? Buffer.concat([computedHash, sibling])
                : Buffer.concat([sibling, computedHash]);

            computedHash = createHash('sha256').update(combined).digest();
            idx = Math.floor(idx / 2);
        }

        return computedHash.toString('hex') === proof.root;
    }

    /**
     * Performs the full recursive audit of a PredictionReport
     */
    public validateReport(report: PredictionReport): boolean {
        // 1. Hash the incoming data atom
        const dataHash = createHash('sha256').update(report.currentData).digest('hex');

        // 2. Verify Leaf belongs to Shard
        const isLeafValid = this.verifyProof(dataHash, report.currentProof);
        if (!isLeafValid) {
            console.error("❌ Integrity Error: Data does not match Shard Proof.");
            return false;
        }

        // 3. Verify Shard Root belongs to Master Forest
        // The MasterKernel hashes each shard-root string to build its leaves,
        // so we must hash the shard root before starting proof traversal.
        if (report.shardRootProof) {
            const shardRootHash = hashString(report.currentProof.root);
            const isShardValid = this.verifyProof(shardRootHash, report.shardRootProof);
            if (!isShardValid || report.shardRootProof.root !== this.masterRoot) {
                console.error("❌ Integrity Error: Shard is not part of the Master Forest.");
                return false;
            }
        }

        return true;
    }
}