import { describe, it, expect } from 'vitest';
import { SparseTransitionMatrix } from '../matrix';

describe('SparseTransitionMatrix', () => {
    it('returns empty predictions for unknown state', () => {
        const m = new SparseTransitionMatrix();
        expect(m.predictNext('unknown')).toEqual([]);
    });

    it('records a transition and predicts it', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('A', 'B');
        expect(m.predictNext('A')).toEqual(['B']);
    });

    it('accumulates weights', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('A', 'B', 1);
        m.recordTransition('A', 'B', 1);
        m.recordTransition('A', 'C', 1);
        // B has weight 2, C has weight 1 — B should be predicted first
        expect(m.predictNext('A', 2)).toEqual(['B', 'C']);
    });

    it('respects custom weight', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('X', 'Y', 10);
        m.recordTransition('X', 'Z', 1);
        expect(m.predictNext('X', 1)).toEqual(['Y']);
    });

    it('returns topK results', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('A', 'B', 3);
        m.recordTransition('A', 'C', 2);
        m.recordTransition('A', 'D', 1);
        expect(m.predictNext('A', 2)).toEqual(['B', 'C']);
    });

    it('handles multiple source states independently', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('A', 'B');
        m.recordTransition('C', 'D');
        expect(m.predictNext('A')).toEqual(['B']);
        expect(m.predictNext('C')).toEqual(['D']);
    });

    it('decay() reduces weights and prunes below minWeight', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('A', 'B', 1);
        m.recordTransition('A', 'C', 10);
        m.decay(0.5, 0.6); // 1 * 0.5 = 0.5 → pruned, 10 * 0.5 = 5 → kept
        expect(m.predictNext('A')).toEqual(['C']);
    });

    it('export() returns all transitions', () => {
        const m = new SparseTransitionMatrix();
        m.recordTransition('X', 'Y', 3);
        m.recordTransition('X', 'Z', 1);
        const entries = m.export();
        expect(entries.length).toBe(2);
        expect(entries.find(e => e.from === 'X' && e.to === 'Y')?.weight).toBe(3);
    });

    it('import() merges transitions', () => {
        const m = new SparseTransitionMatrix();
        m.import([{ from: 'A', to: 'B', weight: 5 }]);
        expect(m.predictNext('A')).toEqual(['B']);
    });

    it('export/import round-trips correctly', () => {
        const m1 = new SparseTransitionMatrix();
        m1.recordTransition('A', 'B', 7);
        m1.recordTransition('C', 'D', 2);

        const m2 = new SparseTransitionMatrix();
        m2.import(m1.export());
        expect(m2.export()).toEqual(expect.arrayContaining(m1.export()));
    });
});