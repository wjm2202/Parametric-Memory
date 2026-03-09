/**
 * TTL REGISTRY (Sprint 14-C-1 + Step 5: Auto-Promotion)
 *
 * Tracks optional per-atom time-to-live metadata.  TTL is:
 *
 *   - Opt-in: atoms without TTL are never expired.
 *   - Access-aware: every access resets the expiry clock.
 *       ttlExpiresAt = lastAccessedAtMs + ttlMs
 *   - Swept by the background reaper in server.ts.
 *
 * AUTO-PROMOTION (memory consolidation):
 *   Atoms that are accessed at least `promotionThreshold` times within
 *   their TTL window are "promoted" — their TTL is removed, making them
 *   permanent.  This models short-term → long-term memory consolidation.
 *
 *   The promotion callback (`onPromote`) is invoked when an atom graduates,
 *   allowing the server to log the event or update metrics.
 *
 * The registry is in-memory.  TTL metadata does not survive a server
 * restart — which is intentional.  Long-lived facts should never carry
 * a TTL.  Use TTL only for ephemeral session state or GDPR-sensitive
 * data that must self-destruct.
 *
 * A 30-second grace buffer is applied during expiry checks to absorb
 * sweep jitter without risking premature deletion.
 */

export interface TtlEntry {
    atom: string;
    /** Duration in milliseconds.  Reset on every access. */
    ttlMs: number;
    /** Unix ms timestamp after which the atom should be tombstoned. */
    ttlExpiresAt: number;
    /** Unix ms of the last access or registration, whichever is newer. */
    lastAccessedAtMs: number;
    /** Number of times this atom has been accessed since TTL was set. */
    accessCount: number;
    /** Whether this atom has been promoted to permanent (TTL removed). */
    promoted: boolean;
}

export interface TtlRegistryOptions {
    /**
     * Number of accesses within the TTL window required for promotion.
     * Set to 0 or Infinity to disable auto-promotion.
     * Default: 3.
     */
    promotionThreshold?: number;
    /**
     * Called when an atom is promoted from TTL → permanent.
     * Useful for logging, metrics, or audit events.
     */
    onPromote?: (atom: string, entry: TtlEntry) => void;
}

const GRACE_MS = 30_000; // 30-second grace buffer against sweep jitter
const DEFAULT_PROMOTION_THRESHOLD = 3;

export class TtlRegistry {
    private readonly entries: Map<string, TtlEntry> = new Map();
    private readonly promotionThreshold: number;
    private readonly onPromote: ((atom: string, entry: TtlEntry) => void) | undefined;
    private _totalPromoted: number = 0;

    constructor(options?: TtlRegistryOptions) {
        this.promotionThreshold = options?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD;
        this.onPromote = options?.onPromote;
    }

    /**
     * Register or update TTL for an atom.
     * Calling this resets the clock to now and clears the access counter.
     */
    set(atom: string, ttlMs: number): TtlEntry {
        const now = Date.now();
        const entry: TtlEntry = {
            atom,
            ttlMs,
            ttlExpiresAt: now + ttlMs,
            lastAccessedAtMs: now,
            accessCount: 0,
            promoted: false,
        };
        this.entries.set(atom, entry);
        return entry;
    }

    /**
     * Record an access, resetting the TTL clock and incrementing access count.
     * If the access count reaches the promotion threshold, the atom is promoted
     * (TTL removed) and the onPromote callback is invoked.
     *
     * Returns 'touched' if the TTL was reset, 'promoted' if the atom graduated
     * to permanent, or 'noop' if the atom has no TTL entry.
     */
    touch(atom: string): 'touched' | 'promoted' | 'noop' {
        const entry = this.entries.get(atom);
        if (!entry) return 'noop';
        if (entry.promoted) return 'noop'; // already promoted, nothing to do

        const now = Date.now();
        entry.lastAccessedAtMs = now;
        entry.ttlExpiresAt = now + entry.ttlMs;
        entry.accessCount++;

        // Check promotion threshold
        if (this.promotionThreshold > 0 &&
            this.promotionThreshold < Infinity &&
            entry.accessCount >= this.promotionThreshold) {
            entry.promoted = true;
            this._totalPromoted++;
            if (this.onPromote) {
                try { this.onPromote(atom, entry); } catch { /* callback must not break access path */ }
            }
            // Remove from TTL tracking — atom is now permanent
            this.entries.delete(atom);
            return 'promoted';
        }

        return 'touched';
    }

    /** Touch multiple atoms in one call (for batch-access). Returns count of promoted atoms. */
    touchAll(atoms: string[]): { touched: number; promoted: number } {
        let touched = 0;
        let promoted = 0;
        for (const atom of atoms) {
            const result = this.touch(atom);
            if (result === 'touched') touched++;
            else if (result === 'promoted') promoted++;
        }
        return { touched, promoted };
    }

    /** Retrieve the TTL entry for a single atom, or undefined. */
    get(atom: string): TtlEntry | undefined {
        return this.entries.get(atom);
    }

    /** Remove the TTL entry for an atom (e.g. after tombstoning). */
    delete(atom: string): void {
        this.entries.delete(atom);
    }

    /**
     * Return all atoms whose TTL has expired (adjusted for grace period).
     * Promoted atoms are never returned here — they've already graduated.
     * Does NOT remove them — the caller is responsible for tombstoning and
     * calling delete() afterwards.
     */
    expired(nowMs = Date.now()): TtlEntry[] {
        const result: TtlEntry[] = [];
        for (const entry of this.entries.values()) {
            if (entry.promoted) continue; // promoted atoms never expire
            if (entry.ttlExpiresAt + GRACE_MS <= nowMs) {
                result.push(entry);
            }
        }
        return result;
    }

    /** Total number of atoms currently tracking TTL (excludes promoted). */
    get size(): number {
        return this.entries.size;
    }

    /** Total number of atoms promoted since registry creation. */
    get totalPromoted(): number {
        return this._totalPromoted;
    }

    /** Current promotion threshold. */
    get threshold(): number {
        return this.promotionThreshold;
    }

    /** All TTL entries (for debugging / export). */
    all(): TtlEntry[] {
        return [...this.entries.values()];
    }
}
