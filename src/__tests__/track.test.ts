import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import {
    compareReports,
    renderCompareSummary,
    saveReportSnapshot,
} from '../../tools/harness/track';
import { BenchmarkReport } from '../../tools/harness/report';

const cleanupDirs: string[] = [];

afterEach(async () => {
    while (cleanupDirs.length) {
        const dir = cleanupDirs.pop()!;
        await rm(dir, { recursive: true, force: true });
    }
});

function baseReport(): BenchmarkReport {
    return {
        generatedAt: new Date().toISOString(),
        runId: 'run-base',
        throughput: {
            totalOpsPerSec: 1000,
            readsPerSec: 700,
            writesPerSec: 300,
            commitsPerSec: 10,
            totalOps: 10000,
            reads: 7000,
            writes: 3000,
            commits: 100,
        },
        latency: {
            accessP50Ms: 0.2,
            accessP95Ms: 1.0,
            accessP99Ms: 2.0,
            commitP50Ms: 5.0,
            commitP95Ms: 10.0,
            commitP99Ms: 20.0,
            proofVerifyAvgMs: 0.05,
        },
        prediction: {
            hitRate: 0.9,
            attempts: 1000,
            hits: 900,
            avgLatencySavedMs: 0.2,
            missPenaltyMs: 0.1,
        },
        correctness: {
            proofFailures: 0,
            staleReads: 0,
            versionMismatches: 0,
        },
        scaling: {
            latencyVsAtomCount: [],
            latencyVsWritePressure: [],
        },
        detail: {
            recall: {
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: 1000,
                patterns: {
                    sequential: { requests: 1, latenciesMs: [1], p50: 1, p95: 1, p99: 1, max: 1, histogram: {} },
                    random: { requests: 1, latenciesMs: [1], p50: 1, p95: 1, p99: 1, max: 1, histogram: {} },
                    predicted: { requests: 1, latenciesMs: [1], p50: 1, p95: 1, p99: 1, max: 1, histogram: {} },
                    hotspot: { requests: 1, latenciesMs: [1], p50: 1, p95: 1, p99: 1, max: 1, histogram: {} },
                    cross_shard: { requests: 1, latenciesMs: [1], p50: 1, p95: 1, p99: 1, max: 1, histogram: {} },
                },
                predictionHitRate: 0.9,
                predictionAttempts: 10,
                predictionHits: 9,
                avgLatencySavedByPredictionMs: 0.2,
                proofVerification: {
                    attempts: 10,
                    failures: 0,
                    avgVerifyMs: 0.05,
                    latenciesMs: [0.05],
                },
            },
        },
    };
}

describe('Harness regression tracker (Story 9.7)', () => {
    it('detects throughput and latency regressions over threshold', () => {
        const baseline = baseReport();
        const current = {
            ...baseReport(),
            runId: 'run-current',
            throughput: {
                ...baseReport().throughput,
                totalOpsPerSec: 820,
                readsPerSec: 560,
            },
            latency: {
                ...baseReport().latency,
                accessP95Ms: 1.25,
                commitP95Ms: 13.0,
            },
        };

        const result = compareReports(baseline, current, 'base.json', 'current.json', 0.1);
        const keys = new Set(result.regressions.map(r => r.key));

        expect(result.regressions.length).toBeGreaterThan(0);
        expect(keys.has('throughput.totalOpsPerSec')).toBe(true);
        expect(keys.has('latency.accessP95Ms')).toBe(true);

        const summary = renderCompareSummary(result);
        expect(summary).toContain('Result: FAIL');
        expect(summary).toContain('REGRESSION');
    });

    it('passes compare when metrics stay within threshold', () => {
        const baseline = baseReport();
        const current = {
            ...baseReport(),
            runId: 'run-current-2',
            throughput: {
                ...baseReport().throughput,
                totalOpsPerSec: 960,
                readsPerSec: 680,
            },
            latency: {
                ...baseReport().latency,
                accessP95Ms: 1.08,
                commitP95Ms: 10.7,
            },
        };

        const result = compareReports(baseline, current, 'base.json', 'current.json', 0.1);
        expect(result.regressions.length).toBe(0);
        expect(renderCompareSummary(result)).toContain('Result: PASS');
    });

    it('saves snapshot file under results dir with optional tag', async () => {
        const tempDir = await mkdtemp(join(os.tmpdir(), 'mmpm-track-test-'));
        cleanupDirs.push(tempDir);
        const reportPath = join(tempDir, 'latest.json');
        const resultsDir = join(tempDir, 'results');
        await writeFile(reportPath, `${JSON.stringify(baseReport(), null, 2)}\n`, 'utf8');

        const outPath = await saveReportSnapshot(reportPath, resultsDir, 'pr-42');
        expect(outPath).toContain('run-base-pr-42.json');

        const raw = await readFile(outPath, 'utf8');
        const parsed = JSON.parse(raw) as BenchmarkReport;
        expect(parsed.runId).toBe('run-base');
    });
});
