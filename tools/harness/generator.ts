export type HarnessDomain = 'knowledge_graph' | 'conversation' | 'tool_call' | 'document';

export interface GeneratorConfig {
    totalAtoms: number;
    avgChainLength: number;
    branchFactor: number;
    vocabularySize: number;
    seed?: number;
}

export interface GeneratorMetadata {
    config: GeneratorConfig;
    domainAtomCounts: Record<HarnessDomain, number>;
    domainSequenceCounts: Record<HarnessDomain, number>;
    generatedAt: string;
    uniqueAtoms: number;
    totalSequences: number;
}

export interface GeneratedDataset {
    atoms: string[];
    sequences: string[][];
    metadata: GeneratorMetadata;
}

const DOMAINS: HarnessDomain[] = ['knowledge_graph', 'conversation', 'tool_call', 'document'];

function createRng(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}

function pick<T>(arr: T[], rnd: () => number): T {
    return arr[Math.floor(rnd() * arr.length)];
}

function pad(i: number, width = 5): string {
    return String(i).padStart(width, '0');
}

function buildAtom(domain: HarnessDomain, ordinal: number, vocabularySize: number, rnd: () => number): string {
    const vocab = `v${pad(Math.floor(rnd() * vocabularySize), 6)}`;

    switch (domain) {
        case 'knowledge_graph': {
            const subject = `s${pad(Math.floor(ordinal / 9), 6)}`;
            const predicate = `p${Math.floor(rnd() * 32)}`;
            const object = `o${pad((ordinal * 7 + Math.floor(rnd() * 97)) % (vocabularySize * 3), 6)}`;
            return `v1.other.kg|${subject}|${predicate}|${object}|${vocab}`;
        }
        case 'conversation': {
            const thread = `t${pad(Math.floor(ordinal / 20), 5)}`;
            const turn = `m${pad(ordinal % 200, 4)}`;
            const role = rnd() < 0.5 ? 'user' : 'assistant';
            return `v1.other.conv|${thread}|${turn}|${role}|${vocab}`;
        }
        case 'tool_call': {
            const agent = `agent${(ordinal % 16) + 1}`;
            const action = `action_${(ordinal * 3) % 64}`;
            const result = `result_${(ordinal * 11 + Math.floor(rnd() * 17)) % 128}`;
            return `v1.other.tool|${agent}|${action}|${result}|${vocab}`;
        }
        case 'document': {
            const doc = `doc${pad(Math.floor(ordinal / 30), 5)}`;
            const para = `p${pad(ordinal % 300, 4)}`;
            const section = `sec${(ordinal % 12) + 1}`;
            return `v1.other.doc|${doc}|${section}|${para}|${vocab}`;
        }
    }
}

function validateConfig(config: GeneratorConfig): GeneratorConfig {
    return {
        totalAtoms: clamp(Math.floor(config.totalAtoms || 0), 100, 1000000),
        avgChainLength: clamp(Math.floor(config.avgChainLength || 0), 3, 1000),
        branchFactor: clamp(Number(config.branchFactor ?? 0.15), 0, 1),
        vocabularySize: clamp(Math.floor(config.vocabularySize || 0), 100, 10000000),
        seed: Number.isFinite(config.seed) ? Number(config.seed) : 42,
    };
}

export function generateStructuredDataset(input: GeneratorConfig): GeneratedDataset {
    const config = validateConfig(input);
    const rnd = createRng(config.seed ?? 42);

    const atomsByDomain: Record<HarnessDomain, string[]> = {
        knowledge_graph: [],
        conversation: [],
        tool_call: [],
        document: [],
    };

    const targetPerDomain = Math.floor(config.totalAtoms / DOMAINS.length);

    for (const domain of DOMAINS) {
        let i = 0;
        while (atomsByDomain[domain].length < targetPerDomain) {
            atomsByDomain[domain].push(buildAtom(domain, i++, config.vocabularySize, rnd));
        }
    }

    const allAtoms = DOMAINS.flatMap(d => atomsByDomain[d]);
    while (allAtoms.length < config.totalAtoms) {
        const domain = pick(DOMAINS, rnd);
        const atom = buildAtom(domain, allAtoms.length, config.vocabularySize, rnd);
        allAtoms.push(atom);
        atomsByDomain[domain].push(atom);
    }

    const sequences: string[][] = [];
    const domainSequenceCounts: Record<HarnessDomain, number> = {
        knowledge_graph: 0,
        conversation: 0,
        tool_call: 0,
        document: 0,
    };

    const perDomainChains = Math.max(1, Math.floor((config.totalAtoms / config.avgChainLength) / DOMAINS.length));

    for (const domain of DOMAINS) {
        const domainAtoms = atomsByDomain[domain];
        if (domainAtoms.length === 0) continue;

        for (let chain = 0; chain < perDomainChains; chain++) {
            const seq: string[] = [];
            let pos = Math.floor(rnd() * domainAtoms.length);
            const chainLength = clamp(
                Math.round(config.avgChainLength * (0.7 + rnd() * 0.6)),
                3,
                Math.max(3, config.avgChainLength * 3)
            );

            for (let step = 0; step < chainLength; step++) {
                seq.push(domainAtoms[pos]);

                if (rnd() < config.branchFactor) {
                    const jump = 1 + Math.floor(rnd() * Math.max(2, Math.floor(config.avgChainLength / 2)));
                    pos = (pos + jump) % domainAtoms.length;
                } else {
                    pos = (pos + 1) % domainAtoms.length;
                }
            }

            sequences.push(seq);
            domainSequenceCounts[domain]++;
        }
    }

    for (let i = 0; i < Math.max(1, Math.floor(perDomainChains / 4)); i++) {
        const cross: string[] = [];
        const chainLength = clamp(
            Math.round(config.avgChainLength * (0.8 + rnd() * 0.8)),
            3,
            Math.max(3, config.avgChainLength * 4)
        );

        let domain = pick(DOMAINS, rnd);
        let index = Math.floor(rnd() * atomsByDomain[domain].length);

        for (let step = 0; step < chainLength; step++) {
            cross.push(atomsByDomain[domain][index]);

            if (rnd() < config.branchFactor) {
                domain = pick(DOMAINS, rnd);
                index = Math.floor(rnd() * atomsByDomain[domain].length);
            } else {
                index = (index + 1) % atomsByDomain[domain].length;
            }
        }

        sequences.push(cross);
    }

    return {
        atoms: allAtoms,
        sequences,
        metadata: {
            config,
            domainAtomCounts: {
                knowledge_graph: atomsByDomain.knowledge_graph.length,
                conversation: atomsByDomain.conversation.length,
                tool_call: atomsByDomain.tool_call.length,
                document: atomsByDomain.document.length,
            },
            domainSequenceCounts,
            generatedAt: new Date().toISOString(),
            uniqueAtoms: new Set(allAtoms).size,
            totalSequences: sequences.length,
        },
    };
}

function parseArgNumber(argv: string[], key: string, fallback: number): number {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return fallback;
    const value = Number(argv[idx + 1]);
    return Number.isFinite(value) ? value : fallback;
}

function parseArgString(argv: string[], key: string): string | null {
    const idx = argv.indexOf(`--${key}`);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
}

async function runCli() {
    const argv = process.argv.slice(2);
    const config: GeneratorConfig = {
        totalAtoms: parseArgNumber(argv, 'atoms', 10000),
        avgChainLength: parseArgNumber(argv, 'avgChainLength', 12),
        branchFactor: parseArgNumber(argv, 'branchFactor', 0.15),
        vocabularySize: parseArgNumber(argv, 'vocabulary', 5000),
        seed: parseArgNumber(argv, 'seed', 42),
    };

    const outputPath = parseArgString(argv, 'out');
    const dataset = generateStructuredDataset(config);

    if (outputPath) {
        const { writeFile } = await import('fs/promises');
        await writeFile(outputPath, JSON.stringify(dataset, null, 2), 'utf-8');
        console.log(`Generated dataset: ${dataset.atoms.length} atoms, ${dataset.sequences.length} sequences -> ${outputPath}`);
        return;
    }

    console.log(JSON.stringify(dataset, null, 2));
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
