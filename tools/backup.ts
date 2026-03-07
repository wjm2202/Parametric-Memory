#!/usr/bin/env ts-node
/**
 * npm run backup
 *
 * Exports all active atoms from the running MMPM server to a timestamped
 * JSON file in ~/.mmpm/backups/.
 *
 * Usage:
 *   npm run backup                        # saves to ~/.mmpm/backups/
 *   npm run backup -- --out ./my-backup.json
 *   npm run backup -- --url http://localhost:3000 --key mykey
 *
 * The output file is a plain JSON array of atom strings — the same format
 * accepted by npm run restore and memory/project-context.json.
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

const BASE_URL = (flag('--url') ?? process.env.MMPM_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY  = flag('--key') ?? process.env.MMPM_API_KEY ?? '';

if (!API_KEY) {
    console.error('ERROR: MMPM_API_KEY is not set. Add it to .env or pass --key <key>');
    process.exit(1);
}

// ── output path ────────────────────────────────────────────────────────────
const defaultBackupDir = path.join(os.homedir(), '.mmpm', 'backups');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const defaultOut = path.join(defaultBackupDir, `mmpm-backup-${timestamp}.json`);
const outPath = path.resolve(flag('--out') ?? defaultOut);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ── HTTP helper ────────────────────────────────────────────────────────────
function get(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => (data += c.toString()));
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                } else {
                    resolve(data);
                }
            });
        });
        req.on('error', reject);
    });
}

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
    // 1. health check
    console.log(`→ Connecting to MMPM at ${BASE_URL} ...`);
    try {
        await get(`${BASE_URL}/health`);
    } catch {
        console.error(`  ERROR: MMPM server not reachable at ${BASE_URL}`);
        process.exit(1);
    }
    console.log('  ✓ Server is up');

    // 2. paginate all active atoms
    const atoms: string[] = [];
    const PAGE = 1000;
    let offset = 0;
    let page = 0;

    process.stdout.write('→ Fetching atoms ');
    while (true) {
        const url = `${BASE_URL}/atoms?status=active&limit=${PAGE}&offset=${offset}`;
        const body = JSON.parse(await get(url));
        const batch: string[] = body.atoms ?? [];
        atoms.push(...batch);
        process.stdout.write('.');
        if (batch.length < PAGE) break;
        offset += PAGE;
        page++;
        if (page > 200) { console.error('\n  Pagination safety limit hit'); break; }
    }
    console.log(` ${atoms.length} atoms`);

    if (atoms.length === 0) {
        console.warn('  WARNING: no active atoms found — backup file will be empty.');
    }

    // 3. write file
    fs.writeFileSync(outPath, JSON.stringify(atoms, null, 2));
    const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log(`  ✓ Saved ${atoms.length} atoms → ${outPath} (${kb} KB)`);
    console.log('');
    console.log('  To restore:');
    console.log(`    npm run restore -- --file "${outPath}"`);
})().catch((err) => {
    console.error('Backup failed:', err.message ?? err);
    process.exit(1);
});
