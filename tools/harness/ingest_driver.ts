import { GeneratedDataset, generateStructuredDataset } from './generator';
import { ShardedOrchestrator } from '../../src/orchestrator';
import { waitForApiReady } from './api_ready';

export type IngestMode = 'bulk' | 'streaming' | 'burst';

export interface IngestDriverOptions {
    mode: IngestMode;
    useApi?: boolean;
    baseUrl?: string;
    apiKey?: string;
    orchestrator?: ShardedOrchestrator;
    atomsPerSecond?: number;
    chunkSize?: number;
    burstEveryMs?: number;
    burstSize?: number;
    maxAccessProbes?: number;
}

export interface IngestDriverStats {
    mode: IngestMode;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    atomsQueued: number;
    atomsCommitted: number;
    trainCalls: number;
    ingestionLatenciesMs: number[];
    backpressureEvents: number;
    accessProbes: number;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
}

function randInt(max: number): number {
    return Math.floor(Math.random() * max);
}

async function postJson(
    baseUrl: string,
    path: string,
    payload: unknown,
    apiKey?: string
): Promise<{ status: number; body: any; headers: Headers }> {
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

    return { status: res.status, body, headers: res.headers };
}

async function runEmbedded(
    dataset: GeneratedDataset,
    options: IngestDriverOptions,
    stats: Omit<IngestDriverStats, 'finishedAt' | 'durationMs'>
): Promise<void> {
    const orchestrator = options.orchestrator;
    if (!orchestrator) {
        throw new Error('Embedded ingestion requires options.orchestrator');
    }

    const chunkSize = Math.max(1, options.chunkSize ?? 100);
    const atomsPerSecond = Math.max(1, options.atomsPerSecond ?? 1000);
    const burstEveryMs = Math.max(100, options.burstEveryMs ?? 1000);
    const burstSize = Math.max(1, options.burstSize ?? 500);

    const enqueueChunk = async (atoms: string[]) => {
        const t0 = performance.now();
        await orchestrator.addAtoms(atoms);
        stats.ingestionLatenciesMs.push(performance.now() - t0);
        stats.atomsQueued += atoms.length;
        stats.atomsCommitted += atoms.length;
    };

    if (options.mode === 'bulk') {
        for (const atoms of chunk(dataset.atoms, chunkSize)) {
            await enqueueChunk(atoms);
        }
        for (const seq of dataset.sequences) {
            await orchestrator.train(seq);
            stats.trainCalls++;
        }
        return;
    }

    if (options.mode === 'streaming') {
        for (const atoms of chunk(dataset.atoms, chunkSize)) {
            await enqueueChunk(atoms);
            if (stats.trainCalls < dataset.sequences.length) {
                await orchestrator.train(dataset.sequences[stats.trainCalls]);
                stats.trainCalls++;
            }
            const waitMs = Math.max(0, Math.round((atoms.length / atomsPerSecond) * 1000));
            if (waitMs > 0) await sleep(waitMs);
        }
        while (stats.trainCalls < dataset.sequences.length) {
            await orchestrator.train(dataset.sequences[stats.trainCalls]);
            stats.trainCalls++;
        }
        return;
    }

    let nextBurstAt = Date.now();
    const queue = [...dataset.atoms];
    let seqIdx = 0;

    while (queue.length > 0) {
        const now = Date.now();
        const size = now >= nextBurstAt ? Math.min(burstSize, queue.length) : Math.min(chunkSize, queue.length);
        const atoms = queue.splice(0, size);
        await enqueueChunk(atoms);

        if (seqIdx < dataset.sequences.length) {
            await orchestrator.train(dataset.sequences[seqIdx++]);
            stats.trainCalls++;
        }

        if (now >= nextBurstAt) {
            nextBurstAt = now + burstEveryMs;
        } else {
            const waitMs = Math.max(0, Math.round((size / atomsPerSecond) * 1000));
            if (waitMs > 0) await sleep(waitMs);
        }
    }

    while (seqIdx < dataset.sequences.length) {
        await orchestrator.train(dataset.sequences[seqIdx++]);
        stats.trainCalls++;
    }
}

async function runApi(
    dataset: GeneratedDataset,
    options: IngestDriverOptions,
    stats: Omit<IngestDriverStats, 'finishedAt' | 'durationMs'>
): Promise<void> {
    const baseUrl = options.baseUrl ?? 'http://localhost:3000';
    await waitForApiReady(baseUrl, { apiKey: options.apiKey });
    const chunkSize = Math.max(1, options.chunkSize ?? 100);
    const atomsPerSecond = Math.max(1, options.atomsPerSecond ?? 1000);
    const burstEveryMs = Math.max(100, options.burstEveryMs ?? 1000);
    const burstSize = Math.max(1, options.burstSize ?? 500);

    const enqueueChunk = async (atoms: string[]) => {
        const t0 = performance.now();
        const res = await postJson(baseUrl, '/atoms', { atoms }, options.apiKey);
        stats.ingestionLatenciesMs.push(performance.now() - t0);

        if (res.status === 503) {
            stats.backpressureEvents++;
            const retryAfterSec = Number(res.headers.get('retry-after') ?? '1');
            await sleep(Math.max(1, retryAfterSec) * 1000);
            return enqueueChunk(atoms);
        }
        if (res.status !== 200) {
            throw new Error(`POST /atoms failed with status ${res.status}`);
        }

        stats.atomsQueued += atoms.length;
    };

    const trainOne = async (sequence: string[]) => {
        const res = await postJson(baseUrl, '/train', { sequence }, options.apiKey);
        if (res.status !== 200) {
            throw new Error(`POST /train failed with status ${res.status}`);
        }
        stats.trainCalls++;
    };

    if (options.mode === 'bulk') {
        for (const atoms of chunk(dataset.atoms, chunkSize)) await enqueueChunk(atoms);
        await postJson(baseUrl, '/admin/commit', {}, options.apiKey);
        stats.atomsCommitted = stats.atomsQueued;
        for (const seq of dataset.sequences) await trainOne(seq);
        return;
    }

    if (options.mode === 'streaming') {
        let seqIdx = 0;
        for (const atoms of chunk(dataset.atoms, chunkSize)) {
            await enqueueChunk(atoms);
            if (seqIdx < dataset.sequences.length) await trainOne(dataset.sequences[seqIdx++]);
            const waitMs = Math.max(0, Math.round((atoms.length / atomsPerSecond) * 1000));
            if (waitMs > 0) await sleep(waitMs);
        }
        await postJson(baseUrl, '/admin/commit', {}, options.apiKey);
        stats.atomsCommitted = stats.atomsQueued;
        while (seqIdx < dataset.sequences.length) await trainOne(dataset.sequences[seqIdx++]);
        return;
    }

    const queue = [...dataset.atoms];
    let nextBurstAt = Date.now();
    let seqIdx = 0;

    while (queue.length > 0) {
        const now = Date.now();
        const size = now >= nextBurstAt ? Math.min(burstSize, queue.length) : Math.min(chunkSize, queue.length);
        const atoms = queue.splice(0, size);
        await enqueueChunk(atoms);
        if (seqIdx < dataset.sequences.length) await trainOne(dataset.sequences[seqIdx++]);

        if (now >= nextBurstAt) {
            nextBurstAt = now + burstEveryMs;
        } else {
            const waitMs = Math.max(0, Math.round((size / atomsPerSecond) * 1000));
            if (waitMs > 0) await sleep(waitMs);
        }
    }

    await postJson(baseUrl, '/admin/commit', {}, options.apiKey);
    stats.atomsCommitted = stats.atomsQueued;

    while (seqIdx < dataset.sequences.length) await trainOne(dataset.sequences[seqIdx++]);
}

async function runAccessProbes(
    dataset: GeneratedDataset,
    options: IngestDriverOptions,
    stats: Omit<IngestDriverStats, 'finishedAt' | 'durationMs'>
): Promise<void> {
    const probes = Math.max(0, options.maxAccessProbes ?? 25);
    if (probes === 0 || dataset.atoms.length === 0) return;

    if (options.useApi) {
        const baseUrl = options.baseUrl ?? 'http://localhost:3000';
        for (let i = 0; i < probes; i++) {
            const atom = dataset.atoms[randInt(dataset.atoms.length)];
            const res = await postJson(baseUrl, '/access', { data: atom }, options.apiKey);
            if (res.status === 200) stats.accessProbes++;
        }
        return;
    }

    const orchestrator = options.orchestrator;
    if (!orchestrator) return;
    for (let i = 0; i < probes; i++) {
        const atom = dataset.atoms[randInt(dataset.atoms.length)];
        await orchestrator.access(atom);
        stats.accessProbes++;
    }
}

export async function runIngestionDriver(
    dataset: GeneratedDataset,
    options: IngestDriverOptions
): Promise<IngestDriverStats> {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    const stats: Omit<IngestDriverStats, 'finishedAt' | 'durationMs'> = {
        mode: options.mode,
        startedAt,
        atomsQueued: 0,
        atomsCommitted: 0,
        trainCalls: 0,
        ingestionLatenciesMs: [],
        backpressureEvents: 0,
        accessProbes: 0,
    };

    if (options.useApi) {
        await runApi(dataset, options, stats);
    } else {
        await runEmbedded(dataset, options, stats);
    }

    await runAccessProbes(dataset, options, stats);

    return {
        ...stats,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - t0,
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
    const mode = (parseArgString(argv, 'mode') as IngestMode | null) ?? 'streaming';
    const useApi = argv.includes('--api');

    const dataset = generateStructuredDataset({
        totalAtoms: parseArgNumber(argv, 'atoms', 10000),
        avgChainLength: parseArgNumber(argv, 'avgChainLength', 12),
        branchFactor: parseArgNumber(argv, 'branchFactor', 0.15),
        vocabularySize: parseArgNumber(argv, 'vocabulary', 5000),
        seed: parseArgNumber(argv, 'seed', 42),
    });

    let orchestrator: ShardedOrchestrator | undefined;
    if (!useApi) {
        orchestrator = new ShardedOrchestrator(4, ['Boot_A', 'Boot_B'], './mmpm-harness-db');
        await orchestrator.init();
    }

    try {
        const stats = await runIngestionDriver(dataset, {
            mode,
            useApi,
            baseUrl: parseArgString(argv, 'baseUrl') ?? 'http://localhost:3000',
            apiKey: parseArgString(argv, 'apiKey') ?? undefined,
            orchestrator,
            atomsPerSecond: parseArgNumber(argv, 'atomsPerSecond', 1000),
            chunkSize: parseArgNumber(argv, 'chunkSize', 100),
            burstEveryMs: parseArgNumber(argv, 'burstEveryMs', 1000),
            burstSize: parseArgNumber(argv, 'burstSize', 500),
            maxAccessProbes: parseArgNumber(argv, 'maxAccessProbes', 25),
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
