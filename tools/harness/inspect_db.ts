import { ClassicLevel as Level } from 'classic-level';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

interface Edge {
    fromHash: string;
    toHash: string;
    weight: number;
}

function parseArgString(argv: string[], key: string): string | null {
    let idx = -1;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === `--${key}`) idx = i;
    }
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

function parseArgNumber(argv: string[], key: string, fallback: number): number {
    const raw = parseArgString(argv, key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function hashAtom(atom: string): string {
    return createHash('sha256').update(atom).digest('hex');
}

async function ensureParentDir(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

async function runCli() {
    const argv = process.argv.slice(2);

    const dbBasePath = resolve(parseArgString(argv, 'db') ?? './mmpm-db');
    const shard = parseArgNumber(argv, 'shard', 0);
    const depth = Math.max(1, parseArgNumber(argv, 'depth', 3));
    const branch = Math.max(1, parseArgNumber(argv, 'branch', 4));
    const atom = parseArgString(argv, 'atom');
    const outPath = parseArgString(argv, 'out');

    const dbPath = resolve(`${dbBasePath}/shard_${shard}`);
    const db = new Level<string, string>(dbPath);

    const atoms: string[] = [];
    const tombstones = new Set<string>();
    const edges: Edge[] = [];

    await db.open();
    try {
        for await (const [, value] of db.iterator({ gte: 'ai:', lte: 'ai:~' })) {
            atoms.push(value as string);
        }

        for await (const [key] of db.iterator({ gte: 'th:', lte: 'th:~' })) {
            tombstones.add(key.slice(3));
        }

        for await (const [key, value] of db.iterator({ gte: 'w:', lte: 'w:~' })) {
            const parts = key.split(':');
            if (parts.length !== 3) continue;
            const weight = Number(value);
            if (!Number.isFinite(weight)) continue;
            edges.push({ fromHash: parts[1], toHash: parts[2], weight });
        }
    } finally {
        await db.close();
    }

    const atomByHash = new Map<string, string>();
    for (const a of atoms) atomByHash.set(hashAtom(a), a);

    const activeAtoms = atoms.filter(a => !tombstones.has(hashAtom(a)));

    console.log(`DB: ${dbPath}`);
    console.log(`Atoms total: ${atoms.length}`);
    console.log(`Atoms active: ${activeAtoms.length}`);
    console.log(`Atoms tombstoned: ${atoms.length - activeAtoms.length}`);
    console.log(`Transition edges: ${edges.length}`);

    console.log('\nSample stored atom text (ai:* values):');
    for (const sample of atoms.slice(0, 10)) {
        console.log(`- ${sample}`);
    }

    if (!atom) return;

    const rootHash = hashAtom(atom);
    const exists = atomByHash.has(rootHash);
    if (!exists) {
        console.log(`\nAtom not found in shard_${shard}: ${atom}`);
        return;
    }

    const byFrom = new Map<string, Edge[]>();
    for (const edge of edges) {
        if (!byFrom.has(edge.fromHash)) byFrom.set(edge.fromHash, []);
        byFrom.get(edge.fromHash)!.push(edge);
    }
    for (const list of byFrom.values()) list.sort((a, b) => b.weight - a.weight);

    const lines: string[] = [];
    lines.push('graph TD');

    const queue: Array<{ h: string; d: number }> = [{ h: rootHash, d: 0 }];
    const seenNode = new Set<string>();
    const seenEdge = new Set<string>();

    while (queue.length > 0) {
        const { h, d } = queue.shift()!;
        if (d > depth) continue;

        const text = atomByHash.get(h) ?? `hash:${h.slice(0, 8)}`;
        if (!seenNode.has(h)) {
            const escaped = text.replace(/"/g, "'");
            lines.push(`  ${h.slice(0, 10)}["${escaped}"]`);
            seenNode.add(h);
        }

        if (d === depth) continue;
        const out = (byFrom.get(h) ?? []).slice(0, branch);
        for (const e of out) {
            const toText = atomByHash.get(e.toHash) ?? `hash:${e.toHash.slice(0, 8)}`;
            if (!seenNode.has(e.toHash)) {
                const escaped = toText.replace(/"/g, "'");
                lines.push(`  ${e.toHash.slice(0, 10)}["${escaped}"]`);
                seenNode.add(e.toHash);
            }

            const ek = `${e.fromHash}->${e.toHash}`;
            if (!seenEdge.has(ek)) {
                lines.push(`  ${e.fromHash.slice(0, 10)} -->|w=${e.weight}| ${e.toHash.slice(0, 10)}`);
                seenEdge.add(ek);
            }
            queue.push({ h: e.toHash, d: d + 1 });
        }
    }

    console.log(`\nSparse transition tree root: ${atom}`);
    console.log(`Depth: ${depth}, fanout cap: ${branch}`);
    console.log(`Nodes rendered: ${seenNode.size}, edges rendered: ${seenEdge.size}`);

    if (outPath) {
        const fullOut = resolve(outPath);
        await ensureParentDir(fullOut);
        await writeFile(fullOut, `${lines.join('\n')}\n`, 'utf8');
        console.log(`Mermaid output: ${fullOut}`);
    } else {
        console.log('\nMermaid graph:');
        console.log(lines.join('\n'));
    }
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
