/**
 * HTTP MCP server for production deployment and Cowork custom connector.
 *
 * Runs alongside the MMPM data server (port 3000) and proxies MCP tool
 * calls to it via the Streamable HTTP transport.
 *
 * Environment:
 *   MCP_PORT                       – listen port (default 3001)
 *   MMPM_MCP_AUTH_KEY              – Bearer token for /mcp endpoint (optional)
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

const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3001', 10);
const MCP_HOST = process.env.MCP_HOST ?? '127.0.0.1';

// API key for authenticating MCP clients (Cowork, curl, etc.)
// If unset, MCP endpoint is open (rely on network-level security).
const AUTH_KEY = process.env.MMPM_MCP_AUTH_KEY ?? '';

// Paths that bypass auth (health probes)
const PUBLIC_PATHS = new Set(['/health']);

// ── Auth middleware ──────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!AUTH_KEY) return true; // auth disabled

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== AUTH_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }
    return true;
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

// ── HTTP handler ────────────────────────────────────────────────────────────

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${MCP_PORT}`);

    // Health check — always public
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    // Auth gate for /mcp
    if (!checkAuth(req, res)) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
            transport = transports.get(sessionId)!;
        } else if (!sessionId) {
            transport = await createNewSession();
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid session' }));
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid session ID' }));
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
    const authStatus = AUTH_KEY ? 'enabled' : 'disabled (no MMPM_MCP_AUTH_KEY set)';
    console.log(`[mmpm-mcp-http] MCP server listening on http://${MCP_HOST}:${MCP_PORT}/mcp`);
    console.log(`[mmpm-mcp-http] Auth: ${authStatus}`);
});
