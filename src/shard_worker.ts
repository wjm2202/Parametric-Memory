import { ClassicLevel as Level } from 'classic-level';
import { DataAtom, Hash, MerkleProof } from './types';
import { MerkleKernel } from './merkle';
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
    /**
     * Transition weights keyed by (fromIndex → toHash → weight).
     * Using the numeric index for the from-key reduces per-atom overhead from
     * ~128 B (64-char hex string object) to ~8 B (V8 SMI), a ~16× saving on
     * the outer map.  The to-key remains a Hash because it may point to an
     * atom on a different shard whose local index is unknown.
     */
    private transitions: Map<number, Map<Hash, number>> = new Map();
    private db: Level<string, string>;

    constructor(dataBlocks: DataAtom[], dbPath: string) {
        this.data = dataBlocks;
        this.dataIndex = new Map(dataBlocks.map((d, i) => [d, i]));
        this.kernel = new MerkleKernel(dataBlocks);
        // Lower per-shard LevelDB block cache from the default 8 MB to 2 MB.
        // 8 shards at default = 64 MB baseline; at 2 MB = 16 MB.
        this.db = new Level<string, string>(dbPath, { blockSize: 4096, cacheSize: 2 * 1024 * 1024 });

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
                    const [, fromHash, toHash] = parts;
                    const fromIdx = this.hashToIndex.get(fromHash);
                    if (fromIdx === undefined) continue;
                    if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
                    const targets = this.transitions.get(fromIdx)!;
                    targets.set(toHash, (targets.get(toHash) || 0) + parseInt(value));
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
        const fromIdx = this.hashToIndex.get(from);
        if (fromIdx === undefined) return;

        // Update in-memory structure
        if (!this.transitions.has(fromIdx)) this.transitions.set(fromIdx, new Map());
        const targets = this.transitions.get(fromIdx)!;
        const newWeight = (targets.get(to) || 0) + 1;
        targets.set(to, newWeight);

        // Persist the live accumulated count — no preceding db.get() needed
        // because the in-memory map always holds the correct cumulative value.
        await this.db.put(`w:${from}:${to}`, newWeight.toString()).catch((err: unknown) => {
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

        // Markov Prediction — O(out-degree) linear scan, no allocation for the common top-1 case
        const targets = this.transitions.get(idx);
        let predictedHash: Hash | null = null;
        if (targets && targets.size > 0) {
            let bestHash: Hash | null = null;
            let bestWeight = -Infinity;
            for (const [h, w] of targets) {
                if (w > bestWeight) { bestWeight = w; bestHash = h; }
            }
            predictedHash = bestHash;
        }
        let next: DataAtom | null = null;
        let nextProof: MerkleProof | null = null;

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

    /** Cluster-level stats — reads only Map sizes, no DB I/O, O(trainedAtoms). */
    getStats(): { trainedAtoms: number; totalEdges: number } {
        let totalEdges = 0;
        for (const t of this.transitions.values()) totalEdges += t.size;
        return { trainedAtoms: this.transitions.size, totalEdges };
    }

    /**
     * Return the outgoing weight map for a given atom.
     * Reads only from the in-memory matrix — zero DB I/O, cannot block writes.
     * Returns null if the atom is unknown to this shard.
     * Cross-shard neighbours are returned with `to: null` and their `toHash`
     * so the orchestrator can resolve them.
     */
    getWeights(item: DataAtom): { to: DataAtom | null; toHash: Hash; weight: number }[] | null {
        const idx = this.dataIndex.get(item);
        if (idx === undefined) return null;
        const transitions = this.transitions.get(idx);
        if (!transitions || transitions.size === 0) return [];

        const result: { to: DataAtom | null; toHash: Hash; weight: number }[] = [];
        for (const [toHash, weight] of transitions) {
            const toIdx = this.hashToIndex.get(toHash);
            result.push({
                to: toIdx !== undefined ? this.data[toIdx] : null,
                toHash,
                weight,
            });
        }
        // Sort descending by weight so the dominant prediction is first
        result.sort((a, b) => b.weight - a.weight);
        return result;
    }

    async close(): Promise<void> {
        await this.db.close();
    }
}