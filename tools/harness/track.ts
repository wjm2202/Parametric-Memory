import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { BenchmarkReport } from './report';

type Direction = 'higher-better' | 'lower-better';

export interface MetricDelta {
    key: string;
    direction: Direction;
    baseline: number;
    current: number;
    deltaRatio: number;
    regressed: boolean;
}

export interface CompareResult {
    baselineFile: string;
    currentFile: string;
    thresholdRatio: number;
    metrics: MetricDelta[];
    regressions: MetricDelta[];
}

interface MetricSpec {
    key: string;
    direction: Direction;
    read: (r: BenchmarkReport) => number;
}

const METRIC_SPECS: MetricSpec[] = [
    {
        key: 'throughput.totalOpsPerSec',
        direction: 'higher-better',
        read: r => r.throughput.totalOpsPerSec,
    },
    {
        key: 'throughput.readsPerSec',
        direction: 'higher-better',
        read: r => r.throughput.readsPerSec,
    },
    {
        key: 'latency.accessP95Ms',
        direction: 'lower-better',
        read: r => r.latency.accessP95Ms,
    },
    {
        key: 'latency.commitP95Ms',
        direction: 'lower-better',
        read: r => r.latency.commitP95Ms,
    },
    {
        key: 'prediction.hitRate',
        direction: 'higher-better',
        read: r => r.prediction.hitRate,
    },
    {
        key: 'correctness.proofFailures',
        direction: 'lower-better',
        read: r => r.correctness.proofFailures,
    },
    {
        key: 'correctness.staleReads',
        direction: 'lower-better',
        read: r => r.correctness.staleReads,
    },
    {
        key: 'correctness.versionMismatches',
        direction: 'lower-better',
        read: r => r.correctness.versionMismatches,
    },
];

function formatPct(ratio: number): string {
    return `${(ratio * 100).toFixed(2)}%`;
}

async function loadReport(path: string): Promise<BenchmarkReport> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BenchmarkReport;
}

function computeDelta(
    key: string,
    direction: Direction,
    baseline: number,
    current: number,
    thresholdRatio: number
): MetricDelta {
    const safeBaseline = Number.isFinite(baseline) ? baseline : 0;
    const safeCurrent = Number.isFinite(current) ? current : 0;

    let deltaRatio = 0;
    if (safeBaseline !== 0) deltaRatio = (safeCurrent - safeBaseline) / Math.abs(safeBaseline);

    let regressed = false;
    if (direction === 'higher-better') {
        if (safeBaseline > 0) regressed = safeCurrent < safeBaseline * (1 - thresholdRatio);
    } else {
        if (safeBaseline === 0) regressed = safeCurrent > 0;
        else regressed = safeCurrent > safeBaseline * (1 + thresholdRatio);
    }

    return {
        key,
        direction,
        baseline: safeBaseline,
        current: safeCurrent,
        deltaRatio,
        regressed,
    };
}

export function compareReports(
    baselineReport: BenchmarkReport,
    currentReport: BenchmarkReport,
    baselineFile: string,
    currentFile: string,
    thresholdRatio: number
): CompareResult {
    const metrics = METRIC_SPECS.map(spec =>
        computeDelta(
            spec.key,
            spec.direction,
            spec.read(baselineReport),
            spec.read(currentReport),
            thresholdRatio
        )
    );

    return {
        baselineFile,
        currentFile,
        thresholdRatio,
        metrics,
        regressions: metrics.filter(m => m.regressed),
    };
}

export async function saveReportSnapshot(
    reportFile: string,
    resultsDir: string,
    tag?: string
): Promise<string> {
    const report = await loadReport(reportFile);
    const stamp = report.runId || new Date().toISOString().replace(/[.:]/g, '-');
    const suffix = tag ? `-${tag.replace(/[^a-zA-Z0-9._-]/g, '_')}` : '';
    const outPath = join(resultsDir, `${stamp}${suffix}.json`);
    await mkdir(resultsDir, { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return outPath;
}

export function renderCompareSummary(result: CompareResult): string {
    const lines: string[] = [];
    lines.push('MMPM Benchmark Comparison');
    lines.push(`Baseline: ${result.baselineFile}`);
    lines.push(`Current : ${result.currentFile}`);
    lines.push(`Threshold: ${formatPct(result.thresholdRatio)}`);
    lines.push('');
    lines.push('Metrics:');

    for (const metric of result.metrics) {
        const status = metric.regressed ? 'REGRESSION' : 'OK';
        lines.push(
            `  [${status}] ${metric.key}: ${metric.baseline} -> ${metric.current} (delta ${formatPct(metric.deltaRatio)})`
        );
    }

    lines.push('');
    if (result.regressions.length === 0) {
        lines.push('Result: PASS (no regressions detected)');
    } else {
        lines.push(`Result: FAIL (${result.regressions.length} regression(s) detected)`);
    }

    return lines.join('\n');
}

function argValue(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

async function runCli() {
    const argv = process.argv.slice(2);
    const command = argv[0];

    if (!command || command === '--help' || command === 'help') {
        console.log([
            'Usage:',
            '  ts-node tools/harness/track.ts save [--report-file FILE] [--results-dir DIR] [--tag TAG]',
            '  ts-node tools/harness/track.ts compare <baseline.json> <current.json> [--threshold 0.10]',
            '',
            'Examples:',
            '  ts-node tools/harness/track.ts save --report-file tools/harness/results/latest.json --tag pr-123',
            '  ts-node tools/harness/track.ts compare tools/harness/results/old.json tools/harness/results/latest.json --threshold 0.10',
        ].join('\n'));
        return;
    }

    if (command === 'save') {
        const reportFile = resolve(argValue(argv, 'report-file') ?? 'tools/harness/results/latest.json');
        const resultsDir = resolve(argValue(argv, 'results-dir') ?? 'tools/harness/results');
        const tag = argValue(argv, 'tag') ?? undefined;

        const outPath = await saveReportSnapshot(reportFile, resultsDir, tag);
        console.log(`Saved benchmark snapshot: ${outPath}`);
        return;
    }

    if (command === 'compare') {
        const baselinePathRaw = argv[1];
        const currentPathRaw = argv[2];
        if (!baselinePathRaw || !currentPathRaw) {
            throw new Error('compare requires <baseline.json> and <current.json>');
        }

        const thresholdRatio = Number(argValue(argv, 'threshold') ?? '0.10');
        if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0) {
            throw new Error('--threshold must be a non-negative number');
        }

        const baselinePath = resolve(baselinePathRaw);
        const currentPath = resolve(currentPathRaw);

        const baseline = await loadReport(baselinePath);
        const current = await loadReport(currentPath);
        const result = compareReports(
            baseline,
            current,
            basename(baselinePath),
            basename(currentPath),
            thresholdRatio
        );

        console.log(renderCompareSummary(result));
        if (result.regressions.length > 0) process.exit(1);
        return;
    }

    throw new Error(`Unknown command '${command}'. Use 'save' or 'compare'.`);
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
