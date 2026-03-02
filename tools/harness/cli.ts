import 'dotenv/config';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { ShardedOrchestrator } from '../../src/orchestrator';
import { generateStructuredDataset } from './generator';
import { runIngestionDriver } from './ingest_driver';
import { runRecallBenchmark } from './recall_bench';
import { buildBenchmarkReport, renderTerminalReport, toPrometheusMetrics } from './report';
import { waitForApiReady } from './api_ready';
import { runAgentSimulation } from './agent_sim';

type PresetName = 'smoke' | 'standard' | 'stress' | 'concurrent';

interface PresetConfig {
    atoms: number;
    avgChainLength: number;
    branchFactor: number;
    vocabulary: number;
    mode: 'bulk' | 'streaming' | 'burst';
    chunkSize: number;
    atomsPerSecond: number;
    sequentialHops: number;
    randomSamples: number;
    predictedSamples: number;
    hotspotSetSize: number;
    hotspotRepeats: number;
    crossShardSamples: number;
    agents: number;
    durationMs: number;
    readRatio: number;
    writeRatio: number;
    trainRatio: number;
    thinkTimeMs: number;
}

const PRESETS: Record<PresetName, PresetConfig> = {
    smoke: {
        atoms: 1500,
        avgChainLength: 8,
        branchFactor: 0.12,
        vocabulary: 1200,
        mode: 'streaming',
        chunkSize: 150,
        atomsPerSecond: 5000,
        sequentialHops: 60,
        randomSamples: 60,
        predictedSamples: 45,
        hotspotSetSize: 8,
        hotspotRepeats: 12,
        crossShardSamples: 30,
        agents: 8,
        durationMs: 10_000,
        readRatio: 0.7,
        writeRatio: 0.1,
        trainRatio: 0.2,
        thinkTimeMs: 5,
    },
    standard: {
        atoms: 10000,
        avgChainLength: 12,
        branchFactor: 0.15,
        vocabulary: 5000,
        mode: 'streaming',
        chunkSize: 250,
        atomsPerSecond: 8000,
        sequentialHops: 200,
        randomSamples: 200,
        predictedSamples: 150,
        hotspotSetSize: 10,
        hotspotRepeats: 40,
        crossShardSamples: 100,
        agents: 20,
        durationMs: 30_000,
        readRatio: 0.7,
        writeRatio: 0.1,
        trainRatio: 0.2,
        thinkTimeMs: 5,
    },
    stress: {
        atoms: 50000,
        avgChainLength: 14,
        branchFactor: 0.2,
        vocabulary: 15000,
        mode: 'burst',
        chunkSize: 500,
        atomsPerSecond: 12000,
        sequentialHops: 500,
        randomSamples: 500,
        predictedSamples: 300,
        hotspotSetSize: 16,
        hotspotRepeats: 80,
        crossShardSamples: 250,
        agents: 50,
        durationMs: 60_000,
        readRatio: 0.7,
        writeRatio: 0.1,
        trainRatio: 0.2,
        thinkTimeMs: 5,
    },
    concurrent: {
        atoms: 10000,
        avgChainLength: 12,
        branchFactor: 0.15,
        vocabulary: 5000,
        mode: 'streaming',
        chunkSize: 250,
        atomsPerSecond: 8000,
        sequentialHops: 120,
        randomSamples: 120,
        predictedSamples: 100,
        hotspotSetSize: 12,
        hotspotRepeats: 30,
        crossShardSamples: 80,
        agents: 50,
        durationMs: 60_000,
        readRatio: 0.7,
        writeRatio: 0.1,
        trainRatio: 0.2,
        thinkTimeMs: 5,
    },
};

function argValue(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

function parseNumber(argv: string[], key: string, fallback: number): number {
    const raw = argValue(argv, key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function hasFlag(argv: string[], key: string): boolean {
    return argv.includes(`--${key}`);
}

function parsePreset(argv: string[]): PresetName {
    const raw = (argValue(argv, 'preset') ?? 'smoke').toLowerCase();
    if (raw === 'smoke' || raw === 'standard' || raw === 'stress' || raw === 'concurrent') return raw;
    throw new Error(`Unsupported preset '${raw}'. Use smoke|standard|stress|concurrent.`);
}

async function ensureParentDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

async function runCli() {
    const argv = process.argv.slice(2);

    if (hasFlag(argv, 'help')) {
        console.log([
            'Usage: ts-node tools/harness/cli.ts [--preset smoke|standard|stress|concurrent] [--api --baseUrl URL --apiKey KEY]',
            '       [--out path/to/report.json] [--prom-out path/to/report.prom] [--print]',
            '',
            'Examples:',
            '  ts-node tools/harness/cli.ts --preset smoke --print',
            '  ts-node tools/harness/cli.ts --preset smoke --api --baseUrl http://localhost:3000 --out tools/harness/results/latest.json --prom-out tools/harness/results/latest.prom --print',
            '  ts-node tools/harness/cli.ts --preset concurrent --agents 50 --durationMs 60000 --writeRatio 0.2 --print',
        ].join('\n'));
        return;
    }

    const preset = parsePreset(argv);
    const config = PRESETS[preset];

    const useApi = hasFlag(argv, 'api');
    const baseUrl = argValue(argv, 'baseUrl') ?? process.env.MMPM_BASE_URL ?? 'http://localhost:3000';
    const apiKeyArg = argValue(argv, 'apiKey');
    const apiKey = (apiKeyArg !== null ? apiKeyArg : process.env.MMPM_API_KEY) || undefined;
    const outFile = resolve(argValue(argv, 'out') ?? 'tools/harness/results/latest.json');
    const promOutFile = resolve(argValue(argv, 'prom-out') ?? 'tools/harness/results/latest.prom');
    const print = hasFlag(argv, 'print') || !hasFlag(argv, 'no-print');

    const atoms = parseNumber(argv, 'atoms', config.atoms);
    const seed = parseNumber(argv, 'seed', 42);

    const dataset = generateStructuredDataset({
        totalAtoms: atoms,
        avgChainLength: parseNumber(argv, 'avgChainLength', config.avgChainLength),
        branchFactor: parseNumber(argv, 'branchFactor', config.branchFactor),
        vocabularySize: parseNumber(argv, 'vocabulary', config.vocabulary),
        seed,
    });

    let orchestrator: ShardedOrchestrator | undefined;
    if (!useApi) {
        const dbPath = resolve(`./mmpm-harness-cli-db-${Date.now()}`);
        orchestrator = new ShardedOrchestrator(4, ['CLI_Boot_A', 'CLI_Boot_B'], dbPath);
        await orchestrator.init();
    } else {
        await waitForApiReady(baseUrl, {
            apiKey,
            timeoutMs: parseNumber(argv, 'ready-timeout-ms', 60_000),
            pollMs: parseNumber(argv, 'ready-poll-ms', 500),
        });
    }

    try {
        const ingestStats = await runIngestionDriver(dataset, {
            mode: config.mode,
            useApi,
            baseUrl,
            apiKey,
            orchestrator,
            chunkSize: parseNumber(argv, 'chunkSize', config.chunkSize),
            atomsPerSecond: parseNumber(argv, 'atomsPerSecond', config.atomsPerSecond),
            maxAccessProbes: 0,
        });

        const recallStats = await runRecallBenchmark(dataset, {
            useApi,
            baseUrl,
            apiKey,
            orchestrator,
            sequentialHops: parseNumber(argv, 'sequentialHops', config.sequentialHops),
            randomSamples: parseNumber(argv, 'randomSamples', config.randomSamples),
            predictedSamples: parseNumber(argv, 'predictedSamples', config.predictedSamples),
            hotspotSetSize: parseNumber(argv, 'hotspotSetSize', config.hotspotSetSize),
            hotspotRepeats: parseNumber(argv, 'hotspotRepeats', config.hotspotRepeats),
            crossShardSamples: parseNumber(argv, 'crossShardSamples', config.crossShardSamples),
        });

        const maybeAgentStats = preset === 'concurrent'
            ? await runAgentSimulation({
                useApi,
                baseUrl,
                apiKey,
                orchestrator,
                agents: parseNumber(argv, 'agents', config.agents),
                durationMs: parseNumber(argv, 'durationMs', config.durationMs),
                readRatio: parseNumber(argv, 'readRatio', config.readRatio),
                writeRatio: parseNumber(argv, 'writeRatio', config.writeRatio),
                trainRatio: parseNumber(argv, 'trainRatio', config.trainRatio),
                thinkTimeMs: parseNumber(argv, 'thinkTimeMs', config.thinkTimeMs),
                initialAtoms: dataset.atoms.slice(0, Math.min(200, dataset.atoms.length)),
                seed,
            })
            : undefined;

        const report = buildBenchmarkReport({
            ingestion: ingestStats,
            recall: recallStats,
            agentSim: maybeAgentStats,
        });

        await ensureParentDir(outFile);
        await ensureParentDir(promOutFile);
        await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await writeFile(promOutFile, toPrometheusMetrics(report), 'utf8');

        if (print) {
            console.log(renderTerminalReport(report));
            console.log(`\nReport JSON: ${outFile}`);
            console.log(`Prometheus metrics: ${promOutFile}`);
        }
    } finally {
        if (orchestrator) await orchestrator.close();
    }
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
