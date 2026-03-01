import { Hash } from './types';

export class SparseTransitionMatrix {
    private transitions: Map<Hash, Map<Hash, number>> = new Map();

    recordTransition(from: Hash, to: Hash, weight: number = 1): void {
        if (!this.transitions.has(from)) {
            this.transitions.set(from, new Map());
        }
        const targets = this.transitions.get(from)!;
        targets.set(to, (targets.get(to) || 0) + weight);
    }

    predictNext(from: Hash, topK: number = 1): Hash[] {
        const targets = this.transitions.get(from);
        if (!targets) return [];

        if (topK === 1) {
            // O(K) linear scan — avoids allocating a sorted array for the most common case.
            // K = out-degree of `from` (number of known successor states).
            let bestHash: Hash | null = null;
            let bestWeight = -Infinity;
            for (const [hash, weight] of targets) {
                if (weight > bestWeight) { bestWeight = weight; bestHash = hash; }
            }
            return bestHash ? [bestHash] : [];
        }

        // O(K log K) sort for multi-candidate requests
        return Array.from(targets.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([hash]) => hash);
    }

    /**
     * Multiply all transition weights by `factor` (0–1) to decay old patterns.
     * Weights that drop below `minWeight` are pruned.
     */
    decay(factor: number = 0.9, minWeight: number = 0.1): void {
        for (const [from, targets] of this.transitions) {
            for (const [to, weight] of targets) {
                const next = weight * factor;
                if (next < minWeight) {
                    targets.delete(to);
                } else {
                    targets.set(to, next);
                }
            }
            if (targets.size === 0) this.transitions.delete(from);
        }
    }

    /**
     * Export all transitions as a serialisable array for backup or inspection.
     */
    export(): Array<{ from: Hash; to: Hash; weight: number }> {
        const result: Array<{ from: Hash; to: Hash; weight: number }> = [];
        for (const [from, targets] of this.transitions) {
            for (const [to, weight] of targets) {
                result.push({ from, to, weight });
            }
        }
        return result;
    }

    /**
     * Return counts of trained atoms and edges for cluster-level monitoring.
     * O(atoms) — reads only Map sizes, no iteration over edge lists.
     */
    getStats(): { trainedAtoms: number; totalEdges: number } {
        let totalEdges = 0;
        for (const targets of this.transitions.values()) {
            totalEdges += targets.size;
        }
        return { trainedAtoms: this.transitions.size, totalEdges };
    }

    /**
     * Return all outgoing transitions for a single hash as a plain Map.
     * Read-only — shares the internal Map reference; caller must not mutate.
     * Returns undefined if the hash has no recorded transitions.
     */
    getTransitions(from: Hash): ReadonlyMap<Hash, number> | undefined {
        return this.transitions.get(from);
    }

    /**
     * Import transitions from a previously exported array, merging with any
     * existing weights.
     */
    import(entries: Array<{ from: Hash; to: Hash; weight: number }>): void {
        for (const { from, to, weight } of entries) {
            this.recordTransition(from, to, weight);
        }
    }
}