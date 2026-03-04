import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildApp } from '../server';

type CapturedRequest = {
    method: string;
    url: string;
    body: unknown;
};

type MockApi = {
    baseUrl: string;
    requests: CapturedRequest[];
    close: () => Promise<void>;
};

type ToolCallTextResult = {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
};

function readToolText(result: unknown): string {
    const payload = result as ToolCallTextResult;
    const textItem = payload.content.find((item: { type: string; text?: string }) => item.type === 'text' && typeof item.text === 'string');
    if (!textItem || typeof textItem.text !== 'string') {
        throw new Error('Expected text content item in tool result');
    }
    return textItem.text;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return undefined;
    return JSON.parse(text);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
}

async function startMockApi(): Promise<MockApi> {
    const requests: CapturedRequest[] = [];
    const server = createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        const body = await readJsonBody(req);
        requests.push({ method, url, body });

        if (method === 'GET' && url === '/ready') {
            sendJson(res, 200, { ready: true });
            return;
        }

        if (method === 'GET' && url === '/health') {
            sendJson(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && url === '/atoms') {
            sendJson(res, 200, { atoms: [{ atom: 'seed.alpha' }] });
            return;
        }

        if (method === 'POST' && url === '/access') {
            sendJson(res, 200, { route: 'access', echoed: body });
            return;
        }

        if (method === 'POST' && url === '/train') {
            sendJson(res, 200, { route: 'train', echoed: body });
            return;
        }

        if (method === 'POST' && url === '/memory/bootstrap') {
            sendJson(res, 200, { mode: 'session_bootstrap', echoed: body });
            return;
        }

        sendJson(res, 404, { error: `No route for ${method} ${url}` });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
                server.close(err => (err ? rejectClose(err) : resolveClose()));
            }),
    };
}

function toEnv(overrides: Record<string, string>): Record<string, string> {
    const inherited = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
    return { ...inherited, ...overrides };
}

async function connectClient(baseUrl: string, extraEnv: Record<string, string> = {}) {
    const repoRoot = resolve(process.cwd());
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
            resolve(repoRoot, 'node_modules', 'ts-node', 'dist', 'bin.js'),
            resolve(repoRoot, 'tools', 'mcp', 'mmpm_mcp_server.ts'),
        ],
        cwd: repoRoot,
        env: toEnv({
            MMPM_MCP_BASE_URL: baseUrl,
            ...extraEnv,
        }),
        stderr: 'pipe',
    });

    const client = new Client({ name: 'mmpm-mcp-stdio-test-client', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport };
}

const activeApiServers: MockApi[] = [];
const tempDbDirs: string[] = [];

afterEach(async () => {
    while (activeApiServers.length > 0) {
        const server = activeApiServers.pop();
        if (server) await server.close();
    }
    while (tempDbDirs.length > 0) {
        const path = tempDbDirs.pop();
        if (!path) continue;
        try { rmSync(path, { recursive: true, force: true }); } catch { }
    }
});

describe('MCP stdio integration', () => {
    it('lists visible tools over stdio with safe defaults', async () => {
        const mockApi = await startMockApi();
        activeApiServers.push(mockApi);
        const { client, transport } = await connectClient(mockApi.baseUrl);

        try {
            const listed = await client.listTools();
            const names = new Set(listed.tools.map(tool => tool.name));

            expect(names.has('memory_access')).toBe(true);
            expect(names.has('memory_train')).toBe(false);
            expect(names.has('memory_search')).toBe(false);
        } finally {
            await transport.close();
        }
    }, 20000);

    it('executes memory_access over stdio and forwards HTTP payload', async () => {
        const mockApi = await startMockApi();
        activeApiServers.push(mockApi);
        const { client, transport } = await connectClient(mockApi.baseUrl);

        try {
            const result = await client.callTool({
                name: 'memory_access',
                arguments: { atom: 'v1.other.Node_A', warmRead: true },
            });

            expect('content' in result).toBe(true);
            if (!('content' in result)) throw new Error('Expected CallToolResult with content');
            expect(result.isError).not.toBe(true);

            const parsed = JSON.parse(readToolText(result)) as { route: string; echoed: unknown };
            expect(parsed.route).toBe('access');
            expect(parsed.echoed).toEqual({ data: 'v1.other.Node_A', warmRead: true });

            const accessRequest = mockApi.requests.find(r => r.method === 'POST' && r.url === '/access');
            expect(accessRequest).toBeDefined();
            expect(accessRequest?.body).toEqual({ data: 'v1.other.Node_A', warmRead: true });
        } finally {
            await transport.close();
        }
    }, 20000);

    it('exposes and executes mutating tools when explicitly enabled', async () => {
        const mockApi = await startMockApi();
        activeApiServers.push(mockApi);
        const { client, transport } = await connectClient(mockApi.baseUrl, { MMPM_MCP_ENABLE_MUTATIONS: '1' });

        try {
            const listed = await client.listTools();
            expect(listed.tools.some(tool => tool.name === 'memory_train')).toBe(true);

            const result = await client.callTool({
                name: 'memory_train',
                arguments: { sequence: ['alpha', 'beta'] },
            });

            expect('content' in result).toBe(true);
            if (!('content' in result)) throw new Error('Expected CallToolResult with content');
            expect(result.isError).not.toBe(true);

            const trainRequest = mockApi.requests.find(r => r.method === 'POST' && r.url === '/train');
            expect(trainRequest).toBeDefined();
            expect(trainRequest?.body).toEqual({ sequence: ['alpha', 'beta'] });
        } finally {
            await transport.close();
        }
    }, 20000);

    it('executes memory_session_bootstrap over stdio and forwards HTTP payload', async () => {
        const mockApi = await startMockApi();
        activeApiServers.push(mockApi);
        const { client, transport } = await connectClient(mockApi.baseUrl);

        try {
            const result = await client.callTool({
                name: 'memory_session_bootstrap',
                arguments: {
                    objective: 'start sprint',
                    maxTokens: 400,
                    limit: 6,
                    namespace: { project: 'alpha' },
                    includeGlobal: false,
                },
            });

            expect('content' in result).toBe(true);
            if (!('content' in result)) throw new Error('Expected CallToolResult with content');
            expect(result.isError).not.toBe(true);

            const parsed = JSON.parse(readToolText(result)) as { mode: string; echoed: unknown };
            expect(parsed.mode).toBe('session_bootstrap');
            expect(parsed.echoed).toEqual({
                objective: 'start sprint',
                maxTokens: 400,
                limit: 6,
                namespace: { project: 'alpha' },
                includeGlobal: false,
            });

            const req = mockApi.requests.find(r => r.method === 'POST' && r.url === '/memory/bootstrap');
            expect(req).toBeDefined();
            expect(req?.body).toEqual({
                objective: 'start sprint',
                maxTokens: 400,
                limit: 6,
                namespace: { project: 'alpha' },
                includeGlobal: false,
            });
        } finally {
            await transport.close();
        }
    }, 20000);

    it('executes memory_search against a real server with known atoms', async () => {
        const dbPath = mkdtempSync(join(tmpdir(), 'mmpm-mcp-real-search-'));
        tempDbDirs.push(dbPath);

        const app = buildApp({
            data: ['v1.other.seed_bootstrap'],
            dbBasePath: dbPath,
            numShards: 2,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        const address = app.server.server.address();
        if (!address || typeof address === 'string') {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            throw new Error('Failed to determine listening address for real API server.');
        }

        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            const atomsRes = await fetch(`${baseUrl}/atoms`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    atoms: [
                        'v1.fact.project_is_MMPM',
                        'v1.event.user_discusses_search_quality',
                        'v1.other.unrelated_placeholder',
                    ],
                }),
            });
            expect(atomsRes.status).toBe(200);

            const commitRes = await fetch(`${baseUrl}/admin/commit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(commitRes.status).toBe(200);

            const { client, transport } = await connectClient(baseUrl, {
                MMPM_MCP_ENABLE_SEMANTIC_TOOLS: '1',
            });

            try {
                const listed = await client.listTools();
                const names = new Set(listed.tools.map(tool => tool.name));
                expect(names.has('memory_search')).toBe(true);

                const result = await client.callTool({
                    name: 'memory_search',
                    arguments: {
                        query: 'project mmpm search',
                        limit: 5,
                        threshold: 0,
                    },
                });

                expect('content' in result).toBe(true);
                if (!('content' in result)) throw new Error('Expected CallToolResult with content');
                expect(result.isError).not.toBe(true);

                const parsed = JSON.parse(readToolText(result)) as {
                    mode: string;
                    results: Array<{ atom: string; similarity: number }>;
                };
                expect(parsed.mode).toBe('semantic');
                expect(Array.isArray(parsed.results)).toBe(true);
                expect(parsed.results.length).toBeGreaterThan(0);
                expect(parsed.results.some(r => r.atom === 'v1.fact.project_is_MMPM')).toBe(true);
            } finally {
                await transport.close();
            }
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 30000);

    it('executes memory_context against a real server with known atoms', async () => {
        const dbPath = mkdtempSync(join(tmpdir(), 'mmpm-mcp-real-context-'));
        tempDbDirs.push(dbPath);

        const app = buildApp({
            data: ['v1.other.seed_bootstrap_context'],
            dbBasePath: dbPath,
            numShards: 2,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        const address = app.server.server.address();
        if (!address || typeof address === 'string') {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            throw new Error('Failed to determine listening address for real API server.');
        }

        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            const atomsRes = await fetch(`${baseUrl}/atoms`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    atoms: [
                        'v1.fact.context_contains_focus_topic',
                        'v1.event.context_test_executed',
                        'v1.other.context_placeholder',
                    ],
                }),
            });
            expect(atomsRes.status).toBe(200);

            const commitRes = await fetch(`${baseUrl}/admin/commit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(commitRes.status).toBe(200);

            const { client, transport } = await connectClient(baseUrl, {
                MMPM_MCP_ENABLE_SEMANTIC_TOOLS: '1',
            });

            try {
                const listed = await client.listTools();
                const names = new Set(listed.tools.map(tool => tool.name));
                expect(names.has('memory_context')).toBe(true);

                const result = await client.callTool({
                    name: 'memory_context',
                    arguments: { maxTokens: 128 },
                });

                expect('content' in result).toBe(true);
                if (!('content' in result)) throw new Error('Expected CallToolResult with content');
                expect(result.isError).not.toBe(true);

                const parsed = JSON.parse(readToolText(result)) as {
                    mode: string;
                    context: string;
                    entries: Array<{ atom: string }>;
                    estimatedTokens: number;
                    maxTokens: number;
                };
                expect(parsed.mode).toBe('context');
                expect(typeof parsed.context).toBe('string');
                expect(Array.isArray(parsed.entries)).toBe(true);
                expect(parsed.entries.length).toBeGreaterThan(0);
                expect(parsed.estimatedTokens).toBeLessThanOrEqual(128);
                expect(parsed.maxTokens).toBe(128);
                expect(parsed.entries.some(entry => entry.atom === 'v1.fact.context_contains_focus_topic')).toBe(true);
            } finally {
                await transport.close();
            }
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 30000);

    it('executes memory_session_bootstrap against a real server and returns complete decision evidence bundle', async () => {
        const dbPath = mkdtempSync(join(tmpdir(), 'mmpm-mcp-real-bootstrap-'));
        tempDbDirs.push(dbPath);

        const app = buildApp({
            data: ['v1.other.seed_bootstrap_bundle'],
            dbBasePath: dbPath,
            numShards: 2,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        const address = app.server.server.address();
        if (!address || typeof address === 'string') {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            throw new Error('Failed to determine listening address for real API server.');
        }

        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            const atomsRes = await fetch(`${baseUrl}/atoms`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    atoms: [
                        'v1.fact.current_focus_ship_decision_evidence',
                        'v1.fact.policy_requires_traceable_outputs',
                        'v1.state.next_step_validate_bootstrap_bundle',
                    ],
                }),
            });
            expect(atomsRes.status).toBe(200);

            const commitRes = await fetch(`${baseUrl}/admin/commit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(commitRes.status).toBe(200);

            const { client, transport } = await connectClient(baseUrl);

            try {
                const result = await client.callTool({
                    name: 'memory_session_bootstrap',
                    arguments: {
                        objective: 'traceable decision evidence for high impact output',
                        limit: 6,
                    },
                });

                expect('content' in result).toBe(true);
                if (!('content' in result)) throw new Error('Expected CallToolResult with content');
                expect(result.isError).not.toBe(true);

                const parsed = JSON.parse(readToolText(result)) as {
                    mode: string;
                    topMemories: Array<{ atom: string }>;
                    decisionEvidence: {
                        memoryIds: string[];
                        proofReferences: Array<{ memoryId: string; proofRoot: string; proofIndex: number }>;
                        retrievalRationale: Array<{ memoryId: string; reasons: string[] }>;
                        coverage: {
                            memoryIds: number;
                            proofReferences: number;
                            retrievalRationale: number;
                            complete: boolean;
                        };
                    };
                };

                expect(parsed.mode).toBe('session_bootstrap');
                expect(Array.isArray(parsed.topMemories)).toBe(true);
                expect(parsed.decisionEvidence).toBeDefined();
                expect(parsed.decisionEvidence.coverage.memoryIds).toBe(parsed.topMemories.length);
                expect(parsed.decisionEvidence.coverage.proofReferences).toBe(parsed.topMemories.length);
                expect(parsed.decisionEvidence.coverage.retrievalRationale).toBe(parsed.topMemories.length);
                if (parsed.topMemories.length > 0) {
                    expect(parsed.decisionEvidence.coverage.complete).toBe(true);
                    expect(typeof parsed.decisionEvidence.proofReferences[0].memoryId).toBe('string');
                    expect(typeof parsed.decisionEvidence.proofReferences[0].proofRoot).toBe('string');
                    expect(typeof parsed.decisionEvidence.proofReferences[0].proofIndex).toBe('number');
                    expect(Array.isArray(parsed.decisionEvidence.retrievalRationale[0].reasons)).toBe(true);
                }
            } finally {
                await transport.close();
            }
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 30000);

    it('executes memory_session_bootstrap with highImpact threshold and returns low-evidence fallback metadata', async () => {
        const dbPath = mkdtempSync(join(tmpdir(), 'mmpm-mcp-real-bootstrap-gate-'));
        tempDbDirs.push(dbPath);

        const app = buildApp({
            data: ['v1.other.seed_bootstrap_gate'],
            dbBasePath: dbPath,
            numShards: 2,
        });

        await app.orchestrator.init();
        app.pipeline.start();
        await app.server.listen({ port: 0, host: '127.0.0.1' });

        const address = app.server.server.address();
        if (!address || typeof address === 'string') {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
            throw new Error('Failed to determine listening address for real API server.');
        }

        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            const atomsRes = await fetch(`${baseUrl}/atoms`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    atoms: [
                        'v1.fact.current_focus_ship_d2_gate',
                        'v1.fact.policy_requires_minimum_evidence',
                        'v1.state.next_step_validate_threshold_fallback',
                    ],
                }),
            });
            expect(atomsRes.status).toBe(200);

            const commitRes = await fetch(`${baseUrl}/admin/commit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            expect(commitRes.status).toBe(200);

            const { client, transport } = await connectClient(baseUrl);

            try {
                const result = await client.callTool({
                    name: 'memory_session_bootstrap',
                    arguments: {
                        objective: 'rare unrelated wording to reduce semantic match',
                        highImpact: true,
                        evidenceThreshold: 0.95,
                        limit: 8,
                    },
                });

                expect('content' in result).toBe(true);
                if (!('content' in result)) throw new Error('Expected CallToolResult with content');
                expect(result.isError).not.toBe(true);

                const parsed = JSON.parse(readToolText(result)) as {
                    highImpact: boolean;
                    topMemories: Array<{ atom: string }>;
                    evidenceGate: {
                        applied: boolean;
                        threshold: number;
                        lowEvidenceFallback: boolean;
                        includedCount: number;
                        fallbackReason: string | null;
                    };
                };

                expect(parsed.highImpact).toBe(true);
                expect(parsed.evidenceGate.applied).toBe(true);
                expect(parsed.evidenceGate.threshold).toBe(0.95);
                expect(parsed.evidenceGate.lowEvidenceFallback).toBe(true);
                expect(parsed.evidenceGate.includedCount).toBe(0);
                expect(parsed.topMemories.length).toBe(0);
                expect(typeof parsed.evidenceGate.fallbackReason).toBe('string');
            } finally {
                await transport.close();
            }
        } finally {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        }
    }, 30000);
});
