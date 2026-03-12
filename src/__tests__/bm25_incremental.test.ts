import { describe, it, expect } from 'vitest';
import { Bm25Index, tokenizeText } from '../bm25';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeCorpus(atoms: string[]): Array<{ atom: string; semanticText: string }> {
    return atoms.map(a => {
        // Mimic server.ts semantic text format: "type value atom"
        const parts = a.split('.');
        const type = parts[1] ?? 'other';
        const value = parts.slice(2).join('_');
        return { atom: a, semanticText: `${type} ${value} ${a}` };
    });
}

// ─── tokenizeText ────────────────────────────────────────────────────

describe('tokenizeText', () => {
    it('lowercases and splits on non-alphanumeric', () => {
        expect(tokenizeText('Hello World')).toEqual(['hello', 'world']);
    });

    it('handles atom-style strings', () => {
        expect(tokenizeText('v1.fact.nginx_config')).toEqual(['v1', 'fact', 'nginx', 'config']);
    });

    it('returns empty array for empty string', () => {
        expect(tokenizeText('')).toEqual([]);
    });
});

// ─── Incremental addDocument ─────────────────────────────────────────

describe('Bm25Index — Incremental addDocument', () => {
    it('addDocument increases corpus size', () => {
        const idx = Bm25Index.empty();
        expect(idx.size).toBe(0);

        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        expect(idx.size).toBe(1);

        idx.addDocument('v1.fact.beta', 'fact beta v1.fact.beta');
        expect(idx.size).toBe(2);
    });

    it('addDocument is idempotent for the same atom', () => {
        const idx = Bm25Index.empty();
        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        expect(idx.size).toBe(1);
    });

    it('addDocument makes atom scoreable', () => {
        const idx = Bm25Index.empty();
        idx.addDocument('v1.fact.nginx_config', 'fact nginx_config v1.fact.nginx_config');
        const score = idx.score('nginx', 'v1.fact.nginx_config');
        expect(score).toBeGreaterThan(0);
    });

    it('score returns 0 for unknown atom', () => {
        const idx = Bm25Index.empty();
        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        expect(idx.score('alpha', 'v1.fact.nonexistent')).toBe(0);
    });

    it('incremental build matches full build — single atom', () => {
        const atoms = ['v1.fact.nginx_config'];
        const corpus = makeCorpus(atoms);

        // Full rebuild
        const full = Bm25Index.build(corpus);

        // Incremental
        const incr = Bm25Index.empty();
        for (const { atom, semanticText } of corpus) {
            incr.addDocument(atom, semanticText);
        }

        const query = 'nginx config';
        expect(incr.score(query, atoms[0])).toBeCloseTo(full.score(query, atoms[0]), 10);
    });

    it('incremental build matches full build — multiple atoms', () => {
        const atoms = [
            'v1.fact.nginx_config',
            'v1.fact.redis_cache',
            'v1.state.sprint_10_active',
            'v1.event.deploy_prod_dt_2026_03_10',
            'v1.relation.nginx_proxies_api',
        ];
        const corpus = makeCorpus(atoms);

        // Full rebuild
        const full = Bm25Index.build(corpus);

        // Incremental
        const incr = Bm25Index.empty();
        for (const { atom, semanticText } of corpus) {
            incr.addDocument(atom, semanticText);
        }

        // Verify every atom scores identically for several queries
        const queries = ['nginx', 'redis cache', 'sprint active', 'deploy prod', 'proxies api'];
        for (const q of queries) {
            for (const a of atoms) {
                const fullScore = full.score(q, a);
                const incrScore = incr.score(q, a);
                expect(incrScore).toBeCloseTo(fullScore, 10);
            }
        }
    });

    it('corpus stats match between full and incremental build', () => {
        const atoms = ['v1.fact.a', 'v1.fact.b', 'v1.fact.c'];
        const corpus = makeCorpus(atoms);

        const full = Bm25Index.build(corpus);
        const incr = Bm25Index.empty();
        for (const { atom, semanticText } of corpus) {
            incr.addDocument(atom, semanticText);
        }

        expect(incr.size).toBe(full.size);
        expect(incr.averageDocLength).toBeCloseTo(full.averageDocLength, 10);
    });
});

// ─── Incremental removeDocument ──────────────────────────────────────

describe('Bm25Index — Incremental removeDocument', () => {
    it('removeDocument decreases corpus size', () => {
        const atoms = ['v1.fact.a', 'v1.fact.b'];
        const corpus = makeCorpus(atoms);
        const idx = Bm25Index.build(corpus);
        expect(idx.size).toBe(2);

        idx.removeDocument('v1.fact.a');
        expect(idx.size).toBe(1);
    });

    it('removeDocument is no-op for unknown atom', () => {
        const idx = Bm25Index.empty();
        idx.addDocument('v1.fact.a', 'fact a v1.fact.a');
        idx.removeDocument('v1.fact.nonexistent');
        expect(idx.size).toBe(1);
    });

    it('removed atom scores 0', () => {
        const corpus = makeCorpus(['v1.fact.nginx', 'v1.fact.redis']);
        const idx = Bm25Index.build(corpus);

        expect(idx.score('nginx', 'v1.fact.nginx')).toBeGreaterThan(0);
        idx.removeDocument('v1.fact.nginx');
        expect(idx.score('nginx', 'v1.fact.nginx')).toBe(0);
    });

    it('removing atom does not affect scores of remaining atoms', () => {
        const atoms = ['v1.fact.nginx', 'v1.fact.redis', 'v1.fact.postgres'];
        const corpus = makeCorpus(atoms);

        // Build with all 3, record redis score
        const full3 = Bm25Index.build(corpus);
        const redisScore3 = full3.score('redis', 'v1.fact.redis');

        // Build with just redis + postgres (what incremental removal should produce)
        const corpus2 = makeCorpus(['v1.fact.redis', 'v1.fact.postgres']);
        const full2 = Bm25Index.build(corpus2);
        const redisScore2 = full2.score('redis', 'v1.fact.redis');

        // Incremental: start with 3, remove nginx
        const incr = Bm25Index.build(corpus);
        incr.removeDocument('v1.fact.nginx');
        const redisScoreIncr = incr.score('redis', 'v1.fact.redis');

        // Incremental removal should match a fresh build without the removed atom
        expect(redisScoreIncr).toBeCloseTo(redisScore2, 10);
        // Sanity: the incremental result is well-defined (non-zero)
        expect(redisScoreIncr).toBeGreaterThan(0);
    });

    it('add then remove returns to empty state', () => {
        const idx = Bm25Index.empty();
        idx.addDocument('v1.fact.temp', 'fact temp v1.fact.temp');
        expect(idx.size).toBe(1);
        idx.removeDocument('v1.fact.temp');
        expect(idx.size).toBe(0);
        expect(idx.averageDocLength).toBe(0);
    });
});

// ─── Mixed add/remove sequences ──────────────────────────────────────

describe('Bm25Index — Mixed incremental operations', () => {
    it('add-remove-add cycle works correctly', () => {
        const idx = Bm25Index.empty();

        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        expect(idx.size).toBe(1);
        expect(idx.score('alpha', 'v1.fact.alpha')).toBeGreaterThan(0);

        idx.removeDocument('v1.fact.alpha');
        expect(idx.size).toBe(0);
        expect(idx.score('alpha', 'v1.fact.alpha')).toBe(0);

        // Re-add
        idx.addDocument('v1.fact.alpha', 'fact alpha v1.fact.alpha');
        expect(idx.size).toBe(1);
        expect(idx.score('alpha', 'v1.fact.alpha')).toBeGreaterThan(0);
    });

    it('incremental add after full build matches extended full build', () => {
        const initial = ['v1.fact.nginx', 'v1.fact.redis'];
        const added = ['v1.state.sprint_10', 'v1.event.deploy_prod'];
        const allAtoms = [...initial, ...added];

        const corpus = makeCorpus(allAtoms);

        // Full build with all atoms
        const full = Bm25Index.build(corpus);

        // Incremental: build with initial, then add the rest
        const incr = Bm25Index.build(makeCorpus(initial));
        for (const { atom, semanticText } of makeCorpus(added)) {
            incr.addDocument(atom, semanticText);
        }

        // All scores should match
        const queries = ['nginx', 'redis', 'sprint', 'deploy'];
        for (const q of queries) {
            for (const a of allAtoms) {
                expect(incr.score(q, a)).toBeCloseTo(full.score(q, a), 10);
            }
        }

        expect(incr.size).toBe(full.size);
        expect(incr.averageDocLength).toBeCloseTo(full.averageDocLength, 10);
    });

    it('incremental remove after full build matches reduced full build', () => {
        const allAtoms = ['v1.fact.nginx', 'v1.fact.redis', 'v1.fact.postgres'];
        const remaining = ['v1.fact.redis', 'v1.fact.postgres'];

        // Full build with remaining only
        const full = Bm25Index.build(makeCorpus(remaining));

        // Incremental: build with all, remove nginx
        const incr = Bm25Index.build(makeCorpus(allAtoms));
        incr.removeDocument('v1.fact.nginx');

        const queries = ['redis', 'postgres', 'nginx'];
        for (const q of queries) {
            for (const a of remaining) {
                expect(incr.score(q, a)).toBeCloseTo(full.score(q, a), 10);
            }
        }
    });

    it('large corpus incremental equivalence (50 atoms)', () => {
        const atoms = Array.from({ length: 50 }, (_, i) =>
            `v1.fact.item_${String(i).padStart(3, '0')}_keyword_${i % 5 === 0 ? 'special' : 'normal'}`
        );
        const corpus = makeCorpus(atoms);

        const full = Bm25Index.build(corpus);

        const incr = Bm25Index.empty();
        for (const { atom, semanticText } of corpus) {
            incr.addDocument(atom, semanticText);
        }

        // Spot-check scores
        const queries = ['item', 'special', 'keyword normal', 'fact item 010'];
        for (const q of queries) {
            for (const a of atoms.slice(0, 10)) {
                expect(incr.score(q, a)).toBeCloseTo(full.score(q, a), 10);
            }
        }
        expect(incr.size).toBe(full.size);
    });
});

// ─── Diagnostics ─────────────────────────────────────────────────────

describe('Bm25Index — Diagnostic getters', () => {
    it('size and averageDocLength reflect incremental changes', () => {
        const idx = Bm25Index.empty();
        expect(idx.size).toBe(0);
        expect(idx.averageDocLength).toBe(0);

        idx.addDocument('v1.fact.short', 'a b');
        expect(idx.size).toBe(1);
        expect(idx.averageDocLength).toBe(2);

        idx.addDocument('v1.fact.long', 'a b c d e f');
        expect(idx.size).toBe(2);
        expect(idx.averageDocLength).toBe(4); // (2+6)/2

        idx.removeDocument('v1.fact.short');
        expect(idx.size).toBe(1);
        expect(idx.averageDocLength).toBe(6);
    });
});
