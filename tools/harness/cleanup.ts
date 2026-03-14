import { rm, readdir } from 'fs/promises';
import { resolve } from 'path';

const DIR_PATTERNS: RegExp[] = [
    /^test-shard-db-\d+-\d+$/,
    /^test-orch-db-\d+-\d+$/,
    /^test-validator-db-\d+-\d+$/,
    /^test-backend-db-\d+-\d+$/,
    /^test-migration-db-\d+-\d+$/,
    /^test-api-db$/,
    /^test-auth-db$/,
    /^test-atoms-api-db$/,
    /^test-atoms-backpressure-db$/,
    /^mmpm-test-smoke-db$/,
    /^mmpm-harness-cli-db-\d+$/,
];

const FILE_PATTERNS: RegExp[] = [
    /^test-shard-db-\d+-\d+\.wal$/,
    /^test-orch-db-\d+-\d+\.wal$/,
    /^test-validator-db-\d+-\d+\.wal$/,
    /^test-backend-db-\d+-\d+\.wal$/,
    /^test-migration-db-\d+-\d+\.wal$/,
    /^test-api-db\.wal$/,
    /^test-auth-db\.wal$/,
    /^test-atoms-api-db\.wal$/,
    /^test-atoms-backpressure-db\.wal$/,
    /^mmpm-test-smoke-db\.wal$/,
    /^mmpm-harness-cli-db-\d+\.wal$/,
];

function matchesAny(name: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(name));
}

async function runCleanup() {
    const cwd = process.cwd();
    const entries = await readdir(cwd, { withFileTypes: true });

    let removed = 0;

    for (const entry of entries) {
        const name = entry.name;
        const path = resolve(cwd, name);

        if (entry.isDirectory() && matchesAny(name, DIR_PATTERNS)) {
            await rm(path, { recursive: true, force: true });
            removed++;
            continue;
        }

        if (entry.isFile() && matchesAny(name, FILE_PATTERNS)) {
            await rm(path, { force: true });
            removed++;
        }
    }

    console.log(`[cleanup] removed ${removed} artifact(s)`);
}

if (require.main === module) {
    runCleanup().catch((err) => {
        console.error('[cleanup] failed:', err);
        process.exit(1);
    });
}
