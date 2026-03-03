import 'dotenv/config';
import { readFileSync } from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import { ShardedOrchestrator } from './orchestrator';
import { IngestionPipeline } from './ingestion';
import { collectDefaultMetrics, register } from 'prom-client';
import {
    accessCounter,
    requestDuration,
    trainCounter,
    trainSequenceLength,
    atomDominanceRatio,
    atomTrainedEdges,
    clusterTotalEdges,
    clusterTrainedAtoms,
    transitionByTypeTotal,
} from './metrics';
import { logger } from './logger';
import { assertAtomsV1, ATOM_TYPES, AtomType, encodeAtomV1, isAtomV1, normalizeAtomInput, parseAtomV1 } from './atom_schema';
import { TransitionPolicy, TypePolicyConfig } from './transition_policy';

// Collect Node.js / process metrics automatically (visible at GET /metrics)
collectDefaultMetrics();

interface BuildAppOpts {
    data?: string[];
    atomSeedFile?: string;   // path to a JSON file: ["atom1", "atom2", ...]
    dbBasePath?: string;
    numShards?: number;
    apiKey?: string;
}

const SCHEMA_ERROR = "schema v1 required: use 'v1.<type>.<value>' or object { type, value } with type in {fact,event,relation,state,other}.";

function isAtomType(value: unknown): value is AtomType {
    return typeof value === 'string' && (ATOM_TYPES as readonly string[]).includes(value);
}

function parsePolicyConfig(input: unknown): TypePolicyConfig | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const raw = input as Record<string, unknown>;
    const config: TypePolicyConfig = {};

    for (const [fromKey, toList] of Object.entries(raw)) {
        if (!isAtomType(fromKey)) return null;
        if (!Array.isArray(toList)) return null;
        if (!toList.every(isAtomType)) return null;
        config[fromKey] = toList as AtomType[];
    }

    return config;
}

/** Load a JSON seed file and return its atom array, or null on any error. */
function loadSeedFile(filePath: string): string[] | null {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            logger.warn(`MMPM seed file '${filePath}' must be a JSON array — ignored.`);
            return null;
        }
        const normalized = parsed.map(normalizeAtomInput);
        if (normalized.some(x => x === null)) {
            logger.warn(`MMPM seed file '${filePath}' contains non-v1 atoms — ignored.`);
            return null;
        }
        if (parsed.length === 0) {
            logger.warn(`MMPM seed file '${filePath}' is empty — ignored.`);
            return null;
        }
        logger.info(`MMPM loaded ${normalized.length} schema-v1 atoms from seed file: ${filePath}`);
        return normalized as string[];
    } catch (e: any) {
        logger.warn(`MMPM could not read seed file '${filePath}': ${e.message}`);
        return null;
    }
}

export function buildApp(opts: BuildAppOpts = {}): { server: FastifyInstance; orchestrator: ShardedOrchestrator; pipeline: IngestionPipeline } {
    const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
    const numShards = opts.numShards ?? parseInt(process.env.SHARD_COUNT ?? '4');
    const dbBasePath = opts.dbBasePath ?? (process.env.DB_BASE_PATH ?? './mmpm-db');

    // Atom resolution order (first non-null wins):
    //   1. opts.data  — programmatic / test usage
    //   2. opts.atomSeedFile or MMPM_ATOM_FILE  — JSON file mounted at deploy time
    //   3. MMPM_INITIAL_DATA  — comma-separated env var (legacy / simple cases)
    //   4. built-in defaults
    const seedFilePath = opts.atomSeedFile ?? process.env.MMPM_ATOM_FILE;
    const initialData =
        opts.data ??
        (seedFilePath ? loadSeedFile(seedFilePath) : null) ??
        (process.env.MMPM_INITIAL_DATA?.split(',')) ??
        [
            encodeAtomV1('other', 'Node_A'),
            encodeAtomV1('other', 'Node_B'),
            encodeAtomV1('other', 'Node_C'),
            encodeAtomV1('other', 'Node_D'),
            encodeAtomV1('other', 'Node_E'),
            encodeAtomV1('other', 'Step_1'),
            encodeAtomV1('other', 'Step_2'),
        ];

    assertAtomsV1(initialData, 'initialData');

    const apiKey = opts.apiKey ?? (process.env.MMPM_API_KEY || undefined);
    const orchestrator = new ShardedOrchestrator(numShards, initialData, dbBasePath);
    // Ingestion pipeline: batches incoming atoms, flushes without blocking reads.
    // batchSize and flushIntervalMs can be tuned via env vars.
    const pipeline = new IngestionPipeline(orchestrator, {
        batchSize: parseInt(process.env.INGEST_BATCH_SIZE ?? '100'),
        flushIntervalMs: parseInt(process.env.INGEST_FLUSH_MS ?? '1000'),
    });

    const probePaths = new Set(['/metrics', '/health', '/ready']);

    // Optional Bearer token auth — /metrics always bypasses
    if (apiKey) {
        server.addHook('onRequest', async (request, reply) => {
            if (probePaths.has(request.url)) return;
            const auth = request.headers.authorization;
            if (!auth || auth !== `Bearer ${apiKey}`) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        });
    }

    // Startup/readiness guard for strict orchestrator behavior.
    // Probes remain available while the service is still initializing.
    server.addHook('onRequest', async (request, reply) => {
        if (probePaths.has(request.url)) return;
        if (!orchestrator.isReady()) {
            reply.header('Retry-After', '1');
            return reply.status(503).send({
                error: 'Service unavailable: orchestrator not ready',
                ready: false,
            });
        }
    });

    /**
     * POST /access  —  Body: { "data": "Node_A" }
     */
    server.post('/access', async (request, reply) => {
        let item: string | undefined;
        let warmRead = false;
        try {
            const body = request.body as { data?: unknown; warmRead?: boolean };
            item = normalizeAtomInput(body.data) ?? undefined;
            warmRead = body.warmRead === true;
            if (!item) {
                return reply.status(400).send({ error: `Property 'data' invalid — ${SCHEMA_ERROR}` });
            }
            const report = await orchestrator.access(item);
            const result = report.predictedNext !== null ? 'hit' : 'miss';
            accessCounter.inc({ result });
            requestDuration.observe(report.latencyMs);
            return { ...report, verified: true };
        } catch (e: any) {
            if (warmRead && item) {
                const warm = orchestrator.tryWarmRead(item);
                if (warm) {
                    accessCounter.inc({ result: 'miss' });
                    requestDuration.observe(warm.latencyMs);
                    return warm;
                }
                if (pipeline.getQueuedAtoms().includes(item)) {
                    const queuedWarm = {
                        currentData: item,
                        currentProof: null,
                        predictedNext: null,
                        predictedProof: null,
                        latencyMs: 0,
                        treeVersion: orchestrator.getMasterVersion(),
                        verified: false,
                    };
                    accessCounter.inc({ result: 'miss' });
                    requestDuration.observe(queuedWarm.latencyMs);
                    return queuedWarm;
                }
            }
            accessCounter.inc({ result: 'error' });
            return reply.status(404).send({ error: e.message });
        }
    });

    /**
     * POST /batch-access  —  Body: { "items": ["v1.other.A", ...] }
     *
     * Performs batched reads with shard-level grouping and a single epoch read
     * ticket per shard batch. Unknown/tombstoned/pending items are returned as
     * per-item error records; the overall request still returns 200.
     */
    server.post('/batch-access', async (request, reply) => {
        try {
            const { items } = request.body as { items?: unknown };
            if (!Array.isArray(items) || items.length === 0) {
                return reply.status(400).send({ error: "Property 'items' must be a non-empty array." });
            }

            const normalized = items.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `Property 'items' invalid — ${SCHEMA_ERROR}` });
            }

            const results = await orchestrator.batchAccess(normalized as string[]);
            return { results };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /policy  —  Return the current transition policy.
     */
    server.get('/policy', async () => {
        const policy = orchestrator.getPolicy();
        const isDefault = policy.isOpenPolicy();
        return {
            policy: isDefault ? 'default' : policy.toConfig(),
            isDefault,
        };
    });

    /**
     * POST /policy  —  Set restricted policy or reset to default.
     * Body: { policy: TypePolicyConfig } | { policy: 'default' }
     */
    server.post('/policy', async (request, reply) => {
        const { policy } = (request.body ?? {}) as { policy?: unknown };

        if (policy === 'default') {
            const next = TransitionPolicy.default();
            orchestrator.setPolicy(next);
            return {
                status: 'PolicyUpdated',
                isDefault: true,
                policy: next.toConfig(),
            };
        }

        const cfg = parsePolicyConfig(policy);
        if (!cfg) {
            return reply.status(400).send({
                error: "Property 'policy' must be 'default' or an object mapping valid AtomType keys to AtomType[] values.",
            });
        }

        const next = TransitionPolicy.fromConfig(cfg);
        orchestrator.setPolicy(next);
        return {
            status: 'PolicyUpdated',
            isDefault: next.isOpenPolicy(),
            policy: next.toConfig(),
        };
    });

    /**
     * POST /train  —  Body: { "sequence": ["Node_A", "Node_B"] }
     */
    server.post('/train', async (request, reply) => {
        try {
            const { sequence } = request.body as { sequence?: unknown };
            if (!sequence || !Array.isArray(sequence) || sequence.length === 0) {
                return reply.status(400).send({ error: "Property 'sequence' must be a non-empty array." });
            }
            const normalized = sequence.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `Property 'sequence' invalid — ${SCHEMA_ERROR}` });
            }
            await orchestrator.train(normalized as string[]);
            trainCounter.inc();
            trainSequenceLength.observe(normalized.length);

            for (let i = 0; i < normalized.length - 1; i++) {
                const fromType = parseAtomV1(normalized[i] as string)?.type ?? 'other';
                const toType = parseAtomV1(normalized[i + 1] as string)?.type ?? 'other';
                transitionByTypeTotal.inc({ from_type: fromType, to_type: toType });
            }

            // Update per-atom learning metrics.
            // Only iterates atoms that appeared as `from` in this sequence —
            // O(sequence_length - 1), never scans the full atom pool.
            const fromAtoms = new Set((normalized as string[]).slice(0, -1));
            for (const atom of fromAtoms) {
                const weights = orchestrator.getWeights(atom);
                if (weights && weights.length > 0) {
                    const total = weights.reduce((s, t) => s + t.weight, 0);
                    atomDominanceRatio.set({ atom }, weights[0].weight / total);
                    atomTrainedEdges.set({ atom }, weights.length);
                }
            }
            // Cluster-level totals — O(shards), not O(atoms)
            const stats = orchestrator.getClusterStats();
            clusterTotalEdges.set(stats.totalEdges);
            clusterTrainedAtoms.set(stats.trainedAtoms);

            return { status: 'Success', message: `Trained path of length ${normalized.length} across shards.` };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /weights/:atom  —  Introspect Markov weights for a single atom.
     * Read-only. Returns outgoing transitions sorted by weight descending.
     * Response includes dominanceRatio so callers can assess prediction confidence.
     */
    server.get('/weights/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        const transitions = orchestrator.getWeights(atom);
        if (transitions === null) {
            return reply.status(404).send({ error: `Atom '${atom}' not found in any shard.` });
        }
        const totalWeight = transitions.reduce((s, t) => s + t.weight, 0);
        return {
            atom,
            transitions,
            totalWeight,
            dominantNext: transitions[0]?.to ?? null,
            dominanceRatio: totalWeight > 0 ? transitions[0].weight / totalWeight : null,
        };
    });

    /**
     * GET /health  —  Live cluster health check.
     * Returns per-shard status: pending writes, snapshot version,
     * commit state, active reader count, plus aggregate cluster stats.
     */
    server.get('/health', async () => {
        return {
            status: 'ok',
            ready: orchestrator.isReady(),
            ...orchestrator.getClusterHealth(),
        };
    });

    /**
     * GET /ready  —  strict readiness endpoint for orchestrators.
     * 200 when serving traffic is safe; 503 otherwise.
     */
    server.get('/ready', async (_, reply) => {
        const ready = orchestrator.isReady();
        if (!ready) return reply.status(503).send({ ready: false });
        return { ready: true };
    });

    /**
     * GET /metrics  —  Prometheus scrape endpoint
     */
    server.get('/metrics', async (request, reply) => {
        reply.header('Content-Type', register.contentType);
        return register.metrics();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Dynamic atom management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * POST /atoms  —  Queue new atoms for ingestion (non-blocking).
     * Body: { "atoms": ["new_atom_1", "new_atom_2", ...] }
     *
     * Atoms are accepted into the ingestion pipeline immediately.  They are
     * batched and committed asynchronously — reads are never blocked.
     * Use GET /atoms/pending to check what is queued but not yet committed.
     * Use POST /admin/commit to force an immediate flush.
     *
     * Returns: { queued, batchId, commitEtaMs }
     */
    server.post('/atoms', async (request, reply) => {
        try {
            const { atoms } = request.body as { atoms?: unknown };
            if (!Array.isArray(atoms) || atoms.length === 0) {
                return reply.status(400).send({ error: "'atoms' must be a non-empty array." });
            }
            const normalized = atoms.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `'atoms' invalid — ${SCHEMA_ERROR}` });
            }
            const admission = orchestrator.getWriteAdmission(
                pipeline.getStats().queueDepth,
                normalized.length
            );
            if (!admission.accept) {
                reply.header('Retry-After', String(admission.retryAfterSec));
                return reply.status(503).send({
                    error: 'Backpressure: write buffer is saturated. Retry later.',
                    retryAfterSec: admission.retryAfterSec,
                    pressure: {
                        highWaterMark: admission.highWaterMark,
                        totalShardPendingWrites: admission.totalShardPendingWrites,
                        projectedPendingWrites: admission.projectedPendingWrites,
                    },
                });
            }
            const receipt = await pipeline.enqueue(normalized as string[]);
            return { status: 'Queued', ...receipt };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /atoms/pending  —  List atoms queued in the ingestion pipeline but
     * not yet committed to the Merkle snapshot.
     *
     * Returns: { queuedInPipeline, pipelineStats }
     */
    server.get('/atoms/pending', async () => {
        const stats = pipeline.getStats();
        return {
            queuedInPipeline: pipeline.getQueuedAtoms(),
            pipelineStats: stats,
        };
    });

    /**
     * POST /admin/commit  —  Force an immediate flush of the ingestion pipeline.
     * Useful for testing and for cases where you need atoms committed right away.
     *
     * Returns: { status, flushedCount }
     */
    server.post('/admin/commit', async (_, reply) => {
        try {
            const before = pipeline.getStats().totalCommitted;
            await pipeline.flush();
            const after = pipeline.getStats().totalCommitted;
            return { status: 'Committed', flushedCount: after - before };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * DELETE /atoms/:atom  —  Tombstone (soft-delete) a single atom.
     *
     * The atom's Merkle leaf is replaced with a zero sentinel.  No indices shift,
     * so proofs previously issued for other atoms remain valid at their treeVersion.
     * The tombstoned atom can no longer be accessed or used as a training endpoint.
     *
     * Returns: { status, tombstonedAtom, treeVersion }
     */
    server.delete('/atoms/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        if (!isAtomV1(atom)) {
            return reply.status(400).send({ error: `Path param 'atom' invalid — ${SCHEMA_ERROR}` });
        }
        try {
            const treeVersion = await orchestrator.removeAtom(atom);
            return { status: 'Success', tombstonedAtom: atom, treeVersion };
        } catch (e: any) {
            return reply.status(404).send({ error: e.message });
        }
    });

    /**
     * GET /atoms  —  List all registered atoms across all shards.
     * Returns: { atoms: [{ atom, status: 'active' | 'tombstoned' }], treeVersion }
     */
    server.get('/atoms', async () => {
        return {
            atoms: orchestrator.listAtoms(),
            treeVersion: orchestrator.getMasterVersion(),
        };
    });

    /**
     * GET /atoms/:atom  —  Inspect a single atom's stored record.
     * Returns shard assignment, status, hash, commit visibility, and
     * outgoing learned transitions.
     */
    server.get('/atoms/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        if (!isAtomV1(atom)) {
            return reply.status(400).send({ error: `Path param 'atom' invalid — ${SCHEMA_ERROR}` });
        }
        const record = orchestrator.inspectAtom(atom);
        if (!record) {
            return reply.status(404).send({ error: `Atom '${atom}' not found in any shard.` });
        }
        return record;
    });

    return { server, orchestrator, pipeline };
}

// Only run when invoked directly
if (require.main === module) {
    const PORT = parseInt(process.env.PORT ?? '3000');
    const HOST = process.env.HOST ?? '0.0.0.0';
    const NUM_SHARDS = parseInt(process.env.SHARD_COUNT ?? '4');

    const { server, orchestrator, pipeline } = buildApp({
        numShards: NUM_SHARDS,
        atomSeedFile: process.env.MMPM_ATOM_FILE,
    });

    const shutdown = async () => {
        await pipeline.stop();
        await server.close();
        await orchestrator.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    (async () => {
        try {
            await orchestrator.init();
            pipeline.start();
            await server.listen({ port: PORT, host: HOST });
            logger.info(`MMPM Cluster Online — Shards: ${NUM_SHARDS} | ${HOST}:${PORT}`);
        } catch (err) {
            logger.error(err);
            process.exit(1);
        }
    })();
}