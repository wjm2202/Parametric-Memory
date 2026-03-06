import { performance } from 'perf_hooks';
import { MerkleKernel } from '../../src/merkle';
import { ShardedOrchestrator } from '../../src/orchestrator';
import { ShardRouter } from '../../src/router';
import { GeneratedDataset, generateStructuredDataset } from './generator';
import { runIngestionDriver } from './ingest_driver';
import { waitForApiReady } from './api_ready';

type PatternName = 'sequential' | 'random' | 'predicted' | 'hotspot' | 'cross_shard';

export interface RecallBenchOptions {
    useApi?: boolean;
    baseUrl?: string;
    apiKey?: string;
    orchestrator?: ShardedOrchestrator;
    sequentialHops?: number;
    randomSamples?: number;
    predictedSamples?: number;
    hotspotSetSize?: number;
    hotspotRepeats?: number;
    crossShardSamples?: number;
    contextSamples?: number;
    contextMaxTokens?: number;
}

interface AccessResponse {
    currentData: string;
    currentProof: any;
    predictedNext: string | null;
    predictedProof: any | null;
    shardRootProof?: any;
    treeVersion?: number;
    latencyMs?: number;
    verified?: boolean;
}

export interface PatternMetrics {
    requests: number;
    latenciesMs: number[];
    p50: number;
    p95: number;
    p99: number;
    max: number;
    histogram: Record<string, number>;
}

export interface RecallBenchStats {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    patterns: Record<PatternName, PatternMetrics>;
    contextLoad: PatternMetrics;
    predictionHitRate: number;
    predictionAttempts: number;
    predictionHits: number;
    avgLatencySavedByPredictionMs: number;
    proofVerification: {
        attempts: number;
        failures: number;
        avgVerifyMs: number;
        p50VerifyMs: number;
        p95VerifyMs: number;
        p99VerifyMs: number;
        cvVerify: number;
        latenciesMs: number[];
        byType: {
            current:   ProofTypeStats;
            predicted: ProofTypeStats;
            shardRoot: ProofTypeStats;
        };
    };
}

export interface ProofTypeStats {
    attempts: number;
    failures: number;
    avgVerifyMs: number;
    p50VerifyMs: number;
    p95VerifyMs: number;
    p99VerifyMs: number;
    cvVerify: number;
    latenciesMs: number[];
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[idx];
}

function toHistogram(latencies: number[]): Record<string, number> {
    const buckets = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
    const out: Record<string, number> = {};
    for (const b of buckets) out[`<=${b}ms`] = 0;
    out['>1000ms'] = 0;

    for (const latency of latencies) {
        let placed = false;
        for (const b of buckets) {
            if (latency <= b) {
                out[`<=${b}ms`]++;
                placed = true;
                break;
            }
        }
        if (!placed) out['>1000ms']++;
    }

    return out;
}

function summarisePattern(latencies: number[]): PatternMetrics {
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
        requests: latencies.length,
        latenciesMs: latencies,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        histogram: toHistogram(latencies),
    };
}

async function postJson(
    baseUrl: string,
    path: string,
    payload: unknown,
    apiKey?: string
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    let body: any = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }

    return { status: res.status, body };
}

async function getJson(
    baseUrl: string,
    path: string,
    apiKey?: string
): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers,
    });

    let body: any = null;
    try {
        body = await res.json();
    } catch {
        body = null;
    }

    return { status: res.status, body };
}

function randomInt(max: number): number {
    return Math.floor(Math.random() * max);
}

export async function runRecallBenchmark(
    dataset: GeneratedDataset,
    options: RecallBenchOptions
): Promise<RecallBenchStats> {
    const startedAt = new Date().toISOString();
    const runStart = performance.now();

    const useApi = options.useApi === true;
    const baseUrl = options.baseUrl ?? 'http://localhost:3000';
    if (useApi) await waitForApiReady(baseUrl, { apiKey: options.apiKey });

    const sequentialHops = Math.max(1, options.sequentialHops ?? 200);
    const randomSamples = Math.max(1, options.randomSamples ?? 200);
    const predictedSamples = Math.max(1, options.predictedSamples ?? 150);
    const hotspotSetSize = Math.max(1, options.hotspotSetSize ?? 10);
    const hotspotRepeats = Math.max(1, options.hotspotRepeats ?? 40);
    const crossShardSamples = Math.max(1, options.crossShardSamples ?? 100);
    const contextSamples = Math.max(1, options.contextSamples ?? 20);
    const contextMaxTokens = Math.max(1, options.contextMaxTokens ?? 512);

    const patternLatencies: Record<PatternName, number[]> = {
        sequential: [],
        random: [],
        predicted: [],
        hotspot: [],
        cross_shard: [],
    };
    const contextLoadLatencies: number[] = [];

    let predictionAttempts = 0;
    let predictionHits = 0;
    const latencySavings: number[] = [];

    let proofAttempts = 0;
    let proofFailures = 0;
    const proofVerifyLatencies: number[] = [];

    // Per-type accumulators for F1 — split current / predicted / shardRoot populations
    const proofTypeLatencies = { current: [] as number[], predicted: [] as number[], shardRoot: [] as number[] };
    const proofTypeAttempts  = { current: 0, predicted: 0, shardRoot: 0 };
    const proofTypeFailures  = { current: 0, predicted: 0, shardRoot: 0 };

    const access = async (atom: string): Promise<AccessResponse> => {
        if (useApi) {
            const res = await postJson(baseUrl, '/access', { data: atom }, options.apiKey);
            if (res.status !== 200) {
                throw new Error(`Access failed for '${atom}' with status ${res.status}`);
            }
            return res.body as AccessResponse;
        }
        const orchestrator = options.orchestrator;
        if (!orchestrator) throw new Error('Embedded recall benchmark requires options.orchestrator');
        return await orchestrator.access(atom);
    };

    const verifyProofs = (report: AccessResponse) => {
        if (!report.currentProof) return;

        // Time each proof individually so latenciesMs reflects a single
        // proof verification, not a variable-count batch. Batching 1–3 proofs
        // into a single measurement was the source of CV=0.232 variance.
        // F1: also record into per-type buckets to separate the two audit-depth
        // populations (current/predicted ~9 hops vs shardRoot ~2 hops).
        type ProofType = 'current' | 'predicted' | 'shardRoot';
        const verifyOne = (proof: any, type: ProofType): boolean => {
            const t0 = performance.now();
            proofAttempts++;
            proofTypeAttempts[type]++;
            const ok = MerkleKernel.verifyProof(proof);
            const elapsed = performance.now() - t0;
            proofVerifyLatencies.push(elapsed);
            proofTypeLatencies[type].push(elapsed);
            return ok;
        };

        if (!verifyOne(report.currentProof, 'current')) {
            proofFailures++;
            proofTypeFailures.current++;
        }
        if (report.predictedProof && !verifyOne(report.predictedProof, 'predicted')) {
            proofFailures++;
            proofTypeFailures.predicted++;
        }
        if (report.shardRootProof && !verifyOne(report.shardRootProof, 'shardRoot')) {
            proofFailures++;
            proofTypeFailures.shardRoot++;
        }
    };

    // 1) Sequential recall
    for (const sequence of dataset.sequences) {
        if (sequence.length < 2) continue;
        for (const atom of sequence) {
            if (patternLatencies.sequential.length >= sequentialHops) break;
            const t0 = performance.now();
            const report = await access(atom);
            patternLatencies.sequential.push(performance.now() - t0);
            verifyProofs(report);
        }
        if (patternLatencies.sequential.length >= sequentialHops) break;
    }

    // 2) Random recall
    for (let i = 0; i < randomSamples; i++) {
        const atom = dataset.atoms[randomInt(dataset.atoms.length)];
        const t0 = performance.now();
        const report = await access(atom);
        patternLatencies.random.push(performance.now() - t0);
        verifyProofs(report);
    }

    // 3) Predicted recall and latency-savings estimate vs cold lookup
    const edges: Array<{ from: string; to: string }> = [];
    for (const seq of dataset.sequences) {
        for (let i = 0; i < seq.length - 1; i++) {
            edges.push({ from: seq[i], to: seq[i + 1] });
            if (edges.length >= predictedSamples) break;
        }
        if (edges.length >= predictedSamples) break;
    }

    for (const edge of edges) {
        predictionAttempts++;

        const tFrom = performance.now();
        const fromReport = await access(edge.from);
        const fromLatency = performance.now() - tFrom;
        patternLatencies.predicted.push(fromLatency);
        verifyProofs(fromReport);

        const predictedAtom = fromReport.predictedNext;
        if (!predictedAtom) continue;

        if (predictedAtom === edge.to) predictionHits++;

        const tPred = performance.now();
        const predictedReport = await access(predictedAtom);
        const predictedLatency = performance.now() - tPred;
        verifyProofs(predictedReport);

        const tCold = performance.now();
        const coldReport = await access(edge.to);
        const coldLatency = performance.now() - tCold;
        verifyProofs(coldReport);

        latencySavings.push(coldLatency - predictedLatency);
    }

    // 4) Hot-spot recall
    const hotSet = dataset.atoms.slice(0, hotspotSetSize);
    for (let i = 0; i < hotspotRepeats; i++) {
        for (const atom of hotSet) {
            const t0 = performance.now();
            const report = await access(atom);
            patternLatencies.hotspot.push(performance.now() - t0);
            verifyProofs(report);
        }
    }

    // 5) Cross-shard recall
    const router = new ShardRouter(4);
    const atomsByShard = new Map<number, string[]>();
    for (const atom of dataset.atoms) {
        const shard = router.getShardIndex(atom);
        if (!atomsByShard.has(shard)) atomsByShard.set(shard, []);
        atomsByShard.get(shard)!.push(atom);
    }

    const shardIds = [...atomsByShard.keys()].sort((a, b) => a - b);
    if (shardIds.length >= 2) {
        for (let i = 0; i < crossShardSamples; i++) {
            const shardA = shardIds[i % shardIds.length];
            const shardB = shardIds[(i + 1) % shardIds.length];
            const from = atomsByShard.get(shardA)![randomInt(atomsByShard.get(shardA)!.length)];
            const to = atomsByShard.get(shardB)![randomInt(atomsByShard.get(shardB)!.length)];

            const t0 = performance.now();
            const reportA = await access(from);
            patternLatencies.cross_shard.push(performance.now() - t0);
            verifyProofs(reportA);

            const t1 = performance.now();
            const reportB = await access(to);
            patternLatencies.cross_shard.push(performance.now() - t1);
            verifyProofs(reportB);
        }
    }

    if (useApi) {
        for (let i = 0; i < contextSamples; i++) {
            const t0 = performance.now();
            const res = await getJson(baseUrl, `/memory/context?maxTokens=${contextMaxTokens}`, options.apiKey);
            if (res.status !== 200) {
                throw new Error(`Context load failed with status ${res.status}`);
            }
            contextLoadLatencies.push(performance.now() - t0);
        }
    }

    const finishedAt = new Date().toISOString();
    const durationMs = performance.now() - runStart;

    return {
        startedAt,
        finishedAt,
        durationMs,
        patterns: {
            sequential: summarisePattern(patternLatencies.sequential),
            random: summarisePattern(patternLatencies.random),
            predicted: summarisePattern(patternLatencies.predicted),
            hotspot: summarisePattern(patternLatencies.hotspot),
            cross_shard: summarisePattern(patternLatencies.cross_shard),
        },
        contextLoad: summarisePattern(contextLoadLatencies),
        predictionHitRate: predictionAttempts > 0 ? predictionHits / predictionAttempts : 0,
        predictionAttempts,
        predictionHits,
        avgLatencySavedByPredictionMs: latencySavings.length > 0
            ? latencySavings.reduce((s, v) => s + v, 0) / latencySavings.length
            : 0,
        proofVerification: (() => {
            const buildStats = (
                latencies: number[],
                attempts: number,
                failures: number,
            ) => {
                const sorted = [...latencies].sort((a, b) => a - b);
                const avg = sorted.length > 0
                    ? sorted.reduce((s, v) => s + v, 0) / sorted.length
                    : 0;
                const variance = sorted.length > 1
                    ? sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / sorted.length
                    : 0;
                return {
                    attempts,
                    failures,
                    avgVerifyMs: avg,
                    p50VerifyMs: percentile(sorted, 50),
                    p95VerifyMs: percentile(sorted, 95),
                    p99VerifyMs: percentile(sorted, 99),
                    cvVerify: avg > 0 ? Math.sqrt(variance) / avg : 0,
                    latenciesMs: latencies,
                };
            };
            return {
                ...buildStats(proofVerifyLatencies, proofAttempts, proofFailures),
                byType: {
                    current:   buildStats(proofTypeLatencies.current,   proofTypeAttempts.current,   proofTypeFailures.current),
                    predicted: buildStats(proofTypeLatencies.predicted,  proofTypeAttempts.predicted,  proofTypeFailures.predicted),
                    shardRoot: buildStats(proofTypeLatencies.shardRoot,  proofTypeAttempts.shardRoot,  proofTypeFailures.shardRoot),
                },
            };
        })(),
    };
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

async function runCli() {
    const argv = process.argv.slice(2);
    const useApi = argv.includes('--api');
    const prepare = !argv.includes('--noPrepare');

    const dataset = generateStructuredDataset({
        totalAtoms: parseArgNumber(argv, 'atoms', 10000),
        avgChainLength: parseArgNumber(argv, 'avgChainLength', 12),
        branchFactor: parseArgNumber(argv, 'branchFactor', 0.15),
        vocabularySize: parseArgNumber(argv, 'vocabulary', 5000),
        seed: parseArgNumber(argv, 'seed', 42),
    });

    let orchestrator: ShardedOrchestrator | undefined;
    if (!useApi) {
        orchestrator = new ShardedOrchestrator(4, ['BenchSeed_A', 'BenchSeed_B'], './mmpm-harness-bench-db');
        await orchestrator.init();
    }

    try {
        if (prepare) {
            await runIngestionDriver(dataset, {
                mode: 'streaming',
                useApi,
                baseUrl: parseArgString(argv, 'baseUrl') ?? 'http://localhost:3000',
                apiKey: parseArgString(argv, 'apiKey') ?? undefined,
                orchestrator,
                chunkSize: parseArgNumber(argv, 'chunkSize', 100),
                atomsPerSecond: parseArgNumber(argv, 'atomsPerSecond', 1000),
                maxAccessProbes: 0,
            });
        }

        const stats = await runRecallBenchmark(dataset, {
            useApi,
            baseUrl: parseArgString(argv, 'baseUrl') ?? 'http://localhost:3000',
            apiKey: parseArgString(argv, 'apiKey') ?? undefined,
            orchestrator,
            sequentialHops: parseArgNumber(argv, 'sequentialHops', 200),
            randomSamples: parseArgNumber(argv, 'randomSamples', 200),
            predictedSamples: parseArgNumber(argv, 'predictedSamples', 150),
            hotspotSetSize: parseArgNumber(argv, 'hotspotSetSize', 10),
            hotspotRepeats: parseArgNumber(argv, 'hotspotRepeats', 40),
            crossShardSamples: parseArgNumber(argv, 'crossShardSamples', 100),
        });

        console.log(JSON.stringify(stats, null, 2));
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
