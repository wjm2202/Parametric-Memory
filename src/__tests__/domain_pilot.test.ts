import { describe, it, expect } from 'vitest';
import { runEcommerceDomainPilot } from '../../tools/harness/domain_pilot';

describe('Domain pilot pack (E2)', () => {
    it('replays ecommerce pilot and shows utility + audit improvements', async () => {
        const report = await runEcommerceDomainPilot();

        expect(report.scenario).toBe('ecommerce_refund_decision_pilot');
        expect(report.before.lowEvidenceFallback).toBe(true);
        expect(report.after.lowEvidenceFallback).toBe(false);
        expect(report.after.utilityScore).toBeGreaterThan(report.before.utilityScore);
        expect(report.after.evidenceCoverageComplete).toBe(true);
        expect(report.delta.fallbackResolved).toBe(true);
        expect(report.acceptance.expectedOutcomeMet).toBe(true);
        expect(report.after.matchedExpectedMemories.length).toBeGreaterThanOrEqual(2);
    }, 30000);
});
