import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShardedOrchestrator } from '../orchestrator';
import { buildApp } from '../server';
import { runIngestionDriver } from '../../tools/harness/ingest_driver';
import { generateStructuredDataset } from '../../tools/harness/generator';
import { runAgentSimulation } from '../../tools/harness/agent_sim';
const atom = (value: string) => `v1.other.${value}`;
const API_KEY = 'test-agent-sim-key';

const dirs: string[] = [];

function tempDb(label: string) {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-agent-sim-${label}-`));
    dirs.push(dir);
    return dir;
}

afterAll(() => {
    while (dirs.length) {
        const dir = dirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Harness agent simulator (Story 9.4)', () => {
    it('runs in embedded mode with concurrent agents and emits operations', async () => {
        const dataset = generateStructuredDataset({
            totalAtoms: 300,
            avgChainLength: 7,
            branchFactor: 0.12,
            vocabularySize: 240,
            seed: 777,
        });

        const orchestrator = new ShardedOrchestrator(4, [atom('Seed_A'), atom('Seed_B')], tempDb('embedded'));
        await orchestrator.init();
        try {
            await runIngestionDriver(dataset, {
                mode: 'bulk',
                useApi: false,
                orchestrator,
                chunkSize: 80,
                maxAccessProbes: 0,
            });

            const stats = await runAgentSimulation({
                useApi: false,
                orchestrator,
                agents: 6,
                durationMs: 1000,
                readRatio: 0.7,
                writeRatio: 0.1,
                trainRatio: 0.2,
                thinkTimeMs: 2,
                initialAtoms: dataset.atoms.slice(0, 80),
                seed: 123,
            });

            expect(stats.totalOps).toBeGreaterThan(0);
            expect(stats.reads).toBeGreaterThan(0);
            expect(stats.perAgentOps.length).toBe(6);
            expect(stats.errors).toBeLessThanOrEqual(Math.max(5, Math.floor(stats.totalOps * 0.2)));
        } finally {
            await orchestrator.close();
        }
    }, 60_000);

    it('runs in API mode and respects readiness before issuing load', async () => {
        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';

        const dataset = generateStructuredDataset({
            totalAtoms: 260,
            avgChainLength: 7,
            branchFactor: 0.15,
            vocabularySize: 220,
            seed: 888,
        });

        const port = 3414;
        const app = buildApp({ data: [atom('Seed_X'), atom('Seed_Y')], dbBasePath: tempDb('api'), numShards: 4, apiKey: API_KEY });
        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port, host: '127.0.0.1' });

        try {
            await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                chunkSize: 80,
                atomsPerSecond: 5000,
                maxAccessProbes: 0,
            });

            const stats = await runAgentSimulation({
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                agents: 5,
                durationMs: 900,
                readRatio: 0.7,
                writeRatio: 0.1,
                trainRatio: 0.2,
                thinkTimeMs: 2,
                initialAtoms: dataset.atoms.slice(0, 80),
                seed: 321,
            });

            expect(stats.totalOps).toBeGreaterThan(0);
            expect(stats.reads).toBeGreaterThan(0);
            expect(stats.perAgentOps.length).toBe(5);
            expect(stats.errors).toBeLessThanOrEqual(Math.max(5, Math.floor(stats.totalOps * 0.15)));
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = prevLogLevel;
        }
    }, 120_000);
});

describe('Harness agent simulator — batch access + policy (Story 12.4)', () => {
    it('batch access mode produces similar prediction-hit proxy as sequential mode', async () => {
        const orchestrator = new ShardedOrchestrator(4, [atom('Seed_A'), atom('Seed_B'), atom('Seed_C')], tempDb('batch-parity'));
        await orchestrator.init();
        try {
            const baseOptions = {
                useApi: false as const,
                orchestrator,
                agents: 4,
                durationMs: 900,
                readRatio: 1,
                writeRatio: 0,
                trainRatio: 0,
                thinkTimeMs: 1,
                initialAtoms: [atom('Seed_A'), atom('Seed_B'), atom('Seed_C'), atom('Seed_D'), atom('Seed_E')],
                seed: 99,
            };

            const sequential = await runAgentSimulation({
                ...baseOptions,
                useBatchAccess: false,
            });

            const batch = await runAgentSimulation({
                ...baseOptions,
                useBatchAccess: true,
                batchGroupMin: 3,
                batchGroupMax: 5,
            });

            const seqProxy = sequential.reads > 0 ? sequential.predictionAttempts / sequential.reads : 0;
            const batchProxy = batch.reads > 0 ? batch.predictionAttempts / batch.reads : 0;

            expect(batch.batchReads).toBeGreaterThan(0);
            expect(Math.abs(batchProxy - seqProxy)).toBeLessThanOrEqual(0.05);
        } finally {
            await orchestrator.close();
        }
    }, 60_000);

    it('policy-constrained simulation tracks policyFilteredPredictions stat', async () => {
        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';

        const port = 3415;
        const app = buildApp({
            data: ['v1.fact.A', 'v1.event.B', 'v1.event.C', 'v1.other.Z'],
            dbBasePath: tempDb('policy-filter-api'),
            numShards: 2,
            apiKey: API_KEY,
        });
        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port, host: '127.0.0.1' });

        try {
            await app.server.inject({ method: 'POST', url: '/train', headers: { authorization: `Bearer ${API_KEY}` }, payload: { sequence: ['v1.fact.A', 'v1.event.B'] } });
            await app.server.inject({ method: 'POST', url: '/train', headers: { authorization: `Bearer ${API_KEY}` }, payload: { sequence: ['v1.fact.A', 'v1.event.C'] } });

            const stats = await runAgentSimulation({
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                agents: 4,
                durationMs: 1000,
                readRatio: 1,
                writeRatio: 0,
                trainRatio: 0,
                thinkTimeMs: 1,
                useBatchAccess: true,
                initialAtoms: ['v1.fact.A', 'v1.event.B', 'v1.event.C'],
                policy: { fact: ['state'] },
                seed: 1234,
            });

            expect(stats.batchReads).toBeGreaterThan(0);
            expect(stats.policyFilteredPredictions).toBeGreaterThanOrEqual(1);
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = prevLogLevel;
        }
    }, 120_000);

    it('batchAccess avgBatchSize reflects configured batch group size', async () => {
        const orchestrator = new ShardedOrchestrator(2, [atom('S1'), atom('S2'), atom('S3'), atom('S4'), atom('S5')], tempDb('batch-size'));
        await orchestrator.init();
        try {
            const stats = await runAgentSimulation({
                useApi: false,
                orchestrator,
                agents: 3,
                durationMs: 900,
                readRatio: 1,
                writeRatio: 0,
                trainRatio: 0,
                thinkTimeMs: 1,
                useBatchAccess: true,
                batchGroupMin: 4,
                batchGroupMax: 4,
                initialAtoms: [atom('S1'), atom('S2'), atom('S3'), atom('S4'), atom('S5')],
                seed: 5678,
            });

            expect(stats.batchReads).toBeGreaterThan(0);
            expect(stats.avgBatchSize).toBe(4);
        } finally {
            await orchestrator.close();
        }
    }, 60_000);
});
