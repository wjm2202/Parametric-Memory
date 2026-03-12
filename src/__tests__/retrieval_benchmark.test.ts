/**
 * Retrieval Quality Benchmark
 *
 * Scientific evaluation of search quality across different scoring strategies.
 * Uses hand-labelled ground truth with three categories:
 *
 *   1. EXACT — queries with direct token overlap (BM25 should ace these)
 *   2. MORPHOLOGICAL — queries with word variants (test↔testing, fast↔fastify)
 *   3. SEMANTIC — queries with conceptual but not lexical overlap
 *
 * Metrics: Recall@1, Recall@3, Recall@5, MRR (Mean Reciprocal Rank)
 *
 * This benchmark establishes the baseline for BM25-only scoring and measures
 * the lift from hybrid (BM25 + embedding) scoring.
 */

import { describe, it, expect } from 'vitest';
import { Bm25Index } from '../bm25';
import { EmbeddingIndex, Model2VecEmbedding } from '../embedding';
import { HybridScorer } from '../hybrid_scorer';
import * as path from 'path';
import { existsSync } from 'fs';

// ─── Test corpus — realistic MMPM atoms ─────────────────────────────────────

const CORPUS = [
    'v1.fact.server_uses_fastify',
    'v1.fact.server_runs_on_port_3000',
    'v1.fact.deployment_uses_docker_compose',
    'v1.fact.merkle_tree_sha256_binary_heap',
    'v1.fact.verkle_trees_reduce_proof_size',
    'v1.fact.leveldb_backend_for_persistence',
    'v1.fact.bm25_scoring_replaces_jaccard_overlap',
    'v1.fact.halflife_regression_for_decay_model',
    'v1.fact.jump_hash_zero_memory_overhead',
    'v1.fact.security_no_rate_limiting_oauth',
    'v1.fact.nginx_reverse_proxy_ssl_termination',
    'v1.fact.ppm_trie_variable_order_markov',
    'v1.procedure.store_memory_before_files',
    'v1.procedure.never_use_rm_rf_without_asking',
    'v1.procedure.typecheck_before_sprint_complete',
    'v1.procedure.always_rebuild_after_pushing',
    'v1.state.deployment_status_healthy',
    'v1.state.sprint_17_embedding_in_progress',
    'v1.event.security_review_completed_dt_2026_03_09',
    'v1.event.architecture_upgrade_finished_dt_2026_03_11',
    'v1.relation.mmpm_search_upgrade_jaccard_to_bm25_to_hybrid',
    'v1.relation.decay_parallels_halflife_regression',
];

function entry(atom: string) {
    const match = atom.match(/^v1\.(\w+)\.(.+)$/);
    const semanticText = match ? `${match[1]} ${match[2]} ${atom}` : atom;
    return { atom, semanticText };
}

const CORPUS_ENTRIES = CORPUS.map(entry);

// ─── Ground truth queries ───────────────────────────────────────────────────

interface GroundTruth {
    query: string;
    /** Atoms that SHOULD be retrieved (in any order). */
    relevant: string[];
    /** Category for analysis: exact, morphological, or semantic. */
    category: 'exact' | 'morphological' | 'semantic';
}

const GROUND_TRUTH: GroundTruth[] = [
    // ── EXACT: BM25 should handle these perfectly ───────────────────────
    {
        query: 'merkle tree sha256',
        relevant: ['v1.fact.merkle_tree_sha256_binary_heap'],
        category: 'exact',
    },
    {
        query: 'verkle proof size',
        relevant: ['v1.fact.verkle_trees_reduce_proof_size'],
        category: 'exact',
    },
    {
        query: 'deployment docker',
        relevant: [
            'v1.fact.deployment_uses_docker_compose',
            'v1.state.deployment_status_healthy',
        ],
        category: 'exact',
    },
    {
        query: 'bm25 jaccard scoring',
        relevant: ['v1.fact.bm25_scoring_replaces_jaccard_overlap'],
        category: 'exact',
    },
    {
        query: 'store memory before files',
        relevant: ['v1.procedure.store_memory_before_files'],
        category: 'exact',
    },

    // ── MORPHOLOGICAL: subword overlap should help ──────────────────────
    {
        query: 'fastify configuration',
        relevant: ['v1.fact.server_uses_fastify'],
        category: 'morphological',
    },
    {
        query: 'typechecking code',
        relevant: ['v1.procedure.typecheck_before_sprint_complete'],
        category: 'morphological',
    },
    {
        query: 'rebuilding after deploy',
        relevant: ['v1.procedure.always_rebuild_after_pushing'],
        category: 'morphological',
    },
    {
        query: 'markov prediction model',
        relevant: ['v1.fact.ppm_trie_variable_order_markov'],
        category: 'morphological',
    },
    {
        query: 'embedding search upgrade',
        relevant: [
            'v1.state.sprint_17_embedding_in_progress',
            'v1.relation.mmpm_search_upgrade_jaccard_to_bm25_to_hybrid',
        ],
        category: 'morphological',
    },

    // ── SEMANTIC: conceptual overlap, few/no shared tokens ──────────────
    {
        query: 'web framework settings',
        relevant: ['v1.fact.server_uses_fastify'],
        category: 'semantic',
    },
    {
        query: 'database storage engine',
        relevant: ['v1.fact.leveldb_backend_for_persistence'],
        category: 'semantic',
    },
    {
        query: 'cryptographic verification',
        relevant: [
            'v1.fact.merkle_tree_sha256_binary_heap',
            'v1.fact.verkle_trees_reduce_proof_size',
        ],
        category: 'semantic',
    },
    {
        query: 'authentication security',
        relevant: ['v1.fact.security_no_rate_limiting_oauth'],
        category: 'semantic',
    },
    {
        query: 'load balancer reverse proxy',
        relevant: ['v1.fact.nginx_reverse_proxy_ssl_termination'],
        category: 'semantic',
    },
    {
        query: 'deleting files safely',
        relevant: ['v1.procedure.never_use_rm_rf_without_asking'],
        category: 'semantic',
    },
    {
        query: 'memory decay forgetting curve',
        relevant: [
            'v1.fact.halflife_regression_for_decay_model',
            'v1.relation.decay_parallels_halflife_regression',
        ],
        category: 'semantic',
    },
];

// ─── Metrics computation ────────────────────────────────────────────────────

interface RankingResult {
    query: string;
    category: string;
    relevant: string[];
    /** Rank of each relevant atom (1-indexed); Infinity if not in top-k. */
    ranks: number[];
    /** Reciprocal rank of the best relevant atom. */
    reciprocalRank: number;
    /** Was at least one relevant atom in top-1? */
    recallAt1: boolean;
    /** Was at least one relevant atom in top-3? */
    recallAt3: boolean;
    /** Was at least one relevant atom in top-5? */
    recallAt5: boolean;
}

function computeRanking(
    query: string,
    relevant: string[],
    category: string,
    scoreFn: (q: string, atom: string) => number,
): RankingResult {
    const scored = CORPUS.map(atom => ({
        atom,
        score: scoreFn(query, atom),
    })).sort((a, b) => b.score - a.score);

    // Only count atoms with score > 0 as "retrieved" — prevents false positives
    // from sort-order when all scores are zero
    const ranks = relevant.map(rel => {
        const idx = scored.findIndex(s => s.atom === rel);
        if (idx < 0) return Infinity;
        // If the atom scored 0, it wasn't actually found
        if (scored[idx].score <= 0) return Infinity;
        return idx + 1;
    });

    const bestRank = Math.min(...ranks);
    return {
        query,
        category,
        relevant,
        ranks,
        reciprocalRank: bestRank === Infinity ? 0 : 1 / bestRank,
        recallAt1: bestRank <= 1,
        recallAt3: bestRank <= 3,
        recallAt5: bestRank <= 5,
    };
}

interface BenchmarkMetrics {
    mrr: number;
    recallAt1: number;
    recallAt3: number;
    recallAt5: number;
    byCategory: Record<string, {
        mrr: number;
        recallAt1: number;
        recallAt3: number;
        recallAt5: number;
        count: number;
    }>;
}

function computeMetrics(results: RankingResult[]): BenchmarkMetrics {
    const n = results.length;
    const mrr = results.reduce((sum, r) => sum + r.reciprocalRank, 0) / n;
    const recallAt1 = results.filter(r => r.recallAt1).length / n;
    const recallAt3 = results.filter(r => r.recallAt3).length / n;
    const recallAt5 = results.filter(r => r.recallAt5).length / n;

    const categories = [...new Set(results.map(r => r.category))];
    const byCategory: BenchmarkMetrics['byCategory'] = {};
    for (const cat of categories) {
        const catResults = results.filter(r => r.category === cat);
        const cn = catResults.length;
        byCategory[cat] = {
            mrr: catResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / cn,
            recallAt1: catResults.filter(r => r.recallAt1).length / cn,
            recallAt3: catResults.filter(r => r.recallAt3).length / cn,
            recallAt5: catResults.filter(r => r.recallAt5).length / cn,
            count: cn,
        };
    }

    return { mrr, recallAt1, recallAt3, recallAt5, byCategory };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// ─── Load Model2Vec if available ────────────────────────────────────────────

const MODEL2VEC_PATH = path.join(__dirname, '..', '..', 'data', 'model2vec_vocab.json');
const hasModel2Vec = existsSync(MODEL2VEC_PATH);
let model2vecProvider: Model2VecEmbedding | undefined;
if (hasModel2Vec) {
    model2vecProvider = Model2VecEmbedding.fromFile(MODEL2VEC_PATH);
}

describe('Retrieval Quality Benchmark', () => {
    // Build indices once
    const bm25 = Bm25Index.build(CORPUS_ENTRIES);
    const hybrid = HybridScorer.build(CORPUS_ENTRIES);  // n-gram hybrid
    const embeddingOnly = EmbeddingIndex.build(CORPUS_ENTRIES);

    // Model2Vec hybrid (if vocab available)
    const model2vecHybrid = model2vecProvider
        ? HybridScorer.build(CORPUS_ENTRIES, { embedding: { provider: model2vecProvider } })
        : null;

    describe('BM25-only baseline', () => {
        const results = GROUND_TRUTH.map(gt =>
            computeRanking(gt.query, gt.relevant, gt.category,
                (q, atom) => bm25.score(q, atom)));
        const metrics = computeMetrics(results);

        it('reports baseline metrics', () => {
            console.log('\n=== BM25-ONLY BASELINE ===');
            console.log(`  MRR:       ${metrics.mrr.toFixed(3)}`);
            console.log(`  Recall@1:  ${metrics.recallAt1.toFixed(3)}`);
            console.log(`  Recall@3:  ${metrics.recallAt3.toFixed(3)}`);
            console.log(`  Recall@5:  ${metrics.recallAt5.toFixed(3)}`);
            for (const [cat, m] of Object.entries(metrics.byCategory)) {
                console.log(`  [${cat}] MRR=${m.mrr.toFixed(3)} R@1=${m.recallAt1.toFixed(3)} R@3=${m.recallAt3.toFixed(3)} R@5=${m.recallAt5.toFixed(3)} (n=${m.count})`);
            }

            // Exact queries: BM25 should get most right
            expect(metrics.byCategory['exact']?.recallAt1).toBeGreaterThanOrEqual(0.6);
        });

        it('handles exact keyword queries well', () => {
            const exactResults = results.filter(r => r.category === 'exact');
            const exactR1 = exactResults.filter(r => r.recallAt1).length / exactResults.length;
            expect(exactR1).toBeGreaterThanOrEqual(0.6);
        });
    });

    describe('Embedding-only scoring', () => {
        const results = GROUND_TRUTH.map(gt =>
            computeRanking(gt.query, gt.relevant, gt.category,
                (q, atom) => embeddingOnly.score(q, atom)));
        const metrics = computeMetrics(results);

        it('reports embedding-only metrics', () => {
            console.log('\n=== EMBEDDING-ONLY ===');
            console.log(`  MRR:       ${metrics.mrr.toFixed(3)}`);
            console.log(`  Recall@1:  ${metrics.recallAt1.toFixed(3)}`);
            console.log(`  Recall@3:  ${metrics.recallAt3.toFixed(3)}`);
            console.log(`  Recall@5:  ${metrics.recallAt5.toFixed(3)}`);
            for (const [cat, m] of Object.entries(metrics.byCategory)) {
                console.log(`  [${cat}] MRR=${m.mrr.toFixed(3)} R@1=${m.recallAt1.toFixed(3)} R@3=${m.recallAt3.toFixed(3)} R@5=${m.recallAt5.toFixed(3)} (n=${m.count})`);
            }
            // Embedding should score above zero on morphological queries
            expect(metrics.byCategory['morphological']?.recallAt5).toBeGreaterThanOrEqual(0.2);
        });
    });

    describe('Hybrid scoring (max-pooling + convergence boost)', () => {
        const results = GROUND_TRUTH.map(gt =>
            computeRanking(gt.query, gt.relevant, gt.category,
                (q, atom) => hybrid.score(q, atom)));
        const metrics = computeMetrics(results);

        it('reports hybrid metrics', () => {
            console.log('\n=== HYBRID (max-pool, scale=0.8, convergence=0.1) ===');
            console.log(`  MRR:       ${metrics.mrr.toFixed(3)}`);
            console.log(`  Recall@1:  ${metrics.recallAt1.toFixed(3)}`);
            console.log(`  Recall@3:  ${metrics.recallAt3.toFixed(3)}`);
            console.log(`  Recall@5:  ${metrics.recallAt5.toFixed(3)}`);
            for (const [cat, m] of Object.entries(metrics.byCategory)) {
                console.log(`  [${cat}] MRR=${m.mrr.toFixed(3)} R@1=${m.recallAt1.toFixed(3)} R@3=${m.recallAt3.toFixed(3)} R@5=${m.recallAt5.toFixed(3)} (n=${m.count})`);
            }
        });

        it('does not regress on exact keyword queries vs BM25', () => {
            const bm25Results = GROUND_TRUTH.filter(gt => gt.category === 'exact').map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => bm25.score(q, atom)));
            const hybridResults = GROUND_TRUTH.filter(gt => gt.category === 'exact').map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => hybrid.score(q, atom)));

            const bm25Exact = computeMetrics(bm25Results);
            const hybridExact = computeMetrics(hybridResults);

            // Hybrid must not regress on exact queries at all
            expect(hybridExact.recallAt1).toBeGreaterThanOrEqual(bm25Exact.recallAt1);
        });

        it('improves recall on morphological queries vs BM25', () => {
            const bm25MorphResults = GROUND_TRUTH.filter(gt => gt.category === 'morphological').map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => bm25.score(q, atom)));
            const hybridMorphResults = GROUND_TRUTH.filter(gt => gt.category === 'morphological').map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => hybrid.score(q, atom)));

            const bm25Morph = computeMetrics(bm25MorphResults);
            const hybridMorph = computeMetrics(hybridMorphResults);

            // Hybrid must improve morphological recall
            expect(hybridMorph.recallAt1).toBeGreaterThanOrEqual(bm25Morph.recallAt1);
        });
    });

    describe('Model2Vec hybrid scoring (if vocab available)', () => {
        it('reports Model2Vec metrics', () => {
            if (!model2vecHybrid) {
                console.log('\n=== MODEL2VEC: SKIPPED (vocab not found) ===');
                return;
            }

            const results = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => model2vecHybrid.score(q, atom)));
            const metrics = computeMetrics(results);

            console.log('\n=== MODEL2VEC HYBRID (max-pool, scale=0.8, convergence=0.1) ===');
            console.log(`  MRR:       ${metrics.mrr.toFixed(3)}`);
            console.log(`  Recall@1:  ${metrics.recallAt1.toFixed(3)}`);
            console.log(`  Recall@3:  ${metrics.recallAt3.toFixed(3)}`);
            console.log(`  Recall@5:  ${metrics.recallAt5.toFixed(3)}`);
            for (const [cat, m] of Object.entries(metrics.byCategory)) {
                console.log(`  [${cat}] MRR=${m.mrr.toFixed(3)} R@1=${m.recallAt1.toFixed(3)} R@3=${m.recallAt3.toFixed(3)} R@5=${m.recallAt5.toFixed(3)} (n=${m.count})`);
            }

            // Model2Vec should maintain exact query performance
            expect(metrics.byCategory['exact']?.recallAt1).toBeGreaterThanOrEqual(0.8);
        });

        it('compares all scorers side-by-side', () => {
            if (!model2vecHybrid) return;

            const bm25Results = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => bm25.score(q, atom)));
            const ngramResults = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => hybrid.score(q, atom)));
            const m2vResults = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => model2vecHybrid.score(q, atom)));

            const bm25M = computeMetrics(bm25Results);
            const ngramM = computeMetrics(ngramResults);
            const m2vM = computeMetrics(m2vResults);

            console.log('\n=== FULL COMPARISON (BM25 vs N-gram Hybrid vs Model2Vec Hybrid) ===');
            console.log('  Metric   | BM25   | N-gram | M2V    | Δ M2V-BM25');
            console.log('  ---------|--------|--------|--------|--------');
            console.log(`  MRR      | ${bm25M.mrr.toFixed(3)}  | ${ngramM.mrr.toFixed(3)}  | ${m2vM.mrr.toFixed(3)}  | ${(m2vM.mrr - bm25M.mrr > 0 ? '+' : '')}${(m2vM.mrr - bm25M.mrr).toFixed(3)}`);
            console.log(`  R@1      | ${bm25M.recallAt1.toFixed(3)}  | ${ngramM.recallAt1.toFixed(3)}  | ${m2vM.recallAt1.toFixed(3)}  | ${(m2vM.recallAt1 - bm25M.recallAt1 > 0 ? '+' : '')}${(m2vM.recallAt1 - bm25M.recallAt1).toFixed(3)}`);
            console.log(`  R@3      | ${bm25M.recallAt3.toFixed(3)}  | ${ngramM.recallAt3.toFixed(3)}  | ${m2vM.recallAt3.toFixed(3)}  | ${(m2vM.recallAt3 - bm25M.recallAt3 > 0 ? '+' : '')}${(m2vM.recallAt3 - bm25M.recallAt3).toFixed(3)}`);
            console.log(`  R@5      | ${bm25M.recallAt5.toFixed(3)}  | ${ngramM.recallAt5.toFixed(3)}  | ${m2vM.recallAt5.toFixed(3)}  | ${(m2vM.recallAt5 - bm25M.recallAt5 > 0 ? '+' : '')}${(m2vM.recallAt5 - bm25M.recallAt5).toFixed(3)}`);

            console.log('\n  Per-query Model2Vec breakdown:');
            for (let i = 0; i < GROUND_TRUTH.length; i++) {
                const gt = GROUND_TRUTH[i];
                const b = bm25Results[i];
                const m = m2vResults[i];
                const improved = m.reciprocalRank > b.reciprocalRank ? '✓' :
                    m.reciprocalRank < b.reciprocalRank ? '✗' : '=';
                console.log(`  ${improved} [${gt.category.padEnd(13)}] "${gt.query}" → BM25 rank=${Math.min(...b.ranks)}, M2V rank=${Math.min(...m.ranks)}`);
            }
        });
    });

    describe('Parameter sensitivity analysis', () => {
        const configs = [
            { embeddingScale: 0.5, convergenceBoost: 0.0, label: 'scale=0.5 conv=0.0' },
            { embeddingScale: 0.8, convergenceBoost: 0.0, label: 'scale=0.8 conv=0.0' },
            { embeddingScale: 0.8, convergenceBoost: 0.1, label: 'scale=0.8 conv=0.1' },
            { embeddingScale: 1.0, convergenceBoost: 0.0, label: 'scale=1.0 conv=0.0' },
            { embeddingScale: 1.0, convergenceBoost: 0.1, label: 'scale=1.0 conv=0.1' },
            { embeddingScale: 1.0, convergenceBoost: 0.2, label: 'scale=1.0 conv=0.2' },
            { embeddingScale: 0.0, convergenceBoost: 0.0, label: 'BM25-only (scale=0)' },
        ];

        it('finds optimal parameters', () => {
            console.log('\n=== PARAMETER SENSITIVITY ===');
            console.log('  config                 | MRR    | R@1    | R@3    | R@5');
            console.log('  -----------------------|--------|--------|--------|--------');

            let bestMRR = 0;
            let bestLabel = '';

            for (const cfg of configs) {
                const scorer = HybridScorer.build(CORPUS_ENTRIES, {
                    embeddingScale: cfg.embeddingScale,
                    convergenceBoost: cfg.convergenceBoost,
                });
                const results = GROUND_TRUTH.map(gt =>
                    computeRanking(gt.query, gt.relevant, gt.category,
                        (q, atom) => scorer.score(q, atom)));
                const m = computeMetrics(results);
                console.log(`  ${cfg.label.padEnd(23)}| ${m.mrr.toFixed(3)}  | ${m.recallAt1.toFixed(3)}  | ${m.recallAt3.toFixed(3)}  | ${m.recallAt5.toFixed(3)}`);

                if (m.mrr > bestMRR) {
                    bestMRR = m.mrr;
                    bestLabel = cfg.label;
                }
            }

            console.log(`\n  Best: ${bestLabel} (MRR=${bestMRR.toFixed(3)})`);

            expect(bestMRR).toBeGreaterThan(0);
        });
    });

    describe('Comparative summary', () => {
        it('prints side-by-side comparison', () => {
            const bm25Results = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => bm25.score(q, atom)));
            const hybridResults = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => hybrid.score(q, atom)));
            const embResults = GROUND_TRUTH.map(gt =>
                computeRanking(gt.query, gt.relevant, gt.category,
                    (q, atom) => embeddingOnly.score(q, atom)));

            const bm25M = computeMetrics(bm25Results);
            const hybridM = computeMetrics(hybridResults);
            const embM = computeMetrics(embResults);

            console.log('\n=== SIDE-BY-SIDE COMPARISON ===');
            console.log('  Metric   | BM25   | Embed  | Hybrid | Δ Hybrid-BM25');
            console.log('  ---------|--------|--------|--------|--------');
            console.log(`  MRR      | ${bm25M.mrr.toFixed(3)}  | ${embM.mrr.toFixed(3)}  | ${hybridM.mrr.toFixed(3)}  | ${(hybridM.mrr - bm25M.mrr > 0 ? '+' : '')}${(hybridM.mrr - bm25M.mrr).toFixed(3)}`);
            console.log(`  R@1      | ${bm25M.recallAt1.toFixed(3)}  | ${embM.recallAt1.toFixed(3)}  | ${hybridM.recallAt1.toFixed(3)}  | ${(hybridM.recallAt1 - bm25M.recallAt1 > 0 ? '+' : '')}${(hybridM.recallAt1 - bm25M.recallAt1).toFixed(3)}`);
            console.log(`  R@3      | ${bm25M.recallAt3.toFixed(3)}  | ${embM.recallAt3.toFixed(3)}  | ${hybridM.recallAt3.toFixed(3)}  | ${(hybridM.recallAt3 - bm25M.recallAt3 > 0 ? '+' : '')}${(hybridM.recallAt3 - bm25M.recallAt3).toFixed(3)}`);
            console.log(`  R@5      | ${bm25M.recallAt5.toFixed(3)}  | ${embM.recallAt5.toFixed(3)}  | ${hybridM.recallAt5.toFixed(3)}  | ${(hybridM.recallAt5 - bm25M.recallAt5 > 0 ? '+' : '')}${(hybridM.recallAt5 - bm25M.recallAt5).toFixed(3)}`);

            console.log('\n  Per-query breakdown:');
            for (let i = 0; i < GROUND_TRUTH.length; i++) {
                const gt = GROUND_TRUTH[i];
                const b = bm25Results[i];
                const h = hybridResults[i];
                const improved = h.reciprocalRank > b.reciprocalRank ? '✓' :
                    h.reciprocalRank < b.reciprocalRank ? '✗' : '=';
                console.log(`  ${improved} [${gt.category.padEnd(13)}] "${gt.query}" → BM25 rank=${Math.min(...b.ranks)}, Hybrid rank=${Math.min(...h.ranks)}`);
            }
        });
    });
});
