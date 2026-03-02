interface WaitForApiReadyOptions {
    apiKey?: string;
    timeoutMs?: number;
    pollMs?: number;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForApiReady(
    baseUrl: string,
    options: WaitForApiReadyOptions = {}
): Promise<void> {
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 60_000);
    const pollMs = Math.max(100, options.pollMs ?? 500);
    const deadline = Date.now() + timeoutMs;

    const headers: Record<string, string> = {};
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

    let lastStatus: number | null = null;
    let lastError: unknown;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/ready`, { method: 'GET', headers });
            lastStatus = res.status;
            if (res.status === 200) return;
        } catch (e) {
            lastError = e;
        }
        await sleep(pollMs);
    }

    if (lastStatus !== null) {
        throw new Error(`API readiness check timed out after ${timeoutMs}ms (last status: ${lastStatus})`);
    }
    if (lastError instanceof Error) {
        throw new Error(`API readiness check timed out after ${timeoutMs}ms (${lastError.message})`);
    }
    throw new Error(`API readiness check timed out after ${timeoutMs}ms`);
}
