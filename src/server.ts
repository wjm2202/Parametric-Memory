import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import { ShardedOrchestrator } from './orchestrator';
import { collectDefaultMetrics, register } from 'prom-client';
import { accessCounter, requestDuration, trainCounter, trainSequenceLength } from './metrics';

// Collect Node.js / process metrics automatically (visible at GET /metrics)
collectDefaultMetrics();

interface BuildAppOpts {
    data?: string[];
    dbBasePath?: string;
    numShards?: number;
    apiKey?: string;
}

export function buildApp(opts: BuildAppOpts = {}): { server: FastifyInstance; orchestrator: ShardedOrchestrator } {
    const server = Fastify({ logger: false });
    const numShards = opts.numShards ?? parseInt(process.env.SHARD_COUNT ?? '4');
    const dbBasePath = opts.dbBasePath ?? (process.env.DB_BASE_PATH ?? './mmpm-db');
    const initialData = opts.data ?? (process.env.MMPM_INITIAL_DATA?.split(',') ?? ['Node_A', 'Node_B', 'Node_C', 'Node_D', 'Node_E', 'Step_1', 'Step_2']);
    const apiKey = opts.apiKey ?? (process.env.MMPM_API_KEY || undefined);
    const orchestrator = new ShardedOrchestrator(numShards, initialData, dbBasePath);

    // Optional Bearer token auth — /metrics always bypasses
    if (apiKey) {
        server.addHook('onRequest', async (request, reply) => {
            if (request.url === '/metrics') return;
            const auth = request.headers.authorization;
            if (!auth || auth !== `Bearer ${apiKey}`) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        });
    }

    /**
     * POST /access  —  Body: { "data": "Node_A" }
     */
    server.post('/access', async (request, reply) => {
        try {
            const { data: item } = request.body as { data?: string };
            if (!item || typeof item !== 'string') {
                return reply.status(400).send({ error: "Property 'data' is required." });
            }
            const report = await orchestrator.access(item);
            const result = report.predictedNext !== null ? 'hit' : 'miss';
            accessCounter.inc({ result });
            requestDuration.observe(report.latencyMs);
            return report;
        } catch (e: any) {
            accessCounter.inc({ result: 'error' });
            return reply.status(404).send({ error: e.message });
        }
    });

    /**
     * POST /train  —  Body: { "sequence": ["Node_A", "Node_B"] }
     */
    server.post('/train', async (request, reply) => {
        try {
            const { sequence } = request.body as { sequence?: unknown };
            if (!sequence || !Array.isArray(sequence) || !sequence.every(s => typeof s === 'string')) {
                return reply.status(400).send({ error: "Property 'sequence' must be a non-empty array of strings." });
            }
            await orchestrator.train(sequence as string[]);
            trainCounter.inc();
            trainSequenceLength.observe(sequence.length);
            return { status: 'Success', message: `Trained path of length ${sequence.length} across shards.` };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /metrics  —  Prometheus scrape endpoint
     */
    server.get('/metrics', async (request, reply) => {
        reply.header('Content-Type', register.contentType);
        return register.metrics();
    });

    return { server, orchestrator };
}

// Only run when invoked directly
if (require.main === module) {
    const PORT = parseInt(process.env.PORT ?? '3000');
    const HOST = process.env.HOST ?? '0.0.0.0';
    const NUM_SHARDS = parseInt(process.env.SHARD_COUNT ?? '4');

    const { server, orchestrator } = buildApp({ numShards: NUM_SHARDS });

    const shutdown = async () => { await server.close(); await orchestrator.close(); process.exit(0); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    (async () => {
        try {
            await orchestrator.init();
            await server.listen({ port: PORT, host: HOST });
            console.log(`MMPM Cluster Online — Shards: ${NUM_SHARDS} | ${HOST}:${PORT}`);
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    })();
}