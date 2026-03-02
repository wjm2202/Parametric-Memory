import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../server';
import { rmSync } from 'fs';
import type { FastifyInstance } from 'fastify';
import type { ShardedOrchestrator } from '../orchestrator';

function cleanup(path: string) {
    try { rmSync(path, { recursive: true, force: true }); } catch { }
}

const atom = (value: string) => `v1.other.${value}`;
const atomPath = (value: string) => encodeURIComponent(atom(value));

// --- Integration Suite ---

describe('API Integration', () => {
    const DB_PATH = './test-api-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: [atom('A'), atom('B'), atom('C'), atom('D')], dbBasePath: DB_PATH });
        server = app.server;
        orchestrator = app.orchestrator;
        await orchestrator.init();
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    // --- /metrics ---
    it('GET /metrics returns prometheus text', async () => {
        const res = await server.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/plain');
    });

    // --- /access ---
    it('POST /access with valid atom returns report', async () => {
        const res = await server.inject({
            method: 'POST', url: '/access',
            payload: { data: atom('A') }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.currentData).toBe(atom('A'));
        expect(body.currentProof).toBeDefined();
        expect(typeof body.latencyMs).toBe('number');
    });

    it('POST /access with missing data returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/access',
            payload: {}
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBeDefined();
    });

    it('POST /access with unknown atom returns 404', async () => {
        const res = await server.inject({
            method: 'POST', url: '/access',
            payload: { data: atom('DOES_NOT_EXIST') }
        });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload).error).toBeDefined();
    });

    // --- /train ---
    it('POST /train with valid sequence returns success', async () => {
        const res = await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: [atom('A'), atom('B'), atom('C')] }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).status).toBe('Success');
    });

    it('POST /train enables prediction on next access', async () => {
        await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: [atom('A'), atom('B'), atom('C'), atom('D')] }
        });
        const res = await server.inject({
            method: 'POST', url: '/access',
            payload: { data: atom('A') }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).predictedNext).toBe(atom('B'));
    });

    it('POST /train with missing sequence returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/train',
            payload: {}
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /train with non-array sequence returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: 'not-an-array' }
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /train with non-string items in sequence array returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: [1, 2, 3] }
        });
        expect(res.statusCode).toBe(400);
    });
});

// --- Auth Suite ---

describe('API Auth', () => {
    const AUTH_DB = './test-auth-db';
    let authServer: FastifyInstance;
    let authOrch: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(AUTH_DB);
        const app = buildApp({ data: [atom('X')], dbBasePath: AUTH_DB, apiKey: 'test-secret' });
        authServer = app.server;
        authOrch = app.orchestrator;
        await authOrch.init();
    });

    afterAll(async () => {
        await authServer.close();
        await authOrch.close();
        cleanup(AUTH_DB);
    });

    it('rejects unauthenticated /access with 401', async () => {
        const res = await authServer.inject({ method: 'POST', url: '/access', payload: { data: atom('X') } });
        expect(res.statusCode).toBe(401);
    });

    it('accepts authenticated /access', async () => {
        const res = await authServer.inject({
            method: 'POST', url: '/access',
            payload: { data: atom('X') },
            headers: { authorization: 'Bearer test-secret' }
        });
        expect(res.statusCode).toBe(200);
    });

    it('rejects wrong token with 401', async () => {
        const res = await authServer.inject({
            method: 'POST', url: '/access',
            payload: { data: atom('X') },
            headers: { authorization: 'Bearer wrong-key' }
        });
        expect(res.statusCode).toBe(401);
    });

    it('allows /metrics without auth', async () => {
        const res = await authServer.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
    });

    it('allows /health without auth', async () => {
        const res = await authServer.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
    });

    it('allows /ready without auth', async () => {
        const res = await authServer.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).ready).toBe(true);
    });
});

// ─── Dynamic atom API (/atoms) ───────────────────────────────────────────────

describe('API — /atoms (dynamic atom management)', () => {
    const ATOMS_DB = './test-atoms-api-db';
    let server: ReturnType<typeof buildApp>['server'];
    let orchestrator: ReturnType<typeof buildApp>['orchestrator'];
    let pipeline: ReturnType<typeof buildApp>['pipeline'];

    beforeAll(async () => {
        cleanup(ATOMS_DB);
        const app = buildApp({ data: [atom('A'), atom('B'), atom('C')], dbBasePath: ATOMS_DB });
        server = app.server;
        orchestrator = app.orchestrator;
        pipeline = app.pipeline;
        await orchestrator.init();
    });

    afterAll(async () => {
        await pipeline.stop();
        await server.close();
        await orchestrator.close();
        cleanup(ATOMS_DB);
    });

    // ── POST /atoms (now queues via pipeline) ────────────────────────────────

    it('POST /atoms with valid array queues atoms and returns receipt', async () => {
        const res = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: [atom('D'), atom('E')] }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Queued');
        expect(body.queued).toBe(2);
        expect(typeof body.batchId).toBe('number');
        expect(typeof body.commitEtaMs).toBe('number');
    });

    it('POST /atoms makes new atoms accessible via /access after commit', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('F')] } });
        // Force commit so the atom is in the snapshot
        await server.inject({ method: 'POST', url: '/admin/commit' });
        const res = await server.inject({ method: 'POST', url: '/access', payload: { data: atom('F') } });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).currentData).toBe(atom('F'));
    });

    it('POST /atoms makes new atoms trainable after commit', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('G')] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });
        await server.inject({ method: 'POST', url: '/train', payload: { sequence: [atom('A'), atom('G')] } });
        const res = await server.inject({ method: 'POST', url: '/access', payload: { data: atom('A') } });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).predictedNext).toBe(atom('G'));
    });

    it('POST /atoms with missing field returns 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/atoms', payload: {} });
        expect(res.statusCode).toBe(400);
    });

    it('POST /atoms with empty array returns 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [] } });
        expect(res.statusCode).toBe(400);
    });

    it('POST /atoms with non-string items returns 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [1, 2] } });
        expect(res.statusCode).toBe(400);
    });

    // ── DELETE /atoms/:atom ──────────────────────────────────────────────────

    it('DELETE /atoms/:atom tombstones the atom and returns treeVersion', async () => {
        const res = await server.inject({ method: 'DELETE', url: `/atoms/${atomPath('B')}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Success');
        expect(body.tombstonedAtom).toBe(atom('B'));
        expect(typeof body.treeVersion).toBe('number');
    });

    it('DELETE /atoms/:atom makes the atom return 404 on /access', async () => {
        await server.inject({ method: 'DELETE', url: `/atoms/${atomPath('C')}` });
        const res = await server.inject({ method: 'POST', url: '/access', payload: { data: atom('C') } });
        expect(res.statusCode).toBe(404);
    });

    it('DELETE /atoms/:atom for unknown atom returns 404', async () => {
        const res = await server.inject({ method: 'DELETE', url: `/atoms/${atomPath('DOES_NOT_EXIST')}` });
        expect(res.statusCode).toBe(404);
    });

    // ── GET /atoms ───────────────────────────────────────────────────────────

    it('GET /atoms returns all atoms with their status', async () => {
        const res = await server.inject({ method: 'GET', url: '/atoms' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.atoms)).toBe(true);
        expect(typeof body.treeVersion).toBe('number');
        // Every entry has atom + status
        for (const entry of body.atoms) {
            expect(typeof entry.atom).toBe('string');
            expect(['active', 'tombstoned']).toContain(entry.status);
        }
    });

    it('GET /atoms reflects tombstoned status correctly', async () => {
        // 'B' and 'C' were tombstoned in earlier tests within this suite
        const res = await server.inject({ method: 'GET', url: '/atoms' });
        const body = JSON.parse(res.payload);
        const find = (name: string) => body.atoms.find((a: any) => a.atom === name);
        expect(find(atom('A'))?.status).toBe('active');
        expect(find(atom('B'))?.status).toBe('tombstoned');
        expect(find(atom('C'))?.status).toBe('tombstoned');
    });

    it('GET /atoms/:atom returns atom-level record for active atom', async () => {
        const res = await server.inject({ method: 'GET', url: `/atoms/${atomPath('A')}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.atom).toBe(atom('A'));
        expect(typeof body.shard).toBe('number');
        expect(typeof body.index).toBe('number');
        expect(body.status).toBe('active');
        expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(typeof body.committed).toBe('boolean');
        expect(typeof body.treeVersion).toBe('number');
        expect(Array.isArray(body.outgoingTransitions)).toBe(true);
    });

    it('GET /atoms/:atom returns tombstoned status for tombstoned atom', async () => {
        const res = await server.inject({ method: 'GET', url: `/atoms/${atomPath('B')}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.atom).toBe(atom('B'));
        expect(body.status).toBe('tombstoned');
        expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('GET /atoms/:atom returns 404 for unknown atom', async () => {
        const res = await server.inject({ method: 'GET', url: `/atoms/${atomPath('DOES_NOT_EXIST')}` });
        expect(res.statusCode).toBe(404);
    });

    // ── GET /atoms/pending ───────────────────────────────────────────────────

    it('GET /atoms/pending returns queuedInPipeline and pipelineStats', async () => {
        const res = await server.inject({ method: 'GET', url: '/atoms/pending' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.queuedInPipeline)).toBe(true);
        expect(typeof body.pipelineStats).toBe('object');
        expect(typeof body.pipelineStats.queueDepth).toBe('number');
        expect(typeof body.pipelineStats.totalEnqueued).toBe('number');
        expect(typeof body.pipelineStats.totalCommitted).toBe('number');
    });

    it('GET /atoms/pending reflects atoms queued but not yet committed', async () => {
        // Enqueue an atom without committing
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('PendingAtom1')] } });
        const res = await server.inject({ method: 'GET', url: '/atoms/pending' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        // The queued atom should appear in queuedInPipeline
        expect(body.queuedInPipeline).toContain(atom('PendingAtom1'));
        expect(body.pipelineStats.queueDepth).toBeGreaterThan(0);
        // Clean up: flush so the atom doesn't bleed into other tests
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });

    it('GET /atoms/pending shows empty queue after commit', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('PendingAtom2')] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });
        const res = await server.inject({ method: 'GET', url: '/atoms/pending' });
        const body = JSON.parse(res.payload);
        expect(body.queuedInPipeline).not.toContain(atom('PendingAtom2'));
        expect(body.pipelineStats.queueDepth).toBe(0);
    });

    // ── POST /admin/commit ───────────────────────────────────────────────────

    it('POST /admin/commit returns status Committed and flushedCount', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('CommitTest1'), atom('CommitTest2')] } });
        const res = await server.inject({ method: 'POST', url: '/admin/commit' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Committed');
        expect(typeof body.flushedCount).toBe('number');
        expect(body.flushedCount).toBeGreaterThanOrEqual(2);
    });

    it('POST /admin/commit on empty pipeline returns flushedCount of 0', async () => {
        // Ensure queue is empty first
        await server.inject({ method: 'POST', url: '/admin/commit' });
        const res = await server.inject({ method: 'POST', url: '/admin/commit' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Committed');
        expect(body.flushedCount).toBe(0);
    });

    // ── /access treeVersion field ────────────────────────────────────────────

    it('POST /access response includes a numeric treeVersion field', async () => {
        const res = await server.inject({ method: 'POST', url: '/access', payload: { data: atom('A') } });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(typeof body.treeVersion).toBe('number');
        expect(body.treeVersion).toBeGreaterThan(0);
    });

    it('POST /access for committed atom includes verified=true', async () => {
        const res = await server.inject({ method: 'POST', url: '/access', payload: { data: atom('A') } });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.verified).toBe(true);
        expect(body.currentProof).toBeDefined();
    });

    it('POST /access with warmRead=true returns unverified response for pending atom', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('WarmPending1')] } });
        const res = await server.inject({
            method: 'POST',
            url: '/access',
            payload: { data: atom('WarmPending1'), warmRead: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.currentData).toBe(atom('WarmPending1'));
        expect(body.verified).toBe(false);
        expect(body.currentProof).toBeNull();

        // cleanup to avoid test bleed
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });

    it('POST /access with warmRead=false keeps pending atoms non-readable until commit', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('WarmPending2')] } });
        const res = await server.inject({
            method: 'POST',
            url: '/access',
            payload: { data: atom('WarmPending2'), warmRead: false },
        });
        expect(res.statusCode).toBe(404);

        // cleanup to avoid test bleed
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });

    // ── /health ──────────────────────────────────────────────────────────────

    it('GET /health returns 200 with status ok', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('ok');
        expect(body.ready).toBe(true);
    });

    it('GET /ready returns 200 with ready true after init', async () => {
        const res = await server.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).ready).toBe(true);
    });

    it('GET /health returns treeVersion as a number', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        const body = JSON.parse(res.payload);
        expect(typeof body.treeVersion).toBe('number');
    });

    it('GET /health returns shards array with correct shape', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.shards)).toBe(true);
        expect(body.shards.length).toBeGreaterThan(0);
        for (const shard of body.shards) {
            expect(typeof shard.id).toBe('number');
            expect(typeof shard.pendingWrites).toBe('number');
            expect(typeof shard.snapshotVersion).toBe('number');
            expect(typeof shard.isCommitting).toBe('boolean');
            expect(typeof shard.activeReaders).toBe('number');
        }
    });

    it('GET /health returns clusterStats with trainedAtoms and totalEdges', async () => {
        const res = await server.inject({ method: 'GET', url: '/health' });
        const body = JSON.parse(res.payload);
        expect(body.clusterStats).toBeDefined();
        expect(typeof body.clusterStats.trainedAtoms).toBe('number');
        expect(typeof body.clusterStats.totalEdges).toBe('number');
    });
});

describe('API — /atoms backpressure (Story 3.4)', () => {
    const BP_DB = './test-atoms-backpressure-db';
    let server: ReturnType<typeof buildApp>['server'];
    let orchestrator: ReturnType<typeof buildApp>['orchestrator'];
    let pipeline: ReturnType<typeof buildApp>['pipeline'];
    const oldHighWater = process.env.MMPM_PENDING_HIGH_WATER_MARK;
    const oldRetryAfter = process.env.MMPM_BACKPRESSURE_RETRY_AFTER_SEC;

    beforeAll(async () => {
        cleanup(BP_DB);
        process.env.MMPM_PENDING_HIGH_WATER_MARK = '1';
        process.env.MMPM_BACKPRESSURE_RETRY_AFTER_SEC = '2';
        const app = buildApp({ data: [atom('A'), atom('B')], dbBasePath: BP_DB });
        server = app.server;
        orchestrator = app.orchestrator;
        pipeline = app.pipeline;
        await orchestrator.init();
    });

    afterAll(async () => {
        await pipeline.stop();
        await server.close();
        await orchestrator.close();
        cleanup(BP_DB);
        if (oldHighWater === undefined) delete process.env.MMPM_PENDING_HIGH_WATER_MARK;
        else process.env.MMPM_PENDING_HIGH_WATER_MARK = oldHighWater;
        if (oldRetryAfter === undefined) delete process.env.MMPM_BACKPRESSURE_RETRY_AFTER_SEC;
        else process.env.MMPM_BACKPRESSURE_RETRY_AFTER_SEC = oldRetryAfter;
    });

    it('returns 503 with Retry-After when projected pending writes exceed high-water mark', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: [atom('X'), atom('Y')] },
        });
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('2');
        const body = JSON.parse(res.payload);
        expect(body.error).toMatch(/Backpressure/i);
        expect(body.retryAfterSec).toBe(2);
        expect(body.pressure.highWaterMark).toBe(1);
        expect(body.pressure.projectedPendingWrites).toBeGreaterThan(1);
    });

    it('accepts /atoms when projected pending writes are within high-water mark', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: [atom('Z')] },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Queued');

        // cleanup so this suite is isolated
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });
});

describe('API readiness guard', () => {
    const READY_DB = './test-readiness-db';
    let server: ReturnType<typeof buildApp>['server'];
    let orchestrator: ReturnType<typeof buildApp>['orchestrator'];
    let pipeline: ReturnType<typeof buildApp>['pipeline'];

    beforeAll(async () => {
        cleanup(READY_DB);
        const app = buildApp({ data: [atom('R1'), atom('R2')], dbBasePath: READY_DB });
        server = app.server;
        orchestrator = app.orchestrator;
        pipeline = app.pipeline;
        // Intentionally do not call orchestrator.init() in this suite.
    });

    afterAll(async () => {
        await pipeline.stop();
        await server.close();
        await orchestrator.close();
        cleanup(READY_DB);
    });

    it('GET /ready returns 503 with ready false before init', async () => {
        const res = await server.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.payload).ready).toBe(false);
    });

    it('rejects non-probe traffic with 503 before init', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/access',
            payload: { data: atom('R1') },
        });
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('1');
        expect(JSON.parse(res.payload).ready).toBe(false);
    });
});
