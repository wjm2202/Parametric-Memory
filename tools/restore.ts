#!/usr/bin/env ts-node
/**
 * npm run restore
 *
 * Imports atoms from a JSON file into a running MMPM server.
 * Idempotent — atoms that already exist are silently accepted.
 *
 * Usage:
 *   npm run restore -- --file memory/project-context.json
 *   npm run restore -- --file ~/.mmpm/backups/mmpm-backup-2026-03-07.json
 *   npm run restore -- --file ./backup.json --url http://localhost:3000 --key mykey
 *   npm run restore -- --file ./backup.json --dry-run   # print atoms, do not POST
 *
 * The input file must be a JSON array of v1 atom strings.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';

// ── argument parsing ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(name);

const BASE_URL  = (flag('--url') ?? process.env.MMPM_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY   = flag('--key') ?? process.env.MMPM_API_KEY ?? '';
const DRY_RUN   = hasFlag('--dry-run');

// Resolve ~ in file path
const rawFile = flag('--file');
if (!rawFile) {
    console.error('ERROR: --file <path> is required');
    console.error('  npm run restore -- --file memory/project-context.json');
    process.exit(1);
}
const filePath = path.resolve(rawFile.startsWith('~/') ? path.join(os.homedir(), rawFile.slice(2)) : rawFile);

if (!fs.existsSync(filePath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    process.exit(1);
}

if (!API_KEY && !DRY_RUN) {
    console.error('ERROR: MMPM_API_KEY is not set. Add it to .env or pass --key <key>');
    process.exit(1);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function get(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => (data += c.toString()));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                else resolve(data);
            });
        });
        req.on('error', reject);
    });
}

function post(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const opts = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = lib.request(url, opts, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => (data += c.toString()));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                else resolve(data);
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
    // 1. read and validate input file
    console.log(`→ Reading ${filePath} ...`);
    let atoms: string[];
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        atoms = JSON.parse(raw);
    } catch (err: unknown) {
        console.error(`  ERROR: Could not parse file — ${err instanceof Error ? err.message : err}`);
        process.exit(1);
    }

    if (!Array.isArray(atoms)) {
        console.error('  ERROR: File must contain a JSON array of atom strings');
        process.exit(1);
    }

    // Filter out non-string entries (e.g. comments or nulls)
    const valid = atoms.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
    console.log(`  ✓ ${valid.length} atoms loaded (${atoms.length - valid.length} non-string entries skipped)`);

    if (DRY_RUN) {
        console.log('');
        console.log('DRY RUN — no changes made. Atoms that would be restored:');
        valid.forEach((a, i) => console.log(`  ${(i + 1).toString().padStart(3)}. ${a}`));
        process.exit(0);
    }

    // 2. health check
    console.log(`→ Connecting to MMPM at ${BASE_URL} ...`);
    try {
        await get(`${BASE_URL}/health`);
    } catch {
        console.error(`  ERROR: MMPM server not reachable at ${BASE_URL}`);
        console.error('  Make sure the server is running: ./start.sh  or  docker compose up -d');
        process.exit(1);
    }
    console.log('  ✓ Server is up');

    // 3. POST atoms in batches of 200
    const BATCH = 200;
    let sent = 0;
    for (let i = 0; i < valid.length; i += BATCH) {
        const batch = valid.slice(i, i + BATCH);
        await post(`${BASE_URL}/atoms`, JSON.stringify({ atoms: batch }));
        sent += batch.length;
        process.stdout.write(`\r→ Sending atoms ... ${sent}/${valid.length}`);
    }
    console.log(`\r  ✓ ${sent} atoms sent                    `);

    // 4. commit to disk
    console.log('→ Committing to disk ...');
    await post(`${BASE_URL}/admin/commit`, '{}');
    console.log('  ✓ Committed');

    // 5. quick verification
    const res = JSON.parse(await get(`${BASE_URL}/atoms?status=active&limit=1`));
    const total: number = res.total ?? res.atoms?.length ?? 0;
    console.log('');
    console.log(`  Done. Active atoms in DB: ${total}`);
    console.log('');
    console.log('  Verify context:');
    console.log(`    curl -s -H "Authorization: Bearer $MMPM_API_KEY" ${BASE_URL}/memory/context`);
})().catch((err) => {
    console.error('Restore failed:', err.message ?? err);
    process.exit(1);
});
