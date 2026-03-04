import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShardedOrchestrator } from '../orchestrator';
import { buildApp } from '../server';
import { generateStructuredDataset } from '../../tools/harness/generator';
import { runIngestionDriver } from '../../tools/harness/ingest_driver';
const atom = (value: string) => `v1.other.${value}`;
const API_KEY = 'test-ingest-driver-key';

const dirs: string[] = [];

function tempDb(label: string) {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-ingest-driver-${label}-`));
    dirs.push(dir);
    return dir;
}

afterAll(() => {
    while (dirs.length) {
        const dir = dirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Harness ingestion driver (Story 9.2)', () => {
    it('runs embedded bulk mode and commits all generated atoms', async () => {
        const dataset = generateStructuredDataset({
            totalAtoms: 1200,
            avgChainLength: 8,
            branchFactor: 0.1,
            vocabularySize: 1500,
            seed: 101,
        });

        const orchestrator = new ShardedOrchestrator(4, [atom('Seed_A'), atom('Seed_B')], tempDb('bulk'));
        await orchestrator.init();
        try {
            const stats = await runIngestionDriver(dataset, {
                mode: 'bulk',
                useApi: false,
                orchestrator,
                chunkSize: 250,
                maxAccessProbes: 5,
            });

            expect(stats.atomsQueued).toBe(dataset.atoms.length);
            expect(stats.atomsCommitted).toBe(dataset.atoms.length);
            expect(stats.trainCalls).toBe(dataset.sequences.length);
            expect(stats.accessProbes).toBe(5);
        } finally {
            await orchestrator.close();
        }
    }, 60_000);

    it('runs embedded streaming mode and records ingestion latency samples', async () => {
        const dataset = generateStructuredDataset({
            totalAtoms: 1500,
            avgChainLength: 10,
            branchFactor: 0.2,
            vocabularySize: 1200,
            seed: 202,
        });

        const orchestrator = new ShardedOrchestrator(4, [atom('Seed_X'), atom('Seed_Y')], tempDb('stream'));
        await orchestrator.init();
        try {
            const stats = await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: false,
                orchestrator,
                chunkSize: 200,
                atomsPerSecond: 5000,
                maxAccessProbes: 0,
            });

            expect(stats.atomsQueued).toBe(dataset.atoms.length);
            expect(stats.atomsCommitted).toBe(dataset.atoms.length);
            expect(stats.ingestionLatenciesMs.length).toBeGreaterThan(0);
        } finally {
            await orchestrator.close();
        }
    }, 60_000);

    it('runs API streaming mode against live server routes', async () => {
        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';
        const dataset = generateStructuredDataset({
            totalAtoms: 900,
            avgChainLength: 7,
            branchFactor: 0.15,
            vocabularySize: 900,
            seed: 909,
        });

        const port = 3411;
        const dbPath = tempDb('api-stream');
        const app = buildApp({ data: [atom('Boot_A'), atom('Boot_B')], dbBasePath: dbPath, numShards: 4, apiKey: API_KEY });
        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port, host: '127.0.0.1' });

        try {
            const stats = await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                chunkSize: 120,
                atomsPerSecond: 5000,
                maxAccessProbes: 5,
            });

            expect(stats.atomsQueued).toBe(dataset.atoms.length);
            expect(stats.atomsCommitted).toBe(dataset.atoms.length);
            expect(stats.trainCalls).toBe(dataset.sequences.length);
            expect(stats.accessProbes).toBe(5);
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = prevLogLevel;
        }
    }, 120_000);

    it('waits for /ready before API ingestion when server listens before init', async () => {
        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';
        const dataset = generateStructuredDataset({
            totalAtoms: 240,
            avgChainLength: 6,
            branchFactor: 0.1,
            vocabularySize: 300,
            seed: 1001,
        });

        const port = 3413;
        const dbPath = tempDb('api-delayed-ready');
        const app = buildApp({ data: [atom('Boot_X'), atom('Boot_Y')], dbBasePath: dbPath, numShards: 4, apiKey: API_KEY });
        await app.server.listen({ port, host: '127.0.0.1' });

        const delayedInit = setTimeout(async () => {
            await app.orchestrator.init();
            app.pipeline.start();
        }, 300);

        try {
            const stats = await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                chunkSize: 80,
                atomsPerSecond: 4000,
                maxAccessProbes: 0,
            });

            expect(stats.atomsQueued).toBe(dataset.atoms.length);
            expect(stats.atomsCommitted).toBe(dataset.atoms.length);
        } finally {
            clearTimeout(delayedInit);
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = prevLogLevel;
        }
    }, 120_000);
});
