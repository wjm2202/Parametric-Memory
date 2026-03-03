import { performance } from 'perf_hooks';
import { waitForApiReady } from './api_ready';
import { createServer, Server } from 'http';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type ContinuousProfileName = 'balanced' | 'read-heavy' | 'write-heavy' | 'policy-stress';

type OperationName = 'access' | 'batch-access' | 'train' | 'ingest' | 'policy';

interface OperationMix {
    access: number;
    batchAccess: number;
    train: number;
    ingest: number;
    policy: number;
}

interface ScientificCase {
    from: string;
    expected: string;
    alternate: string;
}

export interface ScientificDataset {
    atoms: string[];
    trainingSequences: string[][];
    evaluationCases: ScientificCase[];
}

interface ProfilePhase {
    name: string;
    durationRatio: number;
    opsMultiplier: number;
    mix: OperationMix;
}

interface ProfileSpec {
    phases: ProfilePhase[];
}

export interface ContinuousClientOptions {
    baseUrl?: string;
    apiKey?: string;
    profile?: ContinuousProfileName;
    durationMs?: number;
    targetOpsPerSec?: number;
    concurrency?: number;
    thinkTimeMs?: number;
    seed?: number;
    dataset?: ScientificDataset;
    datasetFlows?: number;
    strongRepeats?: number;
    weakRepeats?: number;
    batchMin?: number;
    batchMax?: number;
    commitEveryWrites?: number;
    readinessTimeoutMs?: number;
    metricsPort?: number;
    metricsHost?: string;
}

export interface AccuracyProbe {
    attempts: number;
    correct: number;
    useful: number;
    accuracy: number;
    usefulRate: number;
    latencyP95Ms: number;
}

export interface ContinuousClientStats {
    profile: ContinuousProfileName;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    targetOpsPerSec: number;
    concurrency: number;
    totalOps: number;
    reads: number;
    batchReads: number;
    writesQueued: number;
    trains: number;
    commits: number;
    policyChanges: number;
    ingestionVerifiedReads: number;
    errors: number;
    backpressureRetries: number;
    accessLatenciesMs: number[];
    batchLatenciesMs: number[];
    trainLatenciesMs: number[];
    ingestLatenciesMs: number[];
    commitLatenciesMs: number[];
    predictionAttempts: number;
    predictionCorrect: number;
    predictionUseful: number;
    predictionAccuracy: number;
    predictionUsefulRate: number;
    accuracyProbe: AccuracyProbe;
    metricsEnabled?: boolean;
    metricsEndpoint?: string | null;
    metricsSnapshot?: string;
}

interface ContinuousMetricsRuntime {
    registry: Registry;
    server: Server;
    endpoint: string;
    offeredOpsTotal: Counter<'profile' | 'op'>;
    completedOpsTotal: Counter<'profile' | 'op' | 'status'>;
    inflightGauge: Gauge<'profile'>;
    opLatencyMs: Histogram<'profile' | 'op'>;
    targetOpsGauge: Gauge<'profile'>;
    predictionAccuracyGauge: Gauge<'profile'>;
    predictionUsefulGauge: Gauge<'profile'>;
    probeAccuracyGauge: Gauge<'profile'>;
    probeUsefulGauge: Gauge<'profile'>;
}

const PROFILE_SPECS: Record<ContinuousProfileName, ProfileSpec> = {
    balanced: {
        phases: [
            {
                name: 'ramp',
                durationRatio: 0.2,
                opsMultiplier: 0.6,
                mix: { access: 0.5, batchAccess: 0.15, train: 0.2, ingest: 0.15, policy: 0 },
            },
            {
                name: 'steady',
                durationRatio: 0.6,
                opsMultiplier: 1,
                mix: { access: 0.55, batchAccess: 0.15, train: 0.15, ingest: 0.15, policy: 0 },
            },
            {
                name: 'spike',
                durationRatio: 0.2,
                opsMultiplier: 1.35,
                mix: { access: 0.5, batchAccess: 0.2, train: 0.1, ingest: 0.2, policy: 0 },
            },
        ],
    },
    'read-heavy': {
        phases: [
            {
                name: 'ramp',
                durationRatio: 0.2,
                opsMultiplier: 0.7,
                mix: { access: 0.72, batchAccess: 0.18, train: 0.05, ingest: 0.05, policy: 0 },
            },
            {
                name: 'steady',
                durationRatio: 0.65,
                opsMultiplier: 1,
                mix: { access: 0.74, batchAccess: 0.16, train: 0.05, ingest: 0.05, policy: 0 },
            },
            {
                name: 'spike',
                durationRatio: 0.15,
                opsMultiplier: 1.25,
                mix: { access: 0.72, batchAccess: 0.18, train: 0.04, ingest: 0.06, policy: 0 },
            },
        ],
    },
    'write-heavy': {
        phases: [
            {
                name: 'ramp',
                durationRatio: 0.2,
                opsMultiplier: 0.6,
                mix: { access: 0.35, batchAccess: 0.1, train: 0.25, ingest: 0.3, policy: 0 },
            },
            {
                name: 'steady',
                durationRatio: 0.6,
                opsMultiplier: 1,
                mix: { access: 0.3, batchAccess: 0.1, train: 0.25, ingest: 0.35, policy: 0 },
            },
            {
                name: 'spike',
                durationRatio: 0.2,
                opsMultiplier: 1.3,
                mix: { access: 0.25, batchAccess: 0.1, train: 0.2, ingest: 0.45, policy: 0 },
            },
        ],
    },
    'policy-stress': {
        phases: [
            {
                name: 'ramp',
                durationRatio: 0.2,
                opsMultiplier: 0.6,
                mix: { access: 0.48, batchAccess: 0.17, train: 0.14, ingest: 0.14, policy: 0.07 },
            },
            {
                name: 'steady',
                durationRatio: 0.6,
                opsMultiplier: 1,
                mix: { access: 0.5, batchAccess: 0.18, train: 0.12, ingest: 0.12, policy: 0.08 },
            },
            {
                name: 'spike',
                durationRatio: 0.2,
                opsMultiplier: 1.25,
                mix: { access: 0.45, batchAccess: 0.2, train: 0.1, ingest: 0.15, policy: 0.1 },
            },
        ],
    },
};

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function percentile(values: number[], percentilePoint: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil((percentilePoint / 100) * sorted.length) - 1);
    return sorted[index];
}

function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function pickOne<T>(items: T[], random: () => number): T {
    return items[Math.floor(random() * items.length)];
}

function weightedOperationChoice(mix: OperationMix, random: () => number): OperationName {
    const slots: Array<{ op: OperationName; weight: number }> = [
        { op: 'access', weight: mix.access },
        { op: 'batch-access', weight: mix.batchAccess },
        { op: 'train', weight: mix.train },
        { op: 'ingest', weight: mix.ingest },
        { op: 'policy', weight: mix.policy },
    ];

    const totalWeight = slots.reduce((sum, slot) => sum + slot.weight, 0);
    if (totalWeight <= 0) return 'access';

    let threshold = random() * totalWeight;
    for (const slot of slots) {
        threshold -= slot.weight;
        if (threshold <= 0) return slot.op;
    }
    return 'access';
}

function getPhase(profile: ProfileSpec, elapsedRatio: number): ProfilePhase {
    let cumulative = 0;
    for (const phase of profile.phases) {
        cumulative += phase.durationRatio;
        if (elapsedRatio <= cumulative) return phase;
    }
    return profile.phases[profile.phases.length - 1];
}

function atomEvent(value: string): string {
    return `v1.event.${value}`;
}

function atomState(value: string): string {
    return `v1.state.${value}`;
}

function atomFact(value: string): string {
    return `v1.fact.${value}`;
}

function atomOther(value: string): string {
    return `v1.other.${value}`;
}

async function startContinuousMetricsExporter(options: {
    profile: ContinuousProfileName;
    targetOpsPerSec: number;
    host: string;
    port: number;
}): Promise<ContinuousMetricsRuntime> {
    const registry = new Registry();

    const offeredOpsTotal = new Counter({
        name: 'mmpm_continuous_client_offered_ops_total',
        help: 'Total operations offered by continuous client',
        labelNames: ['profile', 'op'] as const,
        registers: [registry],
    });

    const completedOpsTotal = new Counter({
        name: 'mmpm_continuous_client_completed_ops_total',
        help: 'Total operations completed by continuous client',
        labelNames: ['profile', 'op', 'status'] as const,
        registers: [registry],
    });

    const inflightGauge = new Gauge({
        name: 'mmpm_continuous_client_inflight_requests',
        help: 'Current in-flight operation count in continuous client',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    const opLatencyMs = new Histogram({
        name: 'mmpm_continuous_client_op_latency_ms',
        help: 'Latency of client operations in milliseconds',
        labelNames: ['profile', 'op'] as const,
        buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
        registers: [registry],
    });

    const targetOpsGauge = new Gauge({
        name: 'mmpm_continuous_client_target_ops_per_sec',
        help: 'Configured target operations per second for continuous client',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    const predictionAccuracyGauge = new Gauge({
        name: 'mmpm_continuous_client_prediction_accuracy_ratio',
        help: 'Continuous client observed prediction accuracy ratio',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    const predictionUsefulGauge = new Gauge({
        name: 'mmpm_continuous_client_prediction_useful_ratio',
        help: 'Continuous client observed prediction usefulness ratio',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    const probeAccuracyGauge = new Gauge({
        name: 'mmpm_continuous_client_probe_accuracy_ratio',
        help: 'Scientific probe prediction accuracy ratio',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    const probeUsefulGauge = new Gauge({
        name: 'mmpm_continuous_client_probe_useful_ratio',
        help: 'Scientific probe prediction usefulness ratio',
        labelNames: ['profile'] as const,
        registers: [registry],
    });

    targetOpsGauge.set({ profile: options.profile }, options.targetOpsPerSec);
    inflightGauge.set({ profile: options.profile }, 0);

    const server = createServer(async (request, response) => {
        if (request.url === '/health') {
            response.statusCode = 200;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ ok: true }));
            return;
        }

        if (request.url !== '/metrics') {
            response.statusCode = 404;
            response.end('not found');
            return;
        }

        response.statusCode = 200;
        response.setHeader('content-type', registry.contentType);
        response.end(await registry.metrics());
    });

    await new Promise<void>((resolve) => {
        server.listen(options.port, options.host, () => resolve());
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : options.port;

    return {
        registry,
        server,
        endpoint: `http://${options.host}:${boundPort}`,
        offeredOpsTotal,
        completedOpsTotal,
        inflightGauge,
        opLatencyMs,
        targetOpsGauge,
        predictionAccuracyGauge,
        predictionUsefulGauge,
        probeAccuracyGauge,
        probeUsefulGauge,
    };
}

export function buildScientificDataset(options: {
    flows?: number;
    strongRepeats?: number;
    weakRepeats?: number;
} = {}): ScientificDataset {
    const flows = Math.max(6, options.flows ?? 36);
    const strongRepeats = Math.max(2, options.strongRepeats ?? 8);
    const weakRepeats = Math.max(1, options.weakRepeats ?? 2);

    const atomSet = new Set<string>();
    const sequences: string[][] = [];
    const evaluationCases: ScientificCase[] = [];

    for (let flowIndex = 0; flowIndex < flows; flowIndex++) {
        const flowName = `flow_${String(flowIndex + 1).padStart(4, '0')}`;
        const start = atomEvent(`${flowName}_start`);
        const dominant = atomState(`${flowName}_dominant`);
        const alternate = atomState(`${flowName}_alternate`);
        const terminal = atomFact(`${flowName}_terminal`);

        atomSet.add(start);
        atomSet.add(dominant);
        atomSet.add(alternate);
        atomSet.add(terminal);

        for (let repeat = 0; repeat < strongRepeats; repeat++) {
            sequences.push([start, dominant, terminal]);
        }
        for (let repeat = 0; repeat < weakRepeats; repeat++) {
            sequences.push([start, alternate]);
        }

        evaluationCases.push({ from: start, expected: dominant, alternate });
    }

    atomSet.add(atomOther('client_seed_a'));
    atomSet.add(atomOther('client_seed_b'));

    return {
        atoms: [...atomSet],
        trainingSequences: sequences,
        evaluationCases,
    };
}

async function postJson(baseUrl: string, path: string, payload: unknown, apiKey?: string): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
    };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    let body: any = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    return { status: response.status, body, headers: response.headers };
}

async function postWithBackpressure(baseUrl: string, path: string, payload: unknown, apiKey: string | undefined, state: { backpressureRetries: number }): Promise<void> {
    while (true) {
        const response = await postJson(baseUrl, path, payload, apiKey);
        if (response.status === 200) return;
        if (response.status !== 503) {
            throw new Error(`POST ${path} failed with status ${response.status}`);
        }
        state.backpressureRetries++;
        const retryAfterSeconds = Number(response.headers.get('retry-after') ?? '1');
        await sleep(Math.max(1, retryAfterSeconds) * 1000);
    }
}

async function seedDataset(baseUrl: string, apiKey: string | undefined, dataset: ScientificDataset, state: { backpressureRetries: number }): Promise<void> {
    const chunkSize = 200;
    for (let index = 0; index < dataset.atoms.length; index += chunkSize) {
        const chunk = dataset.atoms.slice(index, index + chunkSize);
        await postWithBackpressure(baseUrl, '/atoms', { atoms: chunk }, apiKey, state);
    }

    const commitResponse = await postJson(baseUrl, '/admin/commit', {}, apiKey);
    if (commitResponse.status !== 200) {
        throw new Error(`POST /admin/commit failed with status ${commitResponse.status}`);
    }

    for (const sequence of dataset.trainingSequences) {
        const trainResponse = await postJson(baseUrl, '/train', { sequence }, apiKey);
        if (trainResponse.status !== 200) {
            throw new Error(`POST /train failed with status ${trainResponse.status}`);
        }
    }
}

async function runAccuracyProbe(baseUrl: string, apiKey: string | undefined, dataset: ScientificDataset, samples: number, random: () => number): Promise<AccuracyProbe> {
    const attempts = Math.max(1, samples);
    const latencies: number[] = [];
    let correct = 0;
    let useful = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
        const testCase = pickOne(dataset.evaluationCases, random);
        const started = performance.now();
        const response = await postJson(baseUrl, '/access', { data: testCase.from }, apiKey);
        latencies.push(performance.now() - started);
        if (response.status !== 200) continue;

        const predictedNext = response.body?.predictedNext;
        if (typeof predictedNext === 'string') useful++;
        if (predictedNext === testCase.expected) correct++;
    }

    return {
        attempts,
        correct,
        useful,
        accuracy: attempts > 0 ? correct / attempts : 0,
        usefulRate: attempts > 0 ? useful / attempts : 0,
        latencyP95Ms: percentile(latencies, 95),
    };
}

export async function runContinuousClient(options: ContinuousClientOptions = {}): Promise<ContinuousClientStats> {
    const startedAtIso = new Date().toISOString();
    const runStarted = performance.now();

    const profileName = options.profile ?? 'balanced';
    const profile = PROFILE_SPECS[profileName];
    const baseUrl = options.baseUrl ?? 'http://127.0.0.1:3000';
    const apiKey = options.apiKey;
    const durationMs = Math.max(1000, options.durationMs ?? 30_000);
    const targetOpsPerSec = Math.max(1, options.targetOpsPerSec ?? 120);
    const concurrency = Math.max(1, options.concurrency ?? 8);
    const thinkTimeMs = Math.max(0, options.thinkTimeMs ?? 0);
    const random = createRng(options.seed ?? 42);
    const batchMin = Math.max(2, options.batchMin ?? 3);
    const batchMax = Math.max(batchMin, options.batchMax ?? 6);
    const commitEveryWrites = Math.max(1, options.commitEveryWrites ?? 10);
    const metricsHost = options.metricsHost ?? '127.0.0.1';
    const metricsPort = options.metricsPort;

    const dataset = options.dataset ?? buildScientificDataset({
        flows: options.datasetFlows,
        strongRepeats: options.strongRepeats,
        weakRepeats: options.weakRepeats,
    });

    const backpressureState = { backpressureRetries: 0 };

    await waitForApiReady(baseUrl, {
        apiKey,
        timeoutMs: Math.max(1_000, options.readinessTimeoutMs ?? 60_000),
        pollMs: 250,
    });

    await seedDataset(baseUrl, apiKey, dataset, backpressureState);

    const metrics = metricsPort === undefined
        ? null
        : await startContinuousMetricsExporter({
            profile: profileName,
            targetOpsPerSec,
            host: metricsHost,
            port: Math.max(0, metricsPort),
        });

    const stats: ContinuousClientStats = {
        profile: profileName,
        startedAt: startedAtIso,
        finishedAt: startedAtIso,
        durationMs: 0,
        targetOpsPerSec,
        concurrency,
        totalOps: 0,
        reads: 0,
        batchReads: 0,
        writesQueued: 0,
        trains: 0,
        commits: 0,
        policyChanges: 0,
        ingestionVerifiedReads: 0,
        errors: 0,
        backpressureRetries: 0,
        accessLatenciesMs: [],
        batchLatenciesMs: [],
        trainLatenciesMs: [],
        ingestLatenciesMs: [],
        commitLatenciesMs: [],
        predictionAttempts: 0,
        predictionCorrect: 0,
        predictionUseful: 0,
        predictionAccuracy: 0,
        predictionUsefulRate: 0,
        accuracyProbe: {
            attempts: 0,
            correct: 0,
            useful: 0,
            accuracy: 0,
            usefulRate: 0,
            latencyP95Ms: 0,
        },
        metricsEnabled: metrics !== null,
        metricsEndpoint: metrics ? metrics.endpoint : null,
        metricsSnapshot: undefined,
    };

    const writeBuffer: string[] = [];
    let liveWriteCounter = 0;
    let policyDefault = true;

    const expectedByFrom = new Map<string, string>(dataset.evaluationCases.map(testCase => [testCase.from, testCase.expected]));

    const perWorkerBaseSleepMs = Math.max(1, Math.round(1000 / Math.max(1, targetOpsPerSec / concurrency)));

    const runDeadline = Date.now() + durationMs;

    const runSingleOperation = async (): Promise<void> => {
        const now = Date.now();
        const elapsedRatio = Math.min(1, Math.max(0, (now - (runDeadline - durationMs)) / durationMs));
        const phase = getPhase(profile, elapsedRatio);
        const operation = weightedOperationChoice(phase.mix, random);
        metrics?.offeredOpsTotal.inc({ profile: profileName, op: operation });
        metrics?.inflightGauge.inc({ profile: profileName });

        const operationStarted = performance.now();
        const completeMetric = (status: 'success' | 'error') => {
            metrics?.completedOpsTotal.inc({ profile: profileName, op: operation, status });
            metrics?.opLatencyMs.observe({ profile: profileName, op: operation }, performance.now() - operationStarted);
            metrics?.inflightGauge.dec({ profile: profileName });
        };

        try {

            if (operation === 'access') {
                const testCase = pickOne(dataset.evaluationCases, random);
                const started = performance.now();
                const response = await postJson(baseUrl, '/access', { data: testCase.from }, apiKey);
                stats.accessLatenciesMs.push(performance.now() - started);
                stats.totalOps++;
                stats.reads++;

                if (response.status !== 200) {
                    stats.errors++;
                    completeMetric('error');
                    return;
                }

                stats.predictionAttempts++;
                const predicted = response.body?.predictedNext;
                if (typeof predicted === 'string') stats.predictionUseful++;
                if (predicted === testCase.expected) stats.predictionCorrect++;
                completeMetric('success');
                return;
            }

            if (operation === 'batch-access') {
                const batchSize = batchMin + Math.floor(random() * (batchMax - batchMin + 1));
                const requestItems: string[] = [];
                for (let index = 0; index < batchSize; index++) {
                    requestItems.push(pickOne(dataset.evaluationCases, random).from);
                }

                const started = performance.now();
                const response = await postJson(baseUrl, '/batch-access', { items: requestItems }, apiKey);
                stats.batchLatenciesMs.push(performance.now() - started);
                stats.totalOps++;
                stats.batchReads++;

                if (response.status !== 200 || !Array.isArray(response.body?.results)) {
                    stats.errors++;
                    completeMetric('error');
                    return;
                }

                for (let index = 0; index < response.body.results.length; index++) {
                    const result = response.body.results[index];
                    if (!result || result.ok !== true) continue;
                    stats.reads++;
                    stats.predictionAttempts++;
                    const requestAtom = requestItems[index];
                    const expected = expectedByFrom.get(requestAtom);
                    const predicted = result.predictedNext;
                    if (typeof predicted === 'string') stats.predictionUseful++;
                    if (expected && predicted === expected) stats.predictionCorrect++;
                }
                completeMetric('success');
                return;
            }

            if (operation === 'train') {
                const sequence = pickOne(dataset.trainingSequences, random);
                const started = performance.now();
                const response = await postJson(baseUrl, '/train', { sequence }, apiKey);
                stats.trainLatenciesMs.push(performance.now() - started);
                stats.totalOps++;
                if (response.status !== 200) {
                    stats.errors++;
                    completeMetric('error');
                    return;
                }
                stats.trains++;
                completeMetric('success');
                return;
            }

            if (operation === 'ingest') {
                liveWriteCounter++;
                const atom = atomOther(`live_${Date.now()}_${liveWriteCounter}`);
                const started = performance.now();
                const response = await postJson(baseUrl, '/atoms', { atoms: [atom] }, apiKey);
                stats.ingestLatenciesMs.push(performance.now() - started);
                stats.totalOps++;

                if (response.status === 503) {
                    stats.backpressureRetries++;
                    const retryAfterSeconds = Number(response.headers.get('retry-after') ?? '1');
                    await sleep(Math.max(1, retryAfterSeconds) * 1000);
                    completeMetric('error');
                    return;
                }
                if (response.status !== 200) {
                    stats.errors++;
                    completeMetric('error');
                    return;
                }

                stats.writesQueued++;
                writeBuffer.push(atom);

                if (writeBuffer.length >= commitEveryWrites) {
                    const commitStarted = performance.now();
                    const commitResponse = await postJson(baseUrl, '/admin/commit', {}, apiKey);
                    stats.commitLatenciesMs.push(performance.now() - commitStarted);
                    if (commitResponse.status !== 200) {
                        stats.errors++;
                        completeMetric('error');
                        return;
                    }
                    stats.commits++;

                    const probeAtom = writeBuffer.shift();
                    if (probeAtom) {
                        const probeResponse = await postJson(baseUrl, '/access', { data: probeAtom }, apiKey);
                        if (probeResponse.status === 200) {
                            stats.ingestionVerifiedReads++;
                        }
                    }
                    writeBuffer.splice(0);
                }
                completeMetric('success');
                return;
            }

            if (operation === 'policy') {
                const nextPayload = policyDefault
                    ? { policy: { event: ['state'], fact: ['state', 'event'], state: ['fact', 'state'] } }
                    : { policy: 'default' };
                const response = await postJson(baseUrl, '/policy', nextPayload, apiKey);
                stats.totalOps++;
                if (response.status !== 200) {
                    stats.errors++;
                    completeMetric('error');
                    return;
                }
                stats.policyChanges++;
                policyDefault = !policyDefault;
                completeMetric('success');
            }
        } catch (error) {
            completeMetric('error');
            throw error;
        }
    };

    const workers = Array.from({ length: concurrency }, async () => {
        while (Date.now() < runDeadline) {
            const elapsedRatio = Math.min(1, Math.max(0, (Date.now() - (runDeadline - durationMs)) / durationMs));
            const phase = getPhase(profile, elapsedRatio);
            try {
                await runSingleOperation();
            } catch {
                stats.errors++;
            }

            const jitter = 0.8 + random() * 0.4;
            const phaseSleepMs = Math.max(1, Math.round((perWorkerBaseSleepMs / Math.max(0.1, phase.opsMultiplier)) * jitter + thinkTimeMs));
            await sleep(phaseSleepMs);
        }
    });

    await Promise.all(workers);

    if (writeBuffer.length > 0) {
        const commitStarted = performance.now();
        const commitResponse = await postJson(baseUrl, '/admin/commit', {}, apiKey);
        stats.commitLatenciesMs.push(performance.now() - commitStarted);
        if (commitResponse.status === 200) {
            stats.commits++;
            const probeAtom = writeBuffer[0];
            if (probeAtom) {
                const probeResponse = await postJson(baseUrl, '/access', { data: probeAtom }, apiKey);
                if (probeResponse.status === 200) stats.ingestionVerifiedReads++;
            }
        } else {
            stats.errors++;
        }
    }

    // Ensure probe runs under default policy for deterministic comparability.
    if (!policyDefault) {
        const resetPolicyResponse = await postJson(baseUrl, '/policy', { policy: 'default' }, apiKey);
        if (resetPolicyResponse.status === 200) {
            policyDefault = true;
        } else {
            stats.errors++;
        }
    }

    stats.accuracyProbe = await runAccuracyProbe(baseUrl, apiKey, dataset, Math.min(240, dataset.evaluationCases.length * 4), random);

    stats.predictionAccuracy = stats.predictionAttempts > 0 ? stats.predictionCorrect / stats.predictionAttempts : 0;
    stats.predictionUsefulRate = stats.predictionAttempts > 0 ? stats.predictionUseful / stats.predictionAttempts : 0;
    stats.backpressureRetries += backpressureState.backpressureRetries;

    if (metrics) {
        metrics.predictionAccuracyGauge.set({ profile: profileName }, stats.predictionAccuracy);
        metrics.predictionUsefulGauge.set({ profile: profileName }, stats.predictionUsefulRate);
        metrics.probeAccuracyGauge.set({ profile: profileName }, stats.accuracyProbe.accuracy);
        metrics.probeUsefulGauge.set({ profile: profileName }, stats.accuracyProbe.usefulRate);
        stats.metricsSnapshot = await metrics.registry.metrics();
        await new Promise<void>((resolve) => metrics.server.close(() => resolve()));
    }

    stats.durationMs = Math.max(1, Math.round(performance.now() - runStarted));
    stats.finishedAt = new Date().toISOString();

    return stats;
}

function argValue(argv: string[], key: string): string | null {
    const index = argv.indexOf(`--${key}`);
    if (index < 0 || index + 1 >= argv.length) return null;
    return argv[index + 1];
}

function parseNumber(argv: string[], key: string, fallback: number): number {
    const raw = argValue(argv, key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseProfile(argv: string[]): ContinuousProfileName {
    const raw = (argValue(argv, 'profile') ?? 'balanced').toLowerCase();
    if (raw === 'balanced' || raw === 'read-heavy' || raw === 'write-heavy' || raw === 'policy-stress') {
        return raw;
    }
    throw new Error(`Unsupported profile '${raw}'. Use balanced|read-heavy|write-heavy|policy-stress.`);
}

function hasFlag(argv: string[], key: string): boolean {
    return argv.includes(`--${key}`);
}

function renderSummary(stats: ContinuousClientStats): string {
    const row = (name: string, value: string) => `${name.padEnd(28)} ${value}`;
    return [
        'MMPM Continuous Client Report',
        row('profile', stats.profile),
        row('durationMs', String(stats.durationMs)),
        row('targetOpsPerSec', String(stats.targetOpsPerSec)),
        row('concurrency', String(stats.concurrency)),
        row('totalOps', String(stats.totalOps)),
        row('reads / batchReads', `${stats.reads} / ${stats.batchReads}`),
        row('writesQueued / commits', `${stats.writesQueued} / ${stats.commits}`),
        row('trains / policyChanges', `${stats.trains} / ${stats.policyChanges}`),
        row('ingestionVerifiedReads', String(stats.ingestionVerifiedReads)),
        row('errors / backpressure', `${stats.errors} / ${stats.backpressureRetries}`),
        row('predictionAccuracy', `${(stats.predictionAccuracy * 100).toFixed(2)}%`),
        row('predictionUsefulRate', `${(stats.predictionUsefulRate * 100).toFixed(2)}%`),
        row('probeAccuracy', `${(stats.accuracyProbe.accuracy * 100).toFixed(2)}%`),
        row('probeUsefulRate', `${(stats.accuracyProbe.usefulRate * 100).toFixed(2)}%`),
        row('probeLatencyP95Ms', stats.accuracyProbe.latencyP95Ms.toFixed(3)),
    ].join('\n');
}

async function runCli() {
    const argv = process.argv.slice(2);

    if (hasFlag(argv, 'help')) {
        console.log([
            'Usage: ts-node tools/harness/continuous_client.ts [options]',
            '',
            'Options:',
            '  --profile balanced|read-heavy|write-heavy|policy-stress',
            '  --baseUrl http://127.0.0.1:3000',
            '  --apiKey <token>',
            '  --duration-ms 60000',
            '  --target-ops 120',
            '  --concurrency 8',
            '  --dataset-flows 36',
            '  --strong-repeats 8',
            '  --weak-repeats 2',
            '  --metrics-port 9470',
            '  --metrics-host 127.0.0.1',
            '  --json',
            '',
            'Example:',
            '  ts-node tools/harness/continuous_client.ts --profile balanced --duration-ms 60000 --target-ops 150 --concurrency 10',
        ].join('\n'));
        return;
    }

    const stats = await runContinuousClient({
        baseUrl: argValue(argv, 'baseUrl') ?? undefined,
        apiKey: argValue(argv, 'apiKey') ?? process.env.MMPM_API_KEY ?? undefined,
        profile: parseProfile(argv),
        durationMs: parseNumber(argv, 'duration-ms', 60_000),
        targetOpsPerSec: parseNumber(argv, 'target-ops', 120),
        concurrency: parseNumber(argv, 'concurrency', 8),
        thinkTimeMs: parseNumber(argv, 'think-time-ms', 0),
        seed: parseNumber(argv, 'seed', 42),
        datasetFlows: parseNumber(argv, 'dataset-flows', 36),
        strongRepeats: parseNumber(argv, 'strong-repeats', 8),
        weakRepeats: parseNumber(argv, 'weak-repeats', 2),
        batchMin: parseNumber(argv, 'batch-min', 3),
        batchMax: parseNumber(argv, 'batch-max', 6),
        commitEveryWrites: parseNumber(argv, 'commit-every-writes', 10),
        readinessTimeoutMs: parseNumber(argv, 'ready-timeout-ms', 60_000),
        metricsPort: argValue(argv, 'metrics-port') === null ? undefined : parseNumber(argv, 'metrics-port', 9470),
        metricsHost: argValue(argv, 'metrics-host') ?? '127.0.0.1',
    });

    if (hasFlag(argv, 'json')) {
        console.log(JSON.stringify(stats, null, 2));
        return;
    }

    console.log(renderSummary(stats));
}

if (require.main === module) {
    runCli().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
