import { describe, it, expect } from 'vitest';
import { CsrTransitionMatrix } from '../csr_matrix';

describe('CsrTransitionMatrix', () => {
    it('build() from empty transitions yields all -1 topPrediction', () => {
        const matrix = CsrTransitionMatrix.build(new Map(), new Map(), 4);
        expect(matrix.atomCount).toBe(4);
        expect(matrix.edgeCount).toBe(0);
        expect(Array.from(matrix.topPrediction)).toEqual([-1, -1, -1, -1]);
        expect(matrix.rowPtr.length).toBe(5);
        expect(matrix.rowPtr[4]).toBe(0);
    });

    it('build() single edge sets topPrediction and edgeCount', () => {
        const transitions = new Map<number, Map<string, number>>([
            [0, new Map([['hB', 3]])],
        ]);
        const hashToIndex = new Map<string, number>([['hB', 1]]);
        const matrix = CsrTransitionMatrix.build(transitions, hashToIndex, 2);

        expect(matrix.edgeCount).toBe(1);
        expect(matrix.getTopPrediction(0)).toBe(1);
        expect(matrix.getEdges(0)).toEqual([{ toIdx: 1, weight: 3 }]);
    });

    it('build() sorts row edges by descending weight', () => {
        const transitions = new Map<number, Map<string, number>>([
            [0, new Map([['hB', 2], ['hC', 7], ['hD', 5]])],
        ]);
        const hashToIndex = new Map<string, number>([
            ['hB', 1],
            ['hC', 2],
            ['hD', 3],
        ]);
        const matrix = CsrTransitionMatrix.build(transitions, hashToIndex, 4);
        expect(matrix.getEdges(0)).toEqual([
            { toIdx: 2, weight: 7 },
            { toIdx: 3, weight: 5 },
            { toIdx: 1, weight: 2 },
        ]);
        expect(matrix.getTopPrediction(0)).toBe(2);
    });

    it('getEdges() returns correct slices per atom', () => {
        const transitions = new Map<number, Map<string, number>>([
            [0, new Map([['hB', 4]])],
            [2, new Map([['hA', 6], ['hD', 2]])],
        ]);
        const hashToIndex = new Map<string, number>([
            ['hA', 0],
            ['hB', 1],
            ['hD', 3],
        ]);
        const matrix = CsrTransitionMatrix.build(transitions, hashToIndex, 4);

        expect(matrix.getEdges(0)).toEqual([{ toIdx: 1, weight: 4 }]);
        expect(matrix.getEdges(1)).toEqual([]);
        expect(matrix.getEdges(2)).toEqual([
            { toIdx: 0, weight: 6 },
            { toIdx: 3, weight: 2 },
        ]);
        expect(matrix.getEdges(3)).toEqual([]);
    });

    it('build() skips unresolved toHash entries', () => {
        const transitions = new Map<number, Map<string, number>>([
            [0, new Map([['hKnown', 2], ['hMissing', 9]])],
        ]);
        const hashToIndex = new Map<string, number>([['hKnown', 1]]);
        const matrix = CsrTransitionMatrix.build(transitions, hashToIndex, 3);

        expect(matrix.edgeCount).toBe(1);
        expect(matrix.getEdges(0)).toEqual([{ toIdx: 1, weight: 2 }]);
        expect(matrix.getTopPrediction(0)).toBe(1);
    });

    it('getTopPrediction() returns -1 for no edges and out-of-range indices', () => {
        const matrix = CsrTransitionMatrix.empty(3);
        expect(matrix.getTopPrediction(0)).toBe(-1);
        expect(matrix.getTopPrediction(99)).toBe(-1);
        expect(matrix.getTopPrediction(-1)).toBe(-1);
    });

    it('getEdges() returns empty for untrained atom', () => {
        const matrix = CsrTransitionMatrix.empty(2);
        expect(matrix.getEdges(0)).toEqual([]);
    });

    it('static empty() creates zero-edge matrix with sentinel rowPtr', () => {
        const matrix = CsrTransitionMatrix.empty(5);
        expect(matrix.edgeCount).toBe(0);
        expect(matrix.cols.length).toBe(0);
        expect(matrix.weights.length).toBe(0);
        expect(matrix.rowPtr.length).toBe(6);
        expect(matrix.rowPtr[5]).toBe(0);
        expect(Array.from(matrix.topPrediction)).toEqual([-1, -1, -1, -1, -1]);
    });

    it('edgeCount equals total resolved edges and rowPtr sentinel equals edgeCount', () => {
        const transitions = new Map<number, Map<string, number>>([
            [0, new Map([['h1', 1], ['h2', 2]])],
            [1, new Map([['h2', 4]])],
            [3, new Map([['h0', 3], ['hX', 8]])],
        ]);
        const hashToIndex = new Map<string, number>([
            ['h0', 0],
            ['h1', 1],
            ['h2', 2],
        ]);
        const matrix = CsrTransitionMatrix.build(transitions, hashToIndex, 4);
        expect(matrix.edgeCount).toBe(4); // hX unresolved and skipped
        expect(matrix.rowPtr[4]).toBe(matrix.edgeCount);
    });
});
