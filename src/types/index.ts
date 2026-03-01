export type Hash = string;
export type DataAtom = string;

export interface MerkleProof {
    leaf: Hash;
    root: Hash;
    auditPath: Hash[];
    index: number;
}

export interface PredictionReport {
    currentData: DataAtom;
    currentProof: MerkleProof;
    shardRootProof?: MerkleProof; // Proof that this shard's root belongs to the Master
    predictedNext: DataAtom | null;
    predictedProof: MerkleProof | null;
    latencyMs: number;
}