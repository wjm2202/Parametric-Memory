#!/usr/bin/env ts-node
/**
 * Pre-Upgrade Snapshot Script
 *
 * Takes a full-fidelity backup of the running MMPM server before
 * applying architecture upgrades.  Uses the /admin/export-full endpoint
 * to produce a portable NDJSON backup file.
 *
 * Usage:
 *   npm run snapshot:pre-upgrade
 *   npm run snapshot:pre-upgrade -- --output ./my-backup.ndjson
 *
 * The script:
 *   1. Hits GET /admin/export-full on the running server
 *   2. Saves the NDJSON response to a timestamped file
 *   3. Prints a summary of what was captured
 *   4. Exits 0 on success, 1 on failure
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const MMPM_BASE_URL = process.env.MMPM_BASE_URL ?? 'http://localhost:3001';
const API_KEY = process.env.MMPM_API_KEY ?? '';

async function main() {
    // Parse --output flag
    const args = process.argv.slice(2);
    let outputPath: string | null = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--output' && args[i + 1]) {
            outputPath = args[i + 1];
        }
    }

    if (!outputPath) {
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupDir = resolve(__dirname, '../backups');
        mkdirSync(backupDir, { recursive: true });
        outputPath = resolve(backupDir, `pre-upgrade-${dateStr}.ndjson`);
    }

    console.log(`[snapshot] Connecting to ${MMPM_BASE_URL}/admin/export-full ...`);

    const headers: Record<string, string> = {
        'Accept': 'application/x-ndjson',
    };
    if (API_KEY) {
        headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    let response: Response;
    try {
        response = await fetch(`${MMPM_BASE_URL}/admin/export-full`, { headers });
    } catch (err) {
        console.error(`[snapshot] FAILED: Could not connect to ${MMPM_BASE_URL}`);
        console.error(`[snapshot] Is the MMPM server running?`);
        console.error(err);
        process.exit(1);
    }

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[snapshot] FAILED: Server returned ${response.status} ${response.statusText}`);
        console.error(`[snapshot] Body: ${body.slice(0, 500)}`);
        process.exit(1);
    }

    const body = await response.text();
    const lines = body.split('\n').filter(l => l.trim().length > 0);

    // Parse meta header
    let meta: Record<string, unknown> | null = null;
    let atomCount = 0;
    let weightCount = 0;
    let accessCountCount = 0;
    let tombstoneCount = 0;

    for (const line of lines) {
        try {
            const rec = JSON.parse(line);
            if (rec.type === 'meta') meta = rec;
            else if (rec.type === 'atom') {
                atomCount++;
                if (rec.status === 'tombstoned') tombstoneCount++;
            }
            else if (rec.type === 'weight') weightCount++;
            else if (rec.type === 'access_count') accessCountCount++;
        } catch { /* skip unparseable */ }
    }

    writeFileSync(outputPath, body, 'utf-8');

    console.log(`[snapshot] SUCCESS — saved to ${outputPath}`);
    console.log(`[snapshot] Summary:`);
    console.log(`  Total records:   ${lines.length}`);
    console.log(`  Atoms:           ${atomCount} (${tombstoneCount} tombstoned)`);
    console.log(`  Weights:         ${weightCount}`);
    console.log(`  Access counts:   ${accessCountCount}`);
    if (meta) {
        console.log(`  Tree version:    ${meta.treeVersion}`);
        console.log(`  Shard count:     ${meta.shardCount}`);
        console.log(`  Tree root:       ${String(meta.treeRoot).slice(0, 16)}...`);
    }
    console.log(`  File size:       ${(body.length / 1024).toFixed(1)} KB`);
}

main().catch(err => {
    console.error('[snapshot] Unexpected error:', err);
    process.exit(1);
});
