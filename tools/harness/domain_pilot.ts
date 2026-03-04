import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { buildApp } from '../../src/server';

type PilotPhaseReport = {
    phase: 'before' | 'after';
    utilityScore: number;
    matchedExpectedMemories: string[];
    expectedMemoryPatterns: string[];
    includedAtoms: number;
    highImpact: boolean;
    lowEvidenceFallback: boolean;
    evidenceCoverageComplete: boolean;
    excludedCount: number;
    fallbackReason: string | null;
};

export type DomainPilotReport = {
    scenario: string;
    generatedAt: string;
    objective: string;
    thresholds: {
        before: number;
        after: number;
    };
    before: PilotPhaseReport;
    after: PilotPhaseReport;
    delta: {
        utilityScore: number;
        includedAtoms: number;
        auditTraceCompleteImproved: boolean;
        fallbackResolved: boolean;
    };
    acceptance: {
        utilityImproved: boolean;
        auditTraceComplete: boolean;
        expectedOutcomeMet: boolean;
    };
};

type BootstrapResponse = {
    includedAtoms: number;
    topMemories: Array<{ atom: string }>;
    decisionEvidence: {
        coverage: {
            complete: boolean;
        };
    };
    evidenceGate: {
        lowEvidenceFallback: boolean;
        excludedCount: number;
        fallbackReason: string | null;
    };
};

const OBJECTIVE = 'requires refund window and photo evidence to resolve refund decision';
const EXPECTED_MEMORY_PATTERNS = [
    'policy_requires_refund_window_30_days',
    'policy_requires_photo_evidence',
    'current_focus_resolve_refund_decision',
];

const PILOT_PACK_ATOMS = [
    'v1.fact.policy_requires_refund_window_30_days_scope_project_src_human_conf_high_dt_2026_03_04',
    'v1.fact.policy_requires_photo_evidence_scope_project_src_human_conf_high_dt_2026_03_04',
    'v1.state.current_focus_resolve_refund_decision_scope_project_src_human_conf_high_dt_2026_03_04',
    'v1.relation.refund_decision_depends_on_delivery_damage_evidence_scope_project_src_human_conf_high_dt_2026_03_04',
    'v1.event.case_1024_reports_damaged_delivery_scope_project_src_human_conf_high_dt_2026_03_04',
];

async function injectJson<T>(server: FastifyInstance, options: InjectOptions): Promise<T> {
    const res = await server.inject(options);
    if (res.statusCode < 200 || res.statusCode >= 300) {
        throw new Error(`Request failed: ${options.method} ${options.url} => ${res.statusCode} ${res.payload}`);
    }
    return JSON.parse(res.payload) as T;
}

function buildPhaseReport(phase: 'before' | 'after', response: BootstrapResponse): PilotPhaseReport {
    const matchedExpectedMemories = response.topMemories
        .map(entry => entry.atom)
        .filter(atom => EXPECTED_MEMORY_PATTERNS.some(pattern => atom.includes(pattern)));

    const utilityScore = EXPECTED_MEMORY_PATTERNS.length > 0
        ? Number((matchedExpectedMemories.length / EXPECTED_MEMORY_PATTERNS.length).toFixed(6))
        : 0;

    return {
        phase,
        utilityScore,
        matchedExpectedMemories,
        expectedMemoryPatterns: [...EXPECTED_MEMORY_PATTERNS],
        includedAtoms: response.includedAtoms,
        highImpact: true,
        lowEvidenceFallback: response.evidenceGate.lowEvidenceFallback,
        evidenceCoverageComplete: response.decisionEvidence.coverage.complete,
        excludedCount: response.evidenceGate.excludedCount,
        fallbackReason: response.evidenceGate.fallbackReason,
    };
}

export async function runEcommerceDomainPilot(): Promise<DomainPilotReport> {
    const dbPath = await mkdtemp(join(tmpdir(), 'mmpm-domain-pilot-ecommerce-'));
    const app = buildApp({
        data: [
            'v1.other.pilot_seed_generic_a',
            'v1.other.pilot_seed_generic_b',
        ],
        dbBasePath: dbPath,
        numShards: 4,
    });

    await app.orchestrator.init();
    app.pipeline.start();

    try {
        const beforePayload = await injectJson<BootstrapResponse>(app.server, {
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: OBJECTIVE,
                highImpact: true,
                evidenceThreshold: 0.7,
                limit: 12,
            },
        });
        const before = buildPhaseReport('before', beforePayload);

        await injectJson<{ status: string }>(app.server, {
            method: 'POST',
            url: '/atoms',
            payload: { atoms: PILOT_PACK_ATOMS, reviewApproved: true },
        });
        await injectJson<{ status: string }>(app.server, {
            method: 'POST',
            url: '/admin/commit',
            payload: {},
        });

        const afterPayload = await injectJson<BootstrapResponse>(app.server, {
            method: 'POST',
            url: '/memory/bootstrap',
            payload: {
                objective: OBJECTIVE,
                highImpact: true,
                evidenceThreshold: 0.5,
                limit: 12,
            },
        });
        const after = buildPhaseReport('after', afterPayload);

        const report: DomainPilotReport = {
            scenario: 'ecommerce_refund_decision_pilot',
            generatedAt: new Date().toISOString(),
            objective: OBJECTIVE,
            thresholds: {
                before: 0.7,
                after: 0.5,
            },
            before,
            after,
            delta: {
                utilityScore: Number((after.utilityScore - before.utilityScore).toFixed(6)),
                includedAtoms: after.includedAtoms - before.includedAtoms,
                auditTraceCompleteImproved: !before.evidenceCoverageComplete && after.evidenceCoverageComplete,
                fallbackResolved: before.lowEvidenceFallback && !after.lowEvidenceFallback,
            },
            acceptance: {
                utilityImproved: after.utilityScore > before.utilityScore,
                auditTraceComplete: after.evidenceCoverageComplete,
                expectedOutcomeMet:
                    after.utilityScore > before.utilityScore &&
                    after.evidenceCoverageComplete &&
                    after.matchedExpectedMemories.length >= 2,
            },
        };

        return report;
    } finally {
        await app.pipeline.stop();
        await app.server.close();
        await app.orchestrator.close();
        await rm(dbPath, { recursive: true, force: true });
    }
}

async function runCli() {
    const outPath = resolve(process.argv.includes('--out')
        ? process.argv[process.argv.indexOf('--out') + 1]
        : 'tools/harness/results/domain-pilot-ecommerce.json');

    const report = await runEcommerceDomainPilot();
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('MMPM Domain Pilot (E2) — ecommerce_refund_decision_pilot');
    console.log(`Report: ${outPath}`);
    console.log(`Utility score: ${report.before.utilityScore.toFixed(3)} -> ${report.after.utilityScore.toFixed(3)} (delta ${report.delta.utilityScore.toFixed(3)})`);
    console.log(`Audit trace complete (after): ${report.after.evidenceCoverageComplete}`);
    console.log(`Fallback resolved: ${report.delta.fallbackResolved}`);
    console.log(`Expected outcome met: ${report.acceptance.expectedOutcomeMet}`);

    if (!report.acceptance.expectedOutcomeMet) {
        process.exit(1);
    }
}

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
