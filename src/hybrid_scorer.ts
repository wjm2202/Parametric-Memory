/**
 * HybridScorer — combines BM25 keyword matching with embedding cosine similarity.
 *
 * Scoring strategy: **Max-pooling with additive boost**
 *
 *   hybrid = max(bm25_score, embeddingScale × embedding_score)
 *            + boost × min(bm25_score, embeddingScale × embedding_score)
 *
 * When boost=0 this is pure max-pooling: each atom gets the stronger of its
 * two signals.  With boost>0, atoms that score well on BOTH signals get a
 * further lift (rewarding convergent evidence).
 *
 * Why max-pooling?  BM25 and n-gram embeddings excel at different query types:
 *   - BM25: exact keyword matches (100% R@1 on exact queries)
 *   - Embeddings: morphological variants (100% R@1 on morphological queries)
 * Linear combination or conditional switching both create interference.
 * Max-pooling lets each signal win where it's strongest.
 *
 * Lifecycle mirrors Bm25Index:
 *   - build() from corpus at startup
 *   - addDocument() / removeDocument() for incremental updates
 *   - score() / scoreBySemanticText() for query-time scoring
 */

import { Bm25Index, Bm25Options } from './bm25';
import { EmbeddingIndex, EmbeddingIndexOptions } from './embedding';

export interface HybridScorerOptions {
    /**
     * Scale factor for embedding scores before max-pooling.
     * Controls how aggressively embedding competes with BM25.
     * Default 0.8 (embeddings need 80% confidence to override BM25).
     */
    embeddingScale?: number;
    /**
     * Additive boost for convergent evidence (both signals agree).
     * Default 0.1 (small reward when both BM25 and embedding match).
     */
    convergenceBoost?: number;
    /** BM25 tuning parameters. */
    bm25?: Bm25Options;
    /** Embedding provider options. */
    embedding?: EmbeddingIndexOptions;
}

export class HybridScorer {
    private readonly bm25: Bm25Index;
    private readonly embedding: EmbeddingIndex;
    private readonly embeddingScale: number;
    private readonly convergenceBoost: number;

    private constructor(
        bm25: Bm25Index,
        embedding: EmbeddingIndex,
        embeddingScale: number,
        convergenceBoost: number,
    ) {
        this.bm25 = bm25;
        this.embedding = embedding;
        this.embeddingScale = embeddingScale;
        this.convergenceBoost = convergenceBoost;
    }

    /**
     * Build a hybrid scorer from a corpus.
     *
     * @param corpus  Array of {atom, semanticText} — same format as Bm25Index.build()
     * @param opts    Optional tuning parameters.
     */
    static build(
        corpus: Array<{ atom: string; semanticText: string }>,
        opts: HybridScorerOptions = {},
    ): HybridScorer {
        const embeddingScale = opts.embeddingScale ?? 0.8;
        const convergenceBoost = opts.convergenceBoost ?? 0.1;
        const bm25 = Bm25Index.build(corpus, opts.bm25);
        const embedding = EmbeddingIndex.build(corpus, opts.embedding);
        return new HybridScorer(bm25, embedding, embeddingScale, convergenceBoost);
    }

    /** Build an empty hybrid scorer. */
    static empty(opts: HybridScorerOptions = {}): HybridScorer {
        const embeddingScale = opts.embeddingScale ?? 0.8;
        const convergenceBoost = opts.convergenceBoost ?? 0.1;
        return new HybridScorer(
            Bm25Index.empty(opts.bm25),
            EmbeddingIndex.empty(opts.embedding),
            embeddingScale,
            convergenceBoost,
        );
    }

    /**
     * Score a query against a candidate atom in the index.
     */
    score(query: string, candidateAtom: string): number {
        const bm25Score = this.bm25.score(query, candidateAtom);
        const embScore = this.embedding.score(query, candidateAtom);
        return this._combine(bm25Score, embScore);
    }

    /**
     * Score a query against arbitrary semantic text (for atoms not yet in index).
     */
    scoreBySemanticText(query: string, semanticText: string): number {
        const bm25Score = this.bm25.scoreBySemanticText(query, semanticText);
        const embScore = this.embedding.scoreBySemanticText(query, semanticText);
        return this._combine(bm25Score, embScore);
    }

    /**
     * Max-pooling with convergence boost.
     *
     *   scaled_emb = embeddingScale × embedding_score
     *   hybrid = max(bm25, scaled_emb) + convergenceBoost × min(bm25, scaled_emb)
     */
    private _combine(bm25Score: number, embScore: number): number {
        const scaledEmb = this.embeddingScale * embScore;
        const primary = Math.max(bm25Score, scaledEmb);
        const secondary = Math.min(bm25Score, scaledEmb);
        return primary + this.convergenceBoost * secondary;
    }

    /** Add a document incrementally to both indices. */
    addDocument(atom: string, semanticText: string): void {
        this.bm25.addDocument(atom, semanticText);
        this.embedding.addDocument(atom, semanticText);
    }

    /** Remove a document incrementally from both indices. */
    removeDocument(atom: string): void {
        this.bm25.removeDocument(atom);
        this.embedding.removeDocument(atom);
    }

    /** Number of atoms in the BM25 index. */
    get size(): number { return this.bm25.size; }

    /** Current embedding scale (for diagnostics). */
    get embeddingScaleValue(): number { return this.embeddingScale; }

    /** Current convergence boost (for diagnostics). */
    get convergenceBoostValue(): number { return this.convergenceBoost; }

    /** Access underlying BM25 index (for testing / diagnostics). */
    get bm25Index(): Bm25Index { return this.bm25; }

    /** Access underlying embedding index (for testing / diagnostics). */
    get embeddingIndex(): EmbeddingIndex { return this.embedding; }
}
