/**
 * Lifecycle Tests
 *
 * These tests verify end-to-end system behaviour using the ScenarioHarness.
 * Each scenario defines a precise data pool, training history, and expected outcomes.
 * The harness runs the full lifecycle (provision → train → capture → verify) and
 * the tests assert against the captured results.
 *
 * Test structure per scenario:
 *   1. All atoms in the pool are accessible (access() does not throw)
 *   2. All Merkle proofs are cryptographically valid (local + full chain)
 *   3. Every prediction expectation matches exactly what the system returned
 *   4. Latency for every access is within an acceptable ceiling
 *
 * Adding a new scenario: add a definition to fixtures/scenarios.ts — no test code
 * changes needed. The describe.each block picks it up automatically.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
    ScenarioHarness,
    HarnessRunResult,
    assertAllExpectations,
    assertAllProofsValid,
    assertAllAtomsAccessible,
    assertLatencyUnder,
} from './fixtures/harness';
import { ALL_SCENARIOS, TestScenario } from './fixtures/scenarios';

// ─── Parameterised lifecycle suite ───────────────────────────────────────────

describe.each(ALL_SCENARIOS)('Lifecycle: $name', (scenario: TestScenario) => {
    const harness = new ScenarioHarness();
    let result: HarnessRunResult;

    beforeAll(async () => {
        // Run the full lifecycle once; all it-blocks share the captured result.
        // This is intentional — it mirrors production behaviour where a cluster
        // reaches a trained state, then many clients read from it.
        result = await harness.run(scenario);
    }, 30_000); // generous timeout: LevelDB init + repeated training can be slow in CI

    afterAll(async () => {
        await harness.teardown();
    });

    // ── 1. Accessibility ────────────────────────────────────────────────────
    it('all atoms in the pool are accessible after training', () => {
        assertAllAtomsAccessible(result);
    });

    // ── 2. Cryptographic integrity ──────────────────────────────────────────
    it('all Merkle proofs are valid (leaf → shard → master)', () => {
        assertAllProofsValid(result);
    });

    // ── 3. Prediction correctness ────────────────────────────────────────────
    it('predictions match expected outcomes for all atoms', () => {
        assertAllExpectations(result);
    });

    // ── 4. Latency ceiling ──────────────────────────────────────────────────
    it('every access completes under 200ms', () => {
        assertLatencyUnder(result, 200);
    });

    // ── 5. Per-expectation drilldown ─────────────────────────────────────────
    // One it-block per expectation so failures identify the exact atom without
    // having to read the error message of the grouped assertion above.
    describe('per-atom prediction', () => {
        for (const exp of scenario.expectations) {
            it(`[${exp.from}] → ${exp.expectedNext ?? 'null'} (${exp.reason})`, () => {
                const entry = result.auditLog.get(exp.from);
                expect(entry, `Atom "${exp.from}" missing from audit log`).toBeDefined();
                expect(entry!.report.predictedNext).toBe(exp.expectedNext);
            });
        }
    });

    // ── 6. Proof detail for each atom ────────────────────────────────────────
    describe('per-atom proof integrity', () => {
        for (const exp of scenario.expectations) {
            it(`[${exp.from}] has a valid Merkle proof`, () => {
                const entry = result.auditLog.get(exp.from);
                expect(entry, `Atom "${exp.from}" missing from audit log`).toBeDefined();
                expect(entry!.localProofValid).toBe(true);
                expect(entry!.proofChainValid).toBe(true);
            });
        }
    });

    // ── 7. Report structure ──────────────────────────────────────────────────
    it('every PredictionReport has the required fields', () => {
        for (const [atom, entry] of result.auditLog) {
            const r = entry.report;
            expect(r.currentData, `currentData missing for ${atom}`).toBe(atom);
            expect(r.currentProof, `currentProof missing for ${atom}`).toBeTruthy();
            expect(r.currentProof.leaf, `proof.leaf missing for ${atom}`).toBeTruthy();
            expect(r.currentProof.root, `proof.root missing for ${atom}`).toBeTruthy();
            expect(typeof r.latencyMs, `latencyMs not a number for ${atom}`).toBe('number');
            expect(r.latencyMs, `latencyMs negative for ${atom}`).toBeGreaterThanOrEqual(0);
            if (r.predictedNext !== null) {
                expect(r.predictedProof, `predictedProof null although predictedNext exists for ${atom}`).toBeTruthy();
            }
        }
    });
});

// ─── Standalone audit log inspection ─────────────────────────────────────────
// These tests verify harness itself — that it correctly records state.

describe('ScenarioHarness — audit trail completeness', () => {
    it('audit log contains one entry per atom in the pool', async () => {
        const { LINEAR_CHAIN } = await import('./fixtures/scenarios');
        const harness = new ScenarioHarness();
        const result = await harness.run(LINEAR_CHAIN);
        await harness.teardown();

        expect(result.auditLog.size).toBe(LINEAR_CHAIN.atoms.length);
        for (const atom of LINEAR_CHAIN.atoms) {
            expect(result.auditLog.has(atom)).toBe(true);
        }
    });

    it('expectation results contain one entry per expectation', async () => {
        const { FORKING_PATH } = await import('./fixtures/scenarios');
        const harness = new ScenarioHarness();
        const result = await harness.run(FORKING_PATH);
        await harness.teardown();

        expect(result.expectationResults.length).toBe(FORKING_PATH.expectations.length);
    });

    it('expectation results reference the original expectation object', async () => {
        const { CIRCULAR } = await import('./fixtures/scenarios');
        const harness = new ScenarioHarness();
        const result = await harness.run(CIRCULAR);
        await harness.teardown();

        for (const expResult of result.expectationResults) {
            expect(CIRCULAR.expectations).toContain(expResult.expectation);
        }
    });
});

// ─── Harness isolation guarantee ─────────────────────────────────────────────
// Two harnesses running the same scenario must produce independent, identical results.

describe('ScenarioHarness — isolation', () => {
    it('two runs of the same scenario produce independent identical results', async () => {
        const { LINEAR_CHAIN } = await import('./fixtures/scenarios');

        const h1 = new ScenarioHarness();
        const h2 = new ScenarioHarness();

        const [r1, r2] = await Promise.all([
            h1.run(LINEAR_CHAIN),
            h2.run(LINEAR_CHAIN),
        ]);

        await Promise.all([h1.teardown(), h2.teardown()]);

        // Proof roots should be identical (same input data → same Merkle tree)
        for (const atom of LINEAR_CHAIN.atoms) {
            const e1 = r1.auditLog.get(atom)!;
            const e2 = r2.auditLog.get(atom)!;
            expect(e1.report.currentProof.root).toBe(e2.report.currentProof.root);
            expect(e1.report.predictedNext).toBe(e2.report.predictedNext);
        }
    });
});
