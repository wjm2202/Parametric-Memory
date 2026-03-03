import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildApp } from '../server';
import { buildScientificDataset, runContinuousClient } from '../../tools/harness/continuous_client';

const dbDirs: string[] = [];

function tempDb(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `mmpm-continuous-${label}-`));
    dbDirs.push(dir);
    return dir;
}

function bootAtom(value: string): string {
    return `v1.other.${value}`;
}

afterAll(() => {
    while (dbDirs.length > 0) {
        const dir = dbDirs.pop();
        if (!dir) continue;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Continuous client harness', () => {
    it('sends ongoing traffic, ingests writes, and verifies retrieval usefulness', async () => {
        const app = buildApp({
            data: [bootAtom('seed_a'), bootAtom('seed_b'), bootAtom('seed_c')],
            dbBasePath: tempDb('traffic'),
            numShards: 4,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        try {
            const address = app.server.server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Failed to determine Fastify listening port');
            }

            const dataset = buildScientificDataset({
                flows: 22,
                strongRepeats: 12,
                weakRepeats: 2,
            });

            const stats = await runContinuousClient({
                baseUrl: `http://127.0.0.1:${address.port}`,
                profile: 'balanced',
                durationMs: 1800,
                targetOpsPerSec: 45,
                concurrency: 4,
                commitEveryWrites: 4,
                dataset,
                seed: 20260303,
                metricsPort: 0,
            });

            expect(stats.totalOps).toBeGreaterThan(30);
            expect(stats.writesQueued).toBeGreaterThan(0);
            expect(stats.commits).toBeGreaterThan(0);
            expect(stats.ingestionVerifiedReads).toBeGreaterThan(0);
            expect(stats.reads).toBeGreaterThan(0);
            expect(stats.predictionAttempts).toBeGreaterThan(20);
            expect(stats.predictionAccuracy).toBeGreaterThanOrEqual(0.65);
            expect(stats.accuracyProbe.attempts).toBeGreaterThan(40);
            expect(stats.accuracyProbe.accuracy).toBeGreaterThanOrEqual(0.75);
            expect(stats.errors).toBeLessThanOrEqual(Math.max(3, Math.floor(stats.totalOps * 0.1)));
            expect(stats.metricsEnabled).toBe(true);
            expect(stats.metricsEndpoint).toContain('http://127.0.0.1:');
            expect(stats.metricsSnapshot).toContain('mmpm_continuous_client_offered_ops_total');
            expect(stats.metricsSnapshot).toContain('mmpm_continuous_client_prediction_accuracy_ratio');
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 120_000);

    it('policy-stress profile changes policy while keeping retrieval accuracy measurable', async () => {
        const app = buildApp({
            data: [bootAtom('seed_x'), bootAtom('seed_y'), bootAtom('seed_z')],
            dbBasePath: tempDb('policy'),
            numShards: 4,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        try {
            const address = app.server.server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Failed to determine Fastify listening port');
            }

            const stats = await runContinuousClient({
                baseUrl: `http://127.0.0.1:${address.port}`,
                profile: 'policy-stress',
                durationMs: 1700,
                targetOpsPerSec: 40,
                concurrency: 4,
                commitEveryWrites: 4,
                datasetFlows: 18,
                strongRepeats: 10,
                weakRepeats: 2,
                seed: 20260304,
            });

            expect(stats.policyChanges).toBeGreaterThan(0);
            expect(stats.predictionAttempts).toBeGreaterThan(15);
            expect(stats.accuracyProbe.attempts).toBeGreaterThan(30);
            expect(stats.accuracyProbe.usefulRate).toBeGreaterThan(0.4);
            expect(stats.accuracyProbe.accuracy).toBeGreaterThanOrEqual(0.5);
            expect(stats.errors).toBeLessThanOrEqual(Math.max(4, Math.floor(stats.totalOps * 0.12)));
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 120_000);
});
