import { createServer, Server } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { IngestDriverStats } from './ingest_driver';
import { RecallBenchStats, ProofTypeStats } from './recall_bench';

export interface AgentSimStats {
    durationMs: number;
    totalOps: number;
    reads: number;
    writes: number;
    commits: number;
    accessLatenciesMs: number[];
    commitLatenciesMs: number[];
    staleReads?: number;
    versionMismatches?: number;
    batchReads?: number;
    avgBatchSize?: number;
    policyFilteredPredictions?: number;
}

export interface BenchmarkScalingPoint {
    x: number;
    p50: number;
    p95: number;
    p99: number;
}

export interface BenchmarkReport {
    generatedAt: string;
    runId: string;
    throughput: {
        totalOpsPerSec: number;
        readsPerSec: number;
        writesPerSec: number;
        commitsPerSec: number;
        totalOps: number;
        reads: number;
        writes: number;
        commits: number;
    };
    latency: {
        accessP50Ms: number;
        accessP95Ms: number;
        accessP99Ms: number;
        contextLoadP50Ms: number;
        contextLoadP95Ms: number;
        contextLoadP99Ms: number;
        commitP50Ms: number;
        commitP95Ms: number;
        commitP99Ms: number;
        proofVerifyAvgMs: number;
        proofVerifyP50Ms: number;
        proofVerifyP95Ms: number;
        proofVerifyP99Ms: number;
        proofVerifyCv: number;
    };
    prediction: {
        hitRate: number;
        attempts: number;
        hits: number;
        avgLatencySavedMs: number;
        missPenaltyMs: number;
    };
    correctness: {
        proofFailures: number;
        staleReads: number;
        versionMismatches: number;
    };
    scaling: {
        latencyVsAtomCount: BenchmarkScalingPoint[];
        latencyVsWritePressure: BenchmarkScalingPoint[];
    };
    detail: {
        ingestion?: IngestDriverStats;
        recall: RecallBenchStats;
        agentSim?: AgentSimStats;
    };
}

export interface BuildReportInput {
    runId?: string;
    ingestion?: IngestDriverStats;
    recall: RecallBenchStats;
    agentSim?: AgentSimStats;
    scaling?: {
        latencyVsAtomCount?: BenchmarkScalingPoint[];
        latencyVsWritePressure?: BenchmarkScalingPoint[];
    };
}

export interface LatencySloProfile {
    accessP95MaxMs: number;
    contextLoadP95MaxMs: number;
}

export interface LatencySloEvaluation {
    pass: boolean;
    accessP95Ms: number;
    accessP95MaxMs: number;
    contextLoadP95Ms: number;
    contextLoadP95MaxMs: number;
    failures: string[];
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

function flattenPatternLatencies(recall: RecallBenchStats): number[] {
    return [
        ...recall.patterns.sequential.latenciesMs,
        ...recall.patterns.random.latenciesMs,
        ...recall.patterns.predicted.latenciesMs,
        ...recall.patterns.hotspot.latenciesMs,
        ...recall.patterns.cross_shard.latenciesMs,
    ];
}

function computeDurationsMs(input: BuildReportInput): number {
    const durations = [input.recall.durationMs];
    if (input.ingestion) durations.push(input.ingestion.durationMs);
    if (input.agentSim) durations.push(input.agentSim.durationMs);
    return Math.max(...durations, 1);
}

function toRunId(nowIso: string): string {
    return nowIso.replace(/[.:]/g, '-');
}

export function buildBenchmarkReport(input: BuildReportInput): BenchmarkReport {
    const generatedAt = new Date().toISOString();
    const runId = input.runId ?? toRunId(generatedAt);
    const wallMs = computeDurationsMs(input);
    const wallSec = wallMs / 1000;

    const readCount = input.agentSim
        ? input.agentSim.reads
        : Object.values(input.recall.patterns).reduce((sum, pattern) => sum + pattern.requests, 0);

    const writeCount = input.agentSim
        ? input.agentSim.writes
        : (input.ingestion?.atomsQueued ?? 0) + (input.ingestion?.trainCalls ?? 0);

    const commitCount = input.agentSim
        ? input.agentSim.commits
        : (input.ingestion && input.ingestion.atomsCommitted > 0 ? 1 : 0);

    const totalOps = input.agentSim ? input.agentSim.totalOps : readCount + writeCount;

    const accessLatencies = input.agentSim?.accessLatenciesMs ?? flattenPatternLatencies(input.recall);
    const commitLatencies = input.agentSim?.commitLatenciesMs ?? (input.ingestion?.ingestionLatenciesMs ?? []);

    const missPenaltyMs = Math.max(0, -input.recall.avgLatencySavedByPredictionMs);

    return {
        generatedAt,
        runId,
        throughput: {
            totalOpsPerSec: totalOps / wallSec,
            readsPerSec: readCount / wallSec,
            writesPerSec: writeCount / wallSec,
            commitsPerSec: commitCount / wallSec,
            totalOps,
            reads: readCount,
            writes: writeCount,
            commits: commitCount,
        },
        latency: {
            accessP50Ms: percentile(accessLatencies, 50),
            accessP95Ms: percentile(accessLatencies, 95),
            accessP99Ms: percentile(accessLatencies, 99),
            contextLoadP50Ms: input.recall.contextLoad.p50,
            contextLoadP95Ms: input.recall.contextLoad.p95,
            contextLoadP99Ms: input.recall.contextLoad.p99,
            commitP50Ms: percentile(commitLatencies, 50),
            commitP95Ms: percentile(commitLatencies, 95),
            commitP99Ms: percentile(commitLatencies, 99),
            proofVerifyAvgMs: input.recall.proofVerification.avgVerifyMs,
            proofVerifyP50Ms: input.recall.proofVerification.p50VerifyMs,
            proofVerifyP95Ms: input.recall.proofVerification.p95VerifyMs,
            proofVerifyP99Ms: input.recall.proofVerification.p99VerifyMs,
            proofVerifyCv: input.recall.proofVerification.cvVerify,
        },
        prediction: {
            hitRate: input.recall.predictionHitRate,
            attempts: input.recall.predictionAttempts,
            hits: input.recall.predictionHits,
            avgLatencySavedMs: input.recall.avgLatencySavedByPredictionMs,
            missPenaltyMs,
        },
        correctness: {
            proofFailures: input.recall.proofVerification.failures,
            staleReads: input.agentSim?.staleReads ?? 0,
            versionMismatches: input.agentSim?.versionMismatches ?? 0,
        },
        scaling: {
            latencyVsAtomCount: input.scaling?.latencyVsAtomCount ?? [],
            latencyVsWritePressure: input.scaling?.latencyVsWritePressure ?? [],
        },
        detail: {
            ingestion: input.ingestion,
            recall: input.recall,
            agentSim: input.agentSim,
        },
    };
}

export function renderTerminalReport(report: BenchmarkReport): string {
    const percent = (v: number) => `${(v * 100).toFixed(2)}%`;
    const num = (v: number) => Number.isFinite(v) ? v.toFixed(2) : '0.00';

    return [
        `MMPM Sprint 7 Benchmark Report (run: ${report.runId})`,
        `Generated: ${report.generatedAt}`,
        '',
        'Throughput',
        `  ops/sec: ${num(report.throughput.totalOpsPerSec)} | reads/sec: ${num(report.throughput.readsPerSec)} | writes/sec: ${num(report.throughput.writesPerSec)} | commits/sec: ${num(report.throughput.commitsPerSec)}`,
        '',
        'Latency (ms)',
        `  access p50/p95/p99: ${num(report.latency.accessP50Ms)} / ${num(report.latency.accessP95Ms)} / ${num(report.latency.accessP99Ms)}`,
        `  context load p50/p95/p99: ${num(report.latency.contextLoadP50Ms)} / ${num(report.latency.contextLoadP95Ms)} / ${num(report.latency.contextLoadP99Ms)}`,
        `  commit p50/p95/p99: ${num(report.latency.commitP50Ms)} / ${num(report.latency.commitP95Ms)} / ${num(report.latency.commitP99Ms)}`,
        `  proof verify avg/p50/p95/p99: ${num(report.latency.proofVerifyAvgMs)} / ${num(report.latency.proofVerifyP50Ms)} / ${num(report.latency.proofVerifyP95Ms)} / ${num(report.latency.proofVerifyP99Ms)} ms  CV=${num(report.latency.proofVerifyCv)}`,
        (() => {
            const byType = report.detail.recall.proofVerification.byType;
            if (!byType) return '    [per-type breakdown unavailable]';
            const fmt = (label: string, s: ProofTypeStats) =>
                `    [${label}] n=${s.attempts} avg=${num(s.avgVerifyMs)} p95=${num(s.p95VerifyMs)} ms  CV=${num(s.cvVerify)}`;
            return [
                fmt('current  ', byType.current),
                fmt('predicted', byType.predicted),
                fmt('shardRoot', byType.shardRoot),
            ].join('\n');
        })(),
        '',
        'Prediction',
        `  hit rate: ${percent(report.prediction.hitRate)} | avg latency saved: ${num(report.prediction.avgLatencySavedMs)} ms | miss penalty: ${num(report.prediction.missPenaltyMs)} ms`,
        '',
        'Correctness',
        `  proof failures: ${report.correctness.proofFailures} | stale reads: ${report.correctness.staleReads} | version mismatches: ${report.correctness.versionMismatches}`,
    ].join('\n');
}

function formatValue(value: number): string {
    if (!Number.isFinite(value)) return '0';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6);
}

function sanitizeLabel(input: string): string {
    return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function toPrometheusMetrics(report: BenchmarkReport): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        const labelText = labels
            ? `{${Object.entries(labels).map(([k, v]) => `${k}="${sanitizeLabel(v)}"`).join(',')}}`
            : '';
        lines.push(`${name}${labelText} ${formatValue(value)}`);
    };

    const runLabels = { run_id: report.runId };
    gauge('mmpm_harness_throughput_ops_per_sec', 'Total operations per second', report.throughput.totalOpsPerSec, runLabels);
    gauge('mmpm_harness_throughput_reads_per_sec', 'Read operations per second', report.throughput.readsPerSec, runLabels);
    gauge('mmpm_harness_throughput_writes_per_sec', 'Write operations per second', report.throughput.writesPerSec, runLabels);
    gauge('mmpm_harness_throughput_commits_per_sec', 'Commit operations per second', report.throughput.commitsPerSec, runLabels);

    gauge('mmpm_harness_latency_access_p50_ms', 'Access latency p50 in milliseconds', report.latency.accessP50Ms, runLabels);
    gauge('mmpm_harness_latency_access_p95_ms', 'Access latency p95 in milliseconds', report.latency.accessP95Ms, runLabels);
    gauge('mmpm_harness_latency_access_p99_ms', 'Access latency p99 in milliseconds', report.latency.accessP99Ms, runLabels);
    gauge('mmpm_harness_latency_context_load_p95_ms', 'Context-load latency p95 in milliseconds', report.latency.contextLoadP95Ms, runLabels);
    gauge('mmpm_harness_latency_commit_p95_ms', 'Commit latency p95 in milliseconds', report.latency.commitP95Ms, runLabels);
    gauge('mmpm_harness_latency_proof_verify_avg_ms', 'Average proof verification time in milliseconds (per-proof)', report.latency.proofVerifyAvgMs, runLabels);
    gauge('mmpm_harness_latency_proof_verify_p50_ms', 'p50 proof verification time in milliseconds (per-proof)', report.latency.proofVerifyP50Ms, runLabels);
    gauge('mmpm_harness_latency_proof_verify_p95_ms', 'p95 proof verification time in milliseconds (per-proof)', report.latency.proofVerifyP95Ms, runLabels);
    gauge('mmpm_harness_latency_proof_verify_p99_ms', 'p99 proof verification time in milliseconds (per-proof)', report.latency.proofVerifyP99Ms, runLabels);
    gauge('mmpm_harness_latency_proof_verify_cv', 'Coefficient of variation for per-proof verify latency', report.latency.proofVerifyCv, runLabels);

    // F1: per-type breakdown — separates current/predicted (~9-hop) from shardRoot (~2-hop)
    const byType = report.detail.recall.proofVerification.byType;
    for (const [type, stats] of Object.entries(byType ?? {}) as [string, ProofTypeStats][]) {
        const typeLabel = { ...runLabels, proof_type: type };
        gauge('mmpm_harness_latency_proof_verify_avg_ms_by_type',  'Per-type average proof verification time ms',  stats.avgVerifyMs,  typeLabel);
        gauge('mmpm_harness_latency_proof_verify_p95_ms_by_type',  'Per-type p95 proof verification time ms',      stats.p95VerifyMs,  typeLabel);
        gauge('mmpm_harness_latency_proof_verify_p99_ms_by_type',  'Per-type p99 proof verification time ms',      stats.p99VerifyMs,  typeLabel);
        gauge('mmpm_harness_latency_proof_verify_cv_by_type',      'Per-type CV for proof verification latency',   stats.cvVerify,     typeLabel);
        gauge('mmpm_harness_proof_verify_attempts_by_type',        'Per-type proof verification attempt count',    stats.attempts,     typeLabel);
        gauge('mmpm_harness_proof_verify_failures_by_type',        'Per-type proof verification failure count',    stats.failures,     typeLabel);
    }

    gauge('mmpm_harness_prediction_hit_rate_ratio', 'Prediction hit rate ratio', report.prediction.hitRate, runLabels);
    gauge('mmpm_harness_prediction_avg_latency_saved_ms', 'Average latency saved from prediction in milliseconds', report.prediction.avgLatencySavedMs, runLabels);
    gauge('mmpm_harness_prediction_miss_penalty_ms', 'Penalty from incorrect prediction in milliseconds', report.prediction.missPenaltyMs, runLabels);

    gauge('mmpm_harness_correctness_proof_failures_total', 'Total proof verification failures', report.correctness.proofFailures, runLabels);
    gauge('mmpm_harness_correctness_stale_reads_total', 'Total stale reads', report.correctness.staleReads, runLabels);
    gauge('mmpm_harness_correctness_version_mismatches_total', 'Total snapshot version mismatches', report.correctness.versionMismatches, runLabels);

    for (const [pattern, metrics] of Object.entries(report.detail.recall.patterns)) {
        gauge(
            'mmpm_harness_pattern_latency_p95_ms',
            'Pattern p95 latency in milliseconds',
            metrics.p95,
            { ...runLabels, pattern }
        );
    }

    if (report.detail.ingestion) {
        gauge('mmpm_harness_backpressure_events_total', 'Backpressure events during ingestion', report.detail.ingestion.backpressureEvents, runLabels);
        gauge('mmpm_harness_atoms_queued_total', 'Atoms queued during ingestion', report.detail.ingestion.atomsQueued, runLabels);
        gauge('mmpm_harness_atoms_committed_total', 'Atoms committed during ingestion', report.detail.ingestion.atomsCommitted, runLabels);
    }

    return `${lines.join('\n')}\n`;
}

export interface ExporterOptions {
    port?: number;
    reportFile?: string;
    report?: BenchmarkReport;
}

async function loadReportFromFile(filePath: string): Promise<BenchmarkReport> {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as BenchmarkReport;
}

export async function startHarnessMetricsExporter(options: ExporterOptions): Promise<Server> {
    const port = options.port ?? 9466;

    const loadReport = async (): Promise<BenchmarkReport> => {
        if (options.report) return options.report;
        if (!options.reportFile) {
            throw new Error('reportFile is required when report is not supplied');
        }
        return loadReportFromFile(options.reportFile);
    };

    const server = createServer(async (req, res) => {
        try {
            if (req.url === '/health') {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (req.url !== '/metrics') {
                res.statusCode = 404;
                res.end('not found');
                return;
            }

            const report = await loadReport();
            const body = toPrometheusMetrics(report);
            res.statusCode = 200;
            res.setHeader('content-type', 'text/plain; version=0.0.4');
            res.end(body);
        } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: err?.message ?? 'exporter_failed' }));
        }
    });

    await new Promise<void>((resolvePromise) => {
        server.listen(port, () => resolvePromise());
    });

    return server;
}

export function evaluateLatencySlo(report: BenchmarkReport, profile: LatencySloProfile): LatencySloEvaluation {
    const failures: string[] = [];
    if (report.latency.accessP95Ms > profile.accessP95MaxMs) {
        failures.push(`accessP95Ms ${report.latency.accessP95Ms.toFixed(3)} exceeds ${profile.accessP95MaxMs.toFixed(3)}`);
    }
    if (report.latency.contextLoadP95Ms > profile.contextLoadP95MaxMs) {
        failures.push(`contextLoadP95Ms ${report.latency.contextLoadP95Ms.toFixed(3)} exceeds ${profile.contextLoadP95MaxMs.toFixed(3)}`);
    }

    return {
        pass: failures.length === 0,
        accessP95Ms: report.latency.accessP95Ms,
        accessP95MaxMs: profile.accessP95MaxMs,
        contextLoadP95Ms: report.latency.contextLoadP95Ms,
        contextLoadP95MaxMs: profile.contextLoadP95MaxMs,
        failures,
    };
}

function argValue(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

function hasFlag(argv: string[], key: string): boolean {
    return argv.includes(`--${key}`);
}

async function writeTextFile(path: string, content: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
}

async function runCli() {
    const argv = process.argv.slice(2);

    const ingestFile = argValue(argv, 'ingest-file');
    const recallFile = argValue(argv, 'recall-file');
    const reportFile = argValue(argv, 'report-file');
    const outFile = argValue(argv, 'out');
    const promOutFile = argValue(argv, 'prom-out');
    const runId = argValue(argv, 'run-id') ?? undefined;
    const serve = hasFlag(argv, 'serve');
    const print = hasFlag(argv, 'print');
    const port = Number(argValue(argv, 'port') ?? '9466');

    let report: BenchmarkReport | null = null;

    if (ingestFile || recallFile) {
        if (!recallFile) {
            throw new Error('--recall-file is required when building a report');
        }
        const recall = JSON.parse(await readFile(resolve(recallFile), 'utf8')) as RecallBenchStats;
        const ingestion = ingestFile
            ? (JSON.parse(await readFile(resolve(ingestFile), 'utf8')) as IngestDriverStats)
            : undefined;

        report = buildBenchmarkReport({
            runId,
            ingestion,
            recall,
        });
    } else if (reportFile) {
        report = await loadReportFromFile(resolve(reportFile));
    }

    if (report && outFile) {
        await writeTextFile(resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
    }

    if (report && promOutFile) {
        await writeTextFile(resolve(promOutFile), toPrometheusMetrics(report));
    }

    if (report && print) {
        console.log(renderTerminalReport(report));
    }

    if (!serve) {
        if (!report && !reportFile) {
            console.log('No report generated. Provide --recall-file (and optional --ingest-file) or --report-file.');
        }
        return;
    }

    const liveReportFile = outFile ?? reportFile;
    const server = await startHarnessMetricsExporter({
        port,
        report: liveReportFile ? undefined : report ?? undefined,
        reportFile: liveReportFile ? resolve(liveReportFile) : undefined,
    });

    console.log(`Harness metrics exporter listening on :${port}`);

    const stop = async () => {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
        process.exit(0);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
