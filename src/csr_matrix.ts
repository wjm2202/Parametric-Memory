import { Hash } from './types';

export class CsrTransitionMatrix {
    readonly rowPtr: Int32Array;
    readonly cols: Int32Array;
    readonly weights: Int32Array;
    readonly topPrediction: Int32Array;
    readonly atomCount: number;
    readonly edgeCount: number;

    private constructor(
        rowPtr: Int32Array,
        cols: Int32Array,
        weights: Int32Array,
        topPrediction: Int32Array,
        atomCount: number,
        edgeCount: number,
    ) {
        this.rowPtr = rowPtr;
        this.cols = cols;
        this.weights = weights;
        this.topPrediction = topPrediction;
        this.atomCount = atomCount;
        this.edgeCount = edgeCount;
    }

    static empty(atomCount: number): CsrTransitionMatrix {
        const safeAtomCount = Math.max(0, atomCount | 0);
        const rowPtr = new Int32Array(safeAtomCount + 1);
        const topPrediction = new Int32Array(safeAtomCount);
        topPrediction.fill(-1);
        return new CsrTransitionMatrix(
            rowPtr,
            new Int32Array(0),
            new Int32Array(0),
            topPrediction,
            safeAtomCount,
            0,
        );
    }

    static build(
        transitions: Map<number, Map<Hash, number>>,
        hashToIndex: Map<Hash, number>,
        atomCount: number,
    ): CsrTransitionMatrix {
        const safeAtomCount = Math.max(0, atomCount | 0);
        if (safeAtomCount === 0) return CsrTransitionMatrix.empty(0);

        const rowPtr = new Int32Array(safeAtomCount + 1);
        const cols: number[] = [];
        const weights: number[] = [];
        const topPrediction = new Int32Array(safeAtomCount);
        topPrediction.fill(-1);

        let offset = 0;
        for (let atomIdx = 0; atomIdx < safeAtomCount; atomIdx++) {
            rowPtr[atomIdx] = offset;

            const row = transitions.get(atomIdx);
            if (!row || row.size === 0) continue;

            const resolvedEdges: Array<{ toIdx: number; weight: number }> = [];
            for (const [toHash, weight] of row) {
                const toIdx = hashToIndex.get(toHash);
                if (toIdx === undefined || toIdx < 0 || toIdx >= safeAtomCount) continue;
                resolvedEdges.push({ toIdx, weight });
            }

            if (resolvedEdges.length === 0) continue;

            resolvedEdges.sort((a, b) => {
                if (b.weight !== a.weight) return b.weight - a.weight;
                return a.toIdx - b.toIdx;
            });

            topPrediction[atomIdx] = resolvedEdges[0].toIdx;

            for (const edge of resolvedEdges) {
                cols.push(edge.toIdx);
                weights.push(edge.weight);
            }
            offset = cols.length;
        }

        rowPtr[safeAtomCount] = cols.length;
        return new CsrTransitionMatrix(
            rowPtr,
            Int32Array.from(cols),
            Int32Array.from(weights),
            topPrediction,
            safeAtomCount,
            cols.length,
        );
    }

    getTopPrediction(atomIdx: number): number {
        if (atomIdx < 0 || atomIdx >= this.atomCount) return -1;
        return this.topPrediction[atomIdx] ?? -1;
    }

    getEdges(atomIdx: number): Array<{ toIdx: number; weight: number }> {
        if (atomIdx < 0 || atomIdx >= this.atomCount) return [];
        const start = this.rowPtr[atomIdx];
        const end = this.rowPtr[atomIdx + 1];
        if (start === end) return [];

        const edges: Array<{ toIdx: number; weight: number }> = [];
        for (let i = start; i < end; i++) {
            edges.push({ toIdx: this.cols[i], weight: this.weights[i] });
        }
        return edges;
    }
}
