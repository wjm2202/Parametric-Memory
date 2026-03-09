/**
 * checkpoint_ordering.test.ts — Integration test proving that session_checkpoint
 * correctly commits atoms before training them, fixing the "train-on-new-atoms" bug.
 *
 * The bug: session_checkpoint used to do store → train → commit.
 * POST /train silently skips atoms that don't exist in shards yet (still pending),
 * so training newly created atoms in the same checkpoint call always failed silently.
 *
 * The fix: session_checkpoint now does store → commit → train → commit.
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../server';
import { createToolDefinitions } from '../../tools/mcp/mmpm_mcp_server';

type WeightsResponse = {
    atom: string;
    transitions: Array<{ to: string; weight: number; effectiveWeight: number }>;
    totalWeight: number;
};

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

async function startRealServer() {
    const dbPath = mkdtempSync(join(tmpdir(), 'mmpm-checkpoint-ordering-'));
    tempDirs.push(dbPath);

    const app = buildApp({
        data: ['v1.other.seed_checkpoint_test'],
        dbBasePath: dbPath,
        numShards: 2,
    });

    await app.orchestrator.init();
    app.pipeline.start();
    await app.server.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to determine listening address');
    }

    const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`;

    return {
        baseUrl,
        app,
        cleanup: async () => {
            await app.pipeline.stop();
            await app.server.close();
            await app.orchestrator.close();
        },
    };
}

describe('session_checkpoint ordering (integration)', () => {
    it('trains newly created atoms in the same checkpoint — the core bug fix', async () => {
        const { baseUrl, cleanup } = await startRealServer();

        try {
            const tools = createToolDefinitions({
                baseUrl,
                enableMutations: true,
            });
            const checkpoint = tools.find(t => t.name === 'session_checkpoint')!;

            // Create two brand-new atoms and train A → B in a single checkpoint call
            await checkpoint.handler({
                atoms: ['v1.fact.checkpoint_atom_A', 'v1.fact.checkpoint_atom_B'],
                train: ['v1.fact.checkpoint_atom_A', 'v1.fact.checkpoint_atom_B'],
            });

            // Verify the training actually took hold by checking weights
            const res = await fetch(`${baseUrl}/weights/${encodeURIComponent('v1.fact.checkpoint_atom_A')}`);
            expect(res.status).toBe(200);
            const weights = await res.json() as WeightsResponse;

            // The critical assertion: A → B should have weight 1.
            // Before the fix, this would be an empty array (weight 0) because
            // training ran before atoms were committed to shards.
            expect(weights.transitions.length).toBeGreaterThan(0);
            const edge = weights.transitions.find(e => e.to.includes('checkpoint_atom_B'));
            expect(edge).toBeDefined();
            expect(edge!.weight).toBe(1);
        } finally {
            await cleanup();
        }
    }, 15000);

    it('trains pre-existing atoms without double-commit overhead', async () => {
        const { baseUrl, cleanup } = await startRealServer();

        try {
            const tools = createToolDefinitions({
                baseUrl,
                enableMutations: true,
            });
            const checkpoint = tools.find(t => t.name === 'session_checkpoint')!;
            const commit = tools.find(t => t.name === 'memory_commit')!;
            const addAtoms = tools.find(t => t.name === 'memory_atoms_add')!;

            // Pre-create atoms in a separate step
            await addAtoms.handler({ atoms: ['v1.fact.pre_existing_X', 'v1.fact.pre_existing_Y'] });
            await commit.handler({});

            // Now checkpoint with train-only (no new atoms)
            await checkpoint.handler({
                train: ['v1.fact.pre_existing_X', 'v1.fact.pre_existing_Y'],
            });

            // Verify training worked
            const res = await fetch(`${baseUrl}/weights/${encodeURIComponent('v1.fact.pre_existing_X')}`);
            expect(res.status).toBe(200);
            const weights = await res.json() as WeightsResponse;

            expect(weights.transitions.length).toBeGreaterThan(0);
            const edge = weights.transitions.find(e => e.to.includes('pre_existing_Y'));
            expect(edge).toBeDefined();
            expect(edge!.weight).toBe(1);
        } finally {
            await cleanup();
        }
    }, 15000);

    it('tombstone + train in same checkpoint commits tombstones before training', async () => {
        const { baseUrl, cleanup } = await startRealServer();

        try {
            const tools = createToolDefinitions({
                baseUrl,
                enableMutations: true,
            });
            const checkpoint = tools.find(t => t.name === 'session_checkpoint')!;

            // First checkpoint: create atoms
            await checkpoint.handler({
                atoms: ['v1.fact.tomb_test_A', 'v1.fact.tomb_test_B', 'v1.state.old_state'],
            });

            // Second checkpoint: tombstone old state + train A → B
            await checkpoint.handler({
                tombstone: ['v1.state.old_state'],
                train: ['v1.fact.tomb_test_A', 'v1.fact.tomb_test_B'],
            });

            // Verify training worked
            const res = await fetch(`${baseUrl}/weights/${encodeURIComponent('v1.fact.tomb_test_A')}`);
            expect(res.status).toBe(200);
            const weights = await res.json() as WeightsResponse;
            const edge = weights.transitions.find(e => e.to.includes('tomb_test_B'));
            expect(edge).toBeDefined();
            expect(edge!.weight).toBe(1);

            // Verify tombstone actually happened
            const atomRes = await fetch(`${baseUrl}/atoms/${encodeURIComponent('v1.state.old_state')}`);
            expect(atomRes.status).toBe(200);
            const atomData = await atomRes.json() as { status: string };
            expect(atomData.status).toBe('tombstoned');
        } finally {
            await cleanup();
        }
    }, 15000);

    it('multi-atom training sequence works in a single checkpoint', async () => {
        const { baseUrl, cleanup } = await startRealServer();

        try {
            const tools = createToolDefinitions({
                baseUrl,
                enableMutations: true,
            });
            const checkpoint = tools.find(t => t.name === 'session_checkpoint')!;

            // Create 3 atoms and train a chain A → B → C
            await checkpoint.handler({
                atoms: ['v1.procedure.chain_A', 'v1.procedure.chain_B', 'v1.procedure.chain_C'],
                train: ['v1.procedure.chain_A', 'v1.procedure.chain_B', 'v1.procedure.chain_C'],
            });

            // Verify A → B edge
            const resA = await fetch(`${baseUrl}/weights/${encodeURIComponent('v1.procedure.chain_A')}`);
            const weightsA = await resA.json() as WeightsResponse;
            expect(weightsA.transitions.some(e => e.to.includes('chain_B'))).toBe(true);

            // Verify B → C edge
            const resB = await fetch(`${baseUrl}/weights/${encodeURIComponent('v1.procedure.chain_B')}`);
            const weightsB = await resB.json() as WeightsResponse;
            expect(weightsB.transitions.some(e => e.to.includes('chain_C'))).toBe(true);
        } finally {
            await cleanup();
        }
    }, 15000);
});
