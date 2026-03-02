import { describe, it, expect } from 'vitest';
import { generateStructuredDataset } from '../../tools/harness/generator';

describe('Harness generator (Story 9.1)', () => {
    it('generates dataset with expected shape and realistic sequence lengths', () => {
        const dataset = generateStructuredDataset({
            totalAtoms: 10000,
            avgChainLength: 12,
            branchFactor: 0.2,
            vocabularySize: 2000,
            seed: 7,
        });

        expect(Array.isArray(dataset.atoms)).toBe(true);
        expect(Array.isArray(dataset.sequences)).toBe(true);
        expect(dataset.atoms.length).toBe(10000);
        expect(dataset.sequences.length).toBeGreaterThan(0);
        expect(dataset.metadata.uniqueAtoms).toBeGreaterThan(9000);

        for (const seq of dataset.sequences.slice(0, 50)) {
            expect(seq.length).toBeGreaterThanOrEqual(3);
            for (const atom of seq) expect(typeof atom).toBe('string');
        }
    });

    it('is deterministic for the same seed/config', () => {
        const config = {
            totalAtoms: 10000,
            avgChainLength: 10,
            branchFactor: 0.1,
            vocabularySize: 1000,
            seed: 42,
        };

        const a = generateStructuredDataset(config);
        const b = generateStructuredDataset(config);

        expect(a.atoms[0]).toBe(b.atoms[0]);
        expect(a.atoms[500]).toBe(b.atoms[500]);
        expect(a.sequences[0]).toEqual(b.sequences[0]);
        expect(a.metadata.totalSequences).toBe(b.metadata.totalSequences);
    });
});
