import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildBenchmarkReport,
    renderTerminalReport,
    startHarnessMetricsExporter,
    toPrometheusMetrics,
} from '../../tools/harness/report';
import { IngestDriverStats } from '../../tools/harness/ingest_driver';
import { RecallBenchStats } from '../../tools/harness/recall_bench';
import type { AddressInfo } from 'net';

const cleanupPaths: string[] = [];

afterEach(async () => {
    while (cleanupPaths.length) {
        const target = cleanupPaths.pop()!;
        await rm(target, { recursive: true, force: true });
    }
});

function makeIngestStats(): IngestDriverStats {
    return {
        mode: 'streaming',
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(10_000).toISOString(),
        durationMs: 10_000,
        atomsQueued: 1000,
        atomsCommitted: 1000,
        trainCalls: 100,
        ingestionLatenciesMs: [1, 2, 3, 4, 5],
        backpressureEvents: 2,
        accessProbes: 20,
    };
}

function makeRecallStats(): RecallBenchStats {
    return {
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(12_000).toISOString(),
        durationMs: 12_000,
        patterns: {
            sequential: { requests: 2, latenciesMs: [1, 2], p50: 1, p95: 2, p99: 2, max: 2, histogram: { '<=2ms': 2 } },
            random: { requests: 2, latenciesMs: [2, 3], p50: 2, p95: 3, p99: 3, max: 3, histogram: { '<=3ms': 2 } },
            predicted: { requests: 2, latenciesMs: [3, 4], p50: 3, p95: 4, p99: 4, max: 4, histogram: { '<=4ms': 2 } },
            hotspot: { requests: 2, latenciesMs: [4, 5], p50: 4, p95: 5, p99: 5, max: 5, histogram: { '<=5ms': 2 } },
            cross_shard: { requests: 2, latenciesMs: [5, 6], p50: 5, p95: 6, p99: 6, max: 6, histogram: { '<=6ms': 2 } },
        },
        predictionHitRate: 0.6,
        predictionAttempts: 10,
        predictionHits: 6,
        avgLatencySavedByPredictionMs: 1.5,
        proofVerification: {
            attempts: 20,
            failures: 0,
            avgVerifyMs: 0.3,
            latenciesMs: [0.2, 0.3, 0.4],
        },
    };
}

describe('Harness report generator (Story 9.5)', () => {
    it('builds an aggregate report with throughput and correctness fields', () => {
        const report = buildBenchmarkReport({
            runId: 'run-test',
            ingestion: makeIngestStats(),
            recall: makeRecallStats(),
        });

        expect(report.runId).toBe('run-test');
        expect(report.throughput.totalOpsPerSec).toBeGreaterThan(0);
        expect(report.latency.accessP95Ms).toBeGreaterThan(0);
        expect(report.prediction.hitRate).toBe(0.6);
        expect(report.correctness.proofFailures).toBe(0);

        const terminal = renderTerminalReport(report);
        expect(terminal).toContain('Throughput');
        expect(terminal).toContain('Prediction');
    });

    it('exports report metrics in Prometheus exposition format', () => {
        const report = buildBenchmarkReport({
            runId: 'run-prom',
            ingestion: makeIngestStats(),
            recall: makeRecallStats(),
        });

        const metrics = toPrometheusMetrics(report);
        expect(metrics).toContain('mmpm_harness_throughput_ops_per_sec');
        expect(metrics).toContain('mmpm_harness_prediction_hit_rate_ratio');
        expect(metrics).toContain('mmpm_harness_pattern_latency_p95_ms');
        expect(metrics).toContain('run_id="run-prom"');
    });

    it('serves /metrics from a report file via exporter HTTP endpoint', async () => {
        const report = buildBenchmarkReport({
            runId: 'run-http',
            ingestion: makeIngestStats(),
            recall: makeRecallStats(),
        });

        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mmpm-report-test-'));
        cleanupPaths.push(tempDir);
        const reportFile = path.join(tempDir, 'report.json');
        await writeFile(reportFile, JSON.stringify(report), 'utf8');

        const server = await startHarnessMetricsExporter({
            port: 0,
            reportFile,
        });

        try {
            const addr = server.address() as AddressInfo;
            const response = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
            const text = await response.text();
            expect(response.status).toBe(200);
            expect(text).toContain('mmpm_harness_correctness_proof_failures_total');
            expect(text).toContain('run_id="run-http"');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
