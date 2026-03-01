/**
 * ScenarioHarness
 *
 * Wraps a ShardedOrchestrator to provide a structured, auditable test lifecycle:
 *
 *   1. Provision  — create a fresh, isolated orchestrator for the scenario's atom pool
 *   2. Train      — replay all training steps (with repeats) against the orchestrator
 *   3. Capture    — access() every atom and record the full PredictionReport
 *   4. Verify     — assert expectations and validate proof chains
 *
 * Every step is tracked in an audit log so assertion failures include a clear
 * description of what happened at each stage for that specific atom.
 */
import { ShardedOrchestrator } from '../../orchestrator';
import { MMPMValidator } from '../../validator';
import { MerkleKernel } from '../../merkle';
import { DataAtom, PredictionReport } from '../../types';
import { TestScenario, PredictionExpectation } from './scenarios';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AtomAuditEntry {
    atom: DataAtom;
    report: PredictionReport;
    proofChainValid: boolean;
    localProofValid: boolean;
}

export interface HarnessRunResult {
    scenario: TestScenario;
    /** Full audit trail per accessed atom */
    auditLog: Map<DataAtom, AtomAuditEntry>;
    /** Results of each expectation check */
    expectationResults: ExpectationResult[];
}

export interface ExpectationResult {
    expectation: PredictionExpectation;
    passed: boolean;
    /**
     * What the system actually predicted.
     * `undefined` means the atom was not accessed (should not happen in practice).
     */
    actualNext: DataAtom | null | undefined;
    /** Human-readable result line for assertion output */
    summary: string;
}

// ─── ScenarioHarness ─────────────────────────────────────────────────────────

export class ScenarioHarness {
    private orchestrator: ShardedOrchestrator | null = null;
    private dbDir: string | null = null;

    /**
     * Run a complete scenario lifecycle and return the full audit result.
     *
     * This is the primary entry point: call once per scenario, then use the
     * returned HarnessRunResult to make assertions in your test.
     */
    async run(scenario: TestScenario): Promise<HarnessRunResult> {
        await this.provision(scenario);
        await this.train(scenario);
        const auditLog = await this.captureAll(scenario);
        const expectationResults = this.evaluateExpectations(scenario, auditLog);
        return { scenario, auditLog, expectationResults };
    }

    /** Tear down the orchestrator and delete the temp DB directory. */
    async teardown(): Promise<void> {
        if (this.orchestrator) {
            await this.orchestrator.close();
            this.orchestrator = null;
        }
        if (this.dbDir) {
            rmSync(this.dbDir, { recursive: true, force: true });
            this.dbDir = null;
        }
    }

    // ─── Private lifecycle steps ─────────────────────────────────────────────

    private async provision(scenario: TestScenario): Promise<void> {
        // Each scenario gets a fully isolated temp directory so tests
        // never share LevelDB state between scenarios or test runs.
        this.dbDir = mkdtempSync(join(tmpdir(), `mmpm-lifecycle-${scenario.name}-`));
        this.orchestrator = new ShardedOrchestrator(
            2, // two shards: enough to exercise cross-shard routing without overhead
            scenario.atoms,
            this.dbDir,
        );
        await this.orchestrator.init();
    }

    private async train(scenario: TestScenario): Promise<void> {
        if (!this.orchestrator) throw new Error('Harness not provisioned');
        for (const step of scenario.training) {
            const times = step.repeat ?? 1;
            for (let i = 0; i < times; i++) {
                await this.orchestrator.train(step.sequence);
            }
        }
    }

    private async captureAll(scenario: TestScenario): Promise<Map<DataAtom, AtomAuditEntry>> {
        if (!this.orchestrator) throw new Error('Harness not provisioned');
        const log = new Map<DataAtom, AtomAuditEntry>();

        for (const atom of scenario.atoms) {
            const report = await this.orchestrator.access(atom);
            const localProofValid = MerkleKernel.verifyProof(report.currentProof);

            // MMPMValidator is instance-based and requires the master root.
            // The master root is available on shardRootProof.root — the root of
            // the master Merkle tree over all shard roots.
            let proofChainValid = false;
            if (report.shardRootProof) {
                const masterRoot = report.shardRootProof.root;
                const validator = new MMPMValidator(masterRoot);
                proofChainValid = validator.validateReport(report);
            } else {
                // No shard root proof — treat local proof as the chain
                proofChainValid = localProofValid;
            }

            log.set(atom, {
                atom,
                report,
                localProofValid,
                proofChainValid,
            });
        }

        return log;
    }

    private evaluateExpectations(
        scenario: TestScenario,
        auditLog: Map<DataAtom, AtomAuditEntry>,
    ): ExpectationResult[] {
        return scenario.expectations.map(expectation => {
            const entry = auditLog.get(expectation.from);
            const actualNext = entry?.report.predictedNext;

            const passed = actualNext === expectation.expectedNext;

            const summary = passed
                ? `PASS  [${expectation.from}] predicted "${actualNext ?? 'null'}" ✓`
                : `FAIL  [${expectation.from}] expected "${expectation.expectedNext ?? 'null'}" ` +
                  `but got "${actualNext ?? 'null'}" — ${expectation.reason}`;

            return { expectation, passed, actualNext, summary };
        });
    }
}

// ─── Assertion Helpers ────────────────────────────────────────────────────────
// These are standalone helpers that produce clean vitest assertion messages.

/**
 * Assert that every PredictionExpectation in a run result passed.
 * Throws a descriptive error listing every failure if any exist.
 */
export function assertAllExpectations(result: HarnessRunResult): void {
    const failures = result.expectationResults.filter(r => !r.passed);
    if (failures.length > 0) {
        const lines = [
            `\nScenario "${result.scenario.name}" — ${failures.length} expectation(s) failed:\n`,
            ...failures.map(f => `  ${f.summary}`),
            '',
        ];
        throw new Error(lines.join('\n'));
    }
}

/**
 * Assert that all atoms in the scenario have valid Merkle proofs
 * (both local shard proof and full chain to master kernel).
 */
export function assertAllProofsValid(result: HarnessRunResult): void {
    const failures: string[] = [];

    for (const [atom, entry] of result.auditLog) {
        if (!entry.localProofValid) {
            failures.push(`  [${atom}] local Merkle proof is INVALID`);
        }
        if (!entry.proofChainValid) {
            failures.push(`  [${atom}] full chain proof (leaf→shard→master) is INVALID`);
        }
    }

    if (failures.length > 0) {
        throw new Error(
            `\nScenario "${result.scenario.name}" — proof failures:\n` +
            failures.join('\n') + '\n',
        );
    }
}

/**
 * Assert that every atom in the scenario is present in the audit log
 * (i.e. access() succeeded for all atoms, including untrained ones).
 */
export function assertAllAtomsAccessible(result: HarnessRunResult): void {
    const missing = result.scenario.atoms.filter(a => !result.auditLog.has(a));
    if (missing.length > 0) {
        throw new Error(
            `\nScenario "${result.scenario.name}" — atoms not accessible: [${missing.join(', ')}]\n`,
        );
    }
}

/**
 * Assert that latency for every access was under the given ceiling (ms).
 * Useful for catching pathological regressions in hot paths.
 */
export function assertLatencyUnder(result: HarnessRunResult, ceilingMs: number): void {
    const violations: string[] = [];

    for (const [atom, entry] of result.auditLog) {
        if (entry.report.latencyMs > ceilingMs) {
            violations.push(
                `  [${atom}] latency ${entry.report.latencyMs.toFixed(2)}ms > ${ceilingMs}ms ceiling`,
            );
        }
    }

    if (violations.length > 0) {
        throw new Error(
            `\nScenario "${result.scenario.name}" — latency violations:\n` +
            violations.join('\n') + '\n',
        );
    }
}
