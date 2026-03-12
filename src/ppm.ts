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
 * Sprint 13: The trie is now persisted to LevelDB on commit and restored
 * on init, so PPM predictions survive server restarts.
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
    /** Maximum number of trie nodes before pruning kicks in.  Default 100_000. */
    maxNodes?: number;
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
 * Serialized form of one PPM trie node, stored under key `ppm:<context_path>`.
 * Children list contains only the hash keys, not full subtrees — the trie
 * structure is implicit in the LevelDB key hierarchy.
 */
export interface SerializedPpmNode {
    count: number;
    children: string[];
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
    private readonly maxNodes: number;

    /** Root of the context trie.  Root's children are order-0 (unigram). */
    private readonly root: ContextNode = { count: 0, children: new Map() };

    /** Recent access history for building context during prediction. */
    private readonly history: string[] = [];
    private readonly historyMaxLen: number;

    /** Dirty flag: set when the trie has been modified since last serialize. */
    private _dirty = false;

    constructor(options?: PpmOptions) {
        this.maxOrder = options?.maxOrder ?? 3;
        this.escapeThreshold = options?.escapeThreshold ?? 0.3;
        this.maxNodes = options?.maxNodes ?? 100_000;
        // Keep enough history for the highest-order context + 1 (the predicted symbol)
        this.historyMaxLen = this.maxOrder + 1;
    }

    /** Whether the trie has been modified since the last serialize/clear/deserialize. */
    get dirty(): boolean { return this._dirty; }

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
        this._dirty = true;
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
        return {
            maxOrder: this.maxOrder,
            escapeThreshold: this.escapeThreshold,
            nodeCount: this.countNodes(),
            historyLength: this.history.length,
        };
    }

    /** Count total trie nodes (root included). */
    private countNodes(): number {
        let count = 0;
        const walk = (node: ContextNode) => {
            count++;
            for (const child of node.children.values()) walk(child);
        };
        walk(this.root);
        return count;
    }

    /** Reset the model (clear all trained contexts and history). */
    clear(): void {
        this.root.count = 0;
        this.root.children.clear();
        this.history.length = 0;
        this._dirty = false;
    }

    // ─── Serialization (Sprint 13) ──────────────────────────────────────

    /**
     * Serialize the trie to a flat key-value map suitable for LevelDB storage.
     *
     * Each trie node becomes one entry:
     *   key:   `ppm:<context_path>` where context_path is hash keys joined by `/`
     *   value: JSON `{ "count": N, "children": ["hash1", "hash2", ...] }`
     *
     * The root is stored under key `ppm:` (empty context path).
     *
     * Resets the dirty flag on completion.
     */
    serialize(): Map<string, string> {
        const entries = new Map<string, string>();
        const walk = (node: ContextNode, path: string) => {
            const childKeys = Array.from(node.children.keys());
            const value: SerializedPpmNode = { count: node.count, children: childKeys };
            entries.set(path, JSON.stringify(value));
            for (const [key, child] of node.children) {
                walk(child, path === 'ppm:' ? `ppm:${key}` : `${path}/${key}`);
            }
        };
        walk(this.root, 'ppm:');
        this._dirty = false;
        return entries;
    }

    /**
     * Deserialize the trie from a flat key-value map (as produced by serialize()).
     *
     * Clears the existing trie first. If the data is empty, the model is left
     * in a clean empty state. After successful deserialization the dirty flag
     * is false.
     *
     * Entries with keys that don't start with `ppm:` are silently ignored.
     */
    deserialize(entries: Map<string, string>): void {
        this.clear();
        if (entries.size === 0) return;

        // Parse all entries first
        const parsed = new Map<string, SerializedPpmNode>();
        for (const [key, value] of entries) {
            if (!key.startsWith('ppm:')) continue;
            try {
                const node = JSON.parse(value) as SerializedPpmNode;
                if (typeof node.count !== 'number' || !Array.isArray(node.children)) {
                    continue; // skip malformed entries
                }
                parsed.set(key, node);
            } catch {
                continue; // skip unparseable entries
            }
        }

        if (parsed.size === 0) return;

        // Rebuild the trie top-down.  For each parsed entry, walk the key path
        // to find or create the target node, then set its count.
        // We process entries sorted by key length (shorter paths first) to ensure
        // parent nodes exist before children.
        const sortedKeys = Array.from(parsed.keys()).sort((a, b) => a.length - b.length);

        for (const key of sortedKeys) {
            const nodeData = parsed.get(key)!;
            const pathStr = key.slice(4); // strip "ppm:" prefix
            const node = this.ensureNode(pathStr);
            node.count = nodeData.count;
            // Ensure child placeholder nodes exist (they'll get their counts
            // when their own keys are processed)
            for (const childKey of nodeData.children) {
                if (!node.children.has(childKey)) {
                    node.children.set(childKey, { count: 0, children: new Map() });
                }
            }
        }

        this._dirty = false;
    }

    /**
     * Walk from root to the node at the given slash-separated path,
     * creating intermediate nodes as needed.  Empty path returns root.
     */
    private ensureNode(path: string): ContextNode {
        if (path === '') return this.root;
        const segments = path.split('/');
        let node = this.root;
        for (const seg of segments) {
            if (!node.children.has(seg)) {
                node.children.set(seg, { count: 0, children: new Map() });
            }
            node = node.children.get(seg)!;
        }
        return node;
    }

    /**
     * Verify trie integrity after deserialization.
     *
     * Checks:
     *   1. Max depth does not exceed maxOrder + 1 (root is depth 0,
     *      leaf predictions are at depth maxOrder + 1).
     *   2. Negative counts indicate corruption.
     *   3. Extremely large counts (> 1e9) suggest corruption.
     *
     * Note: we do NOT check parent.count >= sum(child.count) because
     * children in this trie accumulate count from two sources — being
     * prediction targets AND context nodes for deeper paths.  A child's
     * count legitimately exceeds its parent's.
     *
     * @returns Array of warning messages.  Empty means the trie is healthy.
     *          If corruption is found, the caller should clear() the model
     *          and log the warnings (graceful degradation).
     */
    verify(): string[] {
        const warnings: string[] = [];
        const maxDepth = this.maxOrder + 1; // root(0) → context(1..maxOrder) → prediction(maxOrder+1)

        const walk = (node: ContextNode, depth: number, path: string) => {
            if (depth > maxDepth) {
                warnings.push(`Depth ${depth} exceeds maxOrder+1=${maxDepth} at path ${path || 'root'}`);
                return;
            }

            if (node.count < 0) {
                warnings.push(`Negative count ${node.count} at ${path || 'root'}`);
            }
            if (node.count > 1e9) {
                warnings.push(`Suspiciously large count ${node.count} at ${path || 'root'}`);
            }

            for (const [key, child] of node.children) {
                walk(child, depth + 1, path ? `${path}/${key}` : key);
            }
        };

        walk(this.root, 0, '');
        return warnings;
    }

    /**
     * Prune the trie to stay within maxNodes.
     *
     * Strategy: iteratively collect leaf nodes (no children), sort by count
     * ascending, and remove the lowest-count leaves until nodeCount <= target.
     * After each round of leaf removal, previously-inner nodes may become
     * new leaves, so we repeat until under the target or no progress is made.
     *
     * Called automatically during persistPpmTrie if the node count exceeds maxNodes.
     *
     * @returns Number of nodes pruned.
     */
    prune(): number {
        let remaining = this.countNodes();
        if (remaining <= this.maxNodes) return 0;
        const target = Math.floor(this.maxNodes * 0.9); // prune to 90% to avoid thrashing
        let totalPruned = 0;

        // Iterate: each pass removes leaves, potentially exposing new leaves
        while (remaining > target) {
            const candidates: Array<{ parent: ContextNode; key: string; count: number }> = [];

            const collectLeaves = (node: ContextNode) => {
                for (const [key, child] of node.children) {
                    if (child.children.size === 0) {
                        candidates.push({ parent: node, key, count: child.count });
                    } else {
                        collectLeaves(child);
                    }
                }
            };
            collectLeaves(this.root);

            if (candidates.length === 0) break; // nothing left to prune

            // Sort by count ascending — prune least-used first
            candidates.sort((a, b) => a.count - b.count);

            let prunedThisRound = 0;
            for (const c of candidates) {
                if (remaining <= target) break;
                // Verify the parent still has this child (may have been removed
                // if parent was pruned in a prior candidate from same round)
                if (c.parent.children.has(c.key)) {
                    c.parent.children.delete(c.key);
                    prunedThisRound++;
                    remaining--;
                }
            }

            if (prunedThisRound === 0) break; // no progress — avoid infinite loop
            totalPruned += prunedThisRound;
        }

        if (totalPruned > 0) this._dirty = true;
        return totalPruned;
    }
}
