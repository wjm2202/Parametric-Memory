import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ShardedOrchestrator } from '../orchestrator';
import { buildApp } from '../server';
import { generateStructuredDataset } from '../../tools/harness/generator';
import { runIngestionDriver } from '../../tools/harness/ingest_driver';
import { runRecallBenchmark } from '../../tools/harness/recall_bench';
const atom = (value: string) => `v1.other.${value}`;
const API_KEY = 'test-recall-bench-key';

const dirs: string[] = [];

function tempDb(label: string) {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-recall-bench-${label}-`));
    dirs.push(dir);
    return dir;
}

afterAll(() => {
    while (dirs.length) {
        const dir = dirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Harness recall benchmark engine (Story 9.3)', () => {
    it('produces latency/profile stats across all benchmark patterns', async () => {
        const dataset = generateStructuredDataset({
            totalAtoms: 1200,
            avgChainLength: 8,
            branchFactor: 0.15,
            vocabularySize: 1200,
            seed: 303,
        });

        const orchestrator = new ShardedOrchestrator(4, [atom('Seed_A'), atom('Seed_B')], tempDb('profile'));
        await orchestrator.init();

        try {
            await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: false,
                orchestrator,
                chunkSize: 200,
                atomsPerSecond: 6000,
                maxAccessProbes: 0,
            });

            const stats = await runRecallBenchmark(dataset, {
                useApi: false,
                orchestrator,
                sequentialHops: 80,
                randomSamples: 80,
                predictedSamples: 60,
                hotspotSetSize: 8,
                hotspotRepeats: 15,
                crossShardSamples: 40,
            });

            expect(stats.durationMs).toBeGreaterThan(0);
            expect(stats.patterns.sequential.requests).toBeGreaterThan(0);
            expect(stats.patterns.random.requests).toBeGreaterThan(0);
            expect(stats.patterns.predicted.requests).toBeGreaterThan(0);
            expect(stats.patterns.hotspot.requests).toBeGreaterThan(0);
            expect(stats.patterns.cross_shard.requests).toBeGreaterThan(0);
            expect(stats.contextLoad.requests).toBe(0);

            expect(stats.proofVerification.attempts).toBeGreaterThan(0);
            expect(stats.proofVerification.failures).toBe(0);

            expect(stats.predictionAttempts).toBeGreaterThan(0);
            expect(stats.predictionHitRate).toBeGreaterThanOrEqual(0);
            expect(stats.predictionHitRate).toBeLessThanOrEqual(1);

            expect(Object.keys(stats.patterns.random.histogram).length).toBeGreaterThan(5);
        } finally {
            await orchestrator.close();
        }
    }, 120_000);

    it('produces recall metrics in API mode against server endpoints', async () => {
        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'silent';
        const dataset = generateStructuredDataset({
            totalAtoms: 900,
            avgChainLength: 8,
            branchFactor: 0.12,
            vocabularySize: 1000,
            seed: 404,
        });

        const port = 3412;
        const app = buildApp({ data: [atom('Seed_API_A'), atom('Seed_API_B')], dbBasePath: tempDb('api-recall'), numShards: 4, apiKey: API_KEY });
        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port, host: '127.0.0.1' });

        try {
            await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                chunkSize: 120,
                atomsPerSecond: 6000,
                maxAccessProbes: 0,
            });

            const stats = await runRecallBenchmark(dataset, {
                useApi: true,
                baseUrl: `http://127.0.0.1:${port}`,
                apiKey: API_KEY,
                sequentialHops: 50,
                randomSamples: 50,
                predictedSamples: 40,
                hotspotSetSize: 6,
                hotspotRepeats: 10,
                crossShardSamples: 25,
            });

            expect(stats.patterns.sequential.requests).toBeGreaterThan(0);
            expect(stats.patterns.random.requests).toBeGreaterThan(0);
            expect(stats.contextLoad.requests).toBeGreaterThan(0);
            expect(stats.proofVerification.attempts).toBeGreaterThan(0);
            expect(stats.proofVerification.failures).toBe(0);
            expect(stats.predictionAttempts).toBeGreaterThan(0);
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            if (prevLogLevel === undefined) delete process.env.LOG_LEVEL;
            else process.env.LOG_LEVEL = prevLogLevel;
        }
    }, 120_000);
});
