/**
 * EPOCH MANAGER — Read/Write concurrency primitive.
 *
 * Manages the lifecycle of read "tickets" and commit transitions.
 *
 * Model:
 *   - Every access() acquires a read ticket bound to the current epoch.
 *   - Writers accumulate into PendingWrites freely (single writer, no lock).
 *   - Commit is the only synchronization point:
 *       1. beginCommit() bumps the epoch so new readers go to the new epoch.
 *       2. It then waits until all readers on the OLD epoch have drained.
 *       3. The caller swaps the snapshot pointer (atomic reference swap).
 *       4. endCommit() finalizes the transition.
 *
 * This gives us: many concurrent readers, one writer, zero locks on the
 * hot read path.  The only wait is during commit (which is brief — readers
 * are fast, and we only wait for in-flight ones to finish, not new ones).
 */

export interface ReadTicket {
    epoch: number;
}

export class EpochManager {
    private _currentEpoch: number = 0;
    /** Number of active readers per epoch. */
    private activeReaders: Map<number, number> = new Map();
    /** Resolve functions waiting for a specific epoch to drain. */
    private drainWaiters: Map<number, (() => void)[]> = new Map();
    /** Whether a commit is currently in progress. */
    private _committing: boolean = false;

    get currentEpoch(): number {
        return this._currentEpoch;
    }

    get isCommitting(): boolean {
        return this._committing;
    }

    /**
     * Acquire a read ticket for the current epoch.
     * This is the hot path — must be zero-allocation and non-blocking.
     */
    beginRead(): ReadTicket {
        const epoch = this._currentEpoch;
        this.activeReaders.set(epoch, (this.activeReaders.get(epoch) || 0) + 1);
        return { epoch };
    }

    /**
     * Release a read ticket.  If this was the last reader on a draining
     * epoch, resolve any waiting commit.
     */
    endRead(ticket: ReadTicket): void {
        const count = this.activeReaders.get(ticket.epoch) || 0;
        if (count <= 1) {
            this.activeReaders.delete(ticket.epoch);
            // Wake up any commit waiting for this epoch to drain
            const waiters = this.drainWaiters.get(ticket.epoch);
            if (waiters) {
                this.drainWaiters.delete(ticket.epoch);
                for (const resolve of waiters) resolve();
            }
        } else {
            this.activeReaders.set(ticket.epoch, count - 1);
        }
    }

    /**
     * Get the number of active readers on a specific epoch.
     * Useful for metrics and health checks.
     */
    getActiveReaders(epoch?: number): number {
        return this.activeReaders.get(epoch ?? this._currentEpoch) || 0;
    }

    /**
     * Begin a commit.  This:
     *   1. Marks commit as in-progress (prevents concurrent commits).
     *   2. Bumps the epoch so new readers join the new epoch.
     *   3. Waits for all readers on the old epoch to drain.
     *
     * After this resolves, it is safe to swap the snapshot pointer.
     *
     * @returns The old epoch number (for bookkeeping).
     * @throws  If a commit is already in progress.
     */
    async beginCommit(): Promise<number> {
        if (this._committing) {
            throw new Error('A commit is already in progress. Commits are serialized.');
        }
        this._committing = true;
        const oldEpoch = this._currentEpoch;
        this._currentEpoch++;

        // Wait for old-epoch readers to drain
        const oldReaders = this.activeReaders.get(oldEpoch) || 0;
        if (oldReaders > 0) {
            await new Promise<void>(resolve => {
                if (!this.drainWaiters.has(oldEpoch)) {
                    this.drainWaiters.set(oldEpoch, []);
                }
                this.drainWaiters.get(oldEpoch)!.push(resolve);
            });
        }

        return oldEpoch;
    }

    /**
     * Finalize the commit.  Clears the committing flag so the next
     * commit can proceed.
     */
    endCommit(): void {
        this._committing = false;
    }

    /**
     * Get a summary for health checks and metrics.
     */
    getStatus(): {
        currentEpoch: number;
        isCommitting: boolean;
        activeReadersByEpoch: Record<number, number>;
    } {
        const activeReadersByEpoch: Record<number, number> = {};
        for (const [epoch, count] of this.activeReaders) {
            activeReadersByEpoch[epoch] = count;
        }
        return {
            currentEpoch: this._currentEpoch,
            isCommitting: this._committing,
            activeReadersByEpoch,
        };
    }
}
