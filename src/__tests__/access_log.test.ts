import { describe, it, expect, beforeEach } from 'vitest';
import { AccessLog } from '../access_log';
import { InMemoryBackend } from '../memory_backend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function freshLog(maxEntries = 50_000): Promise<{ log: AccessLog; storage: InMemoryBackend }> {
    const storage = new InMemoryBackend();
    await storage.open();
    const log = new AccessLog(storage, { maxEntries });
    await log.init();
    return { log, storage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccessLog (Sprint 14)', () => {

    describe('basic operations', () => {

        it('starts with zero entries', async () => {
            const { log } = await freshLog();
            expect(log.count).toBe(0);
        });

        it('appends and reads back entries', async () => {
            const { log } = await freshLog();
            await log.append({ atom: 'v1.fact.test', type: 'access', ts: 1000 });
            await log.append({ atom: 'v1.fact.test', type: 'train', ts: 2000 });

            expect(log.count).toBe(2);
            const all = await log.readAll();
            expect(all).toHaveLength(2);
            expect(all[0].atom).toBe('v1.fact.test');
            expect(all[0].type).toBe('access');
            expect(all[0].ts).toBe(1000);
            expect(all[1].type).toBe('train');
        });

        it('batch append works', async () => {
            const { log } = await freshLog();
            await log.appendBatch([
                { atom: 'v1.fact.a', type: 'access', ts: 100 },
                { atom: 'v1.fact.b', type: 'train', ts: 200 },
                { atom: 'v1.fact.c', type: 'bootstrap', ts: 300 },
            ]);

            expect(log.count).toBe(3);
            const all = await log.readAll();
            expect(all).toHaveLength(3);
        });

        it('empty batch append is no-op', async () => {
            const { log } = await freshLog();
            await log.appendBatch([]);
            expect(log.count).toBe(0);
        });
    });

    describe('query by time range', () => {

        it('returns entries within range', async () => {
            const { log } = await freshLog();
            await log.append({ atom: 'v1.fact.a', type: 'access', ts: 1000 });
            await log.append({ atom: 'v1.fact.b', type: 'access', ts: 2000 });
            await log.append({ atom: 'v1.fact.c', type: 'access', ts: 3000 });
            await log.append({ atom: 'v1.fact.d', type: 'access', ts: 4000 });

            const results = await log.query(2000, 3000);
            expect(results).toHaveLength(2);
            expect(results[0].atom).toBe('v1.fact.b');
            expect(results[1].atom).toBe('v1.fact.c');
        });

        it('returns empty for out-of-range query', async () => {
            const { log } = await freshLog();
            await log.append({ atom: 'v1.fact.a', type: 'access', ts: 1000 });

            const results = await log.query(5000, 9000);
            expect(results).toHaveLength(0);
        });
    });

    describe('FIFO eviction', () => {

        it('evicts oldest entries when over maxEntries', async () => {
            const { log } = await freshLog(5);

            // Add 7 entries — should evict 2 oldest
            for (let i = 0; i < 7; i++) {
                await log.append({ atom: `v1.fact.item_${i}`, type: 'access', ts: (i + 1) * 1000 });
            }

            expect(log.count).toBe(5);
            const all = await log.readAll();
            expect(all).toHaveLength(5);
            // Oldest two (ts=1000, ts=2000) should be gone
            expect(all[0].ts).toBe(3000);
            expect(all[4].ts).toBe(7000);
        });

        it('evicts correctly with batch append', async () => {
            const { log } = await freshLog(3);

            await log.appendBatch([
                { atom: 'v1.fact.a', type: 'access', ts: 100 },
                { atom: 'v1.fact.b', type: 'access', ts: 200 },
                { atom: 'v1.fact.c', type: 'access', ts: 300 },
                { atom: 'v1.fact.d', type: 'access', ts: 400 },
                { atom: 'v1.fact.e', type: 'access', ts: 500 },
            ]);

            expect(log.count).toBe(3);
            const all = await log.readAll();
            expect(all[0].ts).toBe(300);
        });
    });

    describe('persistence across init', () => {

        it('restores count from storage', async () => {
            const storage = new InMemoryBackend();
            await storage.open();

            const log1 = new AccessLog(storage, { maxEntries: 100 });
            await log1.init();
            await log1.append({ atom: 'v1.fact.a', type: 'access', ts: 1000 });
            await log1.append({ atom: 'v1.fact.b', type: 'train', ts: 2000 });
            expect(log1.count).toBe(2);

            // Create new log on same storage — should restore count
            const log2 = new AccessLog(storage, { maxEntries: 100 });
            await log2.init();
            expect(log2.count).toBe(2);

            const all = await log2.readAll();
            expect(all).toHaveLength(2);
        });
    });

    describe('chronological ordering', () => {

        it('readAll returns in chronological order', async () => {
            const { log } = await freshLog();
            // Insert out of order
            await log.append({ atom: 'v1.fact.late', type: 'access', ts: 5000 });
            await log.append({ atom: 'v1.fact.early', type: 'access', ts: 1000 });
            await log.append({ atom: 'v1.fact.mid', type: 'access', ts: 3000 });

            const all = await log.readAll();
            expect(all).toHaveLength(3);
            // Keys are padded timestamps, so lexicographic = chronological
            expect(all[0].ts).toBe(1000);
            expect(all[1].ts).toBe(3000);
            expect(all[2].ts).toBe(5000);
        });
    });

    describe('malformed data handling', () => {

        it('skips malformed JSON in query', async () => {
            const storage = new InMemoryBackend();
            await storage.open();

            // Write a valid entry and a corrupt one
            await storage.put('al:000000000001000', JSON.stringify({ atom: 'v1.fact.a', type: 'access', ts: 1000 }));
            await storage.put('al:000000000002000', 'NOT_JSON{{{');
            await storage.put('al:000000000003000', JSON.stringify({ atom: 'v1.fact.c', type: 'access', ts: 3000 }));

            const log = new AccessLog(storage, { maxEntries: 100 });
            await log.init();

            const all = await log.readAll();
            // Should get 2 valid entries, corrupt one skipped
            expect(all).toHaveLength(2);
            expect(all[0].atom).toBe('v1.fact.a');
            expect(all[1].atom).toBe('v1.fact.c');
        });
    });
});
