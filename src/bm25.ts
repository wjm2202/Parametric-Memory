/**
 * BM25 scoring for MMPM atom retrieval.
 *
 * Replaces the Jaccard token-overlap similarity with Okapi BM25, which adds:
 *   - IDF: rare tokens score higher than common ones
 *   - TF saturation: repeated tokens help, with diminishing returns (k1)
 *   - Length normalisation: short atoms aren't penalised (b)
 *
 * Reference: Robertson & Spärck Jones (2009), "The Probabilistic Relevance
 * Framework: BM25 and Beyond", Foundations and Trends in IR 3(4):333–389.
 */

/** Shared tokeniser — identical to the one in server.ts so atom names tokenise consistently. */
export function tokenizeText(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

export interface Bm25Options {
    /** Term-frequency saturation.  Higher → raw TF matters more.  Default 1.2. */
    k1?: number;
    /** Length normalisation.  0 = no penalty for long docs, 1 = full penalty.  Default 0.75. */
    b?: number;
}

/**
 * Precomputed BM25 index over a corpus of atom strings.
 *
 * Call `Bm25Index.build(atoms)` after each commit to refresh.  The index
 * stores per-token document frequency and average document length so that
 * `score()` runs in O(|query tokens|) per candidate — same asymptotic cost
 * as the old Jaccard but with much better ranking.
 */
export class Bm25Index {
    /** Number of documents (atoms) in corpus. */
    private N: number;
    /** Average document length in tokens. */
    private avgDl: number;
    /** Total token count across all documents (used to recompute avgDl). */
    private totalLength: number;
    /** Document frequency: token → number of documents containing it. */
    private readonly df: Map<string, number>;
    /** Per-document token bags: atom index → Map<token, count>. */
    private readonly docs: Map<number, { tokens: Map<string, number>; length: number }>;
    /** Atom string → index mapping for fast lookup. */
    private readonly atomIndex: Map<string, number>;
    /** Next auto-increment index for addDocument(). */
    private nextIdx: number;

    private readonly k1: number;
    private readonly b: number;

    private constructor(
        N: number,
        avgDl: number,
        totalLength: number,
        df: Map<string, number>,
        docs: Map<number, { tokens: Map<string, number>; length: number }>,
        atomIndex: Map<string, number>,
        nextIdx: number,
        k1: number,
        b: number,
    ) {
        this.N = N;
        this.avgDl = avgDl;
        this.totalLength = totalLength;
        this.df = df;
        this.docs = docs;
        this.atomIndex = atomIndex;
        this.nextIdx = nextIdx;
        this.k1 = k1;
        this.b = b;
    }

    /**
     * Build a BM25 index from a corpus of semantic texts.
     *
     * @param corpus  Array of {atom, semanticText} where semanticText is the
     *                same string previously passed to semanticSimilarityScore
     *                (e.g. `${type} ${value} ${atom}`).
     * @param opts    Optional BM25 tuning parameters.
     */
    static build(
        corpus: Array<{ atom: string; semanticText: string }>,
        opts: Bm25Options = {},
    ): Bm25Index {
        const k1 = opts.k1 ?? 1.2;
        const b = opts.b ?? 0.75;

        const N = corpus.length;
        const df = new Map<string, number>();
        const docs = new Map<number, { tokens: Map<string, number>; length: number }>();
        const atomIndex = new Map<string, number>();
        let totalLength = 0;

        for (let i = 0; i < N; i++) {
            const { atom, semanticText } = corpus[i];
            atomIndex.set(atom, i);

            const rawTokens = tokenizeText(semanticText);
            const tokenCounts = new Map<string, number>();
            for (const t of rawTokens) {
                tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
            }

            docs.set(i, { tokens: tokenCounts, length: rawTokens.length });
            totalLength += rawTokens.length;

            // Document frequency: count each unique token once per doc
            for (const t of tokenCounts.keys()) {
                df.set(t, (df.get(t) ?? 0) + 1);
            }
        }

        const avgDl = N > 0 ? totalLength / N : 0;
        return new Bm25Index(N, avgDl, totalLength, df, docs, atomIndex, N, k1, b);
    }

    /** Build an empty index (scores everything as 0). */
    static empty(opts: Bm25Options = {}): Bm25Index {
        return new Bm25Index(0, 0, 0, new Map(), new Map(), new Map(), 0, opts.k1 ?? 1.2, opts.b ?? 0.75);
    }

    // ─── Incremental updates (O(|tokens in atom|) per operation) ──────

    /**
     * Add a single document to the index incrementally.
     * Updates N, totalLength, avgDl, df, docs, and atomIndex.
     * O(|tokens in semanticText|) — no full corpus scan.
     *
     * If the atom already exists in the index, this is a no-op.
     */
    addDocument(atom: string, semanticText: string): void {
        if (this.atomIndex.has(atom)) return;

        const idx = this.nextIdx++;
        this.atomIndex.set(atom, idx);

        const rawTokens = tokenizeText(semanticText);
        const tokenCounts = new Map<string, number>();
        for (const t of rawTokens) {
            tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
        }

        this.docs.set(idx, { tokens: tokenCounts, length: rawTokens.length });
        this.totalLength += rawTokens.length;
        this.N++;
        this.avgDl = this.N > 0 ? this.totalLength / this.N : 0;

        // Update document frequency for each unique token
        for (const t of tokenCounts.keys()) {
            this.df.set(t, (this.df.get(t) ?? 0) + 1);
        }
    }

    /**
     * Remove a document from the index incrementally.
     * Updates N, totalLength, avgDl, df, and removes from docs/atomIndex.
     * O(|tokens in document|) — no full corpus scan.
     *
     * If the atom is not in the index, this is a no-op.
     */
    removeDocument(atom: string): void {
        const idx = this.atomIndex.get(atom);
        if (idx === undefined) return;

        const doc = this.docs.get(idx);
        if (doc) {
            // Decrement document frequency for each unique token
            for (const t of doc.tokens.keys()) {
                const count = this.df.get(t) ?? 0;
                if (count <= 1) {
                    this.df.delete(t);
                } else {
                    this.df.set(t, count - 1);
                }
            }
            this.totalLength -= doc.length;
            this.docs.delete(idx);
        }

        this.atomIndex.delete(atom);
        this.N--;
        this.avgDl = this.N > 0 ? this.totalLength / this.N : 0;
    }

    /**
     * Score a single candidate atom against a query string.
     *
     * Returns a value normalised to roughly [0, 1] by dividing raw BM25 by
     * the theoretical maximum (all query tokens present with TF=k1+1).
     * This keeps the score compatible with existing threshold parameters.
     */
    score(query: string, candidateAtom: string): number {
        const idx = this.atomIndex.get(candidateAtom);
        if (idx === undefined) return 0;
        return this.scoreByIndex(query, idx);
    }

    /**
     * Score a candidate by its pre-built semantic text (for callers that
     * already have the semantic string and just need a score).
     *
     * Used internally by search/bootstrap where the semantic text is
     * constructed on the fly and the atom may not be in the index yet
     * (edge case during the same commit cycle).
     */
    scoreBySemanticText(query: string, semanticText: string): number {
        const qTokens = tokenizeText(query);
        if (qTokens.length === 0) return 0;

        const rawTokens = tokenizeText(semanticText);
        if (rawTokens.length === 0) return 0;

        const tokenCounts = new Map<string, number>();
        for (const t of rawTokens) {
            tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
        }

        return this._computeNormalisedScore(qTokens, tokenCounts, rawTokens.length);
    }

    private scoreByIndex(query: string, docIdx: number): number {
        const qTokens = tokenizeText(query);
        if (qTokens.length === 0) return 0;

        const doc = this.docs.get(docIdx);
        if (!doc || doc.length === 0) return 0;

        return this._computeNormalisedScore(qTokens, doc.tokens, doc.length);
    }

    private _computeNormalisedScore(
        qTokens: string[],
        docTokens: Map<string, number>,
        docLength: number,
    ): number {
        const { k1, b, N, avgDl, df } = this;
        const safeAvgDl = avgDl > 0 ? avgDl : 1;

        let rawScore = 0;
        let maxPossible = 0;

        // Deduplicate query tokens (BM25 treats each unique query term once)
        const seen = new Set<string>();

        for (const qt of qTokens) {
            if (seen.has(qt)) continue;
            seen.add(qt);

            // IDF: log((N - n + 0.5) / (n + 0.5) + 1)  [BM25 variant with +1 to avoid negatives]
            const n = df.get(qt) ?? 0;
            const idf = Math.log(((N > 0 ? N : 1) - n + 0.5) / (n + 0.5) + 1);

            // TF component for this document
            const tf = docTokens.get(qt) ?? 0;
            const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / safeAvgDl)));

            rawScore += idf * tfNorm;

            // Max possible: assume TF high enough that tfNorm → (k1+1)
            maxPossible += idf * (k1 + 1);
        }

        if (maxPossible <= 0) return 0;
        return Math.max(0, Math.min(1, rawScore / maxPossible));
    }

    /** Corpus size (for diagnostics). */
    get size(): number { return this.N; }

    /** Average document length (for diagnostics). */
    get averageDocLength(): number { return this.avgDl; }
}
