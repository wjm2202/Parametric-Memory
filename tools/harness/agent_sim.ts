import { performance } from 'perf_hooks';
import { ShardedOrchestrator } from '../../src/orchestrator';
import { DataAtom } from '../../src/types';
import { AgentSimStats } from './report';
import { waitForApiReady } from './api_ready';

export interface AgentSimOptions {
    useApi?: boolean;
    baseUrl?: string;
    apiKey?: string;
    orchestrator?: ShardedOrchestrator;
    agents?: number;
    durationMs?: number;
    readRatio?: number;
    writeRatio?: number;
    trainRatio?: number;
    thinkTimeMs?: number;
    followPredictionRatio?: number;
    initialAtoms?: DataAtom[];
    ensureInitialAtoms?: boolean;
    commitEveryWrites?: number;
    seed?: number;
}

export interface AgentSimulationStats extends AgentSimStats {
    startedAt: string;
    finishedAt: string;
    errors: number;
    trainCalls: number;
    predictionAttempts: number;
    predictionFollows: number;
    perAgentOps: number[];
}

interface AccessResponse {
    currentData: string;
    predictedNext: string | null;
    treeVersion?: number;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function pickOne<T>(items: T[], rand: () => number): T {
    return items[Math.floor(rand() * items.length)];
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

async function enqueueAtomsWithBackpressure(
    baseUrl: string,
    atoms: string[],
    apiKey?: string
): Promise<void> {
    const res = await postJson(baseUrl, '/atoms', { atoms }, apiKey);
    if (res.status === 200) return;
    if (res.status === 503) {
        const retryAfterSec = Number(res.headers.get('retry-after') ?? '1');
        await sleep(Math.max(1, retryAfterSec) * 1000);
        return enqueueAtomsWithBackpressure(baseUrl, atoms, apiKey);
    }
    throw new Error(`POST /atoms failed with status ${res.status}`);
}

async function ensureSeededAtoms(
    opts: { useApi: boolean; baseUrl: string; apiKey?: string } & {
        orchestrator?: ShardedOrchestrator;
    },
    atoms: string[]
): Promise<void> {
    if (atoms.length === 0) return;

    if (opts.useApi) {
        await enqueueAtomsWithBackpressure(opts.baseUrl, atoms, opts.apiKey);
        const commitRes = await postJson(opts.baseUrl, '/admin/commit', {}, opts.apiKey);
        if (commitRes.status !== 200) {
            throw new Error(`POST /admin/commit failed with status ${commitRes.status}`);
        }
        return;
    }

    if (!opts.orchestrator) throw new Error('Embedded mode requires options.orchestrator');
    await opts.orchestrator.addAtoms(atoms);
}

export async function runAgentSimulation(options: AgentSimOptions = {}): Promise<AgentSimulationStats> {
    const startedAt = new Date().toISOString();
    const runStart = performance.now();

    const useApi = options.useApi === true;
    const baseUrl = options.baseUrl ?? 'http://localhost:3000';
    const apiKey = options.apiKey;
    const orchestrator = options.orchestrator;

    if (!useApi && !orchestrator) {
        throw new Error('Embedded mode requires options.orchestrator');
    }
    if (useApi) {
        await waitForApiReady(baseUrl, { apiKey });
    }

    const agents = Math.max(1, options.agents ?? 12);
    const durationMs = Math.max(200, options.durationMs ?? 10_000);
    const thinkTimeMs = Math.max(0, options.thinkTimeMs ?? 5);
    const followPredictionRatio = Math.min(1, Math.max(0, options.followPredictionRatio ?? 0.7));
    const commitEveryWrites = Math.max(1, options.commitEveryWrites ?? 5);
    const seed = options.seed ?? 42;

    const writeRatio = Math.min(1, Math.max(0, options.writeRatio ?? 0.1));
    const trainRatio = Math.min(1, Math.max(0, options.trainRatio ?? 0.2));
    const readRatioRaw = Math.max(0, options.readRatio ?? 0.7);
    const totalRatio = readRatioRaw + writeRatio + trainRatio;
    const readRatio = totalRatio > 0 ? readRatioRaw / totalRatio : 1;
    const normWriteRatio = totalRatio > 0 ? writeRatio / totalRatio : 0;
    const normTrainRatio = totalRatio > 0 ? trainRatio / totalRatio : 0;

    const atomPool = [...new Set(options.initialAtoms ?? ['AgentSeed_A', 'AgentSeed_B', 'AgentSeed_C'])];
    const committedPool = [...atomPool];
    const pendingPool: string[] = [];
    if (options.ensureInitialAtoms === true) {
        await ensureSeededAtoms({ useApi, baseUrl, apiKey, orchestrator }, atomPool);
    }

    const stats: AgentSimulationStats = {
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        totalOps: 0,
        reads: 0,
        writes: 0,
        commits: 0,
        trainCalls: 0,
        accessLatenciesMs: [],
        commitLatenciesMs: [],
        staleReads: 0,
        versionMismatches: 0,
        errors: 0,
        predictionAttempts: 0,
        predictionFollows: 0,
        perAgentOps: Array.from({ length: agents }, () => 0),
    };

    const deadline = Date.now() + durationMs;
    let pendingApiWrites = 0;
    let dynamicSeq = 0;

    const accessAtom = async (atom: string): Promise<AccessResponse> => {
        if (useApi) {
            const res = await postJson(baseUrl, '/access', { data: atom }, apiKey);
            if (res.status !== 200) throw new Error(`POST /access failed with status ${res.status}`);
            return res.body as AccessResponse;
        }
        if (!orchestrator) throw new Error('Embedded mode requires options.orchestrator');
        return await orchestrator.access(atom);
    };

    const trainSeq = async (sequence: string[]): Promise<void> => {
        if (useApi) {
            const res = await postJson(baseUrl, '/train', { sequence }, apiKey);
            if (res.status !== 200) throw new Error(`POST /train failed with status ${res.status}`);
            return;
        }
        if (!orchestrator) throw new Error('Embedded mode requires options.orchestrator');
        await orchestrator.train(sequence);
    };

    const ingestOneAtom = async (atom: string): Promise<void> => {
        if (useApi) {
            await enqueueAtomsWithBackpressure(baseUrl, [atom], apiKey);
            pendingApiWrites++;
            if (pendingApiWrites >= commitEveryWrites) {
                const tCommit = performance.now();
                const commitRes = await postJson(baseUrl, '/admin/commit', {}, apiKey);
                stats.commitLatenciesMs.push(performance.now() - tCommit);
                if (commitRes.status !== 200) {
                    throw new Error(`POST /admin/commit failed with status ${commitRes.status}`);
                }
                if (pendingPool.length > 0) committedPool.push(...pendingPool.splice(0));
                stats.commits++;
                pendingApiWrites = 0;
            }
            return;
        }

        if (!orchestrator) throw new Error('Embedded mode requires options.orchestrator');
        const tCommit = performance.now();
        await orchestrator.addAtoms([atom]);
        stats.commitLatenciesMs.push(performance.now() - tCommit);
        stats.commits++;
    };

    const runAgent = async (agentId: number) => {
        const rand = createRng(seed + agentId * 9973);
        let current = pickOne(committedPool, rand);

        while (Date.now() < deadline) {
            const roll = rand();
            try {
                if (roll < readRatio) {
                    const t0 = performance.now();
                    const report = await accessAtom(current);
                    const latency = performance.now() - t0;
                    stats.accessLatenciesMs.push(latency);
                    stats.reads++;
                    stats.totalOps++;
                    stats.perAgentOps[agentId]++;

                    if (report.predictedNext) {
                        stats.predictionAttempts++;
                        if (rand() < followPredictionRatio) {
                            stats.predictionFollows++;
                            current = report.predictedNext;
                        } else {
                            current = pickOne(committedPool, rand);
                        }
                    } else {
                        current = pickOne(committedPool, rand);
                    }
                } else if (roll < readRatio + normTrainRatio) {
                    const a = pickOne(committedPool, rand);
                    const b = pickOne(committedPool, rand);
                    const c = pickOne(committedPool, rand);
                    await trainSeq([a, b, c]);
                    stats.trainCalls++;
                    stats.totalOps++;
                    stats.perAgentOps[agentId]++;
                    current = a;
                } else if (roll < readRatio + normTrainRatio + normWriteRatio) {
                    const atom = `Agent_${agentId}_${dynamicSeq++}`;
                    await ingestOneAtom(atom);
                    atomPool.push(atom);
                    if (useApi) pendingPool.push(atom);
                    else committedPool.push(atom);
                    stats.writes++;
                    stats.totalOps++;
                    stats.perAgentOps[agentId]++;
                    current = pickOne(committedPool, rand);
                }
            } catch {
                stats.errors++;
                current = pickOne(committedPool.length > 0 ? committedPool : atomPool, rand);
            }

            if (thinkTimeMs > 0) {
                const jitter = Math.round(rand() * thinkTimeMs * 0.5);
                await sleep(thinkTimeMs + jitter);
            }
        }
    };

    await Promise.all(Array.from({ length: agents }, (_, i) => runAgent(i)));

    if (useApi && pendingApiWrites > 0) {
        const tCommit = performance.now();
        const commitRes = await postJson(baseUrl, '/admin/commit', {}, apiKey);
        stats.commitLatenciesMs.push(performance.now() - tCommit);
        if (commitRes.status === 200) {
            if (pendingPool.length > 0) committedPool.push(...pendingPool.splice(0));
            stats.commits++;
        }
    }

    stats.durationMs = performance.now() - runStart;
    stats.finishedAt = new Date().toISOString();
    return stats;
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

    let orchestrator: ShardedOrchestrator | undefined;
    if (!useApi) {
        orchestrator = new ShardedOrchestrator(4, ['AgentCli_A', 'AgentCli_B'], './mmpm-harness-agent-db');
        await orchestrator.init();
    }

    try {
        const stats = await runAgentSimulation({
            useApi,
            baseUrl: parseArgString(argv, 'baseUrl') ?? 'http://localhost:3000',
            apiKey: parseArgString(argv, 'apiKey') ?? undefined,
            orchestrator,
            agents: parseArgNumber(argv, 'agents', 20),
            durationMs: parseArgNumber(argv, 'durationMs', 20_000),
            readRatio: parseArgNumber(argv, 'readRatio', 0.7),
            writeRatio: parseArgNumber(argv, 'writeRatio', 0.1),
            trainRatio: parseArgNumber(argv, 'trainRatio', 0.2),
            thinkTimeMs: parseArgNumber(argv, 'thinkTimeMs', 5),
            followPredictionRatio: parseArgNumber(argv, 'followPredictionRatio', 0.7),
            commitEveryWrites: parseArgNumber(argv, 'commitEveryWrites', 5),
            ensureInitialAtoms: true,
            initialAtoms: ['AgentCli_A', 'AgentCli_B', 'AgentCli_C', 'AgentCli_D'],
            seed: parseArgNumber(argv, 'seed', 42),
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
