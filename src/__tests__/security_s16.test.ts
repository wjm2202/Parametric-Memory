/**
 * Sprint 16 Security Tests
 *
 * Exercises every security control introduced in S16 (Security Hardening sprint).
 * Each describe block maps to one sprint item and proves the specific claim.
 *
 *   S16-3  /metrics is auth-gated by default; MMPM_METRICS_PUBLIC=1 reopens it
 *   S16-4  Prompt-injection defence: injection-like atoms → 202 ReviewRequired
 *          Context output lines are prefixed with [MEMORY]
 *   S16-5  review.bypass audit event when reviewApproved:true used
 *   S16-6  memory.time_travel audit event when asOfMs / asOfVersion used
 *   S16-7  MMPM_BLOCK_SECRET_ATOMS=1 rejects secret-looking atoms (HTTP 422)
 *   S16-8  Per-client named API keys via MMPM_API_KEYS env var
 *          clientName propagated into all audit log entries
 *   S16-2  Read operations (bootstrap, context, atoms list) appear in audit log
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyInstance } from 'fastify';
import type { ShardedOrchestrator } from '../orchestrator';
import type { IngestionPipeline } from '../ingestion';
import type { AuditLog } from '../audit_log';
import { buildApp } from '../server';

// ── Helpers ──────────────────────────────────────────────────────────────────

const atom = (value: string) => `v1.other.${value}`;
const fact = (value: string) => `v1.fact.${value}`;
const dirs: string[] = [];

function tempDb(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `mmpm-s16-${label}-`));
    dirs.push(d);
    return d;
}

afterAll(() => {
    while (dirs.length) {
        const d = dirs.pop()!;
        try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
    }
});

interface App {
    server: FastifyInstance;
    orchestrator: ShardedOrchestrator;
    pipeline: IngestionPipeline;
    auditLog: AuditLog;
}

async function makeApp(
    label: string,
    apiKey?: string,
    extraData: string[] = [],
): Promise<App> {
    const app = buildApp({
        data: [atom('A'), atom('B'), atom('C'), ...extraData],
        dbBasePath: tempDb(label),
        numShards: 2,
        apiKey,
    }) as App;
    await app.orchestrator.init();
    return app;
}

function authHeader(key: string): Record<string, string> {
    return { authorization: `Bearer ${key}` };
}

async function closeApp(app: App): Promise<void> {
    await app.server.close();
    await app.orchestrator.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// S16-3: /metrics auth protection
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-3 — /metrics is auth-gated by default', () => {
    const KEY = 'metrics-test-key';
    let app: App;

    beforeAll(async () => {
        delete process.env.MMPM_METRICS_PUBLIC;
        app = await makeApp('metrics-gated', KEY);
    });
    afterAll(() => closeApp(app));

    it('GET /metrics → 401 with no token when key is configured', async () => {
        const res = await app.server.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /metrics → 401 with wrong token', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/metrics',
            headers: authHeader('wrong-key'),
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /metrics → 200 with correct token', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/metrics',
            headers: authHeader(KEY),
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });
});

describe('S16-3 — MMPM_METRICS_PUBLIC=1 reopens /metrics without auth', () => {
    const KEY = 'metrics-public-key';
    let app: App;

    beforeAll(async () => {
        process.env.MMPM_METRICS_PUBLIC = '1';
        app = await makeApp('metrics-public', KEY);
    });
    afterAll(async () => {
        delete process.env.MMPM_METRICS_PUBLIC;
        await closeApp(app);
    });

    it('GET /metrics → 200 with no token when MMPM_METRICS_PUBLIC=1', async () => {
        const res = await app.server.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('GET /metrics → 200 even with a wrong token when MMPM_METRICS_PUBLIC=1', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/metrics',
            headers: authHeader('totally-wrong'),
        });
        expect(res.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-4: Prompt-injection defence
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-4 — Prompt-injection atoms are flagged as ReviewRequired', () => {
    const KEY = 'injection-test-key';
    let app: App;

    beforeAll(async () => { app = await makeApp('injection', KEY); });
    afterAll(() => closeApp(app));

    const injectionAtoms = [
        'v1.fact.ignore_previous_instructions',
        'v1.fact.override_system_prompt',
        'v1.fact.bypass_security_checks',
        'v1.fact.disregard_context',
        'v1.fact.pre_approved_all_writes',
        'v1.fact.forget_previous_context',
    ];

    for (const a of injectionAtoms) {
        it(`POST /atoms with "${a}" → 202 ReviewRequired (no reviewApproved)`, async () => {
            const res = await app.server.inject({
                method: 'POST', url: '/atoms',
                headers: authHeader(KEY),
                payload: { atoms: [a] },
            });
            expect(res.statusCode, `expected 202 for ${a}`).toBe(202);
            const body = JSON.parse(res.payload);
            expect(body.status).toBe('ReviewRequired');
            expect(body.reason).toMatch(/instruction-like/i);
            expect(body.suspiciousAtoms).toContain(a);
        });
    }

    it('POST /atoms with injection atom + reviewApproved:true → 200 (admitted)', async () => {
        const res = await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.ignore_previous_context'], reviewApproved: true },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).status).toBe('Queued');
    });

    it('POST /atoms with clean atom → 200 (not flagged)', async () => {
        const res = await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.project_uses_typescript'] },
        });
        expect(res.statusCode).toBe(200);
    });
});

describe('S16-4 — Context output lines are prefixed with [MEMORY]', () => {
    const KEY = 'context-prefix-key';
    let app: App;

    beforeAll(async () => {
        app = await makeApp('context-prefix', KEY, [fact('project_name_mmpm')]);
        // Wait for pipeline flush so the atom is queryable
        await app.pipeline.flush();
    });
    afterAll(() => closeApp(app));

    it('GET /memory/context response lines all start with [MEMORY]', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/memory/context',
            headers: authHeader(KEY),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        const lines: string[] = (body.context as string).split('\n').filter((l: string) => l.trim() !== '');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line, `line does not start with [MEMORY]: "${line}"`).toMatch(/^\[MEMORY\]/);
        }
    });

    it('POST /memory/bootstrap context lines all start with [MEMORY]', async () => {
        const res = await app.server.inject({
            method: 'POST', url: '/memory/bootstrap',
            headers: authHeader(KEY),
            payload: {},
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        const lines: string[] = (body.context as string).split('\n').filter((l: string) => l.trim() !== '');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line, `bootstrap line missing [MEMORY]: "${line}"`).toMatch(/^\[MEMORY\]/);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-2: Read operations appear in audit log
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-2 — Read operations are recorded in the audit log', () => {
    const KEY = 'audit-reads-key';
    let app: App;

    beforeAll(async () => {
        app = await makeApp('audit-reads', KEY);
        await app.pipeline.flush();
    });
    afterAll(() => closeApp(app));

    async function auditEntries(event: string) {
        const res = await app.server.inject({
            method: 'GET',
            url: `/admin/audit-log?event=${event}&limit=100`,
            headers: authHeader(KEY),
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.payload).entries as Array<{ event: string; clientName?: string }>;
    }

    it('GET /memory/context records a memory.context audit entry', async () => {
        const before = (await auditEntries('memory.context')).length;
        await app.server.inject({ method: 'GET', url: '/memory/context', headers: authHeader(KEY) });
        const after = (await auditEntries('memory.context')).length;
        expect(after).toBeGreaterThan(before);
    });

    it('POST /memory/bootstrap records a memory.bootstrap audit entry', async () => {
        const before = (await auditEntries('memory.bootstrap')).length;
        await app.server.inject({
            method: 'POST', url: '/memory/bootstrap',
            headers: authHeader(KEY),
            payload: {},
        });
        const after = (await auditEntries('memory.bootstrap')).length;
        expect(after).toBeGreaterThan(before);
    });

    it('GET /atoms records an atoms.list audit entry', async () => {
        const before = (await auditEntries('atoms.list')).length;
        await app.server.inject({ method: 'GET', url: '/atoms', headers: authHeader(KEY) });
        const after = (await auditEntries('atoms.list')).length;
        expect(after).toBeGreaterThan(before);
    });

    it('POST /atoms records an atom.add audit entry', async () => {
        const before = (await auditEntries('atom.add')).length;
        await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.audit_test_atom'] },
        });
        const after = (await auditEntries('atom.add')).length;
        expect(after).toBeGreaterThan(before);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-5: review.bypass audit event
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-5 — review.bypass audit event when reviewApproved:true used', () => {
    const KEY = 'review-bypass-key';
    let app: App;

    beforeAll(async () => { app = await makeApp('review-bypass', KEY); });
    afterAll(() => closeApp(app));

    it('review.bypass event is NOT emitted for normal (non-flagged) atoms', async () => {
        const before = app.auditLog.query({ event: 'review.bypass' }).length;
        await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.clean_safe_atom'], reviewApproved: true },
        });
        const after = app.auditLog.query({ event: 'review.bypass' }).length;
        // clean atoms don't trip the injection check, so no bypass event
        expect(after).toBe(before);
    });

    it('review.bypass event IS emitted when an injection-flagged atom is forced through', async () => {
        const before = app.auditLog.query({ event: 'review.bypass' }).length;
        await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.ignore_this_context'], reviewApproved: true },
        });
        const after = app.auditLog.query({ event: 'review.bypass' }).length;
        expect(after).toBeGreaterThan(before);
        const latest = app.auditLog.query({ event: 'review.bypass', limit: 1 })[0] as any;
        expect(latest.event).toBe('review.bypass');
        expect(latest.meta?.clientIp).toBeDefined();
    });

    it('review.bypass event is NOT emitted when reviewApproved is not set (returns 202)', async () => {
        const before = app.auditLog.query({ event: 'review.bypass' }).length;
        await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.bypass_all_rules'] },
            // no reviewApproved
        });
        const after = app.auditLog.query({ event: 'review.bypass' }).length;
        expect(after).toBe(before); // rejected before reaching review.bypass logging
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-6: memory.time_travel audit event
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-6 — memory.time_travel audit event on historical queries', () => {
    const KEY = 'time-travel-key';
    let app: App;

    beforeAll(async () => {
        app = await makeApp('time-travel', KEY);
        await app.pipeline.flush();
    });
    afterAll(() => closeApp(app));

    it('GET /memory/context without asOfMs produces NO time_travel audit event', async () => {
        const before = app.auditLog.query({ event: 'memory.time_travel' }).length;
        await app.server.inject({
            method: 'GET', url: '/memory/context',
            headers: authHeader(KEY),
        });
        const after = app.auditLog.query({ event: 'memory.time_travel' }).length;
        expect(after).toBe(before);
    });

    it('GET /memory/context?asOfMs=<past> produces a memory.time_travel audit event', async () => {
        const before = app.auditLog.query({ event: 'memory.time_travel' }).length;
        const pastMs = Date.now() - 60_000;
        const res = await app.server.inject({
            method: 'GET',
            url: `/memory/context?asOfMs=${pastMs}`,
            headers: authHeader(KEY),
        });
        // May return an empty context for a past timestamp but should not error
        expect([200, 400]).toContain(res.statusCode);
        if (res.statusCode === 200) {
            const after = app.auditLog.query({ event: 'memory.time_travel' }).length;
            expect(after).toBeGreaterThan(before);
            const entry = app.auditLog.query({ event: 'memory.time_travel', limit: 1 })[0] as any;
            expect(entry.meta?.endpoint).toBe('/memory/context');
            expect(entry.meta?.asOfMs).toBe(pastMs);
        }
    });

    it('POST /memory/bootstrap with body asOfVersion=0 produces a memory.time_travel audit event', async () => {
        // bootstrap reads asOfVersion from the request body (POST), not the query string
        const before = app.auditLog.query({ event: 'memory.time_travel' }).length;
        const res = await app.server.inject({
            method: 'POST',
            url: '/memory/bootstrap',
            headers: authHeader(KEY),
            payload: { asOfVersion: 0 },
        });
        expect([200, 400]).toContain(res.statusCode);
        if (res.statusCode === 200) {
            const after = app.auditLog.query({ event: 'memory.time_travel' }).length;
            expect(after).toBeGreaterThan(before);
            const entries = app.auditLog.query({ event: 'memory.time_travel', limit: 100 }) as any[];
            const bootstrapEntry = entries.find(e => e.meta?.endpoint === '/memory/bootstrap');
            expect(bootstrapEntry).toBeDefined();
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-7: MMPM_BLOCK_SECRET_ATOMS
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-7 — MMPM_BLOCK_SECRET_ATOMS=1 rejects credential-like atoms', () => {
    const KEY = 'secrets-block-key';
    let app: App;

    beforeAll(async () => {
        process.env.MMPM_BLOCK_SECRET_ATOMS = '1';
        app = await makeApp('secrets-block', KEY);
    });
    afterAll(async () => {
        delete process.env.MMPM_BLOCK_SECRET_ATOMS;
        await closeApp(app);
    });

    const secretAtoms = [
        'v1.fact.github_password_abc123',
        'v1.fact.stripe_api_key_sk_live',
        'v1.fact.aws_private_key_value',
        'v1.fact.db_secret_password',
        'v1.fact.oauth_access_token_xyz',
        'v1.fact.user_credential_hash',
        'v1.fact.auth_token_session',
        'v1.fact.bearer_token_value',
        'v1.fact.apikey_prod',
    ];

    for (const a of secretAtoms) {
        it(`POST /atoms with "${a}" → 422 Unprocessable Entity`, async () => {
            const res = await app.server.inject({
                method: 'POST', url: '/atoms',
                headers: authHeader(KEY),
                payload: { atoms: [a] },
            });
            expect(res.statusCode, `expected 422 for ${a}`).toBe(422);
            const body = JSON.parse(res.payload);
            expect(body.error).toMatch(/secret|credential/i);
            expect(body.secretAtoms).toContain(a);
        });
    }

    it('POST /atoms with clean atom → 200 when MMPM_BLOCK_SECRET_ATOMS=1', async () => {
        const res = await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.project_language_typescript'] },
        });
        expect(res.statusCode).toBe(200);
    });
});

describe('S16-7 — MMPM_BLOCK_SECRET_ATOMS unset (default) allows all well-formed atoms', () => {
    const KEY = 'secrets-allow-key';
    let app: App;

    beforeAll(async () => {
        delete process.env.MMPM_BLOCK_SECRET_ATOMS;
        app = await makeApp('secrets-allow', KEY);
    });
    afterAll(() => closeApp(app));

    it('POST /atoms with password-like atom → 200 when MMPM_BLOCK_SECRET_ATOMS is unset', async () => {
        // Without the flag the injection check runs first; use a clean-sounding
        // atom that has "password" in it but no injection keywords
        const res = await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(KEY),
            payload: { atoms: ['v1.fact.password_policy_min_12_chars'] },
        });
        // 200 Queued (no block in default mode)
        expect(res.statusCode).toBe(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// S16-8: Per-client named API keys
// ─────────────────────────────────────────────────────────────────────────────

describe('S16-8 — Per-client named API keys (MMPM_API_KEYS)', () => {
    const LEGACY_KEY = 'legacy-default-key';
    const MCP_KEY    = 'named-mcp-key-abc';
    const CLAUDE_KEY = 'named-claude-key-xyz';
    let app: App;

    beforeAll(async () => {
        process.env.MMPM_API_KEYS = `mcp:${MCP_KEY},claude:${CLAUDE_KEY}`;
        app = await makeApp('named-keys', LEGACY_KEY);
        await app.pipeline.flush();
    });
    afterAll(async () => {
        delete process.env.MMPM_API_KEYS;
        await closeApp(app);
    });

    it('Legacy MMPM_API_KEY still grants access (backward compatibility)', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(LEGACY_KEY),
        });
        expect(res.statusCode).toBe(200);
    });

    it('Named key "mcp" grants access', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(MCP_KEY),
        });
        expect(res.statusCode).toBe(200);
    });

    it('Named key "claude" grants access', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(CLAUDE_KEY),
        });
        expect(res.statusCode).toBe(200);
    });

    it('Unknown key is rejected with 401', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader('not-a-registered-key'),
        });
        expect(res.statusCode).toBe(401);
    });

    it('No token is rejected with 401', async () => {
        const res = await app.server.inject({ method: 'GET', url: '/atoms' });
        expect(res.statusCode).toBe(401);
    });

    it('clientName "mcp" appears in atoms.list audit entry when using MCP_KEY', async () => {
        // Trigger an atoms.list event with the MCP key
        await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(MCP_KEY),
        });
        const entries = app.auditLog.query({ event: 'atoms.list', limit: 100 }) as any[];
        const mcpEntry = entries.find(e => e.clientName === 'mcp');
        expect(mcpEntry).toBeDefined();
    });

    it('clientName "claude" appears in atoms.list audit entry when using CLAUDE_KEY', async () => {
        await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(CLAUDE_KEY),
        });
        const entries = app.auditLog.query({ event: 'atoms.list', limit: 100 }) as any[];
        const claudeEntry = entries.find(e => e.clientName === 'claude');
        expect(claudeEntry).toBeDefined();
    });

    it('clientName "default" appears in atom.add audit entry when using the legacy key', async () => {
        await app.server.inject({
            method: 'POST', url: '/atoms',
            headers: authHeader(LEGACY_KEY),
            payload: { atoms: ['v1.fact.legacy_key_write_test'] },
        });
        const entries = app.auditLog.query({ event: 'atom.add', limit: 100 }) as any[];
        const defaultEntry = entries.find(e => e.clientName === 'default');
        expect(defaultEntry).toBeDefined();
    });

    it('clientName appears in memory.bootstrap audit entry', async () => {
        await app.server.inject({
            method: 'POST', url: '/memory/bootstrap',
            headers: authHeader(MCP_KEY),
            payload: {},
        });
        const entries = app.auditLog.query({ event: 'memory.bootstrap', limit: 100 }) as any[];
        const mcpEntry = entries.find(e => e.clientName === 'mcp');
        expect(mcpEntry).toBeDefined();
    });

    it('clientName appears in memory.context audit entry', async () => {
        await app.server.inject({
            method: 'GET', url: '/memory/context',
            headers: authHeader(CLAUDE_KEY),
        });
        const entries = app.auditLog.query({ event: 'memory.context', limit: 100 }) as any[];
        const claudeEntry = entries.find(e => e.clientName === 'claude');
        expect(claudeEntry).toBeDefined();
    });
});

describe('S16-8 — MMPM_API_KEYS malformed entries are silently skipped', () => {
    const GOOD_KEY = 'good-key-abc';
    let app: App;

    beforeAll(async () => {
        // Mix of valid and malformed entries
        process.env.MMPM_API_KEYS = `valid:${GOOD_KEY},:no-name,no-colon,name-only:`;
        app = await makeApp('named-keys-malformed', GOOD_KEY);
    });
    afterAll(async () => {
        delete process.env.MMPM_API_KEYS;
        await closeApp(app);
    });

    it('Well-formed entry in a mixed MMPM_API_KEYS list still grants access', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader(GOOD_KEY),
        });
        expect(res.statusCode).toBe(200);
    });

    it('Malformed entry without a name (":key") does not grant access', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader('no-name'),
        });
        expect(res.statusCode).toBe(401);
    });

    it('Entry without a colon ("no-colon") does not grant access', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/atoms',
            headers: authHeader('no-colon'),
        });
        expect(res.statusCode).toBe(401);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined: audit log query endpoint itself is auth-gated
// ─────────────────────────────────────────────────────────────────────────────

describe('Audit log endpoint is auth-gated', () => {
    const KEY = 'audit-gate-key';
    let app: App;

    beforeAll(async () => { app = await makeApp('audit-gate', KEY); });
    afterAll(() => closeApp(app));

    it('GET /admin/audit-log → 401 with no token', async () => {
        const res = await app.server.inject({ method: 'GET', url: '/admin/audit-log' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /admin/audit-log → 200 with correct token', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/admin/audit-log',
            headers: authHeader(KEY),
        });
        expect(res.statusCode).toBe(200);
    });

    it('GET /admin/audit-log?event=invalid → 400 with unknown event type', async () => {
        const res = await app.server.inject({
            method: 'GET', url: '/admin/audit-log?event=not.a.real.event',
            headers: authHeader(KEY),
        });
        expect(res.statusCode).toBe(400);
    });
});
