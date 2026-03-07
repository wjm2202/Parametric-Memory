/**
 * AUDIT LOG (Sprint 14-A-3, extended Sprint 16)
 *
 * A bounded, in-memory ring buffer that records mutation and read events for
 * operator visibility.  Entries are kept in insertion order; when the buffer
 * is full the oldest entry is evicted.
 *
 * Mutation events:
 *   atom.add         — one or more atoms queued for ingestion
 *   atom.tombstone   — an atom soft-deleted
 *   admin.commit     — the ingestion pipeline flushed
 *   admin.import     — atoms loaded via POST /admin/import
 *   review.bypass    — write-policy review tier bypassed via reviewApproved:true
 *
 * Read / access events (S16-2):
 *   admin.export     — full atom snapshot exported (silent exfil risk)
 *   memory.bootstrap — session bootstrap called (loads full context)
 *   memory.context   — context block generated
 *   atoms.list       — atom list endpoint called
 *   memory.time_travel — any request that used asOfMs or asOfVersion (S16-6)
 *
 * Thread safety: Node.js is single-threaded — no locking needed.
 */

export type AuditEventType =
    | 'atom.add'
    | 'atom.tombstone'
    | 'admin.commit'
    | 'admin.import'
    | 'admin.export'
    | 'review.bypass'
    | 'memory.bootstrap'
    | 'memory.context'
    | 'atoms.list'
    | 'memory.time_travel';

export interface AuditEntry {
    /** Monotonically increasing id within this process lifetime. */
    id: number;
    event: AuditEventType;
    timestampMs: number;
    /** Atoms involved (absent for commit/export entries). */
    atoms?: string[];
    /** Number of atoms affected (useful for bulk operations). */
    count?: number;
    /** Fastify request.id for the originating HTTP call (if available). */
    requestId?: string;
    /** Master tree version after the operation (if available). */
    treeVersion?: number;
    /** Named API key client (S16-8). Populated when per-client keys are configured. */
    clientName?: string;
    /** Extra context — e.g. time-travel params, bypass reason. */
    meta?: Record<string, unknown>;
}

export class AuditLog {
    private readonly buffer: AuditEntry[] = [];
    private counter = 0;
    readonly maxEntries: number;

    constructor(maxEntries = 1_000) {
        this.maxEntries = maxEntries;
    }

    /** Append a new entry, evicting the oldest when the ring is full. */
    record(
        event: AuditEventType,
        opts: {
            atoms?: string[];
            count?: number;
            requestId?: string;
            treeVersion?: number;
            clientName?: string;
            meta?: Record<string, unknown>;
        } = {}
    ): AuditEntry {
        const entry: AuditEntry = {
            id: ++this.counter,
            event,
            timestampMs: Date.now(),
            ...opts,
        };
        if (this.buffer.length >= this.maxEntries) {
            this.buffer.shift(); // evict oldest
        }
        this.buffer.push(entry);
        return entry;
    }

    /**
     * Query entries, newest-first.
     *
     * @param limit   Maximum entries to return (default 100, capped at maxEntries).
     * @param since   Only return entries with timestampMs >= since.
     * @param event   Only return entries of this event type.
     */
    query(opts: { limit?: number; since?: number; event?: AuditEventType } = {}): AuditEntry[] {
        const limit = Math.min(opts.limit ?? 100, this.maxEntries);
        let results = this.buffer.slice(); // shallow copy

        if (opts.since !== undefined) {
            results = results.filter(e => e.timestampMs >= opts.since!);
        }
        if (opts.event) {
            results = results.filter(e => e.event === opts.event);
        }

        // Newest-first
        results.reverse();
        return results.slice(0, limit);
    }

    /** Total number of events recorded (including evicted ones). */
    get totalRecorded(): number {
        return this.counter;
    }

    /** Number of entries currently in the buffer. */
    get size(): number {
        return this.buffer.length;
    }
}
