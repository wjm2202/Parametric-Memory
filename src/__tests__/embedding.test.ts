import { describe, it, expect } from 'vitest';
import { NgramHashEmbedding, EmbeddingIndex } from '../embedding';

// ─── NgramHashEmbedding unit tests ──────────────────────────────────────────

describe('NgramHashEmbedding', () => {
    const emb = new NgramHashEmbedding(256);

    describe('embed()', () => {
        it('returns a Float32Array of the correct dimensions', () => {
            const vec = emb.embed('hello world');
            expect(vec).toBeInstanceOf(Float32Array);
            expect(vec.length).toBe(256);
        });

        it('returns a zero vector for empty input', () => {
            const vec = emb.embed('');
            const sum = vec.reduce((s, v) => s + Math.abs(v), 0);
            expect(sum).toBe(0);
        });

        it('returns L2-normalised vectors (unit length)', () => {
            const vec = emb.embed('fastify server configuration');
            const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
            // Should be ~1.0 (or 0 for empty)
            expect(norm).toBeCloseTo(1.0, 4);
        });

        it('is deterministic — same input gives same output', () => {
            const a = emb.embed('merkle tree sha256');
            const b = emb.embed('merkle tree sha256');
            for (let i = 0; i < a.length; i++) {
                expect(a[i]).toBe(b[i]);
            }
        });

        it('produces different vectors for different inputs', () => {
            const a = emb.embed('security review');
            const b = emb.embed('database storage');
            // Not exactly equal
            let different = false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) { different = true; break; }
            }
            expect(different).toBe(true);
        });
    });

    describe('similarity()', () => {
        it('returns 1.0 for identical vectors', () => {
            const vec = emb.embed('hello world');
            expect(emb.similarity(vec, vec)).toBeCloseTo(1.0, 4);
        });

        it('returns 0 for orthogonal vectors', () => {
            const a = new Float32Array(256);
            const b = new Float32Array(256);
            a[0] = 1;
            b[1] = 1;
            expect(emb.similarity(a, b)).toBe(0);
        });

        it('is symmetric: sim(a,b) == sim(b,a)', () => {
            const a = emb.embed('merkle proof');
            const b = emb.embed('verkle proof');
            expect(emb.similarity(a, b)).toBeCloseTo(emb.similarity(b, a), 10);
        });

        it('ranges from -1 to 1', () => {
            const a = emb.embed('alpha beta');
            const b = emb.embed('gamma delta');
            const sim = emb.similarity(a, b);
            expect(sim).toBeGreaterThanOrEqual(-1);
            expect(sim).toBeLessThanOrEqual(1);
        });
    });

    describe('morphological similarity', () => {
        it('typecheck is similar to typechecking', () => {
            const a = emb.embed('typecheck');
            const b = emb.embed('typechecking');
            const sim = emb.similarity(a, b);
            expect(sim).toBeGreaterThan(0.5);
        });

        it('rebuild is similar to rebuilding', () => {
            const a = emb.embed('rebuild');
            const b = emb.embed('rebuilding');
            const sim = emb.similarity(a, b);
            expect(sim).toBeGreaterThan(0.5);
        });

        it('fast is similar to fastify', () => {
            const a = emb.embed('fast');
            const b = emb.embed('fastify');
            const sim = emb.similarity(a, b);
            expect(sim).toBeGreaterThan(0.3);
        });

        it('test is similar to testing', () => {
            const a = emb.embed('test');
            const b = emb.embed('testing');
            const sim = emb.similarity(a, b);
            // "test" (4 chars) generates fewer n-grams than longer words,
            // so similarity is lower but still meaningful (> 0.3)
            expect(sim).toBeGreaterThan(0.3);
        });

        it('unrelated words have low similarity', () => {
            const a = emb.embed('merkle');
            const b = emb.embed('deployment');
            const sim = emb.similarity(a, b);
            expect(sim).toBeLessThan(0.3);
        });
    });

    describe('custom dimensions', () => {
        it('supports different dimension sizes', () => {
            const small = new NgramHashEmbedding(64);
            const vec = small.embed('hello');
            expect(vec.length).toBe(64);

            const large = new NgramHashEmbedding(512);
            const vec2 = large.embed('hello');
            expect(vec2.length).toBe(512);
        });
    });
});

// ─── EmbeddingIndex unit tests ──────────────────────────────────────────────

describe('EmbeddingIndex', () => {
    const corpus = [
        { atom: 'v1.fact.server_uses_fastify', semanticText: 'fact server_uses_fastify v1.fact.server_uses_fastify' },
        { atom: 'v1.fact.merkle_tree_sha256', semanticText: 'fact merkle_tree_sha256 v1.fact.merkle_tree_sha256' },
        { atom: 'v1.procedure.typecheck_before_sprint', semanticText: 'procedure typecheck_before_sprint v1.procedure.typecheck_before_sprint' },
    ];

    describe('build and score', () => {
        const idx = EmbeddingIndex.build(corpus);

        it('scores matching atoms > 0.5', () => {
            const score = idx.score('merkle tree sha256', 'v1.fact.merkle_tree_sha256');
            expect(score).toBeGreaterThan(0.5);
        });

        it('scores non-matching atoms lower', () => {
            const relevant = idx.score('merkle', 'v1.fact.merkle_tree_sha256');
            const irrelevant = idx.score('merkle', 'v1.fact.server_uses_fastify');
            expect(relevant).toBeGreaterThan(irrelevant);
        });

        it('returns scores in [0, 1] range', () => {
            for (const { atom } of corpus) {
                const score = idx.score('anything goes here', atom);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(1);
            }
        });

        it('returns 0 for unknown atoms', () => {
            expect(idx.score('test', 'v1.fact.nonexistent')).toBe(0);
        });
    });

    describe('scoreBySemanticText', () => {
        const idx = EmbeddingIndex.build(corpus);

        it('works for atoms not in index', () => {
            const score = idx.scoreBySemanticText('fastify server', 'fact server_config v1.fact.server_config');
            expect(score).toBeGreaterThan(0);
        });
    });

    describe('incremental operations', () => {
        it('addDocument makes atom scorable', () => {
            const idx = EmbeddingIndex.empty();
            expect(idx.score('test', 'v1.fact.test_atom')).toBe(0);

            idx.addDocument('v1.fact.test_atom', 'fact test_atom v1.fact.test_atom');
            expect(idx.score('test', 'v1.fact.test_atom')).toBeGreaterThan(0);
        });

        it('addDocument is idempotent', () => {
            const idx = EmbeddingIndex.empty();
            idx.addDocument('v1.fact.x', 'fact x v1.fact.x');
            const score1 = idx.score('x', 'v1.fact.x');
            idx.addDocument('v1.fact.x', 'fact x v1.fact.x');
            const score2 = idx.score('x', 'v1.fact.x');
            expect(score1).toBe(score2);
            expect(idx.size).toBe(1);
        });

        it('removeDocument makes atom unscorable', () => {
            const idx = EmbeddingIndex.build(corpus);
            expect(idx.score('merkle', 'v1.fact.merkle_tree_sha256')).toBeGreaterThan(0);
            idx.removeDocument('v1.fact.merkle_tree_sha256');
            expect(idx.score('merkle', 'v1.fact.merkle_tree_sha256')).toBe(0);
        });

        it('removeDocument on missing atom is a no-op', () => {
            const idx = EmbeddingIndex.build(corpus);
            const sizeBefore = idx.size;
            idx.removeDocument('v1.fact.nonexistent');
            expect(idx.size).toBe(sizeBefore);
        });
    });

    describe('empty index', () => {
        it('scores everything as 0', () => {
            const idx = EmbeddingIndex.empty();
            expect(idx.score('anything', 'v1.fact.whatever')).toBe(0);
        });

        it('has size 0', () => {
            expect(EmbeddingIndex.empty().size).toBe(0);
        });
    });
});
