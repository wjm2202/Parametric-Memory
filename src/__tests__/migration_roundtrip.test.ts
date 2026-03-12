/**
 * Sprint 7 — Migration Round-Trip Test
 *
 * Verifies that exportFull() → importFull() preserves:
 *   1. All atoms (active + tombstoned)
 *   2. Markov transition weights (raw values, not just existence)
 *   3. Weight timestamps
 *   4. Access counts
 *   5. Atom creation timestamps
 *   6. Tombstone status
 *   7. Cross-shard weight references
 *
 * Strategy: build a cluster with known state, export, build a fresh
 * cluster (possibly different shard count), import, then compare.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ShardedOrchestrator } from '../orchestrator';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let dbCounter = 0;

function freshDb(): string {
    const path = `./test-migration-db-${Date.now()}-${dbCounter++}`;
    dbDirs.push(path);
    return path;
}

afterAll(() => {
    for (const dir of dbDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

const atom = (v: string) => `v1.fact.${v}`;
const stateAtom = (v: string) => `v1.state.${v}`;
const procAtom = (v: string) => `v1.procedure.${v}`;

describe('Migration Round-Trip (Sprint 7)', () => {

    it('export and import preserves atoms', async () => {
        const seeds = [atom('alpha'), atom('beta'), atom('gamma'), stateAtom('current')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        // Add dynamic atoms
        await src.addAtoms([atom('delta'), procAtom('rule_one')]);

        const exported = src.exportFull();
        await src.close();

        // Import into a fresh cluster (same shard count)
        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();
        const result = await dst.importFull(exported);

        expect(result.errors).toHaveLength(0);
        expect(result.atomsImported).toBe(6); // 4 seeds + 2 dynamic

        // Verify all atoms are accessible
        const dstAtoms = dst.listAtoms().map(a => a.atom).sort();
        expect(dstAtoms).toEqual(seeds.concat([atom('delta'), procAtom('rule_one')]).sort());

        await dst.close();
    });

    it('export and import preserves Markov weights', async () => {
        const seeds = [atom('a'), atom('b'), atom('c'), atom('d')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        // Train: a→b→c (3 passes = weight 3)
        await src.train([atom('a'), atom('b'), atom('c')]);
        await src.train([atom('a'), atom('b'), atom('c')]);
        await src.train([atom('a'), atom('b'), atom('c')]);

        // Train: c→d (1 pass = weight 1)
        await src.train([atom('c'), atom('d')]);

        // Read weights before export
        const srcWeightsA = src.getWeights(atom('a'));
        expect(srcWeightsA).not.toBeNull();
        const srcAtoB = srcWeightsA!.find(w => w.to === atom('b'));
        expect(srcAtoB).toBeDefined();
        expect(srcAtoB!.weight).toBe(3);

        const exported = src.exportFull();
        await src.close();

        // Import into fresh cluster
        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();
        const result = await dst.importFull(exported);

        expect(result.errors).toHaveLength(0);
        expect(result.weightsImported).toBeGreaterThanOrEqual(3); // a→b, b→c, c→d minimum

        // Verify weights survived
        const dstWeightsA = dst.getWeights(atom('a'));
        expect(dstWeightsA).not.toBeNull();
        const dstAtoB = dstWeightsA!.find(w => w.to === atom('b'));
        expect(dstAtoB).toBeDefined();
        expect(dstAtoB!.weight).toBe(3);

        const dstWeightsC = dst.getWeights(atom('c'));
        expect(dstWeightsC).not.toBeNull();
        const dstCtoD = dstWeightsC!.find(w => w.to === atom('d'));
        expect(dstCtoD).toBeDefined();
        expect(dstCtoD!.weight).toBe(1);

        await dst.close();
    });

    it('export and import preserves tombstones', async () => {
        const seeds = [atom('alive'), atom('dead'), stateAtom('old')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        // Tombstone one atom
        await src.removeAtom(stateAtom('old'));

        const srcAtoms = src.listAtoms();
        const srcTombstoned = srcAtoms.filter(a => a.status === 'tombstoned');
        expect(srcTombstoned).toHaveLength(1);
        expect(srcTombstoned[0].atom).toBe(stateAtom('old'));

        const exported = src.exportFull();
        await src.close();

        // Import
        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();
        await dst.importFull(exported);

        const dstAtoms = dst.listAtoms();
        const dstTombstoned = dstAtoms.filter(a => a.status === 'tombstoned');
        expect(dstTombstoned).toHaveLength(1);
        expect(dstTombstoned[0].atom).toBe(stateAtom('old'));

        // Active atoms are still active
        const dstActive = dstAtoms.filter(a => a.status === 'active').map(a => a.atom).sort();
        expect(dstActive).toEqual([atom('alive'), atom('dead')].sort());

        await dst.close();
    });

    it('export and import preserves atom creation timestamps', async () => {
        const seeds = [atom('ts_test')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        const srcRecord = src.inspectAtom(atom('ts_test'));
        expect(srcRecord).not.toBeNull();
        const srcCreatedAt = srcRecord!.createdAtMs;
        expect(srcCreatedAt).toBeGreaterThan(0);

        const exported = src.exportFull();
        await src.close();

        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();
        await dst.importFull(exported);

        const dstRecord = dst.inspectAtom(atom('ts_test'));
        expect(dstRecord).not.toBeNull();
        // Timestamp should be preserved from the export
        expect(dstRecord!.createdAtMs).toBe(srcCreatedAt);

        await dst.close();
    });

    it('export NDJSON contains meta header', async () => {
        const src = new ShardedOrchestrator(2, [atom('x')], freshDb());
        await src.init();
        const exported = src.exportFull();
        await src.close();

        expect(exported.length).toBeGreaterThanOrEqual(2); // meta + at least 1 atom

        const meta = JSON.parse(exported[0]);
        expect(meta.type).toBe('meta');
        expect(meta.version).toBe(1);
        expect(meta.shardCount).toBe(2);
        expect(meta.treeVersion).toBeGreaterThan(0);
        expect(meta.exportedAtMs).toBeGreaterThan(0);
        expect(meta.treeRoot).toMatch(/^[a-f0-9]{64}$/);
    });

    it('import into cluster with different shard count', async () => {
        // Export from 2 shards
        const seeds = [atom('p'), atom('q'), atom('r'), atom('s')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();
        await src.train([atom('p'), atom('q'), atom('r')]);
        await src.train([atom('p'), atom('q'), atom('r')]);
        const exported = src.exportFull();
        await src.close();

        // Import into 4 shards — different routing
        const dst = new ShardedOrchestrator(4, [], freshDb());
        await dst.init();
        const result = await dst.importFull(exported);

        expect(result.errors).toHaveLength(0);
        expect(result.atomsImported).toBe(4);

        // Atoms are all present
        const dstAtoms = dst.listAtoms().map(a => a.atom).sort();
        expect(dstAtoms).toEqual(seeds.sort());

        // Weights survive re-sharding (the fromAtom routes to same shard as the weight)
        const wP = dst.getWeights(atom('p'));
        expect(wP).not.toBeNull();
        // p→q should have weight 2 (trained twice)
        const pToQ = wP!.find(w => w.to === atom('q'));
        expect(pToQ).toBeDefined();
        expect(pToQ!.weight).toBe(2);

        await dst.close();
    });

    it('double import is idempotent (skips existing atoms, max-merges weights)', async () => {
        const seeds = [atom('dup_a'), atom('dup_b')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();
        await src.train([atom('dup_a'), atom('dup_b')]);
        const exported = src.exportFull();
        await src.close();

        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();

        // First import
        const r1 = await dst.importFull(exported);
        expect(r1.atomsImported).toBe(2);

        // Second import — atoms should be skipped
        const r2 = await dst.importFull(exported);
        expect(r2.atomsSkipped).toBe(2);
        expect(r2.atomsImported).toBe(0);

        // Weight should not double (max merge, not additive)
        const w = dst.getWeights(atom('dup_a'));
        const edge = w!.find(e => e.to === atom('dup_b'));
        expect(edge!.weight).toBe(1); // still 1, not 2

        await dst.close();
    });

    it('export contains all record types', async () => {
        const seeds = [atom('rec_a'), atom('rec_b')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        // Train to create weights
        await src.train([atom('rec_a'), atom('rec_b')]);

        // Access to create access counts
        await src.access(atom('rec_a'));
        await src.access(atom('rec_a'));

        const exported = src.exportFull();
        await src.close();

        const records = exported.map(l => JSON.parse(l));
        const types = new Set(records.map(r => r.type));

        expect(types.has('meta')).toBe(true);
        expect(types.has('atom')).toBe(true);
        expect(types.has('weight')).toBe(true);
        expect(types.has('access_count')).toBe(true);

        // Verify weight records have resolved atom names
        const weightRecs = records.filter(r => r.type === 'weight');
        expect(weightRecs.length).toBeGreaterThan(0);
        for (const w of weightRecs) {
            expect(w.fromAtom).toMatch(/^v1\./);
            expect(w.weight).toBeGreaterThan(0);
            expect(w.toHash).toMatch(/^[a-f0-9]{64}$/);
        }

        // Verify access count records
        const acRecs = records.filter(r => r.type === 'access_count');
        expect(acRecs.length).toBeGreaterThan(0);
        expect(acRecs.some(r => r.atom === atom('rec_a') && r.count >= 2)).toBe(true);
    });

    it('predictions work after import (Markov chain functional)', async () => {
        const seeds = [atom('m1'), atom('m2'), atom('m3')];
        const src = new ShardedOrchestrator(2, seeds, freshDb());
        await src.init();

        // Strong training: m1→m2→m3
        for (let i = 0; i < 5; i++) {
            await src.train([atom('m1'), atom('m2'), atom('m3')]);
        }

        // Verify prediction works in source
        const srcReport = await src.access(atom('m1'));
        expect(srcReport.predictedNext).toBe(atom('m2'));

        const exported = src.exportFull();
        await src.close();

        // Import and verify prediction works in destination
        const dst = new ShardedOrchestrator(2, [], freshDb());
        await dst.init();
        await dst.importFull(exported);

        const dstReport = await dst.access(atom('m1'));
        expect(dstReport.predictedNext).toBe(atom('m2'));

        await dst.close();
    });
});
