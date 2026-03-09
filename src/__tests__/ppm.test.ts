import { describe, it, expect } from 'vitest';
import { PpmModel } from '../ppm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a real MMPM workflow: hash-like strings representing atom leaf hashes. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PpmModel — Variable-Order Markov', () => {

    describe('basic training and prediction', () => {
        it('predicts the next atom in a trained sequence', () => {
            const ppm = new PpmModel({ maxOrder: 3 });
            // Train: setup → review → deploy → monitor
            ppm.train([H.setup, H.review, H.deploy, H.monitor]);

            // Simulate accessing setup, then review, then deploy
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            ppm.recordAccess(H.deploy);

            const prediction = ppm.predict();
            expect(prediction).not.toBeNull();
            expect(prediction!.predicted).toBe(H.monitor);
            expect(prediction!.order).toBeGreaterThanOrEqual(1);
        });

        it('returns null for untrained model', () => {
            const ppm = new PpmModel();
            ppm.recordAccess(H.setup);
            expect(ppm.predict()).toBeNull();
        });

        it('returns null with empty history', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review, H.deploy]);
            expect(ppm.predict()).toBeNull();
        });
    });

    describe('higher-order context improves predictions', () => {
        it('distinguishes branching sequences using context', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });

            // Train two different sequences that diverge after "review"
            // Path A: setup → review → deploy (repeated 5 times for confidence)
            // Path B: debug → review → rollback (repeated 5 times)
            for (let i = 0; i < 5; i++) {
                ppm.train([H.setup, H.review, H.deploy]);
                ppm.train([H.debug, H.review, H.rollback]);
            }

            // Context: setup → review → should predict deploy (not rollback)
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            const predA = ppm.predict();
            expect(predA).not.toBeNull();
            expect(predA!.predicted).toBe(H.deploy);
            expect(predA!.order).toBe(2); // uses order-2 context (setup, review)
        });

        it('uses order-3 context when available', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });

            // Train a specific 4-step sequence multiple times
            for (let i = 0; i < 5; i++) {
                ppm.train([H.setup, H.review, H.deploy, H.monitor]);
            }
            // Also train a competing order-2 path
            for (let i = 0; i < 3; i++) {
                ppm.train([H.fix, H.deploy, H.rollback]);
            }

            // Access: setup → review → deploy
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            ppm.recordAccess(H.deploy);

            const pred = ppm.predict();
            expect(pred).not.toBeNull();
            // Order-3 context (setup, review, deploy) → monitor with high confidence
            expect(pred!.predicted).toBe(H.monitor);
            expect(pred!.order).toBe(3);
        });
    });

    describe('escape to lower orders', () => {
        it('escapes to order-1 when higher orders have no data', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });

            // Only train order-1 transitions
            for (let i = 0; i < 5; i++) {
                ppm.train([H.deploy, H.monitor]);
            }

            // Access with a different prefix context
            ppm.recordAccess(H.debug);
            ppm.recordAccess(H.fix);
            ppm.recordAccess(H.deploy);

            const pred = ppm.predict();
            expect(pred).not.toBeNull();
            expect(pred!.predicted).toBe(H.monitor);
            expect(pred!.order).toBe(1); // escaped to order-1
        });
    });

    describe('tombstone filtering', () => {
        it('excludes tombstoned atoms from predictions', () => {
            const ppm = new PpmModel({ maxOrder: 2 });

            // Train: A → B, A → C (equal weight)
            for (let i = 0; i < 3; i++) {
                ppm.train([H.setup, H.review]);
                ppm.train([H.setup, H.deploy]);
            }

            ppm.recordAccess(H.setup);

            // With review tombstoned, should predict deploy
            const tombstoned = new Set([H.review]);
            const pred = ppm.predict(tombstoned);
            expect(pred).not.toBeNull();
            expect(pred!.predicted).toBe(H.deploy);
        });

        it('returns null when all candidates are tombstoned', () => {
            const ppm = new PpmModel({ maxOrder: 2 });
            ppm.train([H.setup, H.review]);
            ppm.recordAccess(H.setup);

            const tombstoned = new Set([H.review]);
            const pred = ppm.predict(tombstoned);
            expect(pred).toBeNull();
        });
    });

    describe('history management', () => {
        it('maintains history up to maxOrder + 1 length', () => {
            const ppm = new PpmModel({ maxOrder: 3 });
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            ppm.recordAccess(H.deploy);
            ppm.recordAccess(H.monitor);
            ppm.recordAccess(H.rollback); // 5th access — should trim to 4

            expect(ppm.getHistory()).toHaveLength(4); // maxOrder + 1
            // Oldest access (setup) should have been evicted
            expect(ppm.getHistory()[0]).toBe(H.review);
        });
    });

    describe('custom parameters', () => {
        it('maxOrder=1 behaves like first-order Markov', () => {
            const ppm = new PpmModel({ maxOrder: 1 });
            ppm.train([H.setup, H.review, H.deploy]);
            ppm.recordAccess(H.review);

            const pred = ppm.predict();
            expect(pred).not.toBeNull();
            expect(pred!.predicted).toBe(H.deploy);
            expect(pred!.order).toBe(1);
        });

        it('high escapeThreshold forces escape to lower orders', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.99 });

            // Train ambiguous higher-order: 50/50 split
            ppm.train([H.setup, H.review, H.deploy]);
            ppm.train([H.setup, H.review, H.rollback]);

            // But unambiguous order-1: review → deploy (3 more trainings)
            for (let i = 0; i < 3; i++) {
                ppm.train([H.review, H.deploy]);
            }

            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);

            const pred = ppm.predict();
            expect(pred).not.toBeNull();
            // Order-2 has 50% confidence (below 0.99), escapes to order-1
            // Order-1 has 80% confidence for deploy (still below 0.99)
            // Falls through to the fallback return of order-1
            expect(pred!.order).toBe(1);
        });
    });

    describe('model statistics', () => {
        it('reports correct stats', () => {
            const ppm = new PpmModel({ maxOrder: 2 });
            ppm.train([H.setup, H.review, H.deploy]);

            const stats = ppm.getStats();
            expect(stats.maxOrder).toBe(2);
            expect(stats.nodeCount).toBeGreaterThan(1); // root + context nodes
            expect(stats.historyLength).toBe(0); // no accesses yet
        });
    });

    describe('clear', () => {
        it('resets all state', () => {
            const ppm = new PpmModel();
            ppm.train([H.setup, H.review, H.deploy]);
            ppm.recordAccess(H.setup);

            ppm.clear();
            expect(ppm.getStats().nodeCount).toBe(1); // just root
            expect(ppm.getHistory()).toHaveLength(0);
            expect(ppm.predict()).toBeNull();
        });
    });

    describe('real-world workflow simulation', () => {
        it('predicts multi-step deployment pipeline', () => {
            const ppm = new PpmModel({ maxOrder: 3, escapeThreshold: 0.3 });

            // Simulate a deployment pipeline repeated across sessions
            const pipeline = [H.setup, H.review, H.test, H.deploy, H.monitor];
            for (let i = 0; i < 10; i++) {
                ppm.train(pipeline);
            }

            // Simulate a new session accessing the first 3 steps
            ppm.recordAccess(H.setup);
            ppm.recordAccess(H.review);
            ppm.recordAccess(H.test);

            // Should predict deploy with high confidence
            const pred = ppm.predict();
            expect(pred).not.toBeNull();
            expect(pred!.predicted).toBe(H.deploy);
            expect(pred!.confidence).toBeGreaterThan(0.8);
            expect(pred!.order).toBe(3); // full 3-step context
        });
    });
});
