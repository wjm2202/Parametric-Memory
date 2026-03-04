import { describe, it, expect, vi } from 'vitest';
import { createToolDefinitions, selectVisibleTools } from '../../tools/mcp/mmpm_mcp_server';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function mockFetchReturning(payload: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
}

describe('MCP tool catalog wiring', () => {
    it('default visible tools exclude mutating and semantic tools', () => {
        const defs = createToolDefinitions({ fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch });
        const visible = selectVisibleTools(defs, { enableMutations: false, enableSemanticTools: false });
        const names = new Set(visible.map(t => t.name));

        expect(names.has('memory_access')).toBe(true);
        expect(names.has('memory_train')).toBe(false);
        expect(names.has('memory_atoms_add')).toBe(false);
        expect(names.has('memory_search')).toBe(false);
        expect(names.has('memory_context')).toBe(false);
        expect(names.has('memory_weekly_eval_status')).toBe(true);
        expect(names.has('memory_weekly_eval_run')).toBe(false);
    });

    it('enabling mutations exposes mutating tools', () => {
        const defs = createToolDefinitions({ fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch });
        const visible = selectVisibleTools(defs, { enableMutations: true, enableSemanticTools: false });
        const names = new Set(visible.map(t => t.name));

        expect(names.has('memory_train')).toBe(true);
        expect(names.has('memory_atoms_add')).toBe(true);
        expect(names.has('memory_atoms_delete')).toBe(true);
        expect(names.has('memory_policy_set')).toBe(true);
        expect(names.has('memory_write_policy_set')).toBe(true);
        expect(names.has('memory_commit')).toBe(true);
        expect(names.has('memory_weekly_eval_run')).toBe(true);
    });

    it('memory_write_policy_get handler calls GET /write-policy', async () => {
        const fetchMock = mockFetchReturning({ policy: { defaultTier: 'auto-write', byType: {} } });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_write_policy_get');
        expect(tool).toBeDefined();

        await tool!.handler({});

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:3000/write-policy');
        expect(init.method).toBe('GET');
    });

    it('memory_write_policy_set handler calls POST /write-policy with expected payload', async () => {
        const fetchMock = mockFetchReturning({ status: 'WritePolicyUpdated' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_write_policy_set');
        expect(tool).toBeDefined();

        await tool!.handler({ policy: { byType: { fact: 'review-required' } } });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:3000/write-policy');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(JSON.stringify({ policy: { byType: { fact: 'review-required' } } }));
    });

    it('enabling semantic tools exposes memory_search and memory_context', () => {
        const defs = createToolDefinitions({ fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch });
        const visible = selectVisibleTools(defs, { enableMutations: false, enableSemanticTools: true });
        const names = new Set(visible.map(t => t.name));

        expect(names.has('memory_search')).toBe(true);
        expect(names.has('memory_context')).toBe(true);
    });

    it('memory_access handler calls POST /access with expected payload', async () => {
        const fetchMock = mockFetchReturning({ status: 'ok' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_access');
        expect(tool).toBeDefined();

        await tool!.handler({ atom: 'v1.other.Node_A', warmRead: true });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:3000/access');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(JSON.stringify({ data: 'v1.other.Node_A', warmRead: true }));
    });

    it('memory_atoms_list handler forwards query params to GET /atoms', async () => {
        const fetchMock = mockFetchReturning({ atoms: [] });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_atoms_list');
        expect(tool).toBeDefined();

        await tool!.handler({ type: 'fact', prefix: 'v1.fact.topic', limit: 5, offset: 10 });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:3000/atoms?type=fact&prefix=v1.fact.topic&limit=5&offset=10');
        expect(init.method).toBe('GET');
    });

    it('memory_session_bootstrap handler calls POST /memory/bootstrap with expected payload', async () => {
        const fetchMock = mockFetchReturning({ mode: 'session_bootstrap' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_session_bootstrap');
        expect(tool).toBeDefined();

        await tool!.handler({ objective: 'ship a1 bootstrap', maxTokens: 600, limit: 12 });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:3000/memory/bootstrap');
        expect(init.method).toBe('POST');
        expect(init.body).toBe(JSON.stringify({ objective: 'ship a1 bootstrap', maxTokens: 600, limit: 12 }));
    });

    it('semantic handler throws when semantic tools are disabled', async () => {
        const defs = createToolDefinitions({
            fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch,
            enableSemanticTools: false,
        });
        const tool = defs.find(t => t.name === 'memory_search');
        expect(tool).toBeDefined();

        await expect(tool!.handler({ query: 'hello' })).rejects.toThrow(/Semantic tools are disabled/i);
    });

    it('memory_search forwards namespace scope fields', async () => {
        const fetchMock = mockFetchReturning({ mode: 'semantic', results: [] });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
            enableSemanticTools: true,
        });
        const tool = defs.find(t => t.name === 'memory_search');
        expect(tool).toBeDefined();

        await tool!.handler({
            query: 'goal',
            namespace: { project: 'alpha' },
            includeGlobal: false,
        });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.body).toBe(JSON.stringify({
            query: 'goal',
            limit: 10,
            threshold: 0,
            namespace: { project: 'alpha' },
            includeGlobal: false,
        }));
    });

    it('memory_context forwards namespace scope via query params', async () => {
        const fetchMock = mockFetchReturning({ mode: 'context', entries: [] });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
            enableSemanticTools: true,
        });
        const tool = defs.find(t => t.name === 'memory_context');
        expect(tool).toBeDefined();

        await tool!.handler({
            maxTokens: 300,
            namespace: { project: 'alpha', task: 'wave1' },
            includeGlobal: false,
        });

        const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('/memory/context?');
        expect(url).toContain('maxTokens=300');
        expect(url).toContain('namespaceProject=alpha');
        expect(url).toContain('namespaceTask=wave1');
        expect(url).toContain('includeGlobal=false');
    });

    it('memory_session_bootstrap forwards temporal scope fields', async () => {
        const fetchMock = mockFetchReturning({ mode: 'session_bootstrap' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_session_bootstrap');
        expect(tool).toBeDefined();

        await tool!.handler({ objective: 'temporal bootstrap', asOfVersion: 3, asOfMs: 1234567890 });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.body).toBe(JSON.stringify({
            objective: 'temporal bootstrap',
            maxTokens: undefined,
            limit: undefined,
            highImpact: undefined,
            evidenceThreshold: undefined,
            asOfMs: 1234567890,
            asOfVersion: 3,
            namespace: undefined,
            includeGlobal: undefined,
        }));
    });

    it('memory_session_bootstrap forwards highImpact and evidenceThreshold', async () => {
        const fetchMock = mockFetchReturning({ mode: 'session_bootstrap' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_session_bootstrap');
        expect(tool).toBeDefined();

        await tool!.handler({
            objective: 'high impact decision',
            highImpact: true,
            evidenceThreshold: 0.8,
        });

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.body).toBe(JSON.stringify({
            objective: 'high impact decision',
            maxTokens: undefined,
            limit: undefined,
            highImpact: true,
            evidenceThreshold: 0.8,
            asOfMs: undefined,
            asOfVersion: undefined,
            namespace: undefined,
            includeGlobal: undefined,
        }));
    });

    it('memory_atom_get appends temporal query params', async () => {
        const fetchMock = mockFetchReturning({ atom: 'v1.fact.example' });
        const defs = createToolDefinitions({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: fetchMock as unknown as typeof fetch,
        });
        const tool = defs.find(t => t.name === 'memory_atom_get');
        expect(tool).toBeDefined();

        await tool!.handler({ atom: 'v1.fact.example', asOfVersion: 2, asOfMs: 12345 });

        const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('/atoms/v1.fact.example?');
        expect(url).toContain('asOfVersion=2');
        expect(url).toContain('asOfMs=12345');
    });

    it('memory_weekly_eval_status reads due-state from weekly_eval_state.json', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mmpm-weekly-status-'));
        const stateFile = join(dir, 'weekly_eval_state.json');
        writeFileSync(stateFile, JSON.stringify({
            lastCompletedAt: '1970-01-01T00:00:00.000Z',
            lastReportFile: 'tools/harness/results/weekly-old.json',
            lastPromFile: 'tools/harness/results/weekly-old.prom',
            lastRunId: 'old-run',
            lastProfile: 'concurrent',
            notes: 'test state',
        }));

        try {
            const defs = createToolDefinitions({
                fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch,
                weeklyEvalStateFile: stateFile,
            });
            const tool = defs.find(t => t.name === 'memory_weekly_eval_status');
            expect(tool).toBeDefined();

            const result = await tool!.handler({});
            expect((result as { due: boolean }).due).toBe(true);
            expect((result as { lastRunId: string }).lastRunId).toBe('old-run');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('memory_weekly_eval_run executes weekly script with force option', async () => {
        const execMock = vi.fn(async () => ({ stdout: 'weekly run complete', stderr: '' }));
        const dir = mkdtempSync(join(tmpdir(), 'mmpm-weekly-run-'));
        const stateFile = join(dir, 'weekly_eval_state.json');
        writeFileSync(stateFile, JSON.stringify({
            lastCompletedAt: new Date().toISOString(),
            lastReportFile: '',
            lastPromFile: '',
            lastRunId: '',
            lastProfile: 'concurrent',
            notes: 'test state',
        }));

        try {
            const defs = createToolDefinitions({
                fetchImpl: mockFetchReturning({ ok: true }) as unknown as typeof fetch,
                weeklyEvalScript: '/tmp/weekly-memory-eval.sh',
                weeklyEvalStateFile: stateFile,
                execFileAsync: execMock as unknown as (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>,
            });
            const tool = defs.find(t => t.name === 'memory_weekly_eval_run');
            expect(tool).toBeDefined();

            const result = await tool!.handler({ force: true }) as {
                status: string;
                forced: boolean;
                stdout: string;
            };

            expect(execMock).toHaveBeenCalledTimes(1);
            const execCall = execMock.mock.calls[0] as unknown as [string, string[], { cwd: string }];
            expect(execCall[0]).toBe('bash');
            expect(execCall[1]).toEqual(['/tmp/weekly-memory-eval.sh', '--force']);
            expect(result.status).toBe('WeeklyEvaluationExecuted');
            expect(result.forced).toBe(true);
            expect(result.stdout).toContain('weekly run complete');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
