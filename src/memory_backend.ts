/**
 * InMemoryBackend — Test-only StorageBackend using a sorted Map.
 *
 * Sprint 8: Enables fast, deterministic tests without disk I/O.
 *
 * Key ordering uses JavaScript's native `<` / `>` string comparison,
 * which is byte-order for ASCII strings — matching LevelDB's default
 * comparator for the key namespaces used by MMPM (ai:, ac:, th:, ts:, w:, wu:).
 *
 * IMPORTANT: Do NOT use `localeCompare()` — it is NOT byte-order.
 */

import { StorageBackend, BatchOp, IteratorOptions } from './storage_backend';

export class InMemoryBackend implements StorageBackend {
    private store: Map<string, string> = new Map();
    private _open = false;

    async open(): Promise<void> {
        this._open = true;
    }

    async close(): Promise<void> {
        this._open = false;
    }

    async get(key: string): Promise<string | undefined> {
        return this.store.get(key);
    }

    async put(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async del(key: string): Promise<void> {
        this.store.delete(key);
    }

    batch(): BatchOp {
        const ops: Array<{ type: 'put'; key: string; value: string } | { type: 'del'; key: string }> = [];
        const self = this;
        const wrapper: BatchOp = {
            put(key: string, value: string): BatchOp {
                ops.push({ type: 'put', key, value });
                return wrapper;
            },
            del(key: string): BatchOp {
                ops.push({ type: 'del', key });
                return wrapper;
            },
            async write(): Promise<void> {
                for (const op of ops) {
                    if (op.type === 'put') self.store.set(op.key, op.value);
                    else self.store.delete(op.key);
                }
            },
        };
        return wrapper;
    }

    async *iterator(opts?: IteratorOptions): AsyncIterable<[string, string]> {
        // Sort keys using native string comparison (byte-order for ASCII)
        const allKeys = Array.from(this.store.keys()).sort();
        for (const key of allKeys) {
            if (opts?.gte !== undefined && key < opts.gte) continue;
            if (opts?.lte !== undefined && key > opts.lte) break; // sorted, so we can break early
            yield [key, this.store.get(key)!];
        }
    }

    /** Test helper: return the number of keys in the store. */
    get size(): number {
        return this.store.size;
    }

    /** Test helper: clear all data. */
    clear(): void {
        this.store.clear();
    }
}
