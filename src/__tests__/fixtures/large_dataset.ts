/**
 * Large Dataset Fixture
 *
 * Provides a deterministic 200-atom, 4-shard dataset pre-trained with
 * 20 distinct chains of 10 atoms each (5 repetitions per chain).
 *
 * Usage:
 *   import { LARGE_ATOMS, LARGE_CHAINS, buildLargeOrchestrator } from './large_dataset';
 *
 *   const { orchestrator, server } = await buildLargeOrchestrator(dbPath);
 *   // ... run tests ...
 *   await orchestrator.close();
 */

import { ShardedOrchestrator } from '../../orchestrator';
import { buildApp } from '../../server';
import type { FastifyInstance } from 'fastify';
const atom = (value: string) => `v1.other.${value}`;

// ── Atom set ──────────────────────────────────────────────────────────────────

/** 200 uniquely named atoms. "N_000" … "N_199". */
export const LARGE_ATOMS: string[] = Array.from(
    { length: 200 },
    (_, i) => atom(`N_${String(i).padStart(3, '0')}`)
);

// ── Chain definitions ─────────────────────────────────────────────────────────

/**
 * 20 non-overlapping chains of 10 atoms each.
 * Chain k uses atoms N_{k*10} … N_{k*10+9}.
 * This means each atom appears in exactly one chain and has exactly one
 * dominant successor — prediction should be deterministic after training.
 */
export const LARGE_CHAINS: string[][] = Array.from(
    { length: 20 },
    (_, chainIdx) =>
        Array.from({ length: 10 }, (__, pos) =>
            LARGE_ATOMS[chainIdx * 10 + pos]
        )
);

/** For quick lookup: atom → its expected next atom (null for chain tails). */
export const EXPECTED_NEXT: Map<string, string | null> = new Map();
for (const chain of LARGE_CHAINS) {
    for (let i = 0; i < chain.length - 1; i++) {
        EXPECTED_NEXT.set(chain[i], chain[i + 1]);
    }
    // Terminal atom of each chain has no expected successor
    EXPECTED_NEXT.set(chain[chain.length - 1], null);
}

// ── Builder ───────────────────────────────────────────────────────────────────

export interface LargeDatasetAppResult {
    server: FastifyInstance;
    orchestrator: ShardedOrchestrator;
}

/**
 * Create, initialise, and pre-train the large dataset cluster.
 *
 * @param dbBasePath  Base path for LevelDB shards (caller manages cleanup).
 * @param repetitions How many times each chain is trained (default 5).
 *                    More repetitions → higher prediction confidence but slower setup.
 */
export async function buildLargeOrchestrator(
    dbBasePath: string,
    repetitions = 5
): Promise<LargeDatasetAppResult> {
    const { server, orchestrator } = buildApp({
        data: LARGE_ATOMS,
        dbBasePath,
        numShards: 4,
    });

    await orchestrator.init();

    // Train each chain `repetitions` times so the dominant path is clear
    for (let rep = 0; rep < repetitions; rep++) {
        for (const chain of LARGE_CHAINS) {
            await orchestrator.train(chain);
        }
    }

    return { server, orchestrator };
}
