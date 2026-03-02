import { describe, it, expect, afterAll } from 'vitest';
import { MMPMValidator } from '../validator';
import { MerkleKernel } from '../merkle';
import { ShardedOrchestrator } from '../orchestrator';
import { rmSync } from 'fs';

const dbDirs: string[] = [];
let counter = 0;
const atom = (value: string) => `v1.other.${value}`;

function freshDb(): string {
    const path = `./test-validator-db-${Date.now()}-${counter++}`;
    dbDirs.push(path);
    return path;
}

afterAll(() => {
    for (const dir of dbDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
    }
});

// ---------------------------------------------------------------------------
// verifyProof — low-level Merkle proof verification
// ---------------------------------------------------------------------------
describe('MMPMValidator.verifyProof', () => {
    it('returns true for a valid proof from MerkleKernel', () => {
        const kernel = new MerkleKernel(['a', 'b', 'c', 'd']);
        const v = new MMPMValidator(kernel.root);
        for (let i = 0; i < 4; i++) {
            const proof = kernel.getProof(i);
            expect(v.verifyProof(kernel.getLeafHash(i), proof)).toBe(true);
        }
    });

    it('returns false when itemHash does not match the leaf', () => {
        const kernel = new MerkleKernel(['a', 'b', 'c', 'd']);
        const v = new MMPMValidator(kernel.root);
        const proof = kernel.getProof(0);
        // Pass hash of a different leaf
        expect(v.verifyProof(kernel.getLeafHash(2), proof)).toBe(false);
    });

    it('returns false when the audit path is tampered', () => {
        const kernel = new MerkleKernel(['a', 'b', 'c', 'd']);
        const v = new MMPMValidator(kernel.root);
        const proof = kernel.getProof(1);
        proof.auditPath[0] = 'ff'.repeat(32); // tamper
        expect(v.verifyProof(kernel.getLeafHash(1), proof)).toBe(false);
    });

    it('handles a single-element tree', () => {
        const kernel = new MerkleKernel(['solo']);
        const v = new MMPMValidator(kernel.root);
        const proof = kernel.getProof(0);
        expect(v.verifyProof(kernel.getLeafHash(0), proof)).toBe(true);
    });

    it('is correct for deeper trees (index > 0 at inner levels)', () => {
        // 8-element tree — exercises multi-level index advancement
        const data = Array.from({ length: 8 }, (_, i) => `node_${i}`);
        const kernel = new MerkleKernel(data);
        const v = new MMPMValidator(kernel.root);
        for (let i = 0; i < 8; i++) {
            const proof = kernel.getProof(i);
            expect(v.verifyProof(kernel.getLeafHash(i), proof)).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// validateReport — full leaf → shard → master chain
// ---------------------------------------------------------------------------
describe('MMPMValidator.validateReport', () => {
    it('validates a real PredictionReport from ShardedOrchestrator', async () => {
        const data = [atom('A'), atom('B'), atom('C'), atom('D')];
        const mem = new ShardedOrchestrator(4, data, freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));

        // Build validator anchored to the current master root
        const masterRoot = report.shardRootProof?.root ?? report.currentProof.root;
        const v = new MMPMValidator(masterRoot);
        expect(v.validateReport(report)).toBe(true);
        await mem.close();
    });

    it('returns false when currentData is tampered after generation', async () => {
        const data = [atom('A'), atom('B'), atom('C'), atom('D')];
        const mem = new ShardedOrchestrator(4, data, freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));
        const masterRoot = report.shardRootProof?.root ?? report.currentProof.root;
        const v = new MMPMValidator(masterRoot);

        // Mutate the data atom — the hash won't match the proof leaf anymore
        const tampered = { ...report, currentData: atom('TAMPERED') };
        expect(v.validateReport(tampered)).toBe(false);
        await mem.close();
    });

    it('returns false when the master root does not match the shard proof', async () => {
        const data = [atom('A'), atom('B'), atom('C'), atom('D')];
        const mem = new ShardedOrchestrator(4, data, freshDb());
        await mem.init();
        const report = await mem.access(atom('A'));

        // Validator anchored to a different (wrong) master root
        const wrongRoot = '00'.repeat(32);
        const v = new MMPMValidator(wrongRoot);

        if (report.shardRootProof) {
            expect(v.validateReport(report)).toBe(false);
        } else {
            // Single-shard edge case — no shardRootProof, leaf-only validation still passes
            expect(v.validateReport(report)).toBe(true);
        }
        await mem.close();
    });

    it('validates correctly for all atoms in a multi-shard cluster', async () => {
        const data = [atom('Node_A'), atom('Node_B'), atom('Node_C'), atom('Node_D'), atom('Step_1'), atom('Step_2')];
        const mem = new ShardedOrchestrator(4, data, freshDb());
        await mem.init();

        for (const atom of data) {
            const report = await mem.access(atom);
            const masterRoot = report.shardRootProof?.root ?? report.currentProof.root;
            const v = new MMPMValidator(masterRoot);
            expect(v.validateReport(report)).toBe(true);
        }
        await mem.close();
    });

    it('still validates when there is no shardRootProof (single effective shard)', async () => {
        // Use 1 shard so no master tree branching
        const data = [atom('X'), atom('Y'), atom('Z')];
        const mem = new ShardedOrchestrator(1, data, freshDb());
        await mem.init();
        const report = await mem.access(atom('X'));
        const masterRoot = report.shardRootProof?.root ?? report.currentProof.root;
        const v = new MMPMValidator(masterRoot);
        expect(v.validateReport(report)).toBe(true);
        await mem.close();
    });
});
