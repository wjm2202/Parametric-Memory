import { performance } from 'perf_hooks';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { GeneratedDataset } from './generator';
import { runIngestionDriver } from './ingest_driver';
import { runRecallBenchmark } from './recall_bench';
import { buildBenchmarkReport, renderTerminalReport, toPrometheusMetrics } from './report';
import { ShardedOrchestrator } from '../../src/orchestrator';
import { ShardRouter } from '../../src/router';

type PresetName = 'medium' | 'large' | 'xlarge';

interface RealWorldPreset {
    users: number;
    sessionsPerUser: number;
    eventsPerSession: number;
    products: number;
    categories: number;
    chunkSize: number;
    atomsPerSecond: number;
    sequentialHops: number;
    randomSamples: number;
    predictedSamples: number;
    hotspotSetSize: number;
    hotspotRepeats: number;
    crossShardSamples: number;
    validationQueries: number;
}

interface ShardDistribution {
    shard: number;
    atomCount: number;
    ratioToMean: number;
}

interface ValidationSummary {
    totalQueries: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    perShardP95Ms: Record<number, number>;
    hottestShardByTraffic: number;
}

interface RealWorldReport {
    scenario: {
        preset: PresetName;
        generatedAt: string;
        shards: number;
        seed: number;
    };
    dataset: {
        atoms: number;
        sequences: number;
        users: number;
        sessions: number;
        events: number;
        products: number;
        categories: number;
    };
    shardDistribution: {
        meanAtomsPerShard: number;
        maxToMinRatio: number;
        perShard: ShardDistribution[];
    };
    validation: ValidationSummary;
    bottleneckFlags: {
        shardImbalance: boolean;
        latencySkewByShard: boolean;
    };
    benchmark: ReturnType<typeof buildBenchmarkReport>;
}

const PRESETS: Record<PresetName, RealWorldPreset> = {
    medium: {
        users: 4000,
        sessionsPerUser: 2,
        eventsPerSession: 5,
        products: 8000,
        categories: 200,
        chunkSize: 500,
        atomsPerSecond: 12000,
        sequentialHops: 400,
        randomSamples: 500,
        predictedSamples: 300,
        hotspotSetSize: 50,
        hotspotRepeats: 40,
        crossShardSamples: 200,
        validationQueries: 4000,
    },
    large: {
        users: 15000,
        sessionsPerUser: 2,
        eventsPerSession: 6,
        products: 25000,
        categories: 500,
        chunkSize: 750,
        atomsPerSecond: 18000,
        sequentialHops: 800,
        randomSamples: 900,
        predictedSamples: 500,
        hotspotSetSize: 80,
        hotspotRepeats: 60,
        crossShardSamples: 350,
        validationQueries: 8000,
    },
    xlarge: {
        users: 30000,
        sessionsPerUser: 2,
        eventsPerSession: 6,
        products: 50000,
        categories: 900,
        chunkSize: 1000,
        atomsPerSecond: 25000,
        sequentialHops: 1200,
        randomSamples: 1200,
        predictedSamples: 800,
        hotspotSetSize: 120,
        hotspotRepeats: 90,
        crossShardSamples: 600,
        validationQueries: 14000,
    },
};

function createRng(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}

function pad(i: number, width = 6): string {
    return String(i).padStart(width, '0');
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

function parseArgNumber(argv: string[], key: string, fallback: number): number {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return fallback;
    const value = Number(argv[idx + 1]);
    return Number.isFinite(value) ? value : fallback;
}

function parseArgString(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

function parsePreset(argv: string[]): PresetName {
    const raw = (parseArgString(argv, 'preset') ?? 'medium').toLowerCase();
    if (raw === 'medium' || raw === 'large' || raw === 'xlarge') return raw;
    throw new Error(`Unsupported preset '${raw}'. Use medium|large|xlarge.`);
}

function generateRealWorldDataset(config: RealWorldPreset, seed: number): {
    dataset: GeneratedDataset;
    stats: { users: number; sessions: number; events: number; products: number; categories: number };
} {
    const rnd = createRng(seed);
    const atoms = new Set<string>();
    const sequences: string[][] = [];

    const categoryAtoms = Array.from({ length: config.categories }, (_, idx) => `cat|c${pad(idx + 1, 4)}`);
    for (const category of categoryAtoms) atoms.add(category);

    const productAtoms: string[] = [];
    for (let i = 0; i < config.products; i++) {
        const category = categoryAtoms[i % categoryAtoms.length];
        const atom = `product|p${pad(i + 1)}|${category}|brand:b${pad(i % 120, 3)}`;
        productAtoms.push(atom);
        atoms.add(atom);
        sequences.push([atom, category]);
    }

    let sessionCount = 0;
    let eventCount = 0;

    for (let u = 0; u < config.users; u++) {
        const region = ['na', 'eu', 'apac', 'latam'][u % 4];
        const tier = ['free', 'pro', 'enterprise'][u % 3];
        const userAtom = `user|u${pad(u + 1)}|region:${region}|tier:${tier}`;
        atoms.add(userAtom);

        for (let s = 0; s < config.sessionsPerUser; s++) {
            sessionCount++;
            const sessionAtom = `session|u${pad(u + 1)}|s${pad(sessionCount, 7)}|channel:${s % 2 === 0 ? 'web' : 'mobile'}`;
            atoms.add(sessionAtom);
            sequences.push([userAtom, sessionAtom]);

            let previousProduct: string | null = null;
            for (let e = 0; e < config.eventsPerSession; e++) {
                eventCount++;
                const productIdx = Math.floor(rnd() * productAtoms.length);
                const productAtom = productAtoms[productIdx];
                const categoryAtom = categoryAtoms[productIdx % categoryAtoms.length];
                const eventType = e % 5 === 4 ? 'purchase' : e % 3 === 0 ? 'cart' : 'view';
                const eventAtom = `event|s${pad(sessionCount, 7)}|e${pad(eventCount, 8)}|${eventType}`;
                atoms.add(eventAtom);

                sequences.push([sessionAtom, eventAtom, productAtom, categoryAtom]);

                if (previousProduct !== null) {
                    sequences.push([previousProduct, productAtom]);
                }
                previousProduct = productAtom;
            }
        }
    }

    const atomList = [...atoms];
    const dataset: GeneratedDataset = {
        atoms: atomList,
        sequences,
        metadata: {
            config: {
                totalAtoms: atomList.length,
                avgChainLength: 4,
                branchFactor: 0.2,
                vocabularySize: atomList.length,
                seed,
            },
            domainAtomCounts: {
                knowledge_graph: atomList.length,
                conversation: 0,
                tool_call: 0,
                document: 0,
            },
            domainSequenceCounts: {
                knowledge_graph: sequences.length,
                conversation: 0,
                tool_call: 0,
                document: 0,
            },
            generatedAt: new Date().toISOString(),
            uniqueAtoms: atomList.length,
            totalSequences: sequences.length,
        },
    };

    return {
        dataset,
        stats: {
            users: config.users,
            sessions: sessionCount,
            events: eventCount,
            products: config.products,
            categories: config.categories,
        },
    };
}

function computeShardDistribution(atoms: string[], shardCount: number): {
    meanAtomsPerShard: number;
    maxToMinRatio: number;
    perShard: ShardDistribution[];
} {
    const router = new ShardRouter(shardCount);
    const counts = Array.from({ length: shardCount }, () => 0);
    for (const atom of atoms) {
        counts[router.getShardIndex(atom)]++;
    }

    const mean = counts.reduce((sum, n) => sum + n, 0) / Math.max(1, counts.length);
    const min = Math.max(1, Math.min(...counts));
    const max = Math.max(...counts);

    return {
        meanAtomsPerShard: mean,
        maxToMinRatio: max / min,
        perShard: counts.map((count, shard) => ({
            shard,
            atomCount: count,
            ratioToMean: mean > 0 ? count / mean : 0,
        })),
    };
}

async function runValidationQueries(
    orchestrator: ShardedOrchestrator,
    atoms: string[],
    shardCount: number,
    totalQueries: number,
    seed: number
): Promise<ValidationSummary> {
    const rnd = createRng(seed + 777);
    const router = new ShardRouter(shardCount);
    const latenciesMs: number[] = [];
    const byShard: Record<number, number[]> = {};
    const trafficByShard = Array.from({ length: shardCount }, () => 0);

    for (let i = 0; i < totalQueries; i++) {
        const atom = atoms[Math.floor(rnd() * atoms.length)];
        const shard = router.getShardIndex(atom);
        trafficByShard[shard]++;

        const t0 = performance.now();
        await orchestrator.access(atom);
        const latency = performance.now() - t0;

        latenciesMs.push(latency);
        if (!byShard[shard]) byShard[shard] = [];
        byShard[shard].push(latency);
    }

    const perShardP95Ms: Record<number, number> = {};
    for (let shard = 0; shard < shardCount; shard++) {
        perShardP95Ms[shard] = percentile(byShard[shard] ?? [], 95);
    }

    let hottestShardByTraffic = 0;
    for (let shard = 1; shard < shardCount; shard++) {
        if (trafficByShard[shard] > trafficByShard[hottestShardByTraffic]) {
            hottestShardByTraffic = shard;
        }
    }

    return {
        totalQueries,
        p50Ms: percentile(latenciesMs, 50),
        p95Ms: percentile(latenciesMs, 95),
        p99Ms: percentile(latenciesMs, 99),
        maxMs: latenciesMs.length > 0 ? Math.max(...latenciesMs) : 0,
        perShardP95Ms,
        hottestShardByTraffic,
    };
}

async function ensureParentDir(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
}

async function runCli() {
    const argv = process.argv.slice(2);
    const preset = parsePreset(argv);
    const presetConfig = PRESETS[preset];
    const shardCount = Math.max(2, parseArgNumber(argv, 'shards', 8));
    const seed = parseArgNumber(argv, 'seed', 42);

    const outFile = resolve(parseArgString(argv, 'out') ?? 'tools/harness/results/realworld-latest.json');
    const promOutFile = resolve(parseArgString(argv, 'prom-out') ?? 'tools/harness/results/realworld-latest.prom');

    const { dataset, stats } = generateRealWorldDataset(presetConfig, seed);
    const shardDistribution = computeShardDistribution(dataset.atoms, shardCount);

    const dbPath = resolve(`./mmpm-harness-cli-db-${Date.now()}`);
    const orchestrator = new ShardedOrchestrator(
        shardCount,
        ['RW_Boot_A', 'RW_Boot_B'],
        dbPath
    );
    await orchestrator.init();

    try {
        const ingestion = await runIngestionDriver(dataset, {
            mode: 'streaming',
            orchestrator,
            chunkSize: presetConfig.chunkSize,
            atomsPerSecond: presetConfig.atomsPerSecond,
            maxAccessProbes: 0,
        });

        const recall = await runRecallBenchmark(dataset, {
            orchestrator,
            sequentialHops: presetConfig.sequentialHops,
            randomSamples: presetConfig.randomSamples,
            predictedSamples: presetConfig.predictedSamples,
            hotspotSetSize: presetConfig.hotspotSetSize,
            hotspotRepeats: presetConfig.hotspotRepeats,
            crossShardSamples: presetConfig.crossShardSamples,
        });

        const benchmark = buildBenchmarkReport({ ingestion, recall });

        const validation = await runValidationQueries(
            orchestrator,
            dataset.atoms,
            shardCount,
            presetConfig.validationQueries,
            seed
        );

        const shardP95Values = Object.values(validation.perShardP95Ms).filter(v => Number.isFinite(v) && v > 0);
        const minShardP95 = shardP95Values.length > 0 ? Math.min(...shardP95Values) : 0;
        const maxShardP95 = shardP95Values.length > 0 ? Math.max(...shardP95Values) : 0;
        const latencySkew = minShardP95 > 0 ? maxShardP95 / minShardP95 : 0;

        const report: RealWorldReport = {
            scenario: {
                preset,
                generatedAt: new Date().toISOString(),
                shards: shardCount,
                seed,
            },
            dataset: {
                atoms: dataset.atoms.length,
                sequences: dataset.sequences.length,
                users: stats.users,
                sessions: stats.sessions,
                events: stats.events,
                products: stats.products,
                categories: stats.categories,
            },
            shardDistribution,
            validation,
            bottleneckFlags: {
                shardImbalance: shardDistribution.maxToMinRatio > 1.5,
                latencySkewByShard: latencySkew > 2,
            },
            benchmark,
        };

        await ensureParentDir(outFile);
        await ensureParentDir(promOutFile);
        await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await writeFile(promOutFile, toPrometheusMetrics(benchmark), 'utf8');

        console.log('MMPM Real-World Shard Stress Report');
        console.log(`Preset: ${preset} | shards: ${shardCount} | seed: ${seed}`);
        console.log(`Atoms: ${report.dataset.atoms} | Sequences: ${report.dataset.sequences}`);
        console.log(`Shard max/min ratio: ${report.shardDistribution.maxToMinRatio.toFixed(2)}`);
        console.log(`Validation p95: ${report.validation.p95Ms.toFixed(2)} ms | p99: ${report.validation.p99Ms.toFixed(2)} ms`);
        console.log(`Bottlenecks => shardImbalance=${report.bottleneckFlags.shardImbalance}, latencySkewByShard=${report.bottleneckFlags.latencySkewByShard}`);
        console.log('');
        console.log(renderTerminalReport(benchmark));
        console.log(`\nReport JSON: ${outFile}`);
        console.log(`Prometheus metrics: ${promOutFile}`);
    } finally {
        await orchestrator.close();
    }
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
