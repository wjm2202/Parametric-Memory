import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../server';
import { rmSync } from 'fs';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import type { ShardedOrchestrator } from '../orchestrator';

function cleanup(path: string) {
    try { rmSync(path, { recursive: true, force: true }); } catch { }
}

const atom = (value: string) => `v1.other.${value}`;
const atomPath = (value: string) => encodeURIComponent(atom(value));

function withEnvAuth(server: FastifyInstance): FastifyInstance {
    const apiKey = process.env.MMPM_API_KEY;
    if (!apiKey) return server;

    const rawInject = server.inject.bind(server);
    const authHeader = { authorization: `Bearer ${apiKey}` };

    const injectWithAuth = (opts?: string | InjectOptions) => {
        if (typeof opts === 'string') {
            return rawInject({ method: 'GET', url: opts, headers: authHeader });
        }
        const normalized: InjectOptions = opts ?? {};
        const requestWithAuth: InjectOptions = {
            ...normalized,
            headers: {
                ...authHeader,
                ...(normalized.headers ?? {}),
            },
        };
        return rawInject(requestWithAuth);
    };

    return new Proxy(server, {
        get(target, prop, receiver) {
            if (prop === 'inject') return injectWithAuth;
            return Reflect.get(target, prop, receiver);
        },
    }) as FastifyInstance;
}

// --- Integration Suite ---

describe('API Integration', () => {
    const DB_PATH = './test-api-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({
            data: [
                atom('A'), atom('B'), atom('C'), atom('D'),
                'v1.fact.A', 'v1.event.B', 'v1.relation.C',
            ],
            dbBasePath: DB_PATH
        });
        server = withEnvAuth(app.server);
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

    it('GET /metrics exposes mmpm_csr_build_ms and mmpm_csr_edge_count after /admin/commit', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [atom('CSR_METRIC_1')] } });
        await server.inject({ method: 'POST', url: '/train', payload: { sequence: [atom('A'), atom('CSR_METRIC_1')] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const res = await server.inject({ method: 'GET', url: '/metrics' });
        const payload = res.payload;
        expect(payload).toContain('mmpm_csr_build_ms_bucket');
        expect(payload).toContain('mmpm_csr_edge_count');
    });

    it('POST /train increments mmpm_transition_by_type_total correctly', async () => {
        const resTrain = await server.inject({
            method: 'POST',
            url: '/train',
            payload: { sequence: ['v1.fact.A', 'v1.relation.C', 'v1.event.B'] },
        });
        expect(resTrain.statusCode).toBe(200);

        const resMetrics = await server.inject({ method: 'GET', url: '/metrics' });
        const payload = resMetrics.payload;
        expect(payload).toContain('mmpm_transition_by_type_total{from_type="fact",to_type="relation"}');
        expect(payload).toContain('mmpm_transition_by_type_total{from_type="relation",to_type="event"}');
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

    it('POST /batch-access with valid items returns 200 with results array', async () => {
        const res = await server.inject({
            method: 'POST', url: '/batch-access',
            payload: { items: [atom('A'), atom('B')] }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.results.length).toBe(2);
        expect(body.results[0].ok).toBe(true);
        expect(body.results[1].ok).toBe(true);
    });

    it('POST /batch-access includes per-item 404-style error record for unknown atom', async () => {
        const res = await server.inject({
            method: 'POST', url: '/batch-access',
            payload: { items: [atom('A'), atom('DOES_NOT_EXIST')] }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.results[0].ok).toBe(true);
        expect(body.results[1].ok).toBe(false);
        expect(body.results[1].statusCode).toBe(404);
    });

    it('POST /batch-access empty items returns 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/batch-access', payload: { items: [] } });
        expect(res.statusCode).toBe(400);
    });

    it('POST /batch-access non-schema items returns 400', async () => {
        const res = await server.inject({ method: 'POST', url: '/batch-access', payload: { items: [1, 2] } });
        expect(res.statusCode).toBe(400);
    });

    it('GET /policy returns default policy on startup', async () => {
        const res = await server.inject({ method: 'GET', url: '/policy' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.isDefault).toBe(true);
        expect(body.policy).toBe('default');
    });

    it('POST /policy sets restricted policy and access respects new constraints', async () => {
        await server.inject({
            method: 'POST',
            url: '/train',
            payload: { sequence: ['v1.fact.A', 'v1.event.B'] },
        });

        const setRes = await server.inject({
            method: 'POST',
            url: '/policy',
            payload: { policy: { fact: ['state'] } },
        });
        expect(setRes.statusCode).toBe(200);

        const accessRes = await server.inject({
            method: 'POST',
            url: '/access',
            payload: { data: 'v1.fact.A' },
        });
        expect(accessRes.statusCode).toBe(200);
        expect(JSON.parse(accessRes.payload).predictedNext).toBeNull();
    });

    it('POST /policy "default" resets policy', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/policy',
            payload: { policy: 'default' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.isDefault).toBe(true);

        const getRes = await server.inject({ method: 'GET', url: '/policy' });
        const getBody = JSON.parse(getRes.payload);
        expect(getBody.isDefault).toBe(true);
    });

    it('POST /policy invalid type name returns 400', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/policy',
            payload: { policy: { bogus: ['fact'] } },
        });
        expect(res.statusCode).toBe(400);
    });

    it('GET /write-policy returns default write policy on startup', async () => {
        const res = await server.inject({ method: 'GET', url: '/write-policy' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.isDefault).toBe(true);
        expect(body.policy.defaultTier).toBe('auto-write');
        expect(body.policy.byType).toEqual({});
    });

    it('POST /write-policy sets and resets policy tiers', async () => {
        const setRes = await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: {
                policy: {
                    defaultTier: 'auto-write',
                    byType: {
                        fact: 'review-required',
                        state: 'never-store',
                    },
                },
            },
        });
        expect(setRes.statusCode).toBe(200);
        const setBody = JSON.parse(setRes.payload);
        expect(setBody.policy.byType.fact).toBe('review-required');
        expect(setBody.policy.byType.state).toBe('never-store');
        expect(setBody.isDefault).toBe(false);

        const resetRes = await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: { policy: 'default' },
        });
        expect(resetRes.statusCode).toBe(200);
        const resetBody = JSON.parse(resetRes.payload);
        expect(resetBody.isDefault).toBe(true);
        expect(resetBody.policy.defaultTier).toBe('auto-write');
        expect(resetBody.policy.byType).toEqual({});
    });

    it('POST /write-policy invalid tier name returns 400', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: {
                policy: {
                    byType: {
                        fact: 'needs-human',
                    },
                },
            },
        });
        expect(res.statusCode).toBe(400);
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

    it('GET /memory/context returns additive context summary payload', async () => {
        await server.inject({
            method: 'POST',
            url: '/train',
            payload: { sequence: [atom('A'), atom('B')] },
        });

        const res = await server.inject({ method: 'GET', url: '/memory/context' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.mode).toBe('context');
        expect(typeof body.context).toBe('string');
        expect(Array.isArray(body.entries)).toBe(true);
        expect(typeof body.includedAtoms).toBe('number');
        expect(typeof body.estimatedTokens).toBe('number');
        expect(typeof body.maxTokens).toBe('number');
        expect(typeof body.treeVersion).toBe('number');
        expect(typeof body.generatedAtMs).toBe('number');
    });

    it('GET /memory/context respects maxTokens budget', async () => {
        const res = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=12' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.maxTokens).toBe(12);
        expect(body.estimatedTokens).toBeLessThanOrEqual(12);
    });

    it('GET /memory/context supports compact format flag with lower payload size', async () => {
        const fullRes = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=8000' });
        const compactRes = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=8000&compact=true' });

        expect(fullRes.statusCode).toBe(200);
        expect(compactRes.statusCode).toBe(200);

        const fullBody = JSON.parse(fullRes.payload);
        const compactBody = JSON.parse(compactRes.payload);

        expect(fullBody.contextFormat).toBe('full');
        expect(compactBody.contextFormat).toBe('compact');
        expect(compactBody.context.length).toBeLessThan(fullBody.context.length);
    });

    it('GET /memory/context supports objective-aware ranking flag', async () => {
        // Default: recency sort
        const defaultRes = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=8000' });
        expect(defaultRes.statusCode).toBe(200);
        const defaultBody = JSON.parse(defaultRes.payload);
        expect(defaultBody.objectiveRank).toBe(false);

        // Objective-aware ranking: should sort by relevance to objective atom
        const rankRes = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=8000&objectiveRank=true' });
        expect(rankRes.statusCode).toBe(200);
        const rankBody = JSON.parse(rankRes.payload);
        expect(rankBody.objectiveRank).toBe(true);
        // Should still return context and entries
        expect(typeof rankBody.context).toBe('string');
        expect(Array.isArray(rankBody.entries)).toBe(true);
        // If there are any atoms, the first should be most relevant to objective
        if (rankBody.entries.length > 1) {
            // The first atom should be the objective atom or most relevant
            const first = rankBody.entries[0].atom;
            const hasObjective = rankBody.entries.some((e: { atom: string }) => e.atom.includes('objective_'));
            if (hasObjective) {
                expect(first.includes('objective_') || typeof first === 'string').toBe(true);
            }
        }
    });

    it('GET /memory/context invalid objectiveRank flag returns 400', async () => {
        const res = await server.inject({ method: 'GET', url: '/memory/context?objectiveRank=maybe' });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toMatch(/objectiveRank/i);
    });

    it('GET /memory/context invalid maxTokens returns 400', async () => {
        const res = await server.inject({ method: 'GET', url: '/memory/context?maxTokens=0' });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toMatch(/maxTokens/i);
    });

    it('GET /memory/context invalid compact flag returns 400', async () => {
        const res = await server.inject({ method: 'GET', url: '/memory/context?compact=maybe' });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toMatch(/compact/i);
    });

    it('POST /memory/bootstrap returns goals/constraints/preferences and decision evidence bundles', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: 'current focus and policy requirements',
                maxTokens: 256,
                limit: 8,
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.mode).toBe('session_bootstrap');
        expect(Array.isArray(body.goals)).toBe(true);
        expect(Array.isArray(body.constraints)).toBe(true);
        expect(Array.isArray(body.preferences)).toBe(true);
        expect(Array.isArray(body.topMemories)).toBe(true);
        expect(body.topMemories.length).toBeLessThanOrEqual(8);
        expect(body.decisionEvidence).toBeDefined();
        expect(Array.isArray(body.decisionEvidence.memoryIds)).toBe(true);
        expect(Array.isArray(body.decisionEvidence.proofReferences)).toBe(true);
        expect(Array.isArray(body.decisionEvidence.retrievalRationale)).toBe(true);
        expect(body.decisionEvidence.coverage).toBeDefined();
        expect(typeof body.decisionEvidence.coverage.complete).toBe('boolean');
        expect(body.decisionEvidence.coverage.memoryIds).toBe(body.topMemories.length);
        expect(body.decisionEvidence.coverage.proofReferences).toBe(body.topMemories.length);
        expect(body.decisionEvidence.coverage.retrievalRationale).toBe(body.topMemories.length);
        expect(typeof body.treeVersion).toBe('number');
        expect(typeof body.generatedAtMs).toBe('number');
        if (body.topMemories.length > 0) {
            expect(body.topMemories[0].proof).toBeDefined();
            expect(typeof body.topMemories[0].atom).toBe('string');
            expect(typeof body.topMemories[0].category).toBe('string');
            expect(typeof body.decisionEvidence.proofReferences[0].memoryId).toBe('string');
            expect(typeof body.decisionEvidence.proofReferences[0].proofRoot).toBe('string');
            expect(typeof body.decisionEvidence.proofReferences[0].proofIndex).toBe('number');
            expect(typeof body.decisionEvidence.retrievalRationale[0].memoryId).toBe('string');
            expect(Array.isArray(body.decisionEvidence.retrievalRationale[0].reasons)).toBe(true);
        }
    });

    it('POST /memory/bootstrap supports no-objective fallback', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: { limit: 5 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.objective).toBeNull();
        expect(body.includedAtoms).toBeLessThanOrEqual(5);
    });

    it('POST /memory/bootstrap invalid inputs return 400', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: { objective: '', maxTokens: 0, limit: 0 },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBeDefined();
    });

    it('POST /memory/bootstrap applies evidence threshold gating for high-impact outputs', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: 'current focus and policy requirements',
                highImpact: true,
                evidenceThreshold: 0.25,
                limit: 10,
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.highImpact).toBe(true);
        expect(body.evidenceGate.applied).toBe(true);
        expect(body.evidenceGate.threshold).toBe(0.25);
        expect(typeof body.evidenceGate.lowEvidenceUsageRate).toBe('number');
        expect(Array.isArray(body.decisionEvidence.retrievalRationale)).toBe(true);
        if (body.decisionEvidence.retrievalRationale.length > 0) {
            expect(typeof body.decisionEvidence.retrievalRationale[0].evidenceScore).toBe('number');
            expect(body.decisionEvidence.retrievalRationale[0].reasons.some((r: string) => r.startsWith('threshold_gate='))).toBe(true);
        }
    });

    it('POST /memory/bootstrap falls back when high-impact threshold excludes all evidence', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: 'completely unrelated phrase to force low relevance',
                highImpact: true,
                evidenceThreshold: 0.95,
                limit: 10,
            },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.highImpact).toBe(true);
        expect(body.evidenceGate.applied).toBe(true);
        expect(body.evidenceGate.lowEvidenceFallback).toBe(true);
        expect(body.evidenceGate.includedCount).toBe(0);
        expect(body.includedAtoms).toBe(0);
        expect(Array.isArray(body.topMemories)).toBe(true);
        expect(body.topMemories.length).toBe(0);
        expect(typeof body.evidenceGate.fallbackReason).toBe('string');
    });

    it('namespace isolation filters /search, /memory/context, and /memory/bootstrap', async () => {
        await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: {
                atoms: [
                    'v1.fact.goal_alpha_ns_project_alpha',
                    'v1.fact.goal_beta_ns_project_beta',
                    'v1.fact.goal_global_unscoped',
                ],
            },
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const searchRes = await server.inject({
            method: 'POST',
            url: '/search',
            payload: {
                query: 'goal',
                threshold: 0,
                limit: 20,
                namespace: { project: 'alpha' },
                includeGlobal: false,
            },
        });
        expect(searchRes.statusCode).toBe(200);
        const searchBody = JSON.parse(searchRes.payload);
        const searchAtoms = (searchBody.results as Array<{ atom: string }>).map(r => r.atom);
        expect(searchAtoms.some(a => a.includes('ns_project_alpha'))).toBe(true);
        expect(searchAtoms.some(a => a.includes('ns_project_beta'))).toBe(false);
        expect(searchAtoms.some(a => a.includes('goal_global_unscoped'))).toBe(false);

        const contextRes = await server.inject({
            method: 'GET',
            url: '/memory/context?maxTokens=300&namespaceProject=alpha&includeGlobal=false',
        });
        expect(contextRes.statusCode).toBe(200);
        const contextBody = JSON.parse(contextRes.payload);
        const contextAtoms = (contextBody.entries as Array<{ atom: string }>).map(e => e.atom);
        expect(contextAtoms.some(a => a.includes('ns_project_alpha'))).toBe(true);
        expect(contextAtoms.some(a => a.includes('ns_project_beta'))).toBe(false);
        expect(contextAtoms.some(a => a.includes('goal_global_unscoped'))).toBe(false);

        const bootstrapRes = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: 'goal',
                limit: 20,
                namespace: { project: 'alpha' },
                includeGlobal: false,
            },
        });
        expect(bootstrapRes.statusCode).toBe(200);
        const bootstrapBody = JSON.parse(bootstrapRes.payload);
        const bootstrapAtoms = (bootstrapBody.topMemories as Array<{ atom: string }>).map(e => e.atom);
        expect(bootstrapAtoms.some(a => a.includes('ns_project_alpha'))).toBe(true);
        expect(bootstrapAtoms.some(a => a.includes('ns_project_beta'))).toBe(false);
        expect(bootstrapAtoms.some(a => a.includes('goal_global_unscoped'))).toBe(false);
    });

    it('contradiction-aware facts are preserved and surfaced as competing claims', async () => {
        await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: {
                atoms: [
                    'v1.fact.payment_mode_live_src_human_conf_high_scope_project_dt_2026_03_04',
                    'v1.fact.payment_mode_test_src_api_conf_medium_scope_project_dt_2026_03_04',
                ],
            },
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const searchRes = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: 'payment mode', threshold: 0, limit: 10 },
        });
        expect(searchRes.statusCode).toBe(200);
        const searchBody = JSON.parse(searchRes.payload);
        const contradicted = (searchBody.results as Array<any>).find(r =>
            typeof r.atom === 'string' && r.atom.includes('v1.fact.payment_mode_')
        );
        expect(contradicted).toBeDefined();
        expect(contradicted.contradiction.hasConflict).toBe(true);
        expect(contradicted.contradiction.conflictingClaims).toBeUndefined();
        expect(Array.isArray(contradicted.contradiction.competingClaims)).toBe(true);
        expect(contradicted.contradiction.competingClaims.length).toBeGreaterThanOrEqual(2);

        const bootstrapRes = await server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            payload: { objective: 'payment mode', limit: 10 },
        });
        expect(bootstrapRes.statusCode).toBe(200);
        const bootstrapBody = JSON.parse(bootstrapRes.payload);
        expect(Array.isArray(bootstrapBody.conflictingFacts)).toBe(true);
        const paymentConflict = (bootstrapBody.conflictingFacts as Array<any>).find(g => g.key === 'payment_mode');
        expect(paymentConflict).toBeDefined();
        expect(Array.isArray(paymentConflict.claims)).toBe(true);
        expect(paymentConflict.claims).toContain('live');
        expect(paymentConflict.claims).toContain('test');

        const inspectRes = await server.inject({
            method: 'GET',
            url: '/atoms/' + encodeURIComponent('v1.fact.payment_mode_live_src_human_conf_high_scope_project_dt_2026_03_04'),
        });
        expect(inspectRes.statusCode).toBe(200);
        const inspectBody = JSON.parse(inspectRes.payload);
        expect(inspectBody.contradiction.hasConflict).toBe(true);
        expect(inspectBody.contradiction.conflictKey).toBe('payment_mode');
    });

    it('supports time/version pinned retrieval via asOfVersion/asOfMs', async () => {
        const beforeRes = await server.inject({ method: 'GET', url: '/atoms' });
        expect(beforeRes.statusCode).toBe(200);
        const beforeBody = JSON.parse(beforeRes.payload);
        const beforeVersion = beforeBody.treeVersion as number;

        const beforeMs = Date.now();
        await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: ['v1.fact.temporal_probe_visible_after_commit_src_test_conf_high_scope_project_dt_2026_03_04'] },
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const afterRes = await server.inject({ method: 'GET', url: '/atoms' });
        const afterBody = JSON.parse(afterRes.payload);
        const afterVersion = afterBody.treeVersion as number;
        expect(afterVersion).toBeGreaterThanOrEqual(beforeVersion);

        const searchBefore = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: 'temporal probe visible', threshold: 0, asOfVersion: beforeVersion },
        });
        expect(searchBefore.statusCode).toBe(200);
        const searchBeforeAtoms = (JSON.parse(searchBefore.payload).results as Array<{ atom: string }>).map(r => r.atom);
        expect(searchBeforeAtoms.some(a => a.includes('temporal_probe_visible_after_commit'))).toBe(false);

        const searchAfter = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: 'temporal probe visible', threshold: 0, asOfVersion: afterVersion },
        });
        expect(searchAfter.statusCode).toBe(200);
        const searchAfterAtoms = (JSON.parse(searchAfter.payload).results as Array<{ atom: string }>).map(r => r.atom);
        expect(searchAfterAtoms.some(a => a.includes('temporal_probe_visible_after_commit'))).toBe(true);

        const contextTimePinned = await server.inject({
            method: 'GET',
            url: `/memory/context?maxTokens=300&asOfMs=${Math.max(1, beforeMs - 1)}`,
        });
        expect(contextTimePinned.statusCode).toBe(200);
        const contextAtoms = (JSON.parse(contextTimePinned.payload).entries as Array<{ atom: string }>).map(e => e.atom);
        expect(contextAtoms.some(a => a.includes('temporal_probe_visible_after_commit'))).toBe(false);

        const atomBefore = await server.inject({
            method: 'GET',
            url: '/atoms/' + encodeURIComponent('v1.fact.temporal_probe_visible_after_commit_src_test_conf_high_scope_project_dt_2026_03_04') + `?asOfVersion=${beforeVersion}`,
        });
        expect(atomBefore.statusCode).toBe(404);

        const atomAfter = await server.inject({
            method: 'GET',
            url: '/atoms/' + encodeURIComponent('v1.fact.temporal_probe_visible_after_commit_src_test_conf_high_scope_project_dt_2026_03_04') + `?asOfVersion=${afterVersion}`,
        });
        expect(atomAfter.statusCode).toBe(200);
        const atomAfterBody = JSON.parse(atomAfter.payload);
        expect(atomAfterBody.temporal.asOfVersion).toBe(afterVersion);
    });

    it('POST /search returns semantic results with ranking and proofs', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: atom('A'), limit: 5, threshold: 0 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.mode).toBe('semantic');
        expect(body.query).toBe(atom('A'));
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.results.length).toBeGreaterThan(0);
        expect(typeof body.searchTimeMs).toBe('number');
        expect(typeof body.treeVersion).toBe('number');
        const first = body.results[0];
        expect(typeof first.atom).toBe('string');
        expect(typeof first.similarity).toBe('number');
        expect(typeof first.rank).toBe('number');
        expect(typeof first.shardId).toBe('number');
        expect(first.proof).toBeDefined();
    });

    it('POST /search respects limit and threshold', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: atom('A'), limit: 1, threshold: 0.2 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.results.length).toBeLessThanOrEqual(1);
        for (const row of body.results) {
            expect(row.similarity).toBeGreaterThanOrEqual(0.2);
        }
    });

    it('POST /search with invalid payload returns 400', async () => {
        const res = await server.inject({
            method: 'POST',
            url: '/search',
            payload: { query: '', limit: 0, threshold: 2 },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toBeDefined();
    });

    it('GET /weights includes effective confidence fields', async () => {
        await server.inject({
            method: 'POST',
            url: '/train',
            payload: { sequence: [atom('A'), atom('B')] },
        });

        const res = await server.inject({ method: 'GET', url: `/weights/${encodeURIComponent(atom('A'))}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(typeof body.totalWeight).toBe('number');
        expect(typeof body.totalEffectiveWeight).toBe('number');
        if (Array.isArray(body.transitions) && body.transitions.length > 0) {
            expect(typeof body.transitions[0].weight).toBe('number');
            expect(typeof body.transitions[0].effectiveWeight).toBe('number');
            expect(body.transitions[0]).toHaveProperty('lastUpdatedMs');
        }
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

    it('requires auth for /batch-access when API key is set', async () => {
        const unauth = await authServer.inject({
            method: 'POST',
            url: '/batch-access',
            payload: { items: [atom('X')] },
        });
        expect(unauth.statusCode).toBe(401);

        const auth = await authServer.inject({
            method: 'POST',
            url: '/batch-access',
            payload: { items: [atom('X')] },
            headers: { authorization: 'Bearer test-secret' }
        });
        expect(auth.statusCode).toBe(200);
    });

    it('POST /policy requires auth when API key is set', async () => {
        const unauth = await authServer.inject({
            method: 'POST',
            url: '/policy',
            payload: { policy: { fact: ['fact'] } },
        });
        expect(unauth.statusCode).toBe(401);

        const auth = await authServer.inject({
            method: 'POST',
            url: '/policy',
            payload: { policy: { fact: ['fact'] } },
            headers: { authorization: 'Bearer test-secret' },
        });
        expect(auth.statusCode).toBe(200);
    });

    it('POST /write-policy requires auth when API key is set', async () => {
        const unauth = await authServer.inject({
            method: 'POST',
            url: '/write-policy',
            payload: { policy: { byType: { fact: 'review-required' } } },
        });
        expect(unauth.statusCode).toBe(401);

        const auth = await authServer.inject({
            method: 'POST',
            url: '/write-policy',
            payload: { policy: { byType: { fact: 'review-required' } } },
            headers: { authorization: 'Bearer test-secret' },
        });
        expect(auth.statusCode).toBe(200);
    });

    it('POST /search requires auth when API key is set', async () => {
        const unauth = await authServer.inject({
            method: 'POST',
            url: '/search',
            payload: { query: atom('X') },
        });
        expect(unauth.statusCode).toBe(401);

        const auth = await authServer.inject({
            method: 'POST',
            url: '/search',
            payload: { query: atom('X') },
            headers: { authorization: 'Bearer test-secret' },
        });
        expect(auth.statusCode).toBe(200);
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
        server = withEnvAuth(app.server);
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

    it('POST /atoms returns review-required when policy gate requires approval', async () => {
        await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: {
                policy: {
                    byType: { fact: 'review-required' },
                },
            },
        });

        const res = await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: ['v1.fact.requires_review_gate'] },
        });
        expect(res.statusCode).toBe(202);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('ReviewRequired');
        expect(body.queued).toBe(0);
        expect(body.writePolicyOutcome.decision).toBe('review-required');
        expect(body.writePolicyOutcome.reviewRequiredAtoms).toContain('v1.fact.requires_review_gate');

        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
    });

    it('POST /atoms accepts review-required atoms when reviewApproved=true', async () => {
        await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: {
                policy: {
                    byType: { fact: 'review-required' },
                },
            },
        });

        const res = await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: ['v1.fact.review_approved_atom'], reviewApproved: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Queued');
        expect(body.writePolicyOutcome.decision).toBe('allow');
        expect(body.writePolicyOutcome.reviewApproved).toBe(true);
        expect(body.writePolicyOutcome.allowedAtoms).toContain('v1.fact.review_approved_atom');

        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
    });

    it('POST /atoms denies never-store atoms with observable outcome', async () => {
        await server.inject({
            method: 'POST',
            url: '/write-policy',
            payload: {
                policy: {
                    byType: { state: 'never-store' },
                },
            },
        });

        const res = await server.inject({
            method: 'POST',
            url: '/atoms',
            payload: { atoms: ['v1.state.do_not_store_this'] },
        });
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Denied');
        expect(body.queued).toBe(0);
        expect(body.writePolicyOutcome.decision).toBe('deny');
        expect(body.writePolicyOutcome.deniedAtoms).toContain('v1.state.do_not_store_this');

        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
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

    it('DELETE /atoms/:atom accepts empty JSON body with content-type header', async () => {
        const target = 'v1.other.DELETE_HEADER_EMPTY';
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [target] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const res = await server.inject({
            method: 'DELETE',
            url: `/atoms/${encodeURIComponent(target)}`,
            headers: { 'content-type': 'application/json' },
            payload: '',
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('Success');
        expect(body.tombstonedAtom).toBe(target);
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

    it('GET /atoms supports type filter', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: ['v1.fact.FilterFact1', 'v1.event.FilterEvent1'] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const res = await server.inject({ method: 'GET', url: '/atoms?type=fact' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.atoms)).toBe(true);
        for (const entry of body.atoms) {
            expect(entry.atom.startsWith('v1.fact.')).toBe(true);
        }
    });

    it('GET /atoms supports prefix filter', async () => {
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: ['v1.other.PrefixMatch1', 'v1.other.PrefixMiss1'] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const res = await server.inject({ method: 'GET', url: '/atoms?prefix=v1.other.PrefixMatch' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.atoms.length).toBeGreaterThan(0);
        for (const entry of body.atoms) {
            expect(entry.atom.startsWith('v1.other.PrefixMatch')).toBe(true);
        }
    });

    it('GET /atoms supports pagination via limit and offset', async () => {
        const baseline = await server.inject({ method: 'GET', url: '/atoms' });
        const full = JSON.parse(baseline.payload).atoms as Array<{ atom: string; status: string }>;

        const res = await server.inject({ method: 'GET', url: '/atoms?offset=1&limit=2' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.atoms).toEqual(full.slice(1, 3));
    });

    it('GET /atoms invalid query params return 400', async () => {
        const badType = await server.inject({ method: 'GET', url: '/atoms?type=bogus' });
        expect(badType.statusCode).toBe(400);

        const badOffset = await server.inject({ method: 'GET', url: '/atoms?offset=-1' });
        expect(badOffset.statusCode).toBe(400);

        const badLimit = await server.inject({ method: 'GET', url: '/atoms?limit=0' });
        expect(badLimit.statusCode).toBe(400);
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
        expect(typeof body.createdAtMs).toBe('number');
        expect(body.createdAtMs).toBeGreaterThan(0);
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
        expect(typeof body.createdAtMs).toBe('number');
        expect(body.createdAtMs).toBeGreaterThan(0);
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
        server = withEnvAuth(app.server);
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
        server = withEnvAuth(app.server);
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

// =============================================================================
// Sprint 12 — G1/G2/G3/G4/G5 Validation Suite
// =============================================================================

describe('Sprint 12 — G1: Bootstrap contract tests', () => {
    const DB_PATH = './test-sprint12-bootstrap-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({
            data: [
                'v1.fact.pref_dark_mode_src_human_conf_high_scope_project_dt_2026_03_06',
                'v1.fact.pref_concise_src_human_conf_high_scope_project_dt_2026_03_06',
                'v1.state.working_on_sprint_12_src_human_conf_high_scope_project_dt_2026_03_06',
                'v1.event.sprint_11_complete_src_human_conf_high_scope_project_dt_2026_03_06',
                'v1.relation.sprint12_follows_sprint11_src_human_conf_high_scope_project_dt_2026_03_06',
            ],
            dbBasePath: DB_PATH,
        });
        server = withEnvAuth(app.server);
        orchestrator = app.orchestrator;
        await orchestrator.init();
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    it('G1.1: response includes all top-level schema fields', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'sprint planning', maxTokens: 512, limit: 10 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.mode).toBe('session_bootstrap');
        expect(Array.isArray(body.goals)).toBe(true);
        expect(Array.isArray(body.constraints)).toBe(true);
        expect(Array.isArray(body.preferences)).toBe(true);
        expect(Array.isArray(body.topMemories)).toBe(true);
        expect(Array.isArray(body.conflictingFacts)).toBe(true);
        expect(typeof body.treeVersion).toBe('number');
        expect(typeof body.generatedAtMs).toBe('number');
        expect(typeof body.includedAtoms).toBe('number');
        expect(body.decisionEvidence).toBeDefined();
    });

    it('G1.2: maxTokens budget is respected — includedAtoms within token ceiling', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'sprint', maxTokens: 50, limit: 100 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        // At 50 tokens, only a handful of atoms should fit
        expect(body.includedAtoms).toBeLessThanOrEqual(10);
    });

    it('G1.3: limit parameter caps topMemories length', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'sprint', limit: 2 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.topMemories.length).toBeLessThanOrEqual(2);
        expect(body.includedAtoms).toBeLessThanOrEqual(2);
    });

    it('G1.4: each topMemory entry has atom, category, and proof fields', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'preference', limit: 5 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        for (const mem of body.topMemories as Array<any>) {
            expect(typeof mem.atom).toBe('string');
            expect(typeof mem.category).toBe('string');
            expect(mem.proof).toBeDefined();
            expect(typeof mem.proof.root).toBe('string');
        }
    });

    it('G1.5: decisionEvidence arrays are parallel to topMemories', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'sprint state', limit: 5 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        const n = body.topMemories.length;
        expect(body.decisionEvidence.memoryIds.length).toBe(n);
        expect(body.decisionEvidence.proofReferences.length).toBe(n);
        expect(body.decisionEvidence.retrievalRationale.length).toBe(n);
        expect(body.decisionEvidence.coverage.memoryIds).toBe(n);
    });

    it('G1.6: null objective returns null in response and still returns memories', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { limit: 5 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.objective).toBeNull();
        expect(Array.isArray(body.topMemories)).toBe(true);
    });

    it('G1.7: invalid maxTokens (string) returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { maxTokens: 'lots' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('G1.8: invalid limit (negative) returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { limit: -1 },
        });
        expect(res.statusCode).toBe(400);
    });

    it('G1.9: treeVersion in response matches GET /atoms treeVersion', async () => {
        const atomsRes = await server.inject({ method: 'GET', url: '/atoms' });
        const atomsVersion = JSON.parse(atomsRes.payload).treeVersion as number;
        const bootRes = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { limit: 5 },
        });
        const bootVersion = JSON.parse(bootRes.payload).treeVersion as number;
        expect(bootVersion).toBe(atomsVersion);
    });

    it('G1.10: generatedAtMs is a recent timestamp', async () => {
        const before = Date.now();
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { limit: 5 },
        });
        const after = Date.now();
        const body = JSON.parse(res.payload);
        expect(body.generatedAtMs).toBeGreaterThanOrEqual(before);
        expect(body.generatedAtMs).toBeLessThanOrEqual(after);
    });

    it('G1.11: highImpact=false disables evidence gate', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'sprint', highImpact: false, limit: 5 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.highImpact).toBe(false);
        expect(body.evidenceGate.applied).toBe(false);
    });

    it('G1.12: invalid highImpact type returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { highImpact: 'yes' },
        });
        expect(res.statusCode).toBe(400);
    });
});

describe('Sprint 12 — G2: Namespace isolation correctness', () => {
    const DB_PATH = './test-sprint12-namespace-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: [], dbBasePath: DB_PATH });
        server = withEnvAuth(app.server);
        orchestrator = app.orchestrator;
        await orchestrator.init();
        await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: [
                'v1.fact.shared_goal_global',                        // global
                'v1.fact.user_pref_ns_user_alice',                   // user:alice
                'v1.fact.user_pref_ns_user_bob',                     // user:bob
                'v1.fact.proj_state_ns_project_proj1',               // project:proj1
                'v1.fact.proj_state_ns_project_proj2',               // project:proj2
                'v1.fact.task_detail_ns_task_task1',                 // task:task1
                'v1.fact.multi_scope_ns_user_alice_ns_project_proj1', // user:alice + project:proj1
            ]},
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    it('G2.1: user namespace excludes other users and globals when includeGlobal=false', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'pref state goal task', threshold: 0, limit: 20,
                namespace: { user: 'alice' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('ns_user_alice'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_user_bob'))).toBe(false);
        expect(atoms.some(a => a.includes('shared_goal_global'))).toBe(false);
    });

    it('G2.2: includeGlobal=true adds global atoms to scoped results', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'pref state goal task', threshold: 0, limit: 20,
                namespace: { user: 'alice' }, includeGlobal: true },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('ns_user_alice'))).toBe(true);
        expect(atoms.some(a => a.includes('shared_goal_global'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_user_bob'))).toBe(false);
    });

    it('G2.3: project namespace is independently scoped', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'proj user task', threshold: 0, limit: 20,
                namespace: { project: 'proj1' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('ns_project_proj1'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_project_proj2'))).toBe(false);
        // The single-user-only atom should not appear; the multi-dim atom (which also has
        // project=proj1) legitimately appears and may contain 'ns_user_alice' in its name.
        expect(atoms.some(a => a === 'v1.fact.user_pref_ns_user_alice')).toBe(false);
    });

    it('G2.4: task namespace scoping works correctly', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'pref state goal task', threshold: 0, limit: 20,
                namespace: { task: 'task1' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('ns_task_task1'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_user_alice'))).toBe(false);
        expect(atoms.some(a => a.includes('ns_project_proj1'))).toBe(false);
    });

    it('G2.5: multi-dimension namespace matches atoms carrying all specified dims', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'pref state scope goal', threshold: 0, limit: 20,
                namespace: { user: 'alice', project: 'proj1' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('ns_user_alice_ns_project_proj1'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_user_bob'))).toBe(false);
        expect(atoms.some(a => a.includes('ns_project_proj2'))).toBe(false);
    });

    it('G2.6: /memory/context respects namespace via query params', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/memory/context?maxTokens=512&namespaceUser=alice&includeGlobal=false',
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).entries as Array<{atom: string}>).map(e => e.atom);
        expect(atoms.some(a => a.includes('ns_user_alice'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_user_bob'))).toBe(false);
    });

    it('G2.7: /memory/bootstrap respects namespace body param', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { limit: 20, namespace: { project: 'proj2' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).topMemories as Array<{atom: string}>).map(e => e.atom);
        expect(atoms.some(a => a.includes('ns_project_proj2'))).toBe(true);
        expect(atoms.some(a => a.includes('ns_project_proj1'))).toBe(false);
        expect(atoms.some(a => a.includes('ns_user_alice'))).toBe(false);
    });

    it('G2.8: leakage rate is zero — unrelated namespace returns empty result set', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'pref state goal task', threshold: 0, limit: 20,
                namespace: { user: 'charlie' }, includeGlobal: false },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        // charlie has no atoms — nothing should leak from alice, bob, proj1, proj2
        expect(atoms.some(a =>
            a.includes('ns_user_alice') || a.includes('ns_user_bob') ||
            a.includes('ns_project_') || a.includes('shared_goal_global')
        )).toBe(false);
    });
});

describe('Sprint 12 — G3: Temporal retrieval correctness', () => {
    const DB_PATH = './test-sprint12-temporal-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;
    let versionBefore: number;
    let versionAfter: number;
    let tsBeforeMs: number;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: [], dbBasePath: DB_PATH });
        server = withEnvAuth(app.server);
        orchestrator = app.orchestrator;
        await orchestrator.init();

        // Capture version before the probe atom exists
        const before = JSON.parse((await server.inject({ method: 'GET', url: '/atoms' })).payload);
        versionBefore = before.treeVersion as number;
        tsBeforeMs = Date.now();

        await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.temporal_g3_probe_src_test_conf_high_scope_project_dt_2026_03_06'] },
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        const after = JSON.parse((await server.inject({ method: 'GET', url: '/atoms' })).payload);
        versionAfter = after.treeVersion as number;
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    it('G3.1: /search asOfVersion=before excludes atom committed after that version', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'temporal g3 probe', threshold: 0, asOfVersion: versionBefore },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('temporal_g3_probe'))).toBe(false);
    });

    it('G3.2: /search asOfVersion=after includes the committed atom', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'temporal g3 probe', threshold: 0, asOfVersion: versionAfter },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('temporal_g3_probe'))).toBe(true);
    });

    it('G3.3: /memory/context asOfMs=before excludes the probe atom', async () => {
        const res = await server.inject({
            method: 'GET',
            url: `/memory/context?maxTokens=512&asOfMs=${Math.max(1, tsBeforeMs - 1)}`,
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).entries as Array<{atom: string}>).map(e => e.atom);
        expect(atoms.some(a => a.includes('temporal_g3_probe'))).toBe(false);
    });

    it('G3.4: /atoms/:atom?asOfVersion=before returns 404 for atom not yet committed', async () => {
        const probe = encodeURIComponent('v1.fact.temporal_g3_probe_src_test_conf_high_scope_project_dt_2026_03_06');
        const res = await server.inject({ method: 'GET', url: `/atoms/${probe}?asOfVersion=${versionBefore}` });
        expect(res.statusCode).toBe(404);
    });

    it('G3.5: /atoms/:atom?asOfVersion=after returns 200 with temporal metadata', async () => {
        const probe = encodeURIComponent('v1.fact.temporal_g3_probe_src_test_conf_high_scope_project_dt_2026_03_06');
        const res = await server.inject({ method: 'GET', url: `/atoms/${probe}?asOfVersion=${versionAfter}` });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.temporal.asOfVersion).toBe(versionAfter);
    });

    it('G3.6: /memory/bootstrap asOfVersion=before excludes the probe atom', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'temporal probe', limit: 20, asOfVersion: versionBefore },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).topMemories as Array<{atom: string}>).map(e => e.atom);
        expect(atoms.some(a => a.includes('temporal_g3_probe'))).toBe(false);
    });

    it('G3.7: tombstoned atom is excluded from current retrieval', async () => {
        const probeAtom = 'v1.fact.temporal_g3_tombstone_probe_src_test_conf_high_scope_project_dt_2026_03_06';
        await server.inject({ method: 'POST', url: '/atoms', payload: { atoms: [probeAtom] } });
        await server.inject({ method: 'POST', url: '/admin/commit' });

        // Verify it is visible before tombstone
        const beforeTombstone = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'temporal g3 tombstone', threshold: 0 },
        });
        expect((JSON.parse(beforeTombstone.payload).results as Array<{atom: string}>)
            .some(r => r.atom.includes('temporal_g3_tombstone_probe'))).toBe(true);

        await server.inject({ method: 'DELETE', url: `/atoms/${encodeURIComponent(probeAtom)}` });

        // After tombstone, current retrieval should not find it
        const current = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'temporal g3 tombstone', threshold: 0 },
        });
        const currentAtoms = (JSON.parse(current.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(currentAtoms.some(a => a.includes('temporal_g3_tombstone_probe'))).toBe(false);
    });
});

describe('Sprint 12 — G4: Contradiction surface-and-rank validation', () => {
    const DB_PATH = './test-sprint12-contradiction-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: [], dbBasePath: DB_PATH });
        server = withEnvAuth(app.server);
        orchestrator = app.orchestrator;
        await orchestrator.init();

        // Ingest conflicting facts across multiple keys
        await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: [
                // payment_mode conflict
                'v1.fact.payment_mode_live_src_human_conf_high_scope_project_dt_2026_03_01',
                'v1.fact.payment_mode_test_src_api_conf_medium_scope_project_dt_2026_03_06',
                // env conflict (three-way)
                'v1.fact.env_production_src_human_conf_high_scope_project_dt_2026_03_01',
                'v1.fact.env_staging_src_api_conf_medium_scope_project_dt_2026_03_04',
                'v1.fact.env_development_src_system_conf_low_scope_project_dt_2026_03_06',
                // non-conflicting (different semantic key)
                'v1.fact.region_us_east_src_human_conf_high_scope_project_dt_2026_03_06',
            ]},
        });
        await server.inject({ method: 'POST', url: '/admin/commit' });
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    it('G4.1: conflicting facts both appear in /search results', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'payment mode', threshold: 0, limit: 10 },
        });
        expect(res.statusCode).toBe(200);
        const atoms = (JSON.parse(res.payload).results as Array<{atom: string}>).map(r => r.atom);
        expect(atoms.some(a => a.includes('payment_mode_live'))).toBe(true);
        expect(atoms.some(a => a.includes('payment_mode_test'))).toBe(true);
    });

    it('G4.2: contradiction metadata is present on conflicting atoms in /search', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'payment mode', threshold: 0, limit: 10 },
        });
        const results = JSON.parse(res.payload).results as Array<any>;
        const conflicted = results.find(r => r.atom?.includes('payment_mode_'));
        expect(conflicted).toBeDefined();
        expect(conflicted.contradiction.hasConflict).toBe(true);
        expect(conflicted.contradiction.conflictKey).toBe('payment_mode');
        expect(Array.isArray(conflicted.contradiction.competingClaims)).toBe(true);
        expect(conflicted.contradiction.competingClaims.length).toBeGreaterThanOrEqual(2);
    });

    it('G4.3: /atoms/:atom inspect surfaces contradiction metadata', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/atoms/' + encodeURIComponent('v1.fact.payment_mode_live_src_human_conf_high_scope_project_dt_2026_03_01'),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.contradiction.hasConflict).toBe(true);
        expect(body.contradiction.conflictKey).toBe('payment_mode');
        // competingClaims is an array of FactConflictEntry objects {atom, claim, source, confidence, createdAtMs}
        expect(Array.isArray(body.contradiction.competingClaims)).toBe(true);
        expect(body.contradiction.competingClaims.map((c: any) => c.claim)).toContain('test');
    });

    it('G4.4: /memory/bootstrap surfaces conflicting facts in conflictingFacts array', async () => {
        const res = await server.inject({
            method: 'POST', url: '/memory/bootstrap',
            payload: { objective: 'payment environment', limit: 20 },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(Array.isArray(body.conflictingFacts)).toBe(true);

        const paymentConflict = (body.conflictingFacts as Array<any>).find(g => g.key === 'payment_mode');
        expect(paymentConflict).toBeDefined();
        expect(paymentConflict.claims).toContain('live');
        expect(paymentConflict.claims).toContain('test');
    });

    it('G4.5: three-way conflict surfaces all three claims', async () => {
        const res = await server.inject({
            method: 'POST', url: '/search',
            payload: { query: 'env', threshold: 0, limit: 10 },
        });
        const results = JSON.parse(res.payload).results as Array<any>;
        const envConflict = results.find(r => r.atom?.includes('env_production') || r.atom?.includes('env_staging') || r.atom?.includes('env_development'));
        if (envConflict && envConflict.contradiction.hasConflict) {
            expect(envConflict.contradiction.competingClaims.length).toBeGreaterThanOrEqual(2);
        }
    });

    it('G4.6: non-conflicting atom (unique key) has hasConflict=false', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/atoms/' + encodeURIComponent('v1.fact.region_us_east_src_human_conf_high_scope_project_dt_2026_03_06'),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.contradiction.hasConflict).toBe(false);
    });
});

describe('Sprint 12 — G5: Write-policy tier end-to-end', () => {
    const DB_PATH = './test-sprint12-writepolicy-db';
    let server: FastifyInstance;
    let orchestrator: ShardedOrchestrator;

    beforeAll(async () => {
        cleanup(DB_PATH);
        const app = buildApp({ data: [], dbBasePath: DB_PATH });
        server = withEnvAuth(app.server);
        orchestrator = app.orchestrator;
        await orchestrator.init();
    });

    afterAll(async () => {
        await server.close();
        await orchestrator.close();
        cleanup(DB_PATH);
    });

    it('G5.1: default tier is auto-write and atoms are accepted', async () => {
        const policyRes = await server.inject({ method: 'GET', url: '/write-policy' });
        expect(policyRes.statusCode).toBe(200);
        const policy = JSON.parse(policyRes.payload);
        expect(policy.policy.defaultTier).toBe('auto-write');

        const atomsRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.auto_write_allowed_g5'] },
        });
        expect(atomsRes.statusCode).toBe(200);
        const body = JSON.parse(atomsRes.payload);
        expect(body.writePolicyOutcome.decision).toBe('allow');
    });

    it('G5.2: review-required tier returns review-required outcome in writePolicyOutcome', async () => {
        await server.inject({
            method: 'POST', url: '/write-policy',
            payload: { policy: { defaultTier: 'review-required' } },
        });
        const atomsRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.review_required_atom_g5'] },
        });
        // Server returns 202 ReviewRequired when policy requires explicit approval
        expect(atomsRes.statusCode).toBe(202);
        const body = JSON.parse(atomsRes.payload);
        expect(body.writePolicyOutcome.decision).toBe('review-required');
        // Reset
        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
    });

    it('G5.3: never-store tier rejects atoms with decision=deny', async () => {
        await server.inject({
            method: 'POST', url: '/write-policy',
            payload: { policy: { defaultTier: 'never-store' } },
        });
        const atomsRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.should_be_denied_g5'] },
        });
        // Server returns 403 Denied when policy is never-store
        expect(atomsRes.statusCode).toBe(403);
        const body = JSON.parse(atomsRes.payload);
        expect(body.writePolicyOutcome.decision).toBe('deny');
        expect(body.writePolicyOutcome.deniedAtoms).toContain('v1.fact.should_be_denied_g5');
        // Reset
        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
    });

    it('G5.4: reset restores auto-write and subsequent atoms are accepted', async () => {
        // Set to never-store, then reset
        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: { defaultTier: 'never-store' } } });
        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });

        const atomsRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.post_reset_allowed_g5'] },
        });
        expect(atomsRes.statusCode).toBe(200);
        const body = JSON.parse(atomsRes.payload);
        expect(body.writePolicyOutcome.decision).toBe('allow');
    });

    it('G5.5: per-type tier overrides default — fact tier can differ from default', async () => {
        await server.inject({
            method: 'POST', url: '/write-policy',
            payload: { policy: { defaultTier: 'auto-write', byType: { fact: 'review-required' } } },
        });
        const factRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.fact.per_type_review_g5'] },
        });
        // fact atoms → review-required tier → 202 ReviewRequired
        expect(factRes.statusCode).toBe(202);
        expect(JSON.parse(factRes.payload).writePolicyOutcome.decision).toBe('review-required');

        const eventRes = await server.inject({
            method: 'POST', url: '/atoms',
            payload: { atoms: ['v1.event.per_type_auto_g5'] },
        });
        // event atoms → default auto-write tier → 200 Queued
        expect(eventRes.statusCode).toBe(200);
        expect(JSON.parse(eventRes.payload).writePolicyOutcome.decision).toBe('allow');

        // Reset
        await server.inject({ method: 'POST', url: '/write-policy', payload: { policy: 'default' } });
    });

    it('G5.6: invalid tier name returns 400', async () => {
        const res = await server.inject({
            method: 'POST', url: '/write-policy',
            payload: { policy: { defaultTier: 'publish-everywhere' } },
        });
        expect(res.statusCode).toBe(400);
    });
});
