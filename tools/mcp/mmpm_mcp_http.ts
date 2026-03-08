/**
 * HTTP MCP server for production deployment and Cowork custom connector.
 *
 * Runs alongside the MMPM data server (port 3000) and proxies MCP tool
 * calls to it via the Streamable HTTP transport.
 *
 * Authentication:
 *   1. Static Bearer token via MMPM_MCP_AUTH_KEY (for direct API/curl access)
 *   2. OAuth2 access tokens (for Claude Cowork custom connectors)
 *   If MMPM_MCP_AUTH_KEY is unset AND no OAuth provider, the endpoint is open.
 *
 * OAuth2 endpoints (auto-approve, single-tenant):
 *   GET  /.well-known/oauth-authorization-server  — RFC 9728 metadata
 *   POST /oauth/register                          — Dynamic Client Registration
 *   GET  /oauth/authorize                         — Authorization (auto-approve + redirect)
 *   POST /oauth/token                             — Token exchange / refresh
 *
 * Environment:
 *   MCP_PORT                       – listen port (default 3001)
 *   MCP_HOST                       – listen host (default 127.0.0.1)
 *   MMPM_MCP_AUTH_KEY              – static Bearer token for /mcp (optional)
 *   MMPM_OAUTH_ISSUER              – OAuth issuer URL (default https://mmpm.co.nz)
 *   MMPM_MCP_BASE_URL              – data server URL (default http://127.0.0.1:3000)
 *   MMPM_MCP_API_KEY / MMPM_API_KEY – forwarded to data server calls
 *   MMPM_MCP_ENABLE_MUTATIONS      – 1 to enable write tools
 *   MMPM_MCP_ENABLE_SEMANTIC_TOOLS – 1 to enable search/context tools
 *
 * Deploy behind nginx with TLS. See integrations/deploy/ for configs.
 */
import 'dotenv/config';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMmpmMcpServer } from './mmpm_mcp_server';
import { OAuthProvider } from './mmpm_oauth_provider';

const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3001', 10);
const MCP_HOST = process.env.MCP_HOST ?? '127.0.0.1';

// Static API key auth (existing behavior)
const AUTH_KEY = process.env.MMPM_MCP_AUTH_KEY ?? '';

// OAuth2 provider
const OAUTH_ISSUER = process.env.MMPM_OAUTH_ISSUER ?? 'https://mmpm.co.nz';
const oauthProvider = new OAuthProvider(OAUTH_ISSUER);

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

/** Parse URL-encoded form body into key-value pairs. */
function parseFormBody(body: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const pair of body.split('&')) {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
    return params;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';

    // 1. Static Bearer token
    if (AUTH_KEY && token === AUTH_KEY) return true;

    // 2. OAuth access token
    if (token && oauthProvider.validateAccessToken(token)) return true;

    // 3. If no auth mechanisms are configured, allow through
    if (!AUTH_KEY) return true;

    // Reject with WWW-Authenticate pointing to OAuth metadata
    res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-authorization-server"`,
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
}

// ── Session management ──────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

async function createNewSession(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId: string) => {
            transports.set(sessionId, transport);
            console.log(`[mmpm-mcp-http] New session: ${sessionId}`);
        },
    });

    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
            transports.delete(sid);
            console.log(`[mmpm-mcp-http] Session closed: ${sid}`);
        }
    };

    const { server } = createMmpmMcpServer();
    await server.connect(transport);

    return transport;
}

// ── OAuth route handlers ────────────────────────────────────────────────────

/** GET /.well-known/oauth-authorization-server */
function handleMetadata(_req: IncomingMessage, res: ServerResponse): void {
    jsonResponse(res, 200, oauthProvider.getMetadata());
}

/** POST /oauth/register (Dynamic Client Registration) */
async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
    }

    try {
        const body = JSON.parse(await readBody(req));
        const result = oauthProvider.registerClient(body);
        jsonResponse(res, 201, result);
    } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON body' });
    }
}

/** GET /oauth/authorize */
function handleAuthorize(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${MCP_PORT}`);
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? 'S256';
    const state = url.searchParams.get('state') ?? '';
    const responseType = url.searchParams.get('response_type') ?? '';

    if (responseType !== 'code') {
        jsonResponse(res, 400, { error: 'unsupported_response_type' });
        return;
    }

    if (!clientId || !redirectUri || !codeChallenge) {
        jsonResponse(res, 400, { error: 'invalid_request', error_description: 'Missing required parameters' });
        return;
    }

    // Auto-approve (single-tenant) — create auth code and redirect
    const code = oauthProvider.createAuthCode({
        clientId,
        codeChallenge,
        codeChallengeMethod,
        redirectUri,
    });

    if (!code) {
        jsonResponse(res, 400, { error: 'invalid_client' });
        return;
    }

    // Redirect back to Claude's callback with code + state
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.writeHead(302, { Location: redirectUrl.toString() });
    res.end();
}

/** POST /oauth/token */
async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
    }

    let params: Record<string, string>;
    const contentType = req.headers['content-type'] ?? '';

    try {
        const body = await readBody(req);
        if (contentType.includes('application/json')) {
            params = JSON.parse(body);
        } else {
            // application/x-www-form-urlencoded (standard for token endpoint)
            params = parseFormBody(body);
        }
    } catch {
        jsonResponse(res, 400, { error: 'invalid_request' });
        return;
    }

    const grantType = params.grant_type;

    if (grantType === 'authorization_code') {
        const result = oauthProvider.exchangeCode({
            code: params.code ?? '',
            clientId: params.client_id ?? '',
            clientSecret: params.client_secret ?? '',
            codeVerifier: params.code_verifier ?? '',
            redirectUri: params.redirect_uri ?? '',
        });

        if (!result) {
            jsonResponse(res, 400, { error: 'invalid_grant' });
            return;
        }

        jsonResponse(res, 200, result);
        return;
    }

    if (grantType === 'refresh_token') {
        const result = oauthProvider.refreshAccessToken({
            refreshToken: params.refresh_token ?? '',
            clientId: params.client_id ?? '',
            clientSecret: params.client_secret ?? '',
        });

        if (!result) {
            jsonResponse(res, 400, { error: 'invalid_grant' });
            return;
        }

        jsonResponse(res, 200, result);
        return;
    }

    jsonResponse(res, 400, { error: 'unsupported_grant_type' });
}

// ── HTTP handler ────────────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${MCP_PORT}`);

    // Health check — always public
    if (url.pathname === '/health') {
        jsonResponse(res, 200, { ok: true });
        return;
    }

    // ── OAuth endpoints (public, no auth) ────────────────────────────────
    if (url.pathname === '/.well-known/oauth-authorization-server') {
        handleMetadata(req, res);
        return;
    }

    if (url.pathname === '/oauth/register') {
        await handleRegister(req, res);
        return;
    }

    if (url.pathname === '/oauth/authorize') {
        handleAuthorize(req, res);
        return;
    }

    if (url.pathname === '/oauth/token') {
        await handleToken(req, res);
        return;
    }

    // ── MCP endpoint (auth required) ─────────────────────────────────────
    if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    if (!checkAuth(req, res)) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId)!;
        } else if (!sessionId) {
            transport = await createNewSession();
        } else {
            jsonResponse(res, 400, { error: 'Invalid session' });
            return;
        }

        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            console.error('[mmpm-mcp-http] Error handling request:', err);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end('Internal server error');
            }
        }
        return;
    }

    if (req.method === 'GET') {
        if (sessionId && transports.has(sessionId)) {
            await transports.get(sessionId)!.handleRequest(req, res);
            return;
        }
        jsonResponse(res, 400, { error: 'Missing or invalid session ID' });
        return;
    }

    if (req.method === 'DELETE') {
        if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
            transports.delete(sessionId);
            return;
        }
        res.writeHead(400);
        res.end('Missing or invalid session ID');
        return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
});

httpServer.listen(MCP_PORT, MCP_HOST, () => {
    const authModes: string[] = [];
    if (AUTH_KEY) authModes.push('static-bearer');
    authModes.push('oauth2');
    console.log(`[mmpm-mcp-http] MCP server listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
    console.log(`[mmpm-mcp-http] Auth: ${authModes.join(' + ')}`);
    console.log(`[mmpm-mcp-http] OAuth issuer: ${OAUTH_ISSUER}`);
});
