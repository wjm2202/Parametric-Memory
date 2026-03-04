import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { BenchmarkReport, evaluateLatencySlo } from './report';

function argValue(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

function parseNumber(input: string | null, fallback: number): number {
    if (input === null) return fallback;
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadReport(path: string): Promise<BenchmarkReport> {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as BenchmarkReport;
}

async function runCli() {
    const argv = process.argv.slice(2);
    const reportPath = resolve(argValue(argv, 'report-file') ?? 'tools/harness/results/latest.json');

    const accessP95MaxMs = parseNumber(
        argValue(argv, 'access-p95-max-ms') ?? process.env.MMPM_SLO_ACCESS_P95_MS ?? null,
        250
    );
    const contextLoadP95MaxMs = parseNumber(
        argValue(argv, 'context-p95-max-ms') ?? process.env.MMPM_SLO_CONTEXT_P95_MS ?? null,
        750
    );

    const report = await loadReport(reportPath);
    const evalResult = evaluateLatencySlo(report, {
        accessP95MaxMs,
        contextLoadP95MaxMs,
    });

    console.log('MMPM AI-facing latency SLO gate');
    console.log(`Report: ${reportPath}`);
    console.log(`access p95: ${evalResult.accessP95Ms.toFixed(3)} ms (target <= ${evalResult.accessP95MaxMs.toFixed(3)} ms)`);
    console.log(`context load p95: ${evalResult.contextLoadP95Ms.toFixed(3)} ms (target <= ${evalResult.contextLoadP95MaxMs.toFixed(3)} ms)`);

    if (!evalResult.pass) {
        for (const failure of evalResult.failures) {
            console.error(`SLO_FAIL: ${failure}`);
        }
        process.exit(1);
    }

    console.log('SLO_PASS: latency thresholds satisfied.');
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
