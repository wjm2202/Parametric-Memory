export type Hash = string;
export type DataAtom = string;

/**
 * Sentinel leaf value written into the Merkle tree when an atom is tombstoned.
 * 64 hex zeros (32 zero bytes) — can never collide with a real SHA-256 hash.
 */
export const TOMBSTONE_HASH: Hash = '00'.repeat(32);

export interface MerkleProof {
    leaf: Hash;
    root: Hash;
    auditPath: Hash[];
    index: number;
}

/**
 * Consistency proof between two master-tree versions.
 *
 * Proves that the tree at `toVersion` is a legitimate evolution of the tree
 * at `fromVersion`.  A verifier recomputes both master roots from their
 * respective shard-root snapshots and checks they match the stated hashes.
 *
 * Analogous to Certificate Transparency consistency proofs (RFC 6962 §2.1.2)
 * but adapted for a mutable Merkle tree over shard roots rather than an
 * append-only log.
 */
export interface ConsistencyProof {
    fromVersion: number;
    toVersion: number;
    fromRoot: Hash;
    toRoot: Hash;
    fromTimestamp: number;
    toTimestamp: number;
    /** Shard roots at fromVersion — recompute master root to verify. */
    fromShardRoots: Hash[];
    /** Shard roots at toVersion — recompute master root to verify. */
    toShardRoots: Hash[];
    /** Intermediate version→root pairs for chain-of-custody audit. */
    intermediateRoots: Array<{ version: number; root: Hash }>;
}

export interface PredictionReport {
    currentData: DataAtom;
    currentProof: MerkleProof;
    shardRootProof?: MerkleProof; // Proof that this shard's root belongs to the Master
    predictedNext: DataAtom | null;
    predictedProof: MerkleProof | null;
    latencyMs: number;
    /**
     * Master-kernel version at time this report was generated.
     * Pass this to MMPMValidator (when constructed with a MasterKernel) so it
     * looks up the authoritative master root for that exact tree state rather
     * than relying on the current (possibly newer) root.
     */
    treeVersion: number;
}