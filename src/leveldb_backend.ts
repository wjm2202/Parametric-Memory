/**
 * LevelDbBackend — Production StorageBackend wrapping classic-level.
 *
 * Sprint 8: Zero behavior change from direct LevelDB usage.
 * This is pure indirection — every operation delegates directly to
 * the underlying ClassicLevel instance.
 *
 * `get()` catches LEVEL_NOT_FOUND and returns `undefined` instead of
 * throwing, matching the StorageBackend contract.
 */

import { ClassicLevel as Level } from 'classic-level';
import { StorageBackend, BatchOp, IteratorOptions } from './storage_backend';

export interface LevelDbBackendOptions {
    blockSize?: number;
    cacheSize?: number;
}

export class LevelDbBackend implements StorageBackend {
    private db: Level<string, string>;

    constructor(
        readonly dbPath: string,
        options?: LevelDbBackendOptions,
    ) {
        this.db = new Level<string, string>(dbPath, {
            blockSize: options?.blockSize ?? 4096,
            cacheSize: options?.cacheSize ?? 2 * 1024 * 1024,
        });
    }

    async open(): Promise<void> {
        await this.db.open();
    }

    async close(): Promise<void> {
        await this.db.close();
    }

    async get(key: string): Promise<string | undefined> {
        try {
            return await this.db.get(key);
        } catch (err: unknown) {
            // classic-level throws with code 'LEVEL_NOT_FOUND' for missing keys
            if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'LEVEL_NOT_FOUND') {
                return undefined;
            }
            throw err;
        }
    }

    async put(key: string, value: string): Promise<void> {
        await this.db.put(key, value);
    }

    async del(key: string): Promise<void> {
        await this.db.del(key);
    }

    batch(): BatchOp {
        const b = this.db.batch();
        const wrapper: BatchOp = {
            put(key: string, value: string): BatchOp {
                b.put(key, value);
                return wrapper;
            },
            del(key: string): BatchOp {
                b.del(key);
                return wrapper;
            },
            async write(): Promise<void> {
                await b.write();
            },
        };
        return wrapper;
    }

    async *iterator(opts?: IteratorOptions): AsyncIterable<[string, string]> {
        const iterOpts: { gte?: string; lte?: string } = {};
        if (opts?.gte !== undefined) iterOpts.gte = opts.gte;
        if (opts?.lte !== undefined) iterOpts.lte = opts.lte;
        for await (const [key, value] of this.db.iterator(iterOpts)) {
            yield [key as string, value as string];
        }
    }
}
