import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShardedOrchestrator } from '../orchestrator';
import { buildApp } from '../server';
import { runIngestionDriver } from '../../tools/harness/ingest_driver';
import { generateStructuredDataset } from '../../tools/harness/generator';
import { runAgentSimulation } from '../../tools/harness/agent_sim';

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

        const orchestrator = new ShardedOrchestrator(4, ['Seed_A', 'Seed_B'], tempDb('embedded'));
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
            expect(stats.errors).toBe(0);
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
        const app = buildApp({ data: ['Seed_X', 'Seed_Y'], dbBasePath: tempDb('api'), numShards: 4 });
        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port, host: '127.0.0.1' });

        try {
            await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                chunkSize: 80,
                atomsPerSecond: 5000,
                maxAccessProbes: 0,
            });

            const stats = await runAgentSimulation({
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
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
