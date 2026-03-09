import { describe, it, expect } from 'vitest';
import { MasterKernel } from '../master';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a deterministic shard root for testing. */
function shardRoot(label: string): string {
    return createHash('sha256').update(label).digest('hex');
}

/** Create a master kernel with N versions from sequential shard root updates. */
function buildMaster(numShards: number, numVersions: number): MasterKernel {
    const master = new MasterKernel();
    for (let v = 0; v < numVersions; v++) {
        const updates = new Map<number, string>();
        for (let s = 0; s < numShards; s++) {
            updates.set(s, shardRoot(`shard-${s}-v${v}`));
        }
        master.batchUpdateShardRoots(updates);
    }
    return master;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consistency Proofs', () => {

    describe('simple append — tree grows honestly', () => {
        it('generates a valid proof between two consecutive versions', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);

            expect(proof.fromVersion).toBe(1);
            expect(proof.toVersion).toBe(5);
            expect(proof.fromRoot).toBeDefined();
            expect(proof.toRoot).toBeDefined();
            expect(proof.fromRoot).not.toBe(proof.toRoot);
            expect(proof.fromShardRoots).toHaveLength(4);
            expect(proof.toShardRoots).toHaveLength(4);
            expect(proof.intermediateRoots).toHaveLength(3); // versions 2, 3, 4
        });

        it('proof verifies successfully', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(true);
            expect(result.reason).toBeUndefined();
        });

        it('adjacent versions produce valid proof with no intermediates', () => {
            const master = buildMaster(2, 3);
            const proof = master.getConsistencyProof(1, 2);
            expect(proof.intermediateRoots).toHaveLength(0);
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(true);
        });
    });

    describe('tombstone consistency — tree changes honestly via deletions', () => {
        it('single-shard update produces valid proof', () => {
            const master = new MasterKernel();
            // Version 1: initial state
            master.batchUpdateShardRoots(new Map([
                [0, shardRoot('shard-0-init')],
                [1, shardRoot('shard-1-init')],
            ]));
            // Version 2: shard 0 changed (simulates tombstone in shard 0)
            master.updateShardRoot(0, shardRoot('shard-0-after-tombstone'));

            const proof = master.getConsistencyProof(1, 2);
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(true);

            // Only shard 0 should have changed
            expect(proof.fromShardRoots[0]).not.toBe(proof.toShardRoots[0]);
            expect(proof.fromShardRoots[1]).toBe(proof.toShardRoots[1]);
        });
    });

    describe('full history window traversal', () => {
        it('proof spans entire retained window', () => {
            const master = buildMaster(2, 50);
            const proof = master.getConsistencyProof(1, 50);
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(true);
            expect(proof.intermediateRoots).toHaveLength(48); // 2..49
        });

        it('throws when version is outside history window', () => {
            // Build enough versions to evict early ones (window = 100)
            const master = buildMaster(2, 120);
            // Version 1 should be evicted
            expect(() => master.getConsistencyProof(1, 120)).toThrow(/outside the history window/);
            // Version 21 should still exist (120 - 100 + 1 = 21)
            const proof = master.getConsistencyProof(21, 120);
            expect(MasterKernel.verifyConsistencyProof(proof).valid).toBe(true);
        });
    });

    describe('tamper detection', () => {
        it('rejects proof with tampered fromRoot', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);
            proof.fromRoot = 'a'.repeat(64); // tamper
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('fromRoot mismatch');
        });

        it('rejects proof with tampered toRoot', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);
            proof.toRoot = 'b'.repeat(64); // tamper
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('toRoot mismatch');
        });

        it('rejects proof with tampered shard root', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);
            proof.fromShardRoots[2] = 'c'.repeat(64); // tamper one shard
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('fromRoot mismatch');
        });

        it('rejects proof with reversed versions', () => {
            const master = buildMaster(2, 5);
            // Can't generate reversed proof, but we can construct one
            const proof = master.getConsistencyProof(1, 5);
            const tampered = {
                ...proof,
                fromVersion: 5,
                toVersion: 1,
            };
            const result = MasterKernel.verifyConsistencyProof(tampered);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('fromVersion must be less than toVersion');
        });

        it('rejects proof with non-monotonic intermediate chain', () => {
            const master = buildMaster(4, 5);
            const proof = master.getConsistencyProof(1, 5);
            // Swap intermediate versions to break monotonicity
            if (proof.intermediateRoots.length >= 2) {
                const temp = proof.intermediateRoots[0].version;
                proof.intermediateRoots[0].version = proof.intermediateRoots[1].version;
                proof.intermediateRoots[1].version = temp;
            }
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('not monotonic');
        });
    });

    describe('cross-session simulation', () => {
        it('client caches tree-head and verifies consistency on reconnect', () => {
            const master = buildMaster(3, 10);

            // Session 1: client caches tree head at version 5
            const sessionOneHead = {
                version: 5,
                root: master.getRootAtVersion(5)!,
            };

            // Between sessions: 5 more versions are committed
            // (already done — we built 10 versions)

            // Session 2: client connects, gets current head (version 10)
            const sessionTwoHead = {
                version: 10,
                root: master.getRootAtVersion(10)!,
            };

            // Client requests consistency proof
            const proof = master.getConsistencyProof(sessionOneHead.version, sessionTwoHead.version);

            // Client verifies independently
            const result = MasterKernel.verifyConsistencyProof(proof);
            expect(result.valid).toBe(true);

            // Client confirms the proof matches their cached roots
            expect(proof.fromRoot).toBe(sessionOneHead.root);
            expect(proof.toRoot).toBe(sessionTwoHead.root);
        });
    });

    describe('independent verification (computeMasterRoot)', () => {
        it('recomputes correct master root from shard roots', () => {
            const master = new MasterKernel();
            const roots = [shardRoot('a'), shardRoot('b'), shardRoot('c')];
            master.batchUpdateShardRoots(new Map(roots.map((r, i) => [i, r])));

            // Recompute externally
            const recomputed = MasterKernel.computeMasterRoot(roots);
            expect(recomputed).toBe(master.masterRoot);
        });

        it('empty shard roots produce the zero root', () => {
            const root = MasterKernel.computeMasterRoot([]);
            expect(root).toBe('0'.repeat(64));
        });
    });

    describe('tree-head accessor', () => {
        it('returns current version, root, and timestamp', () => {
            const master = buildMaster(2, 3);
            const head = master.treeHead;
            expect(head.version).toBe(3);
            expect(head.root).toBe(master.masterRoot);
            expect(head.timestamp).toBeGreaterThan(0);
        });
    });

    describe('edge cases', () => {
        it('throws when fromVersion >= toVersion', () => {
            const master = buildMaster(2, 5);
            expect(() => master.getConsistencyProof(3, 3)).toThrow(/must be less than/);
            expect(() => master.getConsistencyProof(4, 2)).toThrow(/must be less than/);
        });

        it('oldest version accessor is correct', () => {
            const master = buildMaster(2, 50);
            expect(master.oldestVersion).toBe(1); // window not exceeded yet

            // Exceed window
            const bigMaster = buildMaster(2, 120);
            expect(bigMaster.oldestVersion).toBe(21); // 120 - 100 + 1
        });

        it('timestamps are non-decreasing across versions', () => {
            const master = buildMaster(2, 10);
            const proof = master.getConsistencyProof(1, 10);
            expect(proof.toTimestamp).toBeGreaterThanOrEqual(proof.fromTimestamp);
        });
    });
});
