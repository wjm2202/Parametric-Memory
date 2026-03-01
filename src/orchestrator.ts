import { ShardWorker } from './shard_worker';
import { MasterKernel } from './master';
import { ShardRouter } from './router';
import { SparseTransitionMatrix } from './matrix';
import { DataAtom, PredictionReport } from './types';
import { performance } from 'perf_hooks';

export class ShardedOrchestrator {
    private shards: Map<number, ShardWorker> = new Map();
    private master: MasterKernel = new MasterKernel();
    private router: ShardRouter;
    private globalMatrix: SparseTransitionMatrix = new SparseTransitionMatrix();
    private lastShard: number | null = null;

    constructor(numShards: number, data: DataAtom[], dbBasePath: string = './mmpm-db') {
        this.router = new ShardRouter(numShards);
        const buckets: Map<number, DataAtom[]> = new Map();

        // 1. Group data using Consistent Hashing
        data.forEach(item => {
            const idx = this.router.getShardIndex(item);
            if (!buckets.has(idx)) buckets.set(idx, []);
            buckets.get(idx)!.push(item);
        });

        // 2. Initialize Shards
        for (let i = 0; i < numShards; i++) {
            const shardData = buckets.get(i) || [];
            const worker = new ShardWorker(shardData, `${dbBasePath}/shard_${i}`);
            this.shards.set(i, worker);
        }
    }

    async init() {
        for (const [id, shard] of this.shards.entries()) {
            await shard.init();
            this.master.updateShardRoot(id, shard.getKernelRoot());
        }
    }

    async access(item: DataAtom): Promise<PredictionReport> {
        const start = performance.now();
        const sIdx = this.router.getShardIndex(item);
        const shard = this.shards.get(sIdx);

        if (!shard) throw new Error(`Shard ${sIdx} not initialized for item ${item}`);

        const result = await shard.access(item);

        // Record Inter-shard transitions for the Global Markov Chain
        if (this.lastShard !== null && this.lastShard !== sIdx) {
            this.globalMatrix.recordTransition(`s:${this.lastShard}`, `s:${sIdx}`);
        }

        this.lastShard = sIdx;

        // Resolve cross-shard predictions: if the local shard couldn't resolve
        // the predicted hash to an atom, search the shard that owns it.
        let predictedNext = result.next;
        let predictedProof = result.nextProof;

        if (predictedNext === null && result.predictedHash !== null) {
            for (const otherShard of this.shards.values()) {
                const resolved = otherShard.resolveByHash(result.predictedHash);
                if (resolved !== null) {
                    predictedNext = resolved.atom;
                    predictedProof = resolved.proof;
                    break;
                }
            }
        }

        return {
            currentData: item,
            currentProof: result.proof,
            shardRootProof: this.master.getShardProof(sIdx),
            predictedNext,
            predictedProof,
            latencyMs: performance.now() - start
        };
    }

    /**
     * Train/Reinforce a sequence across the sharded cluster.
     * The orchestrator identifies which shard owns each node and
     * tells the shard to record the transition.
     */
    async train(sequence: string[]): Promise<void> {
        for (let i = 0; i < sequence.length - 1; i++) {
            const from = sequence[i];
            const to = sequence[i + 1];

            const fromShardIdx = this.router.getShardIndex(from);
            const shard = this.shards.get(fromShardIdx);

            if (shard) {
                // Resolve toHash from whichever shard owns `to` — not necessarily
                // the same shard as `from`, so cross-shard edges are captured correctly.
                const toShardIdx = this.router.getShardIndex(to);
                const toShard = this.shards.get(toShardIdx);

                const fromHash = shard.getHash(from);
                const toHash = toShard?.getHash(to);

                if (fromHash && toHash) {
                    await shard.recordTransition(fromHash, toHash);
                }
            }
        }
    }

    /** Close all shard LevelDB instances gracefully. */
    async close(): Promise<void> {
        for (const shard of this.shards.values()) {
            await shard.close();
        }
    }
}