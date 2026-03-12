/**
 * Sprint 8 — StorageBackend Contract Tests
 *
 * Runs the same assertions against both LevelDbBackend and InMemoryBackend
 * to verify they produce identical behavior for all operations used by
 * shard_worker.ts.
 *
 * Key areas tested:
 *   1. get/put/del basic operations
 *   2. get returns undefined for missing keys (not throw)
 *   3. batch put + del + write atomicity
 *   4. iterator ordering matches LevelDB byte-order
 *   5. iterator range bounds (gte/lte)
 *   6. Iterator with MMPM key prefixes (ai:, w:, wu:, th:, ts:, ac:)
 *   7. ShardWorker works identically with InMemoryBackend
 */
import { describe, it, expect, afterAll } from 'vitest';
import { StorageBackend } from '../storage_backend';
import { LevelDbBackend } from '../leveldb_backend';
import { InMemoryBackend } from '../memory_backend';
import { ShardWorker } from '../shard_worker';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let dbCounter = 0;

function freshLevelDb(): LevelDbBackend {
    const path = `./test-backend-db-${Date.now()}-${dbCounter++}`;
    dbDirs.push(path);
    return new LevelDbBackend(path);
}

afterAll(() => {
    for (const dir of dbDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

const atom = (v: string) => `v1.fact.${v}`;

/**
 * Contract test suite — runs against any StorageBackend implementation.
 */
function contractTests(name: string, factory: () => StorageBackend) {
    describe(`StorageBackend contract: ${name}`, () => {

        it('get returns undefined for missing key', async () => {
            const backend = factory();
            await backend.open();
            const result = await backend.get('nonexistent_key');
            expect(result).toBeUndefined();
            await backend.close();
        });

        it('put then get returns the value', async () => {
            const backend = factory();
            await backend.open();
            await backend.put('key1', 'value1');
            const result = await backend.get('key1');
            expect(result).toBe('value1');
            await backend.close();
        });

        it('put overwrites existing value', async () => {
            const backend = factory();
            await backend.open();
            await backend.put('key1', 'old');
            await backend.put('key1', 'new');
            expect(await backend.get('key1')).toBe('new');
            await backend.close();
        });

        it('del removes a key', async () => {
            const backend = factory();
            await backend.open();
            await backend.put('key1', 'value1');
            await backend.del('key1');
            expect(await backend.get('key1')).toBeUndefined();
            await backend.close();
        });

        it('del on missing key is a no-op', async () => {
            const backend = factory();
            await backend.open();
            await backend.del('never_existed');
            // Should not throw
            expect(await backend.get('never_existed')).toBeUndefined();
            await backend.close();
        });

        it('batch applies puts and dels atomically', async () => {
            const backend = factory();
            await backend.open();
            await backend.put('keep', 'yes');
            await backend.put('remove', 'yes');

            const b = backend.batch();
            b.put('new1', 'v1');
            b.put('new2', 'v2');
            b.del('remove');
            await b.write();

            expect(await backend.get('keep')).toBe('yes');
            expect(await backend.get('new1')).toBe('v1');
            expect(await backend.get('new2')).toBe('v2');
            expect(await backend.get('remove')).toBeUndefined();
            await backend.close();
        });

        it('batch is chainable', async () => {
            const backend = factory();
            await backend.open();
            await backend.batch()
                .put('a', '1')
                .put('b', '2')
                .del('a')
                .write();
            expect(await backend.get('a')).toBeUndefined();
            expect(await backend.get('b')).toBe('2');
            await backend.close();
        });

        it('iterator yields keys in byte order', async () => {
            const backend = factory();
            await backend.open();

            // Insert in random order
            const keys = ['c', 'a', 'b', 'z', 'aa', 'ab'];
            for (const k of keys) await backend.put(k, k);

            const result: string[] = [];
            for await (const [key] of backend.iterator()) {
                result.push(key);
            }

            const expected = [...keys].sort(); // JS sort() is byte-order for ASCII
            expect(result).toEqual(expected);
            await backend.close();
        });

        it('iterator respects gte/lte bounds', async () => {
            const backend = factory();
            await backend.open();

            await backend.put('a:1', 'v1');
            await backend.put('a:2', 'v2');
            await backend.put('b:1', 'v3');
            await backend.put('b:2', 'v4');
            await backend.put('c:1', 'v5');

            const result: string[] = [];
            for await (const [key] of backend.iterator({ gte: 'b:', lte: 'b:~' })) {
                result.push(key);
            }

            expect(result).toEqual(['b:1', 'b:2']);
            await backend.close();
        });

        it('iterator with MMPM key prefixes matches expected order', async () => {
            const backend = factory();
            await backend.open();

            // Simulate MMPM key namespaces
            const mmpmKeys = [
                'ai:0000000000',
                'ai:0000000001',
                'ac:0000000000',
                'ac:0000000001',
                'th:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                'ts:0000000000',
                'ts:0000000001',
                'w:0000000000:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                'w:0000000001:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
                'wu:0000000000:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            ];

            // Insert in scrambled order
            const shuffled = [...mmpmKeys].reverse();
            for (const k of shuffled) await backend.put(k, '1');

            // Full scan
            const fullResult: string[] = [];
            for await (const [key] of backend.iterator()) {
                fullResult.push(key);
            }
            expect(fullResult).toEqual([...mmpmKeys].sort());

            // Prefix scan for w: keys
            const wResult: string[] = [];
            for await (const [key] of backend.iterator({ gte: 'w:', lte: 'w:~' })) {
                wResult.push(key);
            }
            expect(wResult).toEqual(mmpmKeys.filter(k => k.startsWith('w:')));

            // Prefix scan for ai: keys
            const aiResult: string[] = [];
            for await (const [key] of backend.iterator({ gte: 'ai:', lte: 'ai:~' })) {
                aiResult.push(key);
            }
            expect(aiResult).toEqual(['ai:0000000000', 'ai:0000000001']);

            await backend.close();
        });

        it('empty iterator returns nothing', async () => {
            const backend = factory();
            await backend.open();
            const result: string[] = [];
            for await (const [key] of backend.iterator({ gte: 'z:', lte: 'z:~' })) {
                result.push(key);
            }
            expect(result).toEqual([]);
            await backend.close();
        });
    });
}

// Run contract tests against both backends
contractTests('LevelDbBackend', freshLevelDb);
contractTests('InMemoryBackend', () => new InMemoryBackend());

describe('Cross-backend ordering verification', () => {
    it('both backends produce identical key ordering for mixed MMPM keys', async () => {
        const levelDb = freshLevelDb();
        const memDb = new InMemoryBackend();
        await levelDb.open();
        await memDb.open();

        // Realistic MMPM keys in random insertion order
        const keys = [
            'wu:0000000005:ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',
            'ai:0000000002',
            'w:0000000001:aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11',
            'th:bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22bb22',
            'ac:0000000003',
            'ts:0000000001',
            'ai:0000000000',
            'w:0000000000:cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33cc33',
            'ts:0000000000',
            'ac:0000000000',
        ];

        for (const k of keys) {
            await levelDb.put(k, 'v');
            await memDb.put(k, 'v');
        }

        const levelKeys: string[] = [];
        for await (const [key] of levelDb.iterator()) levelKeys.push(key);

        const memKeys: string[] = [];
        for await (const [key] of memDb.iterator()) memKeys.push(key);

        expect(memKeys).toEqual(levelKeys);

        await levelDb.close();
        await memDb.close();
    });
});

describe('ShardWorker with InMemoryBackend', () => {
    it('basic add + access + train cycle works', async () => {
        const backend = new InMemoryBackend();
        const dbPath = './test-inmem-shard-unused';
        const worker = new ShardWorker(
            [atom('a'), atom('b'), atom('c')],
            dbPath,
            { storage: backend },
        );
        await worker.init();

        // Atoms are present
        const atoms = worker.getAtoms();
        expect(atoms).toHaveLength(3);
        expect(atoms.map(a => a.atom).sort()).toEqual([atom('a'), atom('b'), atom('c')].sort());

        // Access works
        const result = await worker.access(atom('a'));
        expect(result.proof.leaf).toMatch(/^[a-f0-9]{64}$/);

        // Train works
        const hashA = worker.getHash(atom('a'))!;
        const hashB = worker.getHash(atom('b'))!;
        await worker.recordTransition(hashA, hashB);
        await worker.recordTransition(hashA, hashB);

        const weights = worker.getWeights(atom('a'));
        expect(weights).not.toBeNull();
        const edge = weights!.find(w => w.to === atom('b'));
        expect(edge).toBeDefined();
        expect(edge!.weight).toBe(2);

        await worker.close();
    });

    it('add dynamic atoms works with InMemoryBackend', async () => {
        const backend = new InMemoryBackend();
        const worker = new ShardWorker(
            [atom('seed')],
            './test-inmem-shard-add',
            { storage: backend },
        );
        await worker.init();

        await worker.addAtoms([atom('dynamic_one'), atom('dynamic_two')]);
        await worker.commit();

        const atoms = worker.getAtoms();
        expect(atoms).toHaveLength(3);

        // Access the dynamic atom
        const result = await worker.access(atom('dynamic_one'));
        expect(result.proof.leaf).toMatch(/^[a-f0-9]{64}$/);

        await worker.close();
    });

    it('tombstone works with InMemoryBackend', async () => {
        const backend = new InMemoryBackend();
        const worker = new ShardWorker(
            [atom('alive'), atom('doomed')],
            './test-inmem-shard-tomb',
            { storage: backend },
        );
        await worker.init();

        await worker.tombstoneAtom(atom('doomed'));
        await worker.commit();

        const atoms = worker.getAtoms();
        const doomed = atoms.find(a => a.atom === atom('doomed'));
        expect(doomed?.status).toBe('tombstoned');

        await worker.close();
    });

    it('exportFull works with InMemoryBackend', async () => {
        const backend = new InMemoryBackend();
        const worker = new ShardWorker(
            [atom('exp_a'), atom('exp_b')],
            './test-inmem-export',
            { storage: backend },
        );
        await worker.init();

        const hashA = worker.getHash(atom('exp_a'))!;
        const hashB = worker.getHash(atom('exp_b'))!;
        await worker.recordTransition(hashA, hashB);

        const lines = worker.exportFull();
        expect(lines.length).toBeGreaterThanOrEqual(3); // 2 atoms + 1 weight

        const records = lines.map(l => JSON.parse(l));
        expect(records.filter(r => r.type === 'atom')).toHaveLength(2);
        expect(records.filter(r => r.type === 'weight')).toHaveLength(1);

        await worker.close();
    });

    it('restart with InMemoryBackend preserves state', async () => {
        const backend = new InMemoryBackend();
        const seeds = [atom('persist_a'), atom('persist_b')];

        // First lifecycle
        const w1 = new ShardWorker(seeds, './test-inmem-restart', { storage: backend });
        await w1.init();
        const hashA = w1.getHash(atom('persist_a'))!;
        const hashB = w1.getHash(atom('persist_b'))!;
        await w1.recordTransition(hashA, hashB);
        await w1.recordTransition(hashA, hashB);
        await w1.recordTransition(hashA, hashB);
        await w1.close();

        // Second lifecycle — same backend, simulating restart
        const w2 = new ShardWorker(seeds, './test-inmem-restart', { storage: backend });
        await w2.init();

        // Weights should be preserved
        const weights = w2.getWeights(atom('persist_a'));
        expect(weights).not.toBeNull();
        const edge = weights!.find(w => w.to === atom('persist_b'));
        expect(edge).toBeDefined();
        expect(edge!.weight).toBe(3);

        await w2.close();
    });
});
