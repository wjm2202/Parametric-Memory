#!/usr/bin/env npx tsx
/**
 * MMPM Migration Script — Coordinated Router Upgrade
 *
 * Exports all atoms AND their Markov transition weights from a running
 * MMPM server, saves them to a local JSON file, then can re-import
 * atoms and replay training on a fresh instance (e.g. after switching
 * from MD5 ring hash to Jump Consistent Hash).
 *
 * Usage:
 *   # Phase 1: Export (run BEFORE updating code on the droplet)
 *   npx tsx scripts/migrate.ts export --server https://mmpm.co.nz --token YOUR_TOKEN
 *
 *   # Phase 2: Import (run AFTER deploying new code and restarting)
 *   npx tsx scripts/migrate.ts import --server https://mmpm.co.nz --token YOUR_TOKEN --file mmpm-migration-YYYY-MM-DD.json
 *
 * The migration file contains:
 *   - atoms[]: full atom list with status and metadata
 *   - weights[]: { from, to, weight } triples for every trained transition
 *   - meta: { exportedAt, serverVersion, atomCount, edgeCount }
 */

import { writeFileSync, readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AtomRecord {
    atom: string;
    status: string;
    hash: string;
    createdAtMs: number;
    committedAtVersion: number;
    shard: number;
}

interface WeightEdge {
    from: string;
    to: string;
    weight: number;
}

interface MigrationFile {
    meta: {
        exportedAt: string;
        atomCount: number;
        activeAtomCount: number;
        edgeCount: number;
        totalWeight: number;
    };
    atoms: AtomRecord[];
    weights: WeightEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BATCH_SIZE = 20;  // concurrent weight lookups
const TRAIN_BATCH = 50; // train calls per batch

async function fetchJson(url: string, token: string, options?: RequestInit): Promise<any> {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...((options?.headers as Record<string, string>) ?? {}),
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
}

async function fetchText(url: string, token: string): Promise<string> {
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.text();
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

async function doExport(server: string, token: string): Promise<string> {
    console.log(`\n📦 Exporting from ${server} ...\n`);

    // 1. Export atoms (NDJSON)
    console.log('  → Fetching atoms via GET /admin/export?status=all ...');
    const ndjson = await fetchText(`${server}/admin/export?status=all`, token);
    const atoms: AtomRecord[] = ndjson
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));

    const activeAtoms = atoms.filter(a => a.status === 'active');
    console.log(`    ${atoms.length} total atoms (${activeAtoms.length} active, ${atoms.length - activeAtoms.length} tombstoned)`);

    // 2. Export weights for each active atom
    console.log(`  → Fetching Markov weights for ${activeAtoms.length} active atoms ...`);
    const allEdges: WeightEdge[] = [];
    let processed = 0;

    for (let i = 0; i < activeAtoms.length; i += BATCH_SIZE) {
        const batch = activeAtoms.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(a =>
                fetchJson(`${server}/weights/${encodeURIComponent(a.atom)}`, token)
                    .catch(() => null) // atom may have no weights
            )
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                const data = result.value;
                if (data.transitions && Array.isArray(data.transitions)) {
                    for (const t of data.transitions) {
                        allEdges.push({
                            from: data.atom,
                            to: t.to,
                            weight: t.weight,
                        });
                    }
                }
            }
        }

        processed += batch.length;
        if (processed % 100 === 0 || processed === activeAtoms.length) {
            console.log(`    ${processed}/${activeAtoms.length} atoms scanned, ${allEdges.length} edges found`);
        }
    }

    const totalWeight = allEdges.reduce((s, e) => s + e.weight, 0);
    console.log(`    Total: ${allEdges.length} edges, ${totalWeight} cumulative weight\n`);

    // 3. Write migration file
    const migration: MigrationFile = {
        meta: {
            exportedAt: new Date().toISOString(),
            atomCount: atoms.length,
            activeAtomCount: activeAtoms.length,
            edgeCount: allEdges.length,
            totalWeight,
        },
        atoms,
        weights: allEdges,
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `mmpm-migration-${dateStr}.json`;
    writeFileSync(filename, JSON.stringify(migration, null, 2));
    console.log(`✅ Migration file saved: ${filename}`);
    console.log(`   ${migration.meta.atomCount} atoms, ${migration.meta.edgeCount} edges, ${migration.meta.totalWeight} total weight\n`);

    return filename;
}

// ---------------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------------

async function doImport(server: string, token: string, filePath: string): Promise<void> {
    console.log(`\n📥 Importing from ${filePath} into ${server} ...\n`);

    const migration: MigrationFile = JSON.parse(readFileSync(filePath, 'utf-8'));
    console.log(`  Migration file from: ${migration.meta.exportedAt}`);
    console.log(`  ${migration.meta.atomCount} atoms, ${migration.meta.edgeCount} edges\n`);

    // 1. Import atoms
    const activeAtoms = migration.atoms
        .filter(a => a.status === 'active')
        .map(a => a.atom);

    console.log(`  → Importing ${activeAtoms.length} active atoms via POST /admin/import ...`);
    const ndjsonBody = activeAtoms.join('\n');
    const importResult = await fetchJson(`${server}/admin/import`, token, {
        method: 'POST',
        body: ndjsonBody,
        headers: { 'Content-Type': 'text/plain' },
    });
    console.log(`    Result: ${JSON.stringify(importResult)}`);

    // 2. Commit to flush atoms into LevelDB before training
    console.log('  → Committing atoms via POST /admin/commit ...');
    const commitResult = await fetchJson(`${server}/admin/commit`, token, {
        method: 'POST',
        body: '{}',
    });
    console.log(`    Result: ${JSON.stringify(commitResult)}`);

    // Wait for commit to settle
    await sleep(2000);

    // 3. Replay Markov training
    // Each edge { from, to, weight: N } means train([from, to]) was called N times.
    // We replay by calling POST /train with [from, to] for each unit of weight.
    const totalTrainCalls = migration.weights.reduce((s, e) => s + e.weight, 0);
    console.log(`  → Replaying ${totalTrainCalls} training calls for ${migration.weights.length} edges ...`);

    // Build the full list of train calls
    const trainCalls: [string, string][] = [];
    for (const edge of migration.weights) {
        for (let w = 0; w < edge.weight; w++) {
            trainCalls.push([edge.from, edge.to]);
        }
    }

    let trained = 0;
    let errors = 0;
    for (let i = 0; i < trainCalls.length; i += TRAIN_BATCH) {
        const batch = trainCalls.slice(i, i + TRAIN_BATCH);
        const results = await Promise.allSettled(
            batch.map(([from, to]) =>
                fetchJson(`${server}/train`, token, {
                    method: 'POST',
                    body: JSON.stringify({ sequence: [from, to] }),
                })
            )
        );

        for (const r of results) {
            if (r.status === 'fulfilled') trained++;
            else errors++;
        }

        if ((trained + errors) % 200 === 0 || i + TRAIN_BATCH >= trainCalls.length) {
            console.log(`    ${trained}/${totalTrainCalls} trained (${errors} errors)`);
        }
    }

    console.log(`\n✅ Migration complete!`);
    console.log(`   Atoms imported: ${activeAtoms.length}`);
    console.log(`   Edges retrained: ${trained} (${errors} errors)`);
    console.log(`   Total weight restored: ${trained}\n`);

    // 4. Verify
    console.log('  → Verifying tree head ...');
    const treeHead = await fetchJson(`${server}/tree-head`, token);
    console.log(`    Version: ${treeHead.version}, Root: ${treeHead.root.slice(0, 16)}...`);

    const healthResult = await fetchJson(`${server}/health`, token);
    console.log(`    Health: ${JSON.stringify(healthResult.stats ?? {})}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const getArg = (name: string): string | undefined => {
        const idx = args.indexOf(`--${name}`);
        return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
    };

    const server = getArg('server') ?? process.env.MMPM_SERVER;
    const token = getArg('token') ?? process.env.MMPM_TOKEN;
    const file = getArg('file');

    if (!server) {
        console.error('Error: --server URL required (or set MMPM_SERVER env var)');
        process.exit(1);
    }
    if (!token) {
        console.error('Error: --token required (or set MMPM_TOKEN env var)');
        process.exit(1);
    }

    switch (command) {
        case 'export':
            await doExport(server, token);
            break;

        case 'import':
            if (!file) {
                console.error('Error: --file path required for import');
                process.exit(1);
            }
            await doImport(server, token, file);
            break;

        default:
            console.log(`
MMPM Migration Script — Router Upgrade

Commands:
  export    Export all atoms + Markov weights to a local JSON file
  import    Re-import atoms and replay training from a migration file

Options:
  --server URL     MMPM server URL (e.g. https://mmpm.co.nz)
  --token TOKEN    Bearer auth token
  --file PATH      Migration file path (import only)

Example:
  npx tsx scripts/migrate.ts export --server https://mmpm.co.nz --token abc123
  npx tsx scripts/migrate.ts import --server https://mmpm.co.nz --token abc123 --file mmpm-migration-2026-03-09.json
`);
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
