import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../server';
import { rmSync } from 'fs';
import type { FastifyInstance } from 'fastify';
import type { ShardedOrchestrator } from '../orchestrator';

function cleanup(path: string) {
    try { rmSync(path, { recursive: true, force: true }); } catch { }
}

// --- Integration Suite ---

describe('API Integration', () => {
    const DB_PATH = './test-api-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: ['A', 'B', 'C', 'D'], dbBasePath: DB_PATH });
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
            payload: { data: 'A' }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.currentData).toBe('A');
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
            payload: { data: 'DOES_NOT_EXIST' }
        });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.payload).error).toBeDefined();
    });

    // --- /train ---
    it('POST /train with valid sequence returns success', async () => {
        const res = await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: ['A', 'B', 'C'] }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).status).toBe('Success');
    });

    it('POST /train enables prediction on next access', async () => {
        await server.inject({
            method: 'POST', url: '/train',
            payload: { sequence: ['A', 'B', 'C', 'D'] }
        });
        const res = await server.inject({
            method: 'POST', url: '/access',
            payload: { data: 'A' }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).predictedNext).toBe('B');
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
        const app = buildApp({ data: ['X'], dbBasePath: AUTH_DB, apiKey: 'test-secret' });
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
        const res = await authServer.inject({ method: 'POST', url: '/access', payload: { data: 'X' } });
        expect(res.statusCode).toBe(401);
    });

    it('accepts authenticated /access', async () => {
        const res = await authServer.inject({
            method: 'POST', url: '/access',
            payload: { data: 'X' },
            headers: { authorization: 'Bearer test-secret' }
        });
        expect(res.statusCode).toBe(200);
    });

    it('rejects wrong token with 401', async () => {
        const res = await authServer.inject({
            method: 'POST', url: '/access',
            payload: { data: 'X' },
            headers: { authorization: 'Bearer wrong-key' }
        });
        expect(res.statusCode).toBe(401);
    });

    it('allows /metrics without auth', async () => {
        const res = await authServer.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
    });
});
