import { describe, it, expect } from 'vitest';
import { PpmModel } from '../ppm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const H = {
    setup:    'aa'.repeat(32),
    review:   'bb'.repeat(32),
    deploy:   'cc'.repeat(32),
    monitor:  'dd'.repeat(32),
    rollback: 'ee'.repeat(32),
};

/**
 * Train a reference model and serialize it to get a valid baseline.
 */
function getValidEntries(): Map<string, string> {
    const ppm = new PpmModel({ maxOrder: 3 });
    for (let i = 0; i < 5; i++) {
        ppm.train([H.setup, H.review, H.deploy, H.monitor]);
    }
    return ppm.serialize();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PPM Corruption Handling (Sprint 13)', () => {

    it('handles invalid JSON values gracefully', () => {
        const entries = getValidEntries();
        // Corrupt one entry with invalid JSON
        const firstNonRoot = Array.from(entries.keys()).find(k => k !== 'ppm:');
        if (firstNonRoot) {
            entries.set(firstNonRoot, 'NOT_JSON{{{');
        }

        const ppm = new PpmModel({ maxOrder: 3 });
        // Should not throw
        expect(() => ppm.deserialize(entries)).not.toThrow();
        // Model should still be functional (possibly degraded)
        expect(ppm.getStats().nodeCount).toBeGreaterThanOrEqual(1);
    });

    it('handles missing count field gracefully', () => {
        const entries = getValidEntries();
        const firstNonRoot = Array.from(entries.keys()).find(k => k !== 'ppm:');
        if (firstNonRoot) {
            entries.set(firstNonRoot, JSON.stringify({ children: ['abc'] }));
        }

        const ppm = new PpmModel({ maxOrder: 3 });
        expect(() => ppm.deserialize(entries)).not.toThrow();
    });

    it('handles missing children field gracefully', () => {
        const entries = getValidEntries();
        const firstNonRoot = Array.from(entries.keys()).find(k => k !== 'ppm:');
        if (firstNonRoot) {
            entries.set(firstNonRoot, JSON.stringify({ count: 5 }));
        }

        const ppm = new PpmModel({ maxOrder: 3 });
        expect(() => ppm.deserialize(entries)).not.toThrow();
    });

    it('handles children as non-array gracefully', () => {
        const entries = getValidEntries();
        const firstNonRoot = Array.from(entries.keys()).find(k => k !== 'ppm:');
        if (firstNonRoot) {
            entries.set(firstNonRoot, JSON.stringify({ count: 5, children: 'not_array' }));
        }

        const ppm = new PpmModel({ maxOrder: 3 });
        expect(() => ppm.deserialize(entries)).not.toThrow();
    });

    it('ignores entries with non-ppm: keys', () => {
        const entries = getValidEntries();
        entries.set('other:key', JSON.stringify({ count: 1, children: [] }));
        entries.set('ai:0000000001', 'some atom');

        const ppm = new PpmModel({ maxOrder: 3 });
        ppm.deserialize(entries);
        // Should work normally — extra keys ignored
        const validEntries = getValidEntries();
        const ppmClean = new PpmModel({ maxOrder: 3 });
        ppmClean.deserialize(validEntries);
        expect(ppm.getStats().nodeCount).toBe(ppmClean.getStats().nodeCount);
    });

    it('verify detects negative counts and caller can clear()', () => {
        const entries = getValidEntries();

        // Corrupt a deep node with a negative count
        const keys = Array.from(entries.keys())
            .filter(k => k !== 'ppm:')
            .sort((a, b) => b.length - a.length); // longest paths first (deeper nodes)

        if (keys.length > 0) {
            const deepKey = keys[0];
            const parsed = JSON.parse(entries.get(deepKey)!);
            parsed.count = -1;
            entries.set(deepKey, JSON.stringify(parsed));
        }

        const ppm = new PpmModel({ maxOrder: 3 });
        ppm.deserialize(entries);

        const warnings = ppm.verify();
        expect(warnings.length).toBeGreaterThan(0);

        // Graceful degradation: clear and start fresh
        ppm.clear();
        expect(ppm.getStats().nodeCount).toBe(1); // just root
        expect(ppm.predict()).toBeNull();
    });

    it('handles completely empty root entry', () => {
        const entries = new Map<string, string>();
        entries.set('ppm:', JSON.stringify({ count: 0, children: [] }));

        const ppm = new PpmModel();
        expect(() => ppm.deserialize(entries)).not.toThrow();
        expect(ppm.getStats().nodeCount).toBe(1); // just root
    });

    it('handles orphaned child references (child listed but no key)', () => {
        // Root says it has a child "abc" but there's no ppm:abc entry
        const entries = new Map<string, string>();
        entries.set('ppm:', JSON.stringify({ count: 5, children: ['abc', 'def'] }));
        // Only provide one child entry
        entries.set('ppm:abc', JSON.stringify({ count: 3, children: [] }));
        // "def" is referenced but has no entry — deserialize creates a placeholder

        const ppm = new PpmModel();
        expect(() => ppm.deserialize(entries)).not.toThrow();
        // Should have root + abc placeholder + def placeholder = at least 3
        expect(ppm.getStats().nodeCount).toBeGreaterThanOrEqual(3);
    });

    it('survives all-corrupt entries', () => {
        const entries = new Map<string, string>();
        entries.set('ppm:', 'GARBAGE');
        entries.set('ppm:abc', '{bad json');
        entries.set('ppm:abc/def', '42');

        const ppm = new PpmModel();
        expect(() => ppm.deserialize(entries)).not.toThrow();
        // Should be effectively empty
        expect(ppm.getStats().nodeCount).toBe(1); // just root
    });
});
