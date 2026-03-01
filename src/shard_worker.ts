import { ClassicLevel as Level } from 'classic-level';
import { DataAtom, Hash, MerkleProof } from './types';
import { MerkleKernel } from './merkle';
import { SparseTransitionMatrix } from './matrix';
import { performance } from 'perf_hooks';

/**
 * SHARD WORKER
 * A self-contained memory unit managing a subset of the global data.
 * It maintains local integrity (Merkle) and local logic (Markov).
 */
export class ShardWorker {
    private data: DataAtom[];
    private dataIndex: Map<DataAtom, number>;
    private hashToIndex: Map<Hash, number> = new Map();
    private kernel: MerkleKernel;
    private matrix: SparseTransitionMatrix;
    private db: Level<string, string>;

    constructor(dataBlocks: DataAtom[], dbPath: string) {
        this.data = dataBlocks;
        this.dataIndex = new Map(dataBlocks.map((d, i) => [d, i]));
        this.kernel = new MerkleKernel(dataBlocks);
        this.matrix = new SparseTransitionMatrix();
        this.db = new Level<string, string>(dbPath);

        // Pre-compute Hash -> Index for O(1) prediction lookups
        dataBlocks.forEach((_, i) => {
            this.hashToIndex.set(this.kernel.getLeafHash(i), i);
        });
    }

    /**
     * Load persistent Markov weights from LevelDB.
     */
    async init() {
        try {
            for await (const [key, value] of this.db.iterator({ gt: 'w:' })) {
                if (!key.startsWith('w:')) break;
                const parts = key.split(':');
                if (parts.length === 3) {
                    const [, from, to] = parts;
                    this.matrix.recordTransition(from, to, parseInt(value));
                }
            }
        } catch (err) {
            console.error(`Failed to initialize shard at ${this.db.location}:`, err);
        }
    }

    /**
     * Helper for the Orchestrator to translate Data -> Hash
     */
    getHash(item: DataAtom): Hash | undefined {
        const idx = this.dataIndex.get(item);
        return idx !== undefined ? this.kernel.getLeafHash(idx) : undefined;
    }

    /**
     * Reverse lookup: given a leaf hash, return the DataAtom.
     * Used by the orchestrator to resolve cross-shard predictions.
     */
    getAtomByHash(hash: Hash): DataAtom | undefined {
        const idx = this.hashToIndex.get(hash);
        return idx !== undefined ? this.data[idx] : undefined;
    }

    /**
     * Resolve a leaf hash to its atom and Merkle proof.
     * Returns null if this shard does not own that hash.
     */
    resolveByHash(hash: Hash): { atom: DataAtom; proof: MerkleProof } | null {
        const idx = this.hashToIndex.get(hash);
        if (idx === undefined) return null;
        return { atom: this.data[idx], proof: this.kernel.getProof(idx) };
    }

    /**
     * Returns the local Merkle Root for Master Tree anchoring.
     */
    getKernelRoot(): Hash {
        return this.kernel.root;
    }

    /**
     * Persistent Training: Updates RAM and Disk.
     */
    async recordTransition(from: Hash, to: Hash) {
        // 1. Update In-Memory Matrix
        this.matrix.recordTransition(from, to);

        // 2. Async Persist to LevelDB
        const key = `w:${from}:${to}`;
        const currentVal = await this.db.get(key).catch(() => '0') ?? '0';
        const newVal = (parseInt(currentVal) + 1).toString();

        await this.db.put(key, newVal).catch((err: unknown) => {
            console.error("Shard Persistence Error:", err);
        });
    }

    /**
     * Core Access Logic
     */
    async access(item: DataAtom): Promise<{
        proof: MerkleProof,
        next: DataAtom | null,
        nextProof: MerkleProof | null,
        hash: Hash,
        predictedHash: Hash | null
    }> {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) throw new Error(`Item ${item} not found in this shard.`);

        const hash = this.kernel.getLeafHash(idx);
        const proof = this.kernel.getProof(idx);

        // Markov Prediction
        const predictions = this.matrix.predictNext(hash);
        let next: DataAtom | null = null;
        let nextProof: MerkleProof | null = null;
        let predictedHash: Hash | null = predictions[0] ?? null;

        if (predictedHash !== null) {
            const nIdx = this.hashToIndex.get(predictedHash);
            if (nIdx !== undefined) {
                // Intra-shard prediction — can resolve fully here
                next = this.data[nIdx];
                nextProof = this.kernel.getProof(nIdx);
            }
            // Cross-shard: next remains null; orchestrator will resolve via predictedHash
        }

        return { proof, next, nextProof, hash, predictedHash };
    }

    async close(): Promise<void> {
        await this.db.close();
    }
}