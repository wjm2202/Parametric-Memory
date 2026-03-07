/**
 * TTL REGISTRY (Sprint 14-C-1)
 *
 * Tracks optional per-atom time-to-live metadata.  TTL is:
 *
 *   - Opt-in: atoms without TTL are never expired.
 *   - Access-aware: every access resets the expiry clock.
 *       ttlExpiresAt = lastAccessedAtMs + ttlMs
 *   - Swept by the background reaper in server.ts.
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
}

const GRACE_MS = 30_000; // 30-second grace buffer against sweep jitter

export class TtlRegistry {
    private readonly entries: Map<string, TtlEntry> = new Map();

    /**
     * Register or update TTL for an atom.
     * Calling this resets the clock to now.
     */
    set(atom: string, ttlMs: number): TtlEntry {
        const now = Date.now();
        const entry: TtlEntry = {
            atom,
            ttlMs,
            ttlExpiresAt: now + ttlMs,
            lastAccessedAtMs: now,
        };
        this.entries.set(atom, entry);
        return entry;
    }

    /**
     * Record an access, resetting the TTL clock.
     * No-op if the atom has no TTL entry.
     */
    touch(atom: string): void {
        const entry = this.entries.get(atom);
        if (!entry) return;
        const now = Date.now();
        entry.lastAccessedAtMs = now;
        entry.ttlExpiresAt = now + entry.ttlMs;
    }

    /** Touch multiple atoms in one call (for batch-access). */
    touchAll(atoms: string[]): void {
        for (const atom of atoms) this.touch(atom);
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
     * Does NOT remove them — the caller is responsible for tombstoning and
     * calling delete() afterwards.
     */
    expired(nowMs = Date.now()): TtlEntry[] {
        const result: TtlEntry[] = [];
        for (const entry of this.entries.values()) {
            if (entry.ttlExpiresAt + GRACE_MS <= nowMs) {
                result.push(entry);
            }
        }
        return result;
    }

    /** Total number of atoms currently tracking TTL. */
    get size(): number {
        return this.entries.size;
    }

    /** All TTL entries (for debugging / export). */
    all(): TtlEntry[] {
        return [...this.entries.values()];
    }
}
