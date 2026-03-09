/**
 * PPM — Prediction by Partial Matching (Variable-Order Markov)
 *
 * Extends the fixed first-order Markov model with variable-length context.
 * When the user accesses atoms in a sequence [A, B, C], PPM stores:
 *   - order-1: C → prediction
 *   - order-2: B,C → prediction
 *   - order-3: A,B,C → prediction
 *
 * During prediction, the highest-order context that has been observed is
 * used first.  If it doesn't have a confident prediction, we "escape" to
 * lower orders (PPM-C style blending).
 *
 * Key design: the PPM model is per-shard and purely in-memory.  It does NOT
 * replace the existing first-order Markov model (which is persisted in
 * LevelDB) — it augments it.  On server restart, the PPM model is empty
 * and rebuilds as sequences are trained.
 *
 * Reference: Cleary & Teahan (1997), "Unbounded Length Contexts for PPM",
 * The Computer Journal 40(2/3):67–75.
 */

export interface PpmOptions {
    /** Maximum context order.  Default 3. */
    maxOrder?: number;
    /** Minimum confidence (0–1) for a high-order prediction to be used
     *  instead of escaping to a lower order.  Default 0.3. */
    escapeThreshold?: number;
}

export interface PpmPrediction {
    /** The predicted next atom hash. */
    predicted: string;
    /** The context order that produced this prediction (1 = first-order). */
    order: number;
    /** Confidence: count of this context→predicted / total count from this context. */
    confidence: number;
}

/**
 * A trie node in the PPM context tree.
 * Children are keyed by atom hash (the next symbol in the context).
 */
interface ContextNode {
    /** Total number of sequences that have traversed this node. */
    count: number;
    /** Child nodes keyed by next-atom hash. */
    children: Map<string, ContextNode>;
}

export class PpmModel {
    private readonly maxOrder: number;
    private readonly escapeThreshold: number;

    /** Root of the context trie.  Root's children are order-0 (unigram). */
    private readonly root: ContextNode = { count: 0, children: new Map() };

    /** Recent access history for building context during prediction. */
    private readonly history: string[] = [];
    private readonly historyMaxLen: number;

    constructor(options?: PpmOptions) {
        this.maxOrder = options?.maxOrder ?? 3;
        this.escapeThreshold = options?.escapeThreshold ?? 0.3;
        // Keep enough history for the highest-order context + 1 (the predicted symbol)
        this.historyMaxLen = this.maxOrder + 1;
    }

    /**
     * Train the model on a sequence of atom hashes.
     *
     * For a sequence [A, B, C, D], this records:
     *   - order-1: A→B, B→C, C→D
     *   - order-2: (A,B)→C, (B,C)→D
     *   - order-3: (A,B,C)→D
     *
     * Call this with the same sequences passed to the Markov trainer.
     */
    train(sequence: string[]): void {
        if (sequence.length < 2) return;

        for (let i = 1; i < sequence.length; i++) {
            const target = sequence[i];
            // Record contexts of all orders up to maxOrder
            for (let order = 1; order <= Math.min(this.maxOrder, i); order++) {
                const context = sequence.slice(i - order, i);
                this.recordContext(context, target);
            }
        }
    }

    /**
     * Record a context→target observation in the trie.
     */
    private recordContext(context: string[], target: string): void {
        let node = this.root;
        // Walk down the context path
        for (const symbol of context) {
            if (!node.children.has(symbol)) {
                node.children.set(symbol, { count: 0, children: new Map() });
            }
            node = node.children.get(symbol)!;
        }
        // Record the target prediction at this context
        node.count++;
        if (!node.children.has(target)) {
            node.children.set(target, { count: 0, children: new Map() });
        }
        node.children.get(target)!.count++;
    }

    /**
     * Record an atom access in the running history.
     * Call this every time an atom is accessed, before calling predict().
     */
    recordAccess(atomHash: string): void {
        this.history.push(atomHash);
        if (this.history.length > this.historyMaxLen) {
            this.history.shift();
        }
    }

    /**
     * Predict the next atom using the longest available context.
     *
     * Uses PPM-C escape: starts from the highest order with enough history,
     * and falls through to lower orders if confidence is below threshold.
     *
     * @param tombstoned  Set of atom hashes that are tombstoned (excluded from predictions).
     * @returns The prediction with order and confidence, or null if no prediction.
     */
    predict(tombstoned?: Set<string>): PpmPrediction | null {
        if (this.history.length === 0) return null;

        // Try from highest order down to 1
        const maxCtx = Math.min(this.maxOrder, this.history.length);
        for (let order = maxCtx; order >= 1; order--) {
            const context = this.history.slice(-order);
            const prediction = this.predictFromContext(context, tombstoned);
            if (prediction && prediction.confidence >= this.escapeThreshold) {
                return { ...prediction, order };
            }
        }

        // Fallback: return best prediction even below threshold (order-1)
        if (this.history.length > 0) {
            const context = this.history.slice(-1);
            const prediction = this.predictFromContext(context, tombstoned);
            if (prediction) {
                return { ...prediction, order: 1 };
            }
        }

        return null;
    }

    /**
     * Predict from a specific context by looking up the trie.
     */
    private predictFromContext(context: string[], tombstoned?: Set<string>): Omit<PpmPrediction, 'order'> | null {
        let node = this.root;
        for (const symbol of context) {
            const child = node.children.get(symbol);
            if (!child) return null;
            node = child;
        }

        // node.children now holds the predictions from this context
        if (node.children.size === 0 || node.count === 0) return null;

        let bestHash: string | null = null;
        let bestCount = 0;
        let totalCount = 0;

        for (const [hash, child] of node.children) {
            if (tombstoned?.has(hash)) continue;
            totalCount += child.count;
            if (child.count > bestCount) {
                bestCount = child.count;
                bestHash = hash;
            }
        }

        if (!bestHash || totalCount === 0) return null;

        return {
            predicted: bestHash,
            confidence: bestCount / totalCount,
        };
    }

    /**
     * Get the current context history (for diagnostics).
     */
    getHistory(): ReadonlyArray<string> {
        return this.history;
    }

    /**
     * Get model statistics.
     */
    getStats(): { maxOrder: number; escapeThreshold: number; nodeCount: number; historyLength: number } {
        let nodeCount = 0;
        const countNodes = (node: ContextNode) => {
            nodeCount++;
            for (const child of node.children.values()) {
                countNodes(child);
            }
        };
        countNodes(this.root);
        return {
            maxOrder: this.maxOrder,
            escapeThreshold: this.escapeThreshold,
            nodeCount,
            historyLength: this.history.length,
        };
    }

    /** Reset the model (clear all trained contexts and history). */
    clear(): void {
        this.root.count = 0;
        this.root.children.clear();
        this.history.length = 0;
    }
}
