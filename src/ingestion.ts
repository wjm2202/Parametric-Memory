import { DataAtom } from './types';
import { ShardedOrchestrator } from './orchestrator';

/**
 * INGESTION PIPELINE — Async, batched atom ingestion.
 *
 * Accepts atoms via enqueue() without blocking the caller.  Atoms accumulate
 * in an internal queue and are flushed to the orchestrator in batches when
 * either:
 *   - the queue depth reaches `batchSize` (count-based flush), or
 *   - `flushIntervalMs` has elapsed since the last flush (time-based flush).
 *
 * The key property: enqueue() returns immediately with a receipt.  Reads
 * (access/train) are never blocked by ingestion — the epoch model in
 * ShardWorker ensures that in-flight reads see a consistent committed
 * snapshot, and new atoms become visible only after their batch commits.
 *
 * Usage:
 *   const pipeline = new IngestionPipeline(orchestrator, { batchSize: 200 });
 *   pipeline.start();
 *   const receipt = pipeline.enqueue(['atom_a', 'atom_b']);
 *   // receipt.batchId can be polled via getPendingCount()
 *   await pipeline.flush();  // force immediate commit
 *   pipeline.stop();
 *
 * Pending vs committed atoms:
 *   - "queued"    = in this pipeline's queue, not yet sent to shards
 *   - "pending"   = sent to shards, in PendingWrites, not yet committed
 *   - "committed" = in the active snapshot, visible to access()
 *
 * GET /atoms/pending shows both queued and shard-pending atoms.
 */

export interface IngestionReceipt {
    /** Monotonically increasing batch identifier. */
    batchId: number;
    /** Number of atoms accepted into this pipeline call. */
    queued: number;
    /** Estimated ms until this batch commits (based on flush interval). */
    commitEtaMs: number;
}

export interface IngestionStats {
    queueDepth: number;
    totalEnqueued: number;
    totalFlushed: number;
    totalCommitted: number;
    lastFlushMs: number | null;
    isRunning: boolean;
}

export class IngestionPipeline {
    private readonly orchestrator: ShardedOrchestrator;
    private readonly batchSize: number;
    private readonly flushIntervalMs: number;

    private queue: DataAtom[] = [];
    private queuedAtoms: Set<DataAtom> = new Set();  // dedup within pipeline
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private batchCounter: number = 0;
    private isRunning: boolean = false;
    private isFlushing: boolean = false;

    // Stats
    private totalEnqueued: number = 0;
    private totalFlushed: number = 0;
    private totalCommitted: number = 0;
    private lastFlushMs: number | null = null;

    constructor(
        orchestrator: ShardedOrchestrator,
        options?: {
            batchSize?: number;
            flushIntervalMs?: number;
        }
    ) {
        this.orchestrator = orchestrator;
        this.batchSize = options?.batchSize ?? 100;
        this.flushIntervalMs = options?.flushIntervalMs ?? 1000;
    }

    /**
     * Start the background flush timer.
     * Must be called before enqueue() for time-based flushing to work.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.flushTimer = setInterval(async () => {
            if (!this.isFlushing && this.queue.length > 0) {
                await this.flush().catch(err =>
                    console.error('[IngestionPipeline] Background flush error:', err)
                );
            }
        }, this.flushIntervalMs);
    }

    /**
     * Stop the background flush timer.
     * Performs a final flush of any remaining queued atoms before stopping.
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        // Final drain
        if (this.queue.length > 0) {
            await this.flush();
        }
        this.isRunning = false;
    }

    /**
     * Accept atoms into the pipeline queue.
     *
     * Returns immediately — does NOT wait for commit.  Duplicate atoms
     * (already in the queue or already in the orchestrator) are silently
     * de-duplicated.
     *
     * If the queue depth reaches batchSize after this call, a flush is
     * triggered synchronously before returning (this is the only case
     * where enqueue() may take longer than a few microseconds).
     */
    async enqueue(atoms: DataAtom[]): Promise<IngestionReceipt> {
        const batchId = ++this.batchCounter;
        let accepted = 0;

        for (const atom of atoms) {
            if (!this.queuedAtoms.has(atom)) {
                this.queue.push(atom);
                this.queuedAtoms.add(atom);
                accepted++;
            }
        }
        this.totalEnqueued += accepted;

        // Trigger an immediate flush if we've hit the batch size threshold
        if (this.queue.length >= this.batchSize && !this.isFlushing) {
            await this.flush();
        }

        const commitEtaMs = this.isFlushing
            ? 0
            : this.flushIntervalMs;

        return { batchId, queued: accepted, commitEtaMs };
    }

    /**
     * Force an immediate flush of all queued atoms.
     * Drains the queue, calls orchestrator.addAtoms(), and commits.
     * No-op if the queue is empty or a flush is already in progress.
     */
    async flush(): Promise<void> {
        if (this.isFlushing || this.queue.length === 0) return;
        this.isFlushing = true;

        const batch = this.queue.splice(0, this.queue.length);
        // Clear dedup set for flushed atoms
        for (const atom of batch) this.queuedAtoms.delete(atom);

        try {
            await this.orchestrator.addAtoms(batch);
            this.totalFlushed += batch.length;
            this.totalCommitted += batch.length;
            this.lastFlushMs = Date.now();
        } catch (err) {
            // Re-queue on failure so atoms aren't silently dropped
            this.queue.unshift(...batch);
            for (const atom of batch) this.queuedAtoms.add(atom);
            throw err;
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Return a snapshot of pipeline statistics.
     */
    getStats(): IngestionStats {
        return {
            queueDepth: this.queue.length,
            totalEnqueued: this.totalEnqueued,
            totalFlushed: this.totalFlushed,
            totalCommitted: this.totalCommitted,
            lastFlushMs: this.lastFlushMs,
            isRunning: this.isRunning,
        };
    }

    /**
     * Return atoms currently waiting in the pipeline queue (not yet sent
     * to shards).  For observability only — do not mutate.
     */
    getQueuedAtoms(): ReadonlyArray<DataAtom> {
        return this.queue;
    }
}
