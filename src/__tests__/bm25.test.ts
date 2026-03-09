import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenizeText } from '../bm25';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a corpus entry from an atom name (mirrors server.ts semanticText logic). */
function entry(atom: string) {
    // parseAtomV1 equivalent: v1.<type>.<value>
    const match = atom.match(/^v1\.(\w+)\.(.+)$/);
    const semanticText = match ? `${match[1]} ${match[2]} ${atom}` : atom;
    return { atom, semanticText };
}

/** Build a corpus from a list of atom names. */
function buildIndex(atoms: string[]) {
    return Bm25Index.build(atoms.map(entry));
}

// ---------------------------------------------------------------------------
// Test corpus — models real MMPM usage
// ---------------------------------------------------------------------------

const REAL_CORPUS = [
    // Security review atoms (common token: "security")
    'v1.fact.security_critical_dockerfile_copies_env_files',
    'v1.fact.security_critical_readbody_no_size_limit',
    'v1.fact.security_high_no_rate_limiting_oauth_token',
    'v1.fact.security_high_missing_nginx_headers',
    'v1.fact.security_medium_containers_run_as_root',
    // Merkle tree atoms (rare tokens: "merkle", "verkle")
    'v1.fact.merkle_tree_sha256_heap_indexed_binary',
    'v1.fact.verkle_trees_reduce_proof_size_10x',
    // Research atoms
    'v1.fact.bm25_sparse_retrieval_outperforms_jaccard_with_tf_idf_saturation_src_research',
    'v1.fact.halflife_regression_settles_duolingo_45pct_better_recall_src_research',
    'v1.fact.jump_hash_zero_memory_overhead_perfect_distribution_src_research',
    // Procedures
    'v1.procedure.store_memory_before_creating_files',
    'v1.procedure.atoms_must_exist_before_training',
    // States
    'v1.state.sprint_step_1_bm25_search_pending',
    'v1.state.deployment_status_healthy',
    // Events
    'v1.event.security_review_completed_dt_2026_03_09',
    'v1.event.cs_paper_research_completed_dt_2026_03_09',
    // Relations
    'v1.relation.mmpm_search_upgrade_path_jaccard_to_bm25',
    'v1.relation.mmpm_decay_model_parallels_halflife_regression',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bm25Index', () => {
    describe('tokenizeText', () => {
        it('lowercases and splits on non-alphanumeric', () => {
            expect(tokenizeText('v1.fact.Hello_World')).toEqual(['v1', 'fact', 'hello', 'world']);
        });

        it('filters empty tokens', () => {
            expect(tokenizeText('__foo___bar__')).toEqual(['foo', 'bar']);
        });

        it('returns empty array for empty string', () => {
            expect(tokenizeText('')).toEqual([]);
        });
    });

    describe('empty index', () => {
        it('returns 0 for any query', () => {
            const idx = Bm25Index.empty();
            expect(idx.score('anything', 'v1.fact.whatever')).toBe(0);
            expect(idx.scoreBySemanticText('anything', 'whatever')).toBe(0);
        });

        it('has size 0', () => {
            expect(Bm25Index.empty().size).toBe(0);
        });
    });

    describe('rare token boost (IDF)', () => {
        it('ranks rare-token atoms above common-token atoms', () => {
            const idx = buildIndex(REAL_CORPUS);

            // "verkle" appears in only 1 atom; "security" appears in 6
            const verkleScore = idx.score('verkle tree proof', 'v1.fact.verkle_trees_reduce_proof_size_10x');
            const securityScore = idx.score('verkle tree proof', 'v1.fact.security_critical_dockerfile_copies_env_files');

            expect(verkleScore).toBeGreaterThan(securityScore);
            // verkle should score meaningfully
            expect(verkleScore).toBeGreaterThan(0.1);
        });

        it('ranks merkle atoms high when querying for merkle', () => {
            const idx = buildIndex(REAL_CORPUS);

            const scores = REAL_CORPUS.map(atom => ({
                atom,
                score: idx.score('merkle tree sha256 heap', atom),
            })).sort((a, b) => b.score - a.score);

            // The merkle atom should be #1
            expect(scores[0].atom).toBe('v1.fact.merkle_tree_sha256_heap_indexed_binary');
        });
    });

    describe('length normalisation', () => {
        it('scores short atom higher than long atom with same keywords', () => {
            // Build a corpus with two atoms that both contain "bm25"
            const short = 'v1.fact.bm25_works';
            const long = 'v1.fact.bm25_sparse_retrieval_outperforms_jaccard_with_tf_idf_saturation_src_research';
            const idx = buildIndex([short, long]);

            const shortScore = idx.score('bm25', short);
            const longScore = idx.score('bm25', long);

            // Short atom should score higher due to length normalisation (parameter b)
            expect(shortScore).toBeGreaterThan(longScore);
        });
    });

    describe('Jaccard regression — BM25 ranks at least as well', () => {
        // Hand-labelled: for each query, the top result MUST be the labelled atom
        const LABELLED_QUERIES: Array<{ query: string; expected: string }> = [
            { query: 'verkle tree proof size', expected: 'v1.fact.verkle_trees_reduce_proof_size_10x' },
            { query: 'merkle sha256', expected: 'v1.fact.merkle_tree_sha256_heap_indexed_binary' },
            { query: 'store memory before files', expected: 'v1.procedure.store_memory_before_creating_files' },
            { query: 'bm25 retrieval jaccard', expected: 'v1.fact.bm25_sparse_retrieval_outperforms_jaccard_with_tf_idf_saturation_src_research' },
            { query: 'halflife regression decay', expected: 'v1.relation.mmpm_decay_model_parallels_halflife_regression' },
            { query: 'deployment status', expected: 'v1.state.deployment_status_healthy' },
            { query: 'sprint bm25 pending', expected: 'v1.state.sprint_step_1_bm25_search_pending' },
            { query: 'jump hash distribution', expected: 'v1.fact.jump_hash_zero_memory_overhead_perfect_distribution_src_research' },
            { query: 'rate limiting oauth', expected: 'v1.fact.security_high_no_rate_limiting_oauth_token' },
            { query: 'paper research completed', expected: 'v1.event.cs_paper_research_completed_dt_2026_03_09' },
        ];

        it('returns the correct top-1 result for all labelled queries', () => {
            const idx = buildIndex(REAL_CORPUS);

            for (const { query, expected } of LABELLED_QUERIES) {
                const scores = REAL_CORPUS.map(atom => ({
                    atom,
                    score: idx.score(query, atom),
                })).sort((a, b) => b.score - a.score);

                expect(scores[0].atom).toBe(expected);
            }
        });
    });

    describe('edge cases', () => {
        it('empty query returns 0', () => {
            const idx = buildIndex(REAL_CORPUS);
            expect(idx.score('', REAL_CORPUS[0])).toBe(0);
        });

        it('query with no matching tokens returns 0', () => {
            const idx = buildIndex(REAL_CORPUS);
            expect(idx.score('zzzzzzzzz qqqqqqqqq', REAL_CORPUS[0])).toBe(0);
        });

        it('unknown atom returns 0', () => {
            const idx = buildIndex(REAL_CORPUS);
            expect(idx.score('security', 'v1.fact.nonexistent_atom')).toBe(0);
        });

        it('scoreBySemanticText works for atoms not in index', () => {
            const idx = buildIndex(REAL_CORPUS);
            const score = idx.scoreBySemanticText('security critical', 'fact security_critical_new_finding v1.fact.security_critical_new_finding');
            expect(score).toBeGreaterThan(0);
        });
    });

    describe('reindex idempotency', () => {
        it('two builds from the same corpus produce identical scores', () => {
            const idx1 = buildIndex(REAL_CORPUS);
            const idx2 = buildIndex(REAL_CORPUS);

            for (const atom of REAL_CORPUS) {
                expect(idx1.score('security merkle bm25', atom)).toBe(idx2.score('security merkle bm25', atom));
            }
        });
    });

    describe('score normalisation', () => {
        it('all scores are in [0, 1] range', () => {
            const idx = buildIndex(REAL_CORPUS);

            for (const atom of REAL_CORPUS) {
                const score = idx.score('security critical dockerfile', atom);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(1);
            }
        });

        it('perfect match on a unique term scores close to 1', () => {
            // Build a tiny corpus where one atom has a completely unique term
            const corpus = ['v1.fact.uniquexyz_thing', 'v1.fact.common_thing', 'v1.fact.another_common_thing'];
            const idx = buildIndex(corpus);
            const score = idx.score('uniquexyz', 'v1.fact.uniquexyz_thing');
            expect(score).toBeGreaterThan(0.5);
        });
    });

    describe('diagnostics', () => {
        it('reports correct corpus size', () => {
            const idx = buildIndex(REAL_CORPUS);
            expect(idx.size).toBe(REAL_CORPUS.length);
        });

        it('reports non-zero average document length', () => {
            const idx = buildIndex(REAL_CORPUS);
            expect(idx.averageDocLength).toBeGreaterThan(0);
        });
    });

    describe('custom BM25 parameters', () => {
        it('k1=0 makes all non-zero TF equivalent', () => {
            // With k1=0, tfNorm simplifies to 1 for any TF > 0
            const corpus = [
                { atom: 'a', semanticText: 'foo foo foo bar' },
                { atom: 'b', semanticText: 'foo bar' },
            ];
            const idx = Bm25Index.build(corpus, { k1: 0, b: 0 });
            // Both should score identically for query "foo" since TF doesn't matter
            const scoreA = idx.score('foo', 'a');
            const scoreB = idx.score('foo', 'b');
            expect(scoreA).toBeCloseTo(scoreB, 5);
        });

        it('b=0 disables length normalisation', () => {
            const short = { atom: 'short', semanticText: 'alpha' };
            const long = { atom: 'long', semanticText: 'alpha beta gamma delta epsilon zeta eta theta' };
            const idx = Bm25Index.build([short, long], { b: 0 });
            // With b=0, document length doesn't affect score
            // Both have TF=1 for "alpha", so scores depend only on IDF and k1
            const scoreShort = idx.score('alpha', 'short');
            const scoreLong = idx.score('alpha', 'long');
            // Should be very close (small differences from TF/(TF+k1) since TF=1 for both)
            expect(Math.abs(scoreShort - scoreLong)).toBeLessThan(0.01);
        });
    });
});
