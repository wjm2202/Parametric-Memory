import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShardedOrchestrator } from '../orchestrator';
import { MerkleKernel } from '../merkle';
const atom = (value: string) => `v1.other.${value}`;

const dbDirs: string[] = [];

function tempDb(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dbDirs.push(dir);
    return dir;
}

afterAll(() => {
    while (dbDirs.length > 0) {
        const dir = dbDirs.pop()!;
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

describe('Concurrent read/write stress (Story 8.1)', () => {
    it('runs for 10 seconds with zero invalid proofs under concurrent access/addAtoms load', async () => {
        const seedAtoms = Array.from({ length: 24 }, (_, i) => atom(`Seed_${i}`));
        const db = tempDb('mmpm-concurrent-');
        const orchestrator = new ShardedOrchestrator(4, seedAtoms, db);
        await orchestrator.init();

        const activeAtoms: string[] = [...seedAtoms];
        const durationMs = 10_000;
        const deadline = Date.now() + durationMs;

        let nextAtomId = 0;
        let invalidProofs = 0;
        let readFailures = 0;
        let writeFailures = 0;
        let totalReads = 0;
        let totalWrites = 0;

        const randomActiveAtom = () => activeAtoms[Math.floor(Math.random() * activeAtoms.length)];

        const reader = async () => {
            while (Date.now() < deadline) {
                const atom = randomActiveAtom();
                try {
                    const report = await orchestrator.access(atom);
                    totalReads++;

                    if (!MerkleKernel.verifyProof(report.currentProof)) invalidProofs++;
                    if (report.predictedProof && !MerkleKernel.verifyProof(report.predictedProof)) invalidProofs++;
                    if (report.shardRootProof && !MerkleKernel.verifyProof(report.shardRootProof)) invalidProofs++;
                } catch {
                    readFailures++;
                }
            }
        };

        const writer = async () => {
            while (Date.now() < deadline) {
                const newAtom = atom(`Live_${nextAtomId++}`);
                try {
                    await orchestrator.addAtoms([newAtom]);
                    activeAtoms.push(newAtom);
                    totalWrites++;

                    const from = randomActiveAtom();
                    await orchestrator.train([from, newAtom]);
                } catch {
                    writeFailures++;
                }
            }
        };

        const readers = Array.from({ length: 8 }, () => reader());
        const writers = Array.from({ length: 2 }, () => writer());
        await Promise.all([...readers, ...writers]);

        await orchestrator.close();

        expect(totalReads).toBeGreaterThan(0);
        expect(totalWrites).toBeGreaterThan(0);
        expect(readFailures).toBe(0);
        expect(writeFailures).toBe(0);
        expect(invalidProofs).toBe(0);
    }, 30_000);
});
