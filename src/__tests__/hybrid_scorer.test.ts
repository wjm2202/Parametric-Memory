import { describe, it, expect } from 'vitest';
import { HybridScorer } from '../hybrid_scorer';

// ─── Test corpus — mirrors server.ts semantic text format ───────────────────

function entry(atom: string) {
    const match = atom.match(/^v1\.(\w+)\.(.+)$/);
    const semanticText = match ? `${match[1]} ${match[2]} ${atom}` : atom;
    return { atom, semanticText };
}

const CORPUS = [
    'v1.fact.server_uses_fastify',
    'v1.fact.merkle_tree_sha256_binary_heap',
    'v1.fact.verkle_trees_reduce_proof_size',
    'v1.fact.leveldb_backend_for_persistence',
    'v1.fact.bm25_scoring_replaces_jaccard',
    'v1.procedure.typecheck_before_sprint_complete',
    'v1.procedure.store_memory_before_files',
    'v1.state.deployment_status_healthy',
    'v1.event.security_review_completed_dt_2026_03_09',
].map(entry);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('HybridScorer', () => {
    describe('build and score', () => {
        const scorer = HybridScorer.build(CORPUS);

        it('scores exact keyword matches > 0', () => {
            const score = scorer.score('merkle tree sha256', 'v1.fact.merkle_tree_sha256_binary_heap');
            expect(score).toBeGreaterThan(0);
        });

        it('scores morphological variants > 0', () => {
            // "typechecking" should match "typecheck" via n-gram embedding
            const score = scorer.score('typechecking code', 'v1.procedure.typecheck_before_sprint_complete');
            expect(score).toBeGreaterThan(0);
        });

        it('returns 0 for unknown atoms', () => {
            expect(scorer.score('test', 'v1.fact.nonexistent')).toBe(0);
        });
    });

    describe('max-pooling behavior', () => {
        const scorer = HybridScorer.build(CORPUS);

        it('preserves BM25 ranking for exact queries', () => {
            // BM25 should dominate for exact keyword matches
            const merkle = scorer.score('merkle tree sha256', 'v1.fact.merkle_tree_sha256_binary_heap');
            const fastify = scorer.score('merkle tree sha256', 'v1.fact.server_uses_fastify');
            expect(merkle).toBeGreaterThan(fastify);
        });

        it('embedding wins for morphological queries where BM25 fails', () => {
            // "typechecking" has zero token overlap with "typecheck" (BM25 → 0)
            // but high n-gram overlap (embedding → high)
            const score = scorer.score('typechecking', 'v1.procedure.typecheck_before_sprint_complete');
            expect(score).toBeGreaterThan(0.1);
        });

        it('both signals contribute for convergent matches', () => {
            // "merkle tree" matches both BM25 (exact tokens) and embedding (n-grams)
            // The convergence boost should make this score slightly higher than pure BM25
            const hybridScore = scorer.score('merkle tree', 'v1.fact.merkle_tree_sha256_binary_heap');

            // Build BM25-only scorer (embeddingScale=0)
            const bm25Only = HybridScorer.build(CORPUS, { embeddingScale: 0 });
            const bm25Score = bm25Only.score('merkle tree', 'v1.fact.merkle_tree_sha256_binary_heap');

            // Hybrid should be >= BM25-only due to convergence boost
            expect(hybridScore).toBeGreaterThanOrEqual(bm25Score);
        });
    });

    describe('scoreBySemanticText', () => {
        const scorer = HybridScorer.build(CORPUS);

        it('works for atoms not in index', () => {
            const score = scorer.scoreBySemanticText('merkle proof', 'fact merkle_proof_verification v1.fact.merkle_proof_verification');
            expect(score).toBeGreaterThan(0);
        });
    });

    describe('incremental operations', () => {
        it('addDocument makes atom scorable', () => {
            const scorer = HybridScorer.empty();
            expect(scorer.score('test', 'v1.fact.test_atom')).toBe(0);

            scorer.addDocument('v1.fact.test_atom', 'fact test_atom v1.fact.test_atom');
            expect(scorer.score('test', 'v1.fact.test_atom')).toBeGreaterThan(0);
        });

        it('removeDocument makes atom unscorable', () => {
            const scorer = HybridScorer.build(CORPUS);
            expect(scorer.score('merkle', 'v1.fact.merkle_tree_sha256_binary_heap')).toBeGreaterThan(0);
            scorer.removeDocument('v1.fact.merkle_tree_sha256_binary_heap');
            expect(scorer.score('merkle', 'v1.fact.merkle_tree_sha256_binary_heap')).toBe(0);
        });

        it('incremental add produces same score as full build', () => {
            // Build from all but last atom, then add it incrementally
            const partial = HybridScorer.build(CORPUS.slice(0, -1));
            const lastAtom = CORPUS[CORPUS.length - 1];
            partial.addDocument(lastAtom.atom, lastAtom.semanticText);

            const full = HybridScorer.build(CORPUS);

            // Scores should be very close (BM25 IDF may differ slightly)
            const query = 'security review completed';
            const partialScore = partial.score(query, lastAtom.atom);
            const fullScore = full.score(query, lastAtom.atom);
            expect(Math.abs(partialScore - fullScore)).toBeLessThan(0.05);
        });
    });

    describe('empty scorer', () => {
        const scorer = HybridScorer.empty();

        it('scores everything as 0', () => {
            expect(scorer.score('anything', 'v1.fact.whatever')).toBe(0);
        });

        it('has size 0', () => {
            expect(scorer.size).toBe(0);
        });
    });

    describe('custom parameters', () => {
        it('embeddingScale=0 is equivalent to BM25-only', () => {
            const bm25Only = HybridScorer.build(CORPUS, { embeddingScale: 0, convergenceBoost: 0 });
            // With scale=0, max(bm25, 0*emb) = max(bm25, 0) = bm25
            const score = bm25Only.score('merkle tree', 'v1.fact.merkle_tree_sha256_binary_heap');
            expect(score).toBeGreaterThan(0);
        });

        it('high convergenceBoost rewards dual matches', () => {
            const highConv = HybridScorer.build(CORPUS, { convergenceBoost: 0.5 });
            const lowConv = HybridScorer.build(CORPUS, { convergenceBoost: 0.0 });

            // "merkle tree" matches both BM25 and embedding
            const highScore = highConv.score('merkle tree', 'v1.fact.merkle_tree_sha256_binary_heap');
            const lowScore = lowConv.score('merkle tree', 'v1.fact.merkle_tree_sha256_binary_heap');

            expect(highScore).toBeGreaterThanOrEqual(lowScore);
        });
    });

    describe('diagnostics', () => {
        it('reports correct size', () => {
            const scorer = HybridScorer.build(CORPUS);
            expect(scorer.size).toBe(CORPUS.length);
        });

        it('exposes parameter values', () => {
            const scorer = HybridScorer.build(CORPUS, { embeddingScale: 0.5, convergenceBoost: 0.2 });
            expect(scorer.embeddingScaleValue).toBe(0.5);
            expect(scorer.convergenceBoostValue).toBe(0.2);
        });

        it('exposes underlying indices', () => {
            const scorer = HybridScorer.build(CORPUS);
            expect(scorer.bm25Index).toBeDefined();
            expect(scorer.embeddingIndex).toBeDefined();
            expect(scorer.bm25Index.size).toBe(CORPUS.length);
            expect(scorer.embeddingIndex.size).toBe(CORPUS.length);
        });
    });
});
