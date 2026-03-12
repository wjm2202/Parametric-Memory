import { describe, it, expect } from 'vitest';
import { PpmModel } from '../ppm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const H = {
    setup:    'aa'.repeat(32),
    review:   'bb'.repeat(32),
    deploy:   'cc'.repeat(32),
    monitor:  'dd'.repeat(32),
    rollback: 'ee'.repeat(32),
    debug:    'ff'.repeat(32),
    fix:      '11'.repeat(32),
    test:     '22'.repeat(32),
    release:  '33'.repeat(32),
};

/**
 * Train a model with a standard pipeline, serialize, clear, deserialize into
 * a fresh model, and compare predictions.
 */
function roundTrip(original: PpmModel): PpmModel {
    const entries = original.serialize();
    const restored = new PpmModel({
        maxOrder: original.getStats().maxOrder,
        escapeThreshold: original.getStats().escapeThreshold,
    });
    restored.deserialize(entries);
    return restored;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PPM Trie Persistence (Sprint 13)', () => {

    describe('serialize → deserialize round-trip', () => {

        it('produces identical predictions after round-trip', () => {
            const ppm = new PpmModel({ maxOrder: 3 });
            const pipeline = [H.setup, H.review, H.deploy, H.monitor];
            for (let i = 0; i < 10; i++) ppm.train(pipeline);

            expect(ppm.dirty).toBe(true);

            const restored = roundTrip(ppm);

            // Both models should make the same prediction
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            ppm.recordAccess(H.deploy);
            restored.recordAccess(H.setup);
            restored.recordAccess(H.review);
            restored.recordAccess(H.deploy);

            const origPred = ppm.predict();
            const restPred = restored.predict();

            expect(origPred).not.toBeNull();
            expect(restPred).not.toBeNull();
            expect(restPred!.predicted).toBe(origPred!.predicted);
            expect(restPred!.order).toBe(origPred!.order);
            expect(restPred!.confidence).toBeCloseTo(origPred!.confidence, 10);
        });

        it('preserves node count across round-trip', () => {
            const ppm = new PpmModel({ maxOrder: 3 });
            ppm.train([H.setup, H.review, H.deploy, H.monitor]);
            ppm.train([H.debug, H.review, H.rollback]);

            const originalCount = ppm.getStats().nodeCount;
            const restored = roundTrip(ppm);

            expect(restored.getStats().nodeCount).toBe(originalCount);
        });

        it('clears dirty flag after serialize', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            expect(ppm.dirty).toBe(true);

            ppm.serialize();
            expect(ppm.dirty).toBe(false);
        });

        it('clears dirty flag after deserialize', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            const entries = ppm.serialize();

            const fresh = new PpmModel();
            fresh.deserialize(entries);
            expect(fresh.dirty).toBe(false);
        });

        it('handles empty model', () => {
            const ppm = new PpmModel();
            const entries = ppm.serialize();
            // Root is always serialized even if empty
            expect(entries.size).toBeGreaterThanOrEqual(1);

            const restored = new PpmModel();
            restored.deserialize(entries);
            expect(restored.getStats().nodeCount).toBe(ppm.getStats().nodeCount);
        });

        it('handles empty entries map in deserialize', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review, H.deploy]);

            // Deserialize with empty map should clear everything
            ppm.deserialize(new Map());
            expect(ppm.getStats().nodeCount).toBe(1); // just root
        });

        it('preserves branching sequences', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });

            // Two diverging paths after "review"
            for (let i = 0; i < 5; i++) {
                ppm.train([H.setup, H.review, H.deploy]);
                ppm.train([H.debug, H.review, H.rollback]);
            }

            const restored = roundTrip(ppm);

            // Path A: setup → review → should predict deploy
            restored.recordAccess(H.setup);
            restored.recordAccess(H.review);
            const predA = restored.predict();
            expect(predA).not.toBeNull();
            expect(predA!.predicted).toBe(H.deploy);

            // Path B: need fresh history — use a new model
            const restored2 = roundTrip(ppm);
            restored2.recordAccess(H.debug);
            restored2.recordAccess(H.review);
            const predB = restored2.predict();
            expect(predB).not.toBeNull();
            expect(predB!.predicted).toBe(H.rollback);
        });

        it('preserves all order levels', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });
            for (let i = 0; i < 10; i++) {
                ppm.train([H.setup, H.review, H.deploy, H.monitor]);
            }

            const restored = roundTrip(ppm);

            // Order 3
            restored.recordAccess(H.setup);
            restored.recordAccess(H.review);
            restored.recordAccess(H.deploy);
            const pred3 = restored.predict();
            expect(pred3).not.toBeNull();
            expect(pred3!.order).toBe(3);
            expect(pred3!.predicted).toBe(H.monitor);
        });
    });

    describe('serialization format', () => {

        it('uses ppm: key prefix', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            const entries = ppm.serialize();

            for (const key of entries.keys()) {
                expect(key.startsWith('ppm:')).toBe(true);
            }
        });

        it('root is stored under ppm: key', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            const entries = ppm.serialize();
            expect(entries.has('ppm:')).toBe(true);
        });

        it('values are valid JSON with count and children', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            const entries = ppm.serialize();

            for (const value of entries.values()) {
                const parsed = JSON.parse(value);
                expect(typeof parsed.count).toBe('number');
                expect(Array.isArray(parsed.children)).toBe(true);
            }
        });

        it('context paths use / separator', () => {
            const ppm = new PpmModel({ maxOrder: 2 });
            ppm.train([H.setup, H.review, H.deploy]);
            const entries = ppm.serialize();

            // Should have keys like ppm:, ppm:<hash>, ppm:<hash>/<hash>
            const depths = Array.from(entries.keys()).map(k => {
                const path = k.slice(4);
                return path === '' ? 0 : path.split('/').length;
            });
            expect(depths).toContain(0); // root
            expect(depths).toContain(1); // order-1 context
            expect(depths).toContain(2); // order-2 context
        });
    });

    describe('verify', () => {

        it('clean trie passes verification', () => {
            const ppm = new PpmModel({ maxOrder: 3 });
            for (let i = 0; i < 5; i++) {
                ppm.train([H.setup, H.review, H.deploy, H.monitor]);
            }
            const restored = roundTrip(ppm);
            const warnings = restored.verify();
            expect(warnings).toHaveLength(0);
        });

        it('detects negative count corruption', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);

            const entries = ppm.serialize();
            // Corrupt an entry with a negative count
            const keys = Array.from(entries.keys()).filter(k => k !== 'ppm:');
            if (keys.length > 0) {
                const key = keys[0];
                const parsed = JSON.parse(entries.get(key)!);
                parsed.count = -5;
                entries.set(key, JSON.stringify(parsed));
            }

            const corrupted = new PpmModel();
            corrupted.deserialize(entries);
            const warnings = corrupted.verify();
            expect(warnings.length).toBeGreaterThan(0);
            expect(warnings.some(w => w.includes('Negative count'))).toBe(true);
        });

        it('detects suspiciously large count', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);

            const entries = ppm.serialize();
            const keys = Array.from(entries.keys()).filter(k => k !== 'ppm:');
            if (keys.length > 0) {
                const key = keys[0];
                const parsed = JSON.parse(entries.get(key)!);
                parsed.count = 2e9;
                entries.set(key, JSON.stringify(parsed));
            }

            const corrupted = new PpmModel();
            corrupted.deserialize(entries);
            const warnings = corrupted.verify();
            expect(warnings.length).toBeGreaterThan(0);
            expect(warnings.some(w => w.includes('Suspiciously large count'))).toBe(true);
        });
    });

    describe('prune', () => {

        it('prunes least-used branches when over maxNodes', () => {
            const ppm = new PpmModel({ maxOrder: 2, maxNodes: 10 });

            // Train many sequences to create more than 10 nodes
            const hashes = Object.values(H);
            for (let i = 0; i < hashes.length - 1; i++) {
                ppm.train([hashes[i], hashes[i + 1]]);
            }
            // Also train cross-pairs
            for (let i = 0; i < hashes.length - 2; i++) {
                ppm.train([hashes[i], hashes[i + 1], hashes[i + 2]]);
            }

            const beforeCount = ppm.getStats().nodeCount;
            const pruned = ppm.prune();

            if (beforeCount > 10) {
                expect(pruned).toBeGreaterThan(0);
                // Target is 90% of maxNodes = 9
                const afterCount = ppm.getStats().nodeCount;
                expect(afterCount).toBeLessThan(beforeCount);
                // Should be at or below maxNodes (iterative pruning converges)
                expect(afterCount).toBeLessThanOrEqual(10);
            }
        });

        it('does not prune when under maxNodes', () => {
            const ppm = new PpmModel({ maxOrder: 2, maxNodes: 100000 });
            ppm.train([H.setup, H.review, H.deploy]);
            expect(ppm.prune()).toBe(0);
        });

        it('sets dirty flag after pruning', () => {
            const ppm = new PpmModel({ maxOrder: 2, maxNodes: 5 });
            // Generate enough nodes
            const hashes = Object.values(H);
            for (let i = 0; i < hashes.length - 1; i++) {
                ppm.train([hashes[i], hashes[i + 1]]);
            }
            ppm.serialize(); // clear dirty
            expect(ppm.dirty).toBe(false);

            const pruned = ppm.prune();
            if (pruned > 0) {
                expect(ppm.dirty).toBe(true);
            }
        });
    });

    describe('dirty flag lifecycle', () => {

        it('starts clean', () => {
            const ppm = new PpmModel();
            expect(ppm.dirty).toBe(false);
        });

        it('becomes dirty on train()', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            expect(ppm.dirty).toBe(true);
        });

        it('clears on clear()', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            ppm.clear();
            expect(ppm.dirty).toBe(false);
        });

        it('clears on serialize()', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            ppm.serialize();
            expect(ppm.dirty).toBe(false);
        });

        it('does not become dirty on recordAccess()', () => {
            const ppm = new PpmModel();
            ppm.recordAccess(H.setup);
            expect(ppm.dirty).toBe(false);
        });

        it('does not become dirty on predict()', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review]);
            ppm.serialize(); // clear dirty
            ppm.recordAccess(H.setup);
            ppm.predict();
            expect(ppm.dirty).toBe(false);
        });
    });
});
