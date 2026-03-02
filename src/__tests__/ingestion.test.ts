import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IngestionPipeline } from '../ingestion';
import { ShardedOrchestrator } from '../orchestrator';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
const atom = (value: string) => `v1.other.${value}`;

function tempDir() {
    return mkdtempSync(join(tmpdir(), 'mmpm-ingest-test-'));
}

async function makeOrchestrator(dir: string) {
    const orch = new ShardedOrchestrator(2, [atom('A'), atom('B'), atom('C')], dir);
    await orch.init();
    return orch;
}

describe('IngestionPipeline', () => {
    let dir: string;
    let orchestrator: ShardedOrchestrator;

    beforeEach(async () => {
        dir = tempDir();
        orchestrator = await makeOrchestrator(dir);
    });

    afterEach(async () => {
        if (orchestrator) await orchestrator.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it('enqueue returns a receipt immediately', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        const receipt = await pipeline.enqueue([atom('D'), atom('E')]);
        expect(receipt.queued).toBe(2);
        expect(typeof receipt.batchId).toBe('number');
        expect(typeof receipt.commitEtaMs).toBe('number');
    });

    it('enqueued atoms appear in getQueuedAtoms before flush', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await pipeline.enqueue([atom('NewAtom1'), atom('NewAtom2')]);
        expect(pipeline.getQueuedAtoms()).toContain(atom('NewAtom1'));
        expect(pipeline.getQueuedAtoms()).toContain(atom('NewAtom2'));
    });

    it('flush commits atoms to the orchestrator', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await pipeline.enqueue([atom('D'), atom('E')]);
        expect(orchestrator.listAtoms().map(a => a.atom)).not.toContain(atom('D'));
        await pipeline.flush();
        expect(orchestrator.listAtoms().map(a => a.atom)).toContain(atom('D'));
        expect(orchestrator.listAtoms().map(a => a.atom)).toContain(atom('E'));
    });

    it('queue is empty after flush', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await pipeline.enqueue([atom('X'), atom('Y')]);
        await pipeline.flush();
        expect(pipeline.getQueuedAtoms()).toHaveLength(0);
    });

    it('duplicate atoms within a batch are de-duplicated', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        const receipt = await pipeline.enqueue([atom('Dup'), atom('Dup'), atom('Dup')]);
        expect(receipt.queued).toBe(1); // only one accepted
    });

    it('auto-flushes when batchSize is reached', async () => {
        // batchSize=2: enqueuing 2 atoms should auto-flush
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 2, flushIntervalMs: 60000 });
        await pipeline.enqueue([atom('F'), atom('G')]); // triggers flush at size 2
        // Give the async flush a tick to complete
        await new Promise(r => setTimeout(r, 10));
        const atoms = orchestrator.listAtoms().map(a => a.atom);
        expect(atoms).toContain(atom('F'));
        expect(atoms).toContain(atom('G'));
    });

    it('stop() drains remaining queued atoms', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        pipeline.start();
        await pipeline.enqueue([atom('H'), atom('I')]);
        await pipeline.stop();
        const atoms = orchestrator.listAtoms().map(a => a.atom);
        expect(atoms).toContain(atom('H'));
        expect(atoms).toContain(atom('I'));
    });

    it('getStats reports correct counts after flush', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await pipeline.enqueue([atom('J'), atom('K')]);
        await pipeline.flush();
        const stats = pipeline.getStats();
        expect(stats.totalEnqueued).toBe(2);
        expect(stats.totalFlushed).toBe(2);
        expect(stats.totalCommitted).toBe(2);
        expect(stats.queueDepth).toBe(0);
    });

    it('flush is idempotent on empty queue', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await expect(pipeline.flush()).resolves.not.toThrow();
        await expect(pipeline.flush()).resolves.not.toThrow();
    });

    it('atoms are accessible via access() after flush', async () => {
        const pipeline = new IngestionPipeline(orchestrator, { batchSize: 100 });
        await pipeline.enqueue([atom('AccessMe')]);
        await pipeline.flush();
        const report = await orchestrator.access(atom('AccessMe'));
        expect(report.currentData).toBe(atom('AccessMe'));
        expect(report.currentProof).toBeDefined();
    });
});
