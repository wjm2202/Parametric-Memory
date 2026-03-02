import { createHash } from 'crypto';
import { MerkleProof, PredictionReport } from './types';
import { MasterKernel } from './master';

// Helper: hash a hex-string the same way MerkleKernel hashes its leaf data
function hashString(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

export class MMPMValidator {
    private readonly masterRoot: string;
    /**
     * When a MasterKernel is supplied, validateReport() performs versioned
     * validation: it looks up the authoritative master root for the version
     * embedded in the PredictionReport rather than using a fixed root.
     * This allows old proofs (issued before atom add/tombstone operations) to
     * validate correctly against the tree state that existed when they were minted.
     *
     * When null, the validator falls back to the static masterRoot string —
     * exactly the original behaviour, so all existing callers continue to work.
     */
    private readonly master: MasterKernel | null;

    /**
     * Build a validator anchored to a static master root string.
     * Use this form for tests or when you have an out-of-band root reference.
     */
    constructor(masterRoot: string);
    /**
     * Build a versioned validator backed by a live MasterKernel.
     * validateReport() will look up the root for report.treeVersion, enabling
     * correct validation of proofs issued against any version in the history window.
     */
    constructor(master: MasterKernel);
    constructor(arg: string | MasterKernel) {
        if (typeof arg === 'string') {
            this.masterRoot = arg;
            this.master = null;
        } else {
            this.master = arg;
            this.masterRoot = arg.masterRoot;
        }
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
     * Performs the full recursive audit of a PredictionReport.
     *
     * When this validator was constructed with a MasterKernel and the report
     * carries a treeVersion, the authoritative master root is resolved from the
     * kernel's history rather than the current root.  This means a proof minted
     * at version N still validates correctly even after atoms have been added or
     * tombstoned (creating versions N+1, N+2, …).
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

            // Resolve the authoritative master root:
            //   - versioned path: look up the root recorded at report.treeVersion
            //   - static path   : use the root string provided at construction time
            let expectedMasterRoot: string;
            if (this.master !== null) {
                const vRoot = this.master.getRootAtVersion(report.treeVersion);
                if (vRoot === undefined) {
                    console.error("❌ Integrity Error: treeVersion is outside the known history window.");
                    return false;
                }
                expectedMasterRoot = vRoot;
            } else {
                expectedMasterRoot = this.masterRoot;
            }

            if (!isShardValid || report.shardRootProof.root !== expectedMasterRoot) {
                console.error("❌ Integrity Error: Shard is not part of the Master Forest.");
                return false;
            }
        }

        return true;
    }
}