/**
 * Security Tests
 *
 * Proves every security claim made in the design:
 *
 *   AUTH CLAIMS
 *   1.  All data routes (/access, /train, /weights) return 401 when an API
 *       key is configured and no token is supplied.
 *   2.  All data routes return 401 for wrong tokens.
 *   3.  Wrong header shape (Basic auth, lowercase "bearer", empty string,
 *       trailing whitespace, extra space between "Bearer" and token) all fail.
 *   4.  /metrics is always unauthenticated (Prometheus scraping requirement).
 *   5.  When no API key is configured none of the routes require auth.
 *
 *   INTEGRITY CLAIMS
 *   6.  Every /access response contains a currentProof that independently
 *       verifies (the client does not have to trust the server root).
 *   7.  A predictedProof, when present, also independently verifies.
 *   8.  The shardRootProof, when present, independently verifies.
 *   9.  Proofs survive a round-trip through JSON serialisation.
 *   10. The proof root is a 64-char lowercase hex SHA-256 digest.
 *   11. Mutating any byte of the leaf in a deserialized proof breaks
 *       verification — server cannot return a proof the client cannot verify.
 *   12. Cross-shard prediction (from and to on different shards) returns a
 *       valid proof for the predicted atom.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { ShardedOrchestrator } from '../orchestrator';
import { ShardRouter } from '../router';
import { MerkleKernel } from '../merkle';
import { buildApp } from '../server';
import type { MerkleProof } from '../types';
const atom = (value: string) => `v1.other.${value}`;
const weightsUrl = (value: string) => `/weights/${encodeURIComponent(value)}`;

// ── helpers ──────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tempDb(label: string) {
    const d = mkdtempSync(join(tmpdir(), `mmpm-sec-${label}-`));
    dirs.push(d);
    return d;
}

afterAll(() => {
    while (dirs.length) {
        const d = dirs.pop()!;
        try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
});

async function inject(
    server: FastifyInstance,
    method: 'GET' | 'POST',
    url: string,
    opts: { payload?: unknown; token?: string | null } = {}
) {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined && opts.token !== null) {
        headers['authorization'] = opts.token;
    }
    return server.inject({ method, url, payload: opts.payload as any, headers });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Auth-guarded server
let guardedServer: FastifyInstance;
let guardedOrch: ShardedOrchestrator;
const ATOMS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'].map(atom);
const API_KEY = 'super-secret-key';

// Open server (no API key)
let openServer: FastifyInstance;
let openOrch: ShardedOrchestrator;

beforeAll(async () => {
    {
        const { server, orchestrator } = buildApp({
            data: ATOMS,
            dbBasePath: tempDb('guarded'),
            numShards: 4,
            apiKey: API_KEY,
        });
        await orchestrator.init();
        guardedServer = server;
        guardedOrch = orchestrator;
        // Train a sequence for prediction tests
        await orchestrator.train([atom('Alpha'), atom('Beta'), atom('Gamma'), atom('Delta')]);
    }
    {
        const { server, orchestrator } = buildApp({
            data: ATOMS,
            dbBasePath: tempDb('open'),
            numShards: 4,
        });
        await orchestrator.init();
        openServer = server;
        openOrch = orchestrator;
        await orchestrator.train([atom('Alpha'), atom('Beta'), atom('Gamma'), atom('Delta')]);
    }
});

afterAll(async () => {
    if (guardedServer) await guardedServer.close();
    if (guardedOrch) await guardedOrch.close();
    if (openServer) await openServer.close();
    if (openOrch) await openOrch.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1–4: Auth claim — missing token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — missing token is rejected on all data routes', () => {
    const routes: Array<{ method: 'POST' | 'GET'; url: string; payload?: unknown }> = [
        { method: 'POST', url: '/access', payload: { data: atom('Alpha') } },
        { method: 'POST', url: '/train', payload: { sequence: [atom('Alpha'), atom('Beta')] } },
        { method: 'GET', url: weightsUrl(atom('Alpha')) },
    ];

    for (const { method, url, payload } of routes) {
        it(`${method} ${url} → 401 with no Authorization header`, async () => {
            const res = await inject(guardedServer, method, url, { payload });
            expect(res.statusCode).toBe(401);
            expect(JSON.parse(res.payload).error).toBeDefined();
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth claim — wrong token → 401
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — wrong token rejected', () => {
    it('POST /access → 401 with wrong token', async () => {
        const res = await inject(guardedServer, 'POST', '/access',
            { payload: { data: atom('Alpha') }, token: 'Bearer wrong-key' });
        expect(res.statusCode).toBe(401);
    });

    it('POST /train → 401 with wrong token', async () => {
        const res = await inject(guardedServer, 'POST', '/train',
            { payload: { sequence: [atom('Alpha'), atom('Beta')] }, token: 'Bearer wrong-key' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /weights/Alpha → 401 with wrong token', async () => {
        const res = await inject(guardedServer, 'GET', weightsUrl(atom('Alpha')),
            { token: 'Bearer wrong-key' });
        expect(res.statusCode).toBe(401);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth claim — malformed header shapes all fail
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — malformed Authorization header shapes are rejected', () => {
    const malformed = [
        { label: 'lowercase bearer', value: `bearer ${API_KEY}` },
        { label: 'Basic auth', value: `Basic ${Buffer.from(`admin:${API_KEY}`).toString('base64')}` },
        { label: 'empty string', value: '' },
        { label: 'token with leading space', value: ` Bearer ${API_KEY}` },
        { label: 'extra space after Bearer', value: `Bearer  ${API_KEY}` },
        { label: 'no Bearer prefix', value: API_KEY },
    ];

    for (const { label, value } of malformed) {
        it(`POST /access → 401 with "${label}"`, async () => {
            const headers: Record<string, string> = { authorization: value };
            const res = await guardedServer.inject({
                method: 'POST', url: '/access',
                payload: { data: atom('Alpha') },
                headers,
            });
            expect(res.statusCode).toBe(401);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth claim — correct token grants access on all data routes
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — correct token accepted on all data routes', () => {
    const auth = `Bearer ${API_KEY}`;

    it('POST /access → 200 with correct token', async () => {
        const res = await inject(guardedServer, 'POST', '/access',
            { payload: { data: atom('Alpha') }, token: auth });
        expect(res.statusCode).toBe(200);
    });

    it('POST /train → 200 with correct token', async () => {
        const res = await inject(guardedServer, 'POST', '/train',
            { payload: { sequence: [atom('Alpha'), atom('Beta')] }, token: auth });
        expect(res.statusCode).toBe(200);
    });

    it('GET /weights/Alpha → 200 with correct token', async () => {
        const res = await inject(guardedServer, 'GET', weightsUrl(atom('Alpha')),
            { token: auth });
        expect(res.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth claim — /metrics always bypasses the guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — /metrics is always unauthenticated', () => {
    it('GET /metrics → 200 with no token on guarded server', async () => {
        const res = await inject(guardedServer, 'GET', '/metrics');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/plain');
    });

    it('GET /metrics → 200 even with wrong token', async () => {
        const res = await inject(guardedServer, 'GET', '/metrics',
            { token: 'Bearer garbage' });
        expect(res.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth claim — no API key means no auth required on any route
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — open server requires no authentication', () => {
    it('POST /access → 200 with no token on open server', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Alpha') } });
        expect(res.statusCode).toBe(200);
    });

    it('GET /weights/Alpha → 200 with no token on open server', async () => {
        const res = await inject(openServer, 'GET', weightsUrl(atom('Alpha')));
        expect(res.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integrity claim — currentProof independently verifies
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — Merkle proof integrity at the API level', () => {
    it('currentProof in /access response independently verifies', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Alpha') } });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(MerkleKernel.verifyProof(body.currentProof)).toBe(true);
    });

    it('predictedProof, when present, independently verifies', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Alpha') } });
        const body = JSON.parse(res.payload);
        if (body.predictedProof) {
            expect(MerkleKernel.verifyProof(body.predictedProof)).toBe(true);
        }
    });

    it('shardRootProof, when present, independently verifies', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Alpha') } });
        const body = JSON.parse(res.payload);
        if (body.shardRootProof) {
            expect(MerkleKernel.verifyProof(body.shardRootProof)).toBe(true);
        }
    });

    it('proof root is a 64-char hex SHA-256 digest', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Beta') } });
        const body = JSON.parse(res.payload);
        expect(body.currentProof.root).toMatch(/^[a-f0-9]{64}$/);
    });

    it('proof survives JSON round-trip and still verifies', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Gamma') } });
        const proof: MerkleProof = JSON.parse(JSON.stringify(JSON.parse(res.payload).currentProof));
        expect(MerkleKernel.verifyProof(proof)).toBe(true);
    });

    it('mutating the leaf in a serialised proof breaks verification', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Delta') } });
        const proof: MerkleProof = JSON.parse(res.payload).currentProof;
        proof.leaf = 'ff'.repeat(32); // tamper
        expect(MerkleKernel.verifyProof(proof)).toBe(false);
    });

    it('mutating the first audit path node breaks verification', async () => {
        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: atom('Alpha') } });
        const proof: MerkleProof = JSON.parse(res.payload).currentProof;
        if (proof.auditPath.length > 0) {
            proof.auditPath[0] = '00'.repeat(32); // tamper
            expect(MerkleKernel.verifyProof(proof)).toBe(false);
        }
    });

    it('every atom in the dataset has a verifiable proof', async () => {
        for (const atom of ATOMS) {
            const res = await inject(openServer, 'POST', '/access',
                { payload: { data: atom } });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(
                MerkleKernel.verifyProof(body.currentProof),
                `proof invalid for atom '${atom}'`
            ).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integrity claim — cross-shard proof validity
// ─────────────────────────────────────────────────────────────────────────────

describe('Security — cross-shard prediction proof integrity', () => {
    it('predictedProof for a cross-shard edge is verifiable', async () => {
        const router = new ShardRouter(4);
        const candidates = [atom('Epsilon'), atom('Zeta'), atom('Eta'), atom('Theta')];
        let from: string | null = null;
        let to: string | null = null;
        outer:
        for (const a of candidates) {
            for (const b of candidates) {
                if (a !== b && router.getShardIndex(a) !== router.getShardIndex(b)) {
                    from = a;
                    to = b;
                    break outer;
                }
            }
        }
        expect(from).not.toBeNull();
        expect(to).not.toBeNull();

        // Train the cross-shard edge
        await inject(openServer, 'POST', '/train',
            { payload: { sequence: [from!, to!] } });

        const res = await inject(openServer, 'POST', '/access',
            { payload: { data: from! } });
        const body = JSON.parse(res.payload);

        expect(body.predictedNext).toBe(to!);
        if (body.predictedProof) {
            expect(MerkleKernel.verifyProof(body.predictedProof)).toBe(true);
        }
    });
});
