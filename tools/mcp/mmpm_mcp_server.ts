import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

type HttpMethod = 'GET' | 'POST' | 'DELETE';
type ExecFileAsync = (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;

const execFileAsyncDefault = promisify(execFileCb) as unknown as ExecFileAsync;

export type ToolDef = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
    mutating?: boolean;
};

type ResolvedMmpmMcpOptions = {
    baseUrl: string;
    apiKey: string;
    enableMutations: boolean;
    enableSemanticTools: boolean;
    toolCatalogFile: string;
    weeklyEvalStateFile: string;
    weeklyEvalScript: string;
    fetchImpl: typeof fetch;
    execFileAsync: ExecFileAsync;
};

export type MmpmMcpOptions = Partial<ResolvedMmpmMcpOptions>;

function resolveOptions(options: MmpmMcpOptions = {}): ResolvedMmpmMcpOptions {
    return {
        baseUrl: options.baseUrl ?? process.env.MMPM_MCP_BASE_URL ?? 'http://127.0.0.1:3000',
        apiKey: options.apiKey ?? process.env.MMPM_MCP_API_KEY ?? process.env.MMPM_API_KEY ?? '',
        enableMutations: options.enableMutations ?? process.env.MMPM_MCP_ENABLE_MUTATIONS === '1',
        enableSemanticTools: options.enableSemanticTools ?? process.env.MMPM_MCP_ENABLE_SEMANTIC_TOOLS === '1',
        toolCatalogFile: options.toolCatalogFile ?? join(process.cwd(), 'tools', 'mcp', 'mmpm_tool_catalog.json'),
        weeklyEvalStateFile: options.weeklyEvalStateFile ?? join(process.cwd(), 'tools', 'harness', 'weekly_eval_state.json'),
        weeklyEvalScript: options.weeklyEvalScript ?? join(process.cwd(), 'tools', 'harness', 'weekly-memory-eval.sh'),
        fetchImpl: options.fetchImpl ?? fetch,
        execFileAsync: options.execFileAsync ?? execFileAsyncDefault,
    };
}

function clipText(text: string, maxChars = 4000): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...<truncated>`;
}

function readWeeklyEvalStatus(stateFile: string) {
    const raw = readFileSync(stateFile, 'utf8');
    const state = JSON.parse(raw) as {
        lastCompletedAt?: string;
        lastReportFile?: string;
        lastPromFile?: string;
        lastRunId?: string;
        lastProfile?: string;
        notes?: string;
    };

    const lastCompletedAt = state.lastCompletedAt ?? '1970-01-01T00:00:00.000Z';
    const parsed = Date.parse(lastCompletedAt);
    const ageMs = Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : Number.POSITIVE_INFINITY;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const dueThresholdDays = 7;

    return {
        stateFile,
        lastCompletedAt,
        ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(2)) : null,
        dueThresholdDays,
        due: !Number.isFinite(ageDays) || ageDays >= dueThresholdDays,
        lastReportFile: state.lastReportFile ?? '',
        lastPromFile: state.lastPromFile ?? '',
        lastRunId: state.lastRunId ?? '',
        lastProfile: state.lastProfile ?? '',
        notes: state.notes ?? '',
    };
}

function buildHeaders(apiKey: string, includeJsonContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeJsonContentType) headers['content-type'] = 'application/json';
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    return headers;
}

function toResult(payload: unknown, isError = false) {
    return {
        isError,
        content: [
            {
                type: 'text' as const,
                text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
            },
        ],
    };
}

function parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
        throw new Error('Expected string[] input.');
    }
    return value;
}

function createApiCaller(options: ResolvedMmpmMcpOptions) {
    return async (method: HttpMethod, path: string, body?: unknown): Promise<unknown> => {
        const hasBody = body !== undefined;
        const headers = buildHeaders(options.apiKey, hasBody);
        const response = await options.fetchImpl(`${options.baseUrl}${path}`, {
            method,
            headers,
            body: hasBody ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch {
            parsed = text;
        }

        if (!response.ok) {
            throw new Error(`${method} ${path} failed (${response.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
        }

        return parsed;
    };
}

export function createToolDefinitions(options: MmpmMcpOptions = {}): ToolDef[] {
    const resolved = resolveOptions(options);
    const callApi = createApiCaller(resolved);

    return [
        {
            name: 'memory_access',
            description: 'Markov associative recall with proofs. Wraps POST /access.',
            inputSchema: {
                type: 'object',
                properties: {
                    atom: { type: 'string' },
                    warmRead: { type: 'boolean', default: false },
                },
                required: ['atom'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/access', { data: args.atom, warmRead: args.warmRead === true }),
        },
        {
            name: 'memory_batch_access',
            description: 'Batch associative recall for multiple atoms. Wraps POST /batch-access.',
            inputSchema: {
                type: 'object',
                properties: {
                    atoms: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['atoms'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/batch-access', { items: parseStringArray(args.atoms) }),
        },
        {
            name: 'memory_atoms_list',
            description: 'List atoms with status. Wraps GET /atoms.',
            inputSchema: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['fact', 'event', 'relation', 'state', 'other'] },
                    prefix: { type: 'string' },
                    limit: { type: 'number' },
                    offset: { type: 'number' },
                },
                additionalProperties: false,
            },
            handler: async args => {
                const query = new URLSearchParams();
                if (typeof args.type === 'string') query.set('type', args.type);
                if (typeof args.prefix === 'string') query.set('prefix', args.prefix);
                if (typeof args.limit === 'number') query.set('limit', String(args.limit));
                if (typeof args.offset === 'number') query.set('offset', String(args.offset));
                const suffix = query.toString();
                return callApi('GET', suffix ? `/atoms?${suffix}` : '/atoms');
            },
        },
        {
            name: 'memory_atom_get',
            description: 'Inspect one atom record. Wraps GET /atoms/:atom.',
            inputSchema: {
                type: 'object',
                properties: {
                    atom: { type: 'string' },
                    asOfMs: { type: 'number' },
                    asOfVersion: { type: 'number' },
                },
                required: ['atom'],
                additionalProperties: false,
            },
            handler: async args => {
                const query = new URLSearchParams();
                if (typeof args.asOfMs === 'number') query.set('asOfMs', String(args.asOfMs));
                if (typeof args.asOfVersion === 'number') query.set('asOfVersion', String(args.asOfVersion));
                const suffix = query.toString();
                const path = `/atoms/${encodeURIComponent(String(args.atom))}${suffix ? `?${suffix}` : ''}`;
                return callApi('GET', path);
            },
        },
        {
            name: 'memory_weights_get',
            description: 'Inspect outgoing transition weights for an atom. Wraps GET /weights/:atom.',
            inputSchema: {
                type: 'object',
                properties: {
                    atom: { type: 'string' },
                },
                required: ['atom'],
                additionalProperties: false,
            },
            handler: async args => callApi('GET', `/weights/${encodeURIComponent(String(args.atom))}`),
        },
        {
            name: 'memory_policy_get',
            description: 'Read current transition policy. Wraps GET /policy.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/policy'),
        },
        {
            name: 'memory_write_policy_get',
            description: 'Read current write-policy tiers. Wraps GET /write-policy.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/write-policy'),
        },
        {
            name: 'memory_pending',
            description: 'Inspect queued ingestion/pending atoms. Wraps GET /atoms/pending.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/atoms/pending'),
        },
        {
            name: 'memory_health',
            description: 'Read cluster health status. Wraps GET /health.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/health'),
        },
        {
            name: 'memory_ready',
            description: 'Read readiness status. Wraps GET /ready.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/ready'),
        },
        {
            name: 'memory_metrics',
            description: 'Read Prometheus metrics text. Wraps GET /metrics.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('GET', '/metrics'),
        },
        {
            name: 'memory_weekly_eval_status',
            description: 'Read local weekly-evaluation due status from tools/harness/weekly_eval_state.json.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => readWeeklyEvalStatus(resolved.weeklyEvalStateFile),
        },
        {
            name: 'memory_search',
            description: 'Semantic search over memory atoms. Wraps POST /search when enabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'number' },
                    threshold: { type: 'number' },
                    asOfMs: { type: 'number' },
                    asOfVersion: { type: 'number' },
                    namespace: {
                        type: 'object',
                        properties: {
                            user: { type: 'string' },
                            project: { type: 'string' },
                            task: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    includeGlobal: { type: 'boolean' },
                },
                required: ['query'],
                additionalProperties: false,
            },
            handler: async args => {
                if (!resolved.enableSemanticTools) {
                    throw new Error('Semantic tools are disabled. Set MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1 to expose memory_search and memory_context.');
                }
                return callApi('POST', '/search', {
                    query: String(args.query),
                    limit: typeof args.limit === 'number' ? args.limit : 10,
                    threshold: typeof args.threshold === 'number' ? args.threshold : 0,
                    asOfMs: typeof args.asOfMs === 'number' ? args.asOfMs : undefined,
                    asOfVersion: typeof args.asOfVersion === 'number' ? args.asOfVersion : undefined,
                    namespace: typeof args.namespace === 'object' && args.namespace !== null ? args.namespace : undefined,
                    includeGlobal: typeof args.includeGlobal === 'boolean' ? args.includeGlobal : undefined,
                });
            },
        },
        {
            name: 'memory_context',
            description: 'Context block generation for session bootstrap. Wraps GET /memory/context when enabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    maxTokens: { type: 'number' },
                    asOfMs: { type: 'number' },
                    asOfVersion: { type: 'number' },
                    namespace: {
                        type: 'object',
                        properties: {
                            user: { type: 'string' },
                            project: { type: 'string' },
                            task: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    includeGlobal: { type: 'boolean' },
                },
                additionalProperties: false,
            },
            handler: async args => {
                if (!resolved.enableSemanticTools) {
                    throw new Error('Semantic tools are disabled. Set MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1 to expose memory_search and memory_context.');
                }
                const maxTokens = typeof args.maxTokens === 'number' ? args.maxTokens : undefined;
                const ns = typeof args.namespace === 'object' && args.namespace !== null ? args.namespace as Record<string, unknown> : {};
                const query = new URLSearchParams();
                if (maxTokens) query.set('maxTokens', String(maxTokens));
                if (typeof args.asOfMs === 'number') query.set('asOfMs', String(args.asOfMs));
                if (typeof args.asOfVersion === 'number') query.set('asOfVersion', String(args.asOfVersion));
                if (typeof ns.user === 'string') query.set('namespaceUser', ns.user);
                if (typeof ns.project === 'string') query.set('namespaceProject', ns.project);
                if (typeof ns.task === 'string') query.set('namespaceTask', ns.task);
                if (typeof args.includeGlobal === 'boolean') query.set('includeGlobal', String(args.includeGlobal));
                const suffix = query.toString();
                return callApi('GET', suffix ? `/memory/context?${suffix}` : '/memory/context');
            },
        },
        {
            name: 'memory_session_bootstrap',
            description: 'Single-call session bootstrap payload with goals/constraints/preferences and proof metadata. Wraps POST /memory/bootstrap.',
            inputSchema: {
                type: 'object',
                properties: {
                    objective: { type: 'string' },
                    maxTokens: { type: 'number' },
                    limit: { type: 'number' },
                    highImpact: { type: 'boolean' },
                    evidenceThreshold: { type: 'number' },
                    asOfMs: { type: 'number' },
                    asOfVersion: { type: 'number' },
                    namespace: {
                        type: 'object',
                        properties: {
                            user: { type: 'string' },
                            project: { type: 'string' },
                            task: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                    includeGlobal: { type: 'boolean' },
                },
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/memory/bootstrap', {
                objective: typeof args.objective === 'string' ? args.objective : undefined,
                maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
                limit: typeof args.limit === 'number' ? args.limit : undefined,
                highImpact: typeof args.highImpact === 'boolean' ? args.highImpact : undefined,
                evidenceThreshold: typeof args.evidenceThreshold === 'number' ? args.evidenceThreshold : undefined,
                asOfMs: typeof args.asOfMs === 'number' ? args.asOfMs : undefined,
                asOfVersion: typeof args.asOfVersion === 'number' ? args.asOfVersion : undefined,
                namespace: typeof args.namespace === 'object' && args.namespace !== null ? args.namespace : undefined,
                includeGlobal: typeof args.includeGlobal === 'boolean' ? args.includeGlobal : undefined,
            }),
        },
        {
            name: 'memory_train',
            description: 'Train transition sequence. Wraps POST /train.',
            inputSchema: {
                type: 'object',
                properties: {
                    sequence: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['sequence'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/train', { sequence: parseStringArray(args.sequence) }),
            mutating: true,
        },
        {
            name: 'memory_atoms_add',
            description: 'Queue new atoms for ingestion. Wraps POST /atoms.',
            inputSchema: {
                type: 'object',
                properties: {
                    atoms: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['atoms'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/atoms', { atoms: parseStringArray(args.atoms) }),
            mutating: true,
        },
        {
            name: 'memory_atoms_delete',
            description: 'Tombstone an atom. Wraps DELETE /atoms/:atom.',
            inputSchema: {
                type: 'object',
                properties: {
                    atom: { type: 'string' },
                },
                required: ['atom'],
                additionalProperties: false,
            },
            handler: async args => callApi('DELETE', `/atoms/${encodeURIComponent(String(args.atom))}`, {}),
            mutating: true,
        },
        {
            name: 'memory_policy_set',
            description: "Set transition policy. Wraps POST /policy with 'default' or object.",
            inputSchema: {
                type: 'object',
                properties: {
                    policy: {},
                },
                required: ['policy'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/policy', { policy: args.policy }),
            mutating: true,
        },
        {
            name: 'memory_write_policy_set',
            description: "Set write policy tiers. Wraps POST /write-policy with 'default' or object.",
            inputSchema: {
                type: 'object',
                properties: {
                    policy: {},
                },
                required: ['policy'],
                additionalProperties: false,
            },
            handler: async args => callApi('POST', '/write-policy', { policy: args.policy }),
            mutating: true,
        },
        {
            name: 'memory_commit',
            description: 'Force flush pending ingestion. Wraps POST /admin/commit.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => callApi('POST', '/admin/commit', {}),
            mutating: true,
        },
        {
            name: 'memory_weekly_eval_run',
            description: 'Run local weekly evaluation script; updates weekly_eval_state.json and benchmark artifacts.',
            inputSchema: {
                type: 'object',
                properties: {
                    force: { type: 'boolean', default: false },
                },
                additionalProperties: false,
            },
            handler: async args => {
                const force = args.force === true;
                const scriptArgs = force ? [resolved.weeklyEvalScript, '--force'] : [resolved.weeklyEvalScript];
                const execResult = await resolved.execFileAsync('bash', scriptArgs, { cwd: process.cwd() });
                return {
                    status: 'WeeklyEvaluationExecuted',
                    forced: force,
                    script: resolved.weeklyEvalScript,
                    stdout: clipText(execResult.stdout),
                    stderr: clipText(execResult.stderr),
                    weekly: readWeeklyEvalStatus(resolved.weeklyEvalStateFile),
                };
            },
            mutating: true,
        },
    ];
}

export function selectVisibleTools(toolDefs: ToolDef[], options: MmpmMcpOptions = {}): ToolDef[] {
    const resolved = resolveOptions(options);
    return toolDefs.filter(t => {
        if (t.mutating && !resolved.enableMutations) return false;
        if ((t.name === 'memory_search' || t.name === 'memory_context') && !resolved.enableSemanticTools) return false;
        return true;
    });
}

export function createMmpmMcpServer(options: MmpmMcpOptions = {}) {
    const resolved = resolveOptions(options);
    const toolDefs = createToolDefinitions(resolved);
    const visibleTools = selectVisibleTools(toolDefs, resolved);
    const toolMap = new Map(visibleTools.map(t => [t.name, t]));

    const server = new Server(
        {
            name: 'mmpm-memory-mcp',
            version: '0.1.0',
        },
        {
            capabilities: {
                tools: { listChanged: false },
                resources: {},
            },
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: visibleTools.map(tool => ({
                name: tool.name,
                title: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            })),
        };
    });

    server.setRequestHandler(CallToolRequestSchema, async request => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const tool = toolMap.get(name);
        if (!tool) {
            return toResult(`Unknown tool '${name}'.`, true);
        }

        try {
            const output = await tool.handler(args);
            return toResult(output);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return toResult(message, true);
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        return {
            resources: [
                {
                    uri: 'mmpm://health',
                    name: 'MMPM Health',
                    description: 'Cluster health payload from GET /health.',
                    mimeType: 'application/json',
                },
                {
                    uri: 'mmpm://ready',
                    name: 'MMPM Readiness',
                    description: 'Readiness payload from GET /ready.',
                    mimeType: 'application/json',
                },
                {
                    uri: 'mmpm://policy',
                    name: 'MMPM Policy',
                    description: 'Transition policy payload from GET /policy.',
                    mimeType: 'application/json',
                },
                {
                    uri: 'mmpm://metrics',
                    name: 'MMPM Metrics',
                    description: 'Prometheus metrics from GET /metrics.',
                    mimeType: 'text/plain',
                },
                {
                    uri: 'mmpm://tool-catalog',
                    name: 'MMPM Tool Catalog',
                    description: 'Machine-readable recommended MCP tool catalog.',
                    mimeType: 'application/json',
                },
            ],
        };
    });

    const callApi = createApiCaller(resolved);

    server.setRequestHandler(ReadResourceRequestSchema, async request => {
        const uri = request.params.uri;

        if (uri === 'mmpm://health') {
            const data = await callApi('GET', '/health');
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
        }
        if (uri === 'mmpm://ready') {
            const data = await callApi('GET', '/ready');
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
        }
        if (uri === 'mmpm://policy') {
            const data = await callApi('GET', '/policy');
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
        }
        if (uri === 'mmpm://metrics') {
            const data = await callApi('GET', '/metrics');
            return { contents: [{ uri, mimeType: 'text/plain', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
        }
        if (uri === 'mmpm://tool-catalog') {
            const text = readFileSync(resolved.toolCatalogFile, 'utf8');
            return { contents: [{ uri, mimeType: 'application/json', text }] };
        }

        throw new Error(`Unknown resource '${uri}'.`);
    });

    return { server, visibleTools };
}

export async function startMmpmMcpServer(options: MmpmMcpOptions = {}) {
    const { server } = createMmpmMcpServer(options);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

if (typeof require !== 'undefined' && require.main === module) {
    startMmpmMcpServer().catch(error => {
        console.error('[mmpm-mcp] fatal error', error);
        process.exit(1);
    });
}
