import { afterEach, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { waitForApiReady } from '../../tools/harness/api_ready';

const servers: Server[] = [];

async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to read test server address');
    }
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
    while (servers.length) {
        const server = servers.pop()!;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

describe('Harness API readiness wait', () => {
    it('resolves after /ready transitions from 503 to 200', async () => {
        let checks = 0;
        const { baseUrl } = await startServer((req, res) => {
            if (req.url === '/ready') {
                checks++;
                if (checks < 3) {
                    res.statusCode = 503;
                    res.end(JSON.stringify({ ready: false }));
                    return;
                }
                res.statusCode = 200;
                res.end(JSON.stringify({ ready: true }));
                return;
            }
            res.statusCode = 404;
            res.end();
        });

        await waitForApiReady(baseUrl, { timeoutMs: 3000, pollMs: 100 });
        expect(checks).toBeGreaterThanOrEqual(3);
    });

    it('throws when /ready never becomes 200 before timeout', async () => {
        const { baseUrl } = await startServer((req, res) => {
            if (req.url === '/ready') {
                res.statusCode = 503;
                res.end(JSON.stringify({ ready: false }));
                return;
            }
            res.statusCode = 404;
            res.end();
        });

        await expect(
            waitForApiReady(baseUrl, { timeoutMs: 800, pollMs: 100 })
        ).rejects.toThrow(/timed out/i);
    });
});
