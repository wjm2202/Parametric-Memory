import 'dotenv/config';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import { ShardedOrchestrator } from './orchestrator';
import { IngestionPipeline } from './ingestion';
import { collectDefaultMetrics, register } from 'prom-client';
import {
    accessCounter,
    requestDuration,
    trainCounter,
    trainSequenceLength,
    atomDominanceRatio,
    atomTrainedEdges,
    clusterTotalEdges,
    clusterTrainedAtoms,
    transitionByTypeTotal,
} from './metrics';
import { logger } from './logger';
import { assertAtomsV1, ATOM_TYPES, AtomType, encodeAtomV1, isAtomV1, normalizeAtomInput, parseAtomV1 } from './atom_schema';
import { TransitionPolicy, TypePolicyConfig } from './transition_policy';
import { MerkleSnapshot } from './merkle_snapshot';
import { MerkleProof } from './types';
import { AuditLog, AuditEventType } from './audit_log';
import { TtlRegistry } from './ttl_registry';

// Collect Node.js / process metrics automatically (visible at GET /metrics)
collectDefaultMetrics();

interface BuildAppOpts {
    data?: string[];
    atomSeedFile?: string;   // path to a JSON file: ["atom1", "atom2", ...]
    dbBasePath?: string;
    numShards?: number;
    apiKey?: string;
}

const SCHEMA_ERROR = "schema v1 required: use 'v1.<type>.<value>' or object { type, value } with type in {fact,event,relation,state,procedure,other}.";
const DEFAULT_CONTEXT_MAX_TOKENS = 512;
const MAX_CONTEXT_MAX_TOKENS = 8000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_BOOTSTRAP_LIMIT = 12;
const MAX_ATOMS_PAGE_SIZE = 1000;
const DEFAULT_HIGH_IMPACT_EVIDENCE_THRESHOLD = 0.65;
const WRITE_POLICY_TIERS = ['auto-write', 'review-required', 'never-store'] as const;

type NamespaceScope = {
    user?: string;
    project?: string;
    task?: string;
    includeGlobal: boolean;
};

type ContextFormat = 'full' | 'compact';

type FactConflictEntry = {
    atom: string;
    claim: string;
    source: string | null;
    confidence: string | null;
    createdAtMs: number;
};

type FactConflictGroup = {
    key: string;
    claims: string[];
    entries: FactConflictEntry[];
};

type TemporalScope = {
    mode: 'current' | 'time' | 'version' | 'time+version';
    asOfMs: number | null;
    asOfVersion: number | null;
    effectiveAsOfMs: number | null;
    rootAtVersion: string | null;
};

type BootstrapProof = {
    leaf: string;
    root: string;
    auditPath: string[];
    index: number;
};

type BootstrapMemoryItem = {
    atom: string;
    type: string;
    value: string;
    category: 'goal' | 'constraint' | 'preference' | 'memory';
    relevance: number;
    createdAtMs: number;
    shardId: number;
    dominantNext: string | null;
    proof: BootstrapProof;
    contradiction: {
        hasConflict: boolean;
        conflictKey: string | null;
        competingClaims: FactConflictEntry[];
    };
};

type WritePolicyTier = (typeof WRITE_POLICY_TIERS)[number];

type WritePolicyConfig = {
    defaultTier: WritePolicyTier;
    byType: Partial<Record<AtomType, WritePolicyTier>>;
};

type WritePolicyEvaluation = {
    decision: 'allow' | 'review-required' | 'deny';
    reviewApproved: boolean;
    allowedAtoms: string[];
    reviewRequiredAtoms: string[];
    deniedAtoms: string[];
    policy: WritePolicyConfig;
};

function estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
}

function parseMaxTokens(input: unknown): number | null {
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input <= 0 || input > MAX_CONTEXT_MAX_TOKENS) return null;
        return input;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const parsed = parseInt(trimmed, 10);
        if (parsed <= 0 || parsed > MAX_CONTEXT_MAX_TOKENS) return null;
        return parsed;
    }
    return null;
}

function tokenizeText(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function semanticSimilarityScore(query: string, candidate: string): number {
    const q = new Set(tokenizeText(query));
    const c = new Set(tokenizeText(candidate));
    if (q.size === 0 || c.size === 0) return 0;

    let overlap = 0;
    for (const token of q) {
        if (c.has(token)) overlap++;
    }
    if (overlap === 0) return 0;

    const union = new Set([...q, ...c]).size;
    return overlap / union;
}

function parseSearchLimit(input: unknown): number | null {
    if (input === undefined) return DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(input) || (input as number) <= 0 || (input as number) > MAX_SEARCH_LIMIT) return null;
    return input as number;
}

function parseSearchThreshold(input: unknown): number | null {
    if (input === undefined) return 0;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 1) return null;
    return input;
}

function parseNamespaceValue(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const value = input.trim().toLowerCase();
    if (value.length === 0 || value.length > 64) return null;
    if (!/^[a-z0-9_-]+$/.test(value)) return null;
    return value;
}

function parseIncludeGlobal(input: unknown, fallback: boolean): boolean | null {
    if (input === undefined) return fallback;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'string') {
        const v = input.trim().toLowerCase();
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
    }
    return null;
}

function parseBooleanFlag(input: unknown, fallback: boolean): boolean | null {
    if (input === undefined) return fallback;
    return parseIncludeGlobal(input, fallback);
}

function stripAtomMetadataSuffix(value: string): string {
    const lower = value.toLowerCase();
    const metadataMarkers = ['_src_', '_conf_', '_scope_', '_dt_', '_ns_', '_namespace_'];
    let end = value.length;
    for (const marker of metadataMarkers) {
        const idx = lower.indexOf(marker);
        if (idx !== -1 && idx < end) end = idx;
    }
    return value.slice(0, end).replace(/^_+|_+$/g, '');
}

function summarizeAtomForCompactContext(atom: string): string {
    const parsed = parseAtomV1(atom);
    if (!parsed) return atom;
    const compactValue = stripAtomMetadataSuffix(parsed.value);
    if (compactValue.length === 0) return parsed.type;
    return `${parsed.type}:${compactValue}`;
}

function parseNamespaceScope(
    namespaceInput: unknown,
    includeGlobalInput: unknown,
    fallbackIncludeGlobal = true
): NamespaceScope | null {
    if (namespaceInput !== undefined && (typeof namespaceInput !== 'object' || namespaceInput === null || Array.isArray(namespaceInput))) {
        return null;
    }

    const ns = (namespaceInput ?? {}) as Record<string, unknown>;
    const userParsed = ns.user === undefined ? undefined : parseNamespaceValue(ns.user);
    const projectParsed = ns.project === undefined ? undefined : parseNamespaceValue(ns.project);
    const taskParsed = ns.task === undefined ? undefined : parseNamespaceValue(ns.task);
    if ((ns.user !== undefined && userParsed === null) || (ns.project !== undefined && projectParsed === null) || (ns.task !== undefined && taskParsed === null)) {
        return null;
    }
    const user = userParsed ?? undefined;
    const project = projectParsed ?? undefined;
    const task = taskParsed ?? undefined;

    const includeGlobal = parseIncludeGlobal(includeGlobalInput, fallbackIncludeGlobal);
    if (includeGlobal === null) return null;

    return { user, project, task, includeGlobal };
}

function parseNamespaceScopeFromQuery(query: Record<string, unknown>): NamespaceScope | null {
    return parseNamespaceScope(
        {
            user: query.namespaceUser,
            project: query.namespaceProject,
            task: query.namespaceTask,
        },
        query.includeGlobal,
        true
    );
}

function extractAtomNamespace(atom: string): Omit<NamespaceScope, 'includeGlobal'> {
    const parsed = parseAtomV1(atom);
    const value = parsed?.value.toLowerCase() ?? atom.toLowerCase();
    const found: Omit<NamespaceScope, 'includeGlobal'> = {};
    // Non-greedy with lookahead so multi-dim atoms (e.g. ns_user_alice_ns_project_proj1)
    // yield separate matches per dimension instead of one greedy match.
    const regex = /(?:^|_)(?:ns|namespace)_(user|project|task)_([a-z0-9_-]+?)(?=_(?:ns|namespace)_(?:user|project|task)_|$)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        const key = match[1] as 'user' | 'project' | 'task';
        if (!found[key]) found[key] = match[2];
    }
    return found;
}

function matchesNamespaceScope(atom: string, scope: NamespaceScope): boolean {
    const atomNs = extractAtomNamespace(atom);
    const checks: Array<keyof Omit<NamespaceScope, 'includeGlobal'>> = ['user', 'project', 'task'];

    for (const key of checks) {
        const expected = scope[key];
        if (!expected) continue;
        const actual = atomNs[key];
        if (actual === undefined) {
            if (!scope.includeGlobal) return false;
            continue;
        }
        if (actual !== expected) return false;
    }
    return true;
}

function parseFactClaim(atom: string): {
    key: string;
    claim: string;
    source: string | null;
    confidence: string | null;
} | null {
    const parsed = parseAtomV1(atom);
    if (!parsed || parsed.type !== 'fact') return null;

    const value = parsed.value.toLowerCase();
    const metadataMarkers = ['_src_', '_conf_', '_scope_', '_dt_', '_ns_', '_namespace_'];
    let coreEnd = value.length;
    for (const marker of metadataMarkers) {
        const idx = value.indexOf(marker);
        if (idx !== -1 && idx < coreEnd) coreEnd = idx;
    }
    const core = value.slice(0, coreEnd).replace(/^_+|_+$/g, '');
    const tokens = core.split('_').filter(Boolean);
    if (tokens.length < 2) return null;

    const key = tokens.slice(0, -1).join('_');
    const claim = tokens[tokens.length - 1];
    if (!key || !claim) return null;

    const sourceMatch = value.match(/(?:^|_)src_([a-z0-9_-]+)/);
    const confMatch = value.match(/(?:^|_)conf_([a-z0-9_-]+)/);

    return {
        key,
        claim,
        source: sourceMatch?.[1] ?? null,
        confidence: confMatch?.[1] ?? null,
    };
}

function buildFactConflictIndex(
    atoms: Array<{ atom: string; createdAtMs: number }>
): Map<string, FactConflictGroup> {
    const grouped = new Map<string, FactConflictEntry[]>();

    for (const row of atoms) {
        const claim = parseFactClaim(row.atom);
        if (!claim) continue;
        const entry: FactConflictEntry = {
            atom: row.atom,
            claim: claim.claim,
            source: claim.source,
            confidence: claim.confidence,
            createdAtMs: row.createdAtMs,
        };
        if (!grouped.has(claim.key)) grouped.set(claim.key, []);
        grouped.get(claim.key)!.push(entry);
    }

    const conflicts = new Map<string, FactConflictGroup>();
    for (const [key, entries] of grouped.entries()) {
        const claims = Array.from(new Set(entries.map(entry => entry.claim))).sort();
        if (claims.length < 2) continue;
        conflicts.set(key, {
            key,
            claims,
            entries: entries.sort((a, b) => b.createdAtMs - a.createdAtMs),
        });
    }

    return conflicts;
}

function getFactConflictForAtom(
    atom: string,
    conflicts: Map<string, FactConflictGroup>
): {
    hasConflict: boolean;
    conflictKey: string | null;
    competingClaims: FactConflictEntry[];
} {
    const parsed = parseFactClaim(atom);
    if (!parsed) {
        return { hasConflict: false, conflictKey: null, competingClaims: [] };
    }
    const group = conflicts.get(parsed.key);
    if (!group) {
        return { hasConflict: false, conflictKey: parsed.key, competingClaims: [] };
    }
    return {
        hasConflict: true,
        conflictKey: group.key,
        competingClaims: group.entries,
    };
}

function parseBootstrapLimit(input: unknown): number | null {
    if (input === undefined) return DEFAULT_BOOTSTRAP_LIMIT;
    if (!Number.isInteger(input) || (input as number) <= 0 || (input as number) > MAX_SEARCH_LIMIT) return null;
    return input as number;
}

function classifyBootstrapMemory(atom: string): 'goal' | 'constraint' | 'preference' | 'memory' {
    const parsed = parseAtomV1(atom);
    if (!parsed) return 'memory';

    const value = parsed.value.toLowerCase();
    if (value.includes('prefers_') || value.includes('preference_')) return 'preference';
    if (value.includes('requires_') || value.includes('must_') || value.includes('constraint_') || value.includes('policy_')) return 'constraint';
    if (value.includes('objective_') || value.includes('current_focus_') || value.includes('next_step_') || value.includes('sprint.')) return 'goal';
    return 'memory';
}

function buildDecisionEvidence(
    topMemories: BootstrapMemoryItem[],
    objectiveText: string,
    treeVersion: number,
    evidenceByMemory: Map<string, number>,
    thresholdGate: { applied: boolean; threshold: number }
) {
    const objectiveTokens = new Set(tokenizeText(objectiveText));

    const memoryIds = topMemories.map(item => item.atom);
    const proofReferences = topMemories.map(item => ({
        memoryId: item.atom,
        shardId: item.shardId,
        treeVersion,
        proofRoot: item.proof.root,
        proofLeaf: item.proof.leaf,
        proofIndex: item.proof.index,
    }));

    const retrievalRationale = topMemories.map((item, idx) => {
        const valueTokens = new Set(tokenizeText(item.value));
        const overlapCount = Array.from(objectiveTokens).filter(token => valueTokens.has(token)).length;
        const reasons: string[] = [];
        if (objectiveText.length > 0 && overlapCount > 0) {
            reasons.push(`objective_token_overlap=${overlapCount}`);
        }
        if (item.relevance > 0) {
            reasons.push(`semantic_relevance=${item.relevance}`);
        }
        if (item.category !== 'memory') {
            reasons.push(`category=${item.category}`);
        }
        if (item.contradiction.hasConflict && item.contradiction.conflictKey) {
            reasons.push(`conflict_key=${item.contradiction.conflictKey}`);
        }
        const evidenceScore = evidenceByMemory.get(item.atom) ?? 0;
        reasons.push(`evidence_score=${evidenceScore}`);
        if (thresholdGate.applied) {
            reasons.push(`threshold_gate=${evidenceScore >= thresholdGate.threshold ? 'pass' : 'fail'}`);
        }
        reasons.push(`rank=${idx + 1}`);

        return {
            memoryId: item.atom,
            rank: idx + 1,
            relevance: item.relevance,
            evidenceScore,
            category: item.category,
            createdAtMs: item.createdAtMs,
            hasConflict: item.contradiction.hasConflict,
            reasons,
        };
    });

    return {
        memoryIds,
        proofReferences,
        retrievalRationale,
        coverage: {
            memoryIds: memoryIds.length,
            proofReferences: proofReferences.length,
            retrievalRationale: retrievalRationale.length,
            complete:
                memoryIds.length > 0 &&
                memoryIds.length === proofReferences.length &&
                memoryIds.length === retrievalRationale.length,
        },
    };
}

function computeBootstrapEvidenceScore(item: BootstrapMemoryItem): number {
    const proofPresent = item.proof && typeof item.proof.root === 'string' && item.proof.root.length > 0;
    const categorySignal = item.category === 'memory' ? 0 : 1;
    const conflictPenalty = item.contradiction.hasConflict ? 0 : 1;

    const raw =
        (item.relevance * 0.55) +
        (proofPresent ? 0.25 : 0) +
        (categorySignal * 0.10) +
        (conflictPenalty * 0.10);

    const clamped = Math.max(0, Math.min(1, raw));
    return Number(clamped.toFixed(6));
}

function applyEvidenceThresholdGate(
    topMemories: BootstrapMemoryItem[],
    highImpact: boolean,
    threshold: number
): {
    included: BootstrapMemoryItem[];
    excluded: Array<{ memoryId: string; evidenceScore: number }>;
    evidenceByMemory: Map<string, number>;
    gate: {
        applied: boolean;
        threshold: number;
        inputCount: number;
        includedCount: number;
        excludedCount: number;
        lowEvidenceFallback: boolean;
        lowEvidenceUsageRate: number;
    };
} {
    const evidenceByMemory = new Map<string, number>();
    for (const item of topMemories) {
        evidenceByMemory.set(item.atom, computeBootstrapEvidenceScore(item));
    }

    if (!highImpact) {
        return {
            included: topMemories,
            excluded: [],
            evidenceByMemory,
            gate: {
                applied: false,
                threshold,
                inputCount: topMemories.length,
                includedCount: topMemories.length,
                excludedCount: 0,
                lowEvidenceFallback: false,
                lowEvidenceUsageRate: 0,
            },
        };
    }

    const included: BootstrapMemoryItem[] = [];
    const excluded: Array<{ memoryId: string; evidenceScore: number }> = [];
    for (const item of topMemories) {
        const score = evidenceByMemory.get(item.atom) ?? 0;
        if (score >= threshold) included.push(item);
        else excluded.push({ memoryId: item.atom, evidenceScore: score });
    }

    const inputCount = topMemories.length;
    const excludedCount = excluded.length;
    const lowEvidenceUsageRate = inputCount > 0 ? Number((excludedCount / inputCount).toFixed(6)) : 0;

    return {
        included,
        excluded,
        evidenceByMemory,
        gate: {
            applied: true,
            threshold,
            inputCount,
            includedCount: included.length,
            excludedCount,
            lowEvidenceFallback: included.length === 0 && inputCount > 0,
            lowEvidenceUsageRate,
        },
    };
}

function parseOptionalNonNegativeInt(input: unknown): number | null {
    if (input === undefined) return 0;
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input < 0) return null;
        return input;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        return parseInt(trimmed, 10);
    }
    return null;
}

function parseOptionalPositiveInt(input: unknown): number | null {
    if (input === undefined) return null;
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input <= 0 || input > MAX_ATOMS_PAGE_SIZE) return null;
        return input;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const parsed = parseInt(trimmed, 10);
        if (parsed <= 0 || parsed > MAX_ATOMS_PAGE_SIZE) return null;
        return parsed;
    }
    return null;
}

function parseAsOfMs(input: unknown): number | null {
    if (input === undefined) return null;
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input <= 0) return null;
        return input;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const parsed = parseInt(trimmed, 10);
        if (parsed <= 0) return null;
        return parsed;
    }
    return null;
}

function parseAsOfVersion(input: unknown): number | null {
    if (input === undefined) return null;
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input < 0) return null;
        return input;
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        return parseInt(trimmed, 10);
    }
    return null;
}

function isAtomType(value: unknown): value is AtomType {
    return typeof value === 'string' && (ATOM_TYPES as readonly string[]).includes(value);
}

function parsePolicyConfig(input: unknown): TypePolicyConfig | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const raw = input as Record<string, unknown>;
    const config: TypePolicyConfig = {};

    for (const [fromKey, toList] of Object.entries(raw)) {
        if (!isAtomType(fromKey)) return null;
        if (!Array.isArray(toList)) return null;
        if (!toList.every(isAtomType)) return null;
        config[fromKey] = toList as AtomType[];
    }

    return config;
}

function isWritePolicyTier(value: unknown): value is WritePolicyTier {
    return typeof value === 'string' && (WRITE_POLICY_TIERS as readonly string[]).includes(value);
}

function createDefaultWritePolicy(): WritePolicyConfig {
    return {
        defaultTier: 'auto-write',
        byType: {},
    };
}

function parseWritePolicyConfig(input: unknown): WritePolicyConfig | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const raw = input as Record<string, unknown>;

    const defaultTierInput = raw.defaultTier;
    const defaultTier = defaultTierInput === undefined
        ? 'auto-write'
        : (isWritePolicyTier(defaultTierInput) ? defaultTierInput : null);
    if (defaultTier === null) return null;

    const byTypeInput = raw.byType;
    const byType: Partial<Record<AtomType, WritePolicyTier>> = {};
    if (byTypeInput !== undefined) {
        if (!byTypeInput || typeof byTypeInput !== 'object' || Array.isArray(byTypeInput)) return null;
        const rawByType = byTypeInput as Record<string, unknown>;
        for (const [atomType, tier] of Object.entries(rawByType)) {
            if (!isAtomType(atomType)) return null;
            if (!isWritePolicyTier(tier)) return null;
            byType[atomType] = tier;
        }
    }

    return { defaultTier, byType };
}

function resolveWriteTierForAtom(atom: string, policy: WritePolicyConfig): WritePolicyTier {
    const parsed = parseAtomV1(atom);
    const atomType = parsed?.type ?? 'other';
    return policy.byType[atomType] ?? policy.defaultTier;
}

function evaluateWritePolicy(atoms: string[], policy: WritePolicyConfig, reviewApproved: boolean): WritePolicyEvaluation {
    const allowedAtoms: string[] = [];
    const reviewRequiredAtoms: string[] = [];
    const deniedAtoms: string[] = [];

    for (const atom of atoms) {
        const tier = resolveWriteTierForAtom(atom, policy);
        if (tier === 'never-store') {
            deniedAtoms.push(atom);
        } else if (tier === 'review-required' && !reviewApproved) {
            reviewRequiredAtoms.push(atom);
        } else {
            allowedAtoms.push(atom);
        }
    }

    const decision: WritePolicyEvaluation['decision'] =
        deniedAtoms.length > 0 ? 'deny'
            : reviewRequiredAtoms.length > 0 ? 'review-required'
                : 'allow';

    return {
        decision,
        reviewApproved,
        allowedAtoms,
        reviewRequiredAtoms,
        deniedAtoms,
        policy,
    };
}

/** Load a JSON seed file and return its atom array, or null on any error. */
function loadSeedFile(filePath: string): string[] | null {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            logger.warn(`MMPM seed file '${filePath}' must be a JSON array — ignored.`);
            return null;
        }
        const normalized = parsed.map(normalizeAtomInput);
        if (normalized.some(x => x === null)) {
            logger.warn(`MMPM seed file '${filePath}' contains non-v1 atoms — ignored.`);
            return null;
        }
        if (parsed.length === 0) {
            logger.warn(`MMPM seed file '${filePath}' is empty — ignored.`);
            return null;
        }
        logger.info(`MMPM loaded ${normalized.length} schema-v1 atoms from seed file: ${filePath}`);
        return normalized as string[];
    } catch (e: any) {
        logger.warn(`MMPM could not read seed file '${filePath}': ${e.message}`);
        return null;
    }
}

export function buildApp(opts: BuildAppOpts = {}): { server: FastifyInstance; orchestrator: ShardedOrchestrator; pipeline: IngestionPipeline; auditLog: AuditLog } {
    // 14-H-1: Thread x-request-id across every request so log lines and error
    // responses share a correlation ID.  Clients that set their own ID are
    // honoured; otherwise a short monotonic counter is used.
    let _reqCounter = 0;
    const server = Fastify({
        logger: { level: process.env.LOG_LEVEL ?? 'info' },
        requestIdHeader: 'x-request-id',
        genReqId: () => String(++_reqCounter),
    });
    // 14-A-3: Audit log — bounded ring buffer of mutation events.
    const auditLog = new AuditLog(parseInt(process.env.MMPM_AUDIT_LOG_MAX_ENTRIES ?? '1000', 10));

    // 14-C-1: TTL registry — optional per-atom expiry with access-aware reset.
    const ttlRegistry = new TtlRegistry();

    server.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
        const rawBody = typeof body === 'string' ? body : body.toString('utf8');
        if (rawBody.trim().length === 0) {
            done(null, {});
            return;
        }
        try {
            done(null, JSON.parse(rawBody));
        } catch (error: unknown) {
            done(error instanceof Error ? error : new Error('Invalid JSON payload'), undefined);
        }
    });
    const numShards = opts.numShards ?? parseInt(process.env.SHARD_COUNT ?? '4');
    // Resolve DB path: expand leading ~ so .env values like ~/.mmpm/data work
    // correctly across all run modes (Docker, start.sh, MCP).
    // Default to ~/.mmpm/data so the DB lives outside the git repo by default.
    const expandHome = (p: string) =>
        p.startsWith('~/') || p === '~'
            ? path.join(os.homedir(), p.slice(1))
            : p;
    const dbBasePath = expandHome(
        opts.dbBasePath ?? (process.env.DB_BASE_PATH ?? path.join(os.homedir(), '.mmpm', 'data'))
    );

    // Atom resolution order (first non-null wins):
    //   1. opts.data  — programmatic / test usage
    //   2. opts.atomSeedFile or MMPM_ATOM_FILE  — JSON file mounted at deploy time
    //   3. MMPM_INITIAL_DATA  — comma-separated env var (legacy / simple cases)
    //   4. built-in defaults
    const seedFilePath = opts.atomSeedFile ?? process.env.MMPM_ATOM_FILE;
    const initialData =
        opts.data ??
        (seedFilePath ? loadSeedFile(seedFilePath) : null) ??
        (process.env.MMPM_INITIAL_DATA?.split(',')) ??
        [
            encodeAtomV1('other', 'Node_A'),
            encodeAtomV1('other', 'Node_B'),
            encodeAtomV1('other', 'Node_C'),
            encodeAtomV1('other', 'Node_D'),
            encodeAtomV1('other', 'Node_E'),
            encodeAtomV1('other', 'Step_1'),
            encodeAtomV1('other', 'Step_2'),
        ];

    assertAtomsV1(initialData, 'initialData');

    const apiKey = opts.apiKey ?? (process.env.MMPM_API_KEY || undefined);
    const orchestrator = new ShardedOrchestrator(numShards, initialData, dbBasePath);
    // Ingestion pipeline: batches incoming atoms, flushes without blocking reads.
    // batchSize and flushIntervalMs can be tuned via env vars.
    const pipeline = new IngestionPipeline(orchestrator, {
        batchSize: parseInt(process.env.INGEST_BATCH_SIZE ?? '100'),
        flushIntervalMs: parseInt(process.env.INGEST_FLUSH_MS ?? '1000'),
    });
    let writePolicy: WritePolicyConfig = createDefaultWritePolicy();

    // Paths that bypass auth and readiness checks.
    // POST /verify is public by design — third-party auditors must be able to
    // verify proofs without API credentials.
    const probePaths = new Set(['/metrics', '/health', '/ready', '/verify']);

    const resolveTemporalScope = (asOfMsInput: unknown, asOfVersionInput: unknown):
        | { ok: true; scope: TemporalScope }
        | { ok: false; statusCode: number; error: string } => {
        const asOfMs = parseAsOfMs(asOfMsInput);
        const asOfVersion = parseAsOfVersion(asOfVersionInput);

        if (asOfMsInput !== undefined && asOfMs === null) {
            return { ok: false, statusCode: 400, error: "Property 'asOfMs' must be a positive integer Unix timestamp (ms)." };
        }
        if (asOfVersionInput !== undefined && asOfVersion === null) {
            return { ok: false, statusCode: 400, error: "Property 'asOfVersion' must be a non-negative integer." };
        }

        const currentVersion = orchestrator.getMasterVersion();
        if (asOfVersion !== null && asOfVersion > currentVersion) {
            return { ok: false, statusCode: 400, error: `Requested asOfVersion ${asOfVersion} exceeds current version ${currentVersion}.` };
        }

        let versionTimestamp: number | null = null;
        let rootAtVersion: string | null = null;
        if (asOfVersion !== null) {
            if (asOfVersion === currentVersion) {
                versionTimestamp = Date.now();
                rootAtVersion = orchestrator.getMasterRootAtVersion(currentVersion) ?? null;
            } else {
                const ts = orchestrator.getMasterVersionTimestamp(asOfVersion);
                const root = orchestrator.getMasterRootAtVersion(asOfVersion);
                if (ts === undefined || root === undefined) {
                    return {
                        ok: false,
                        statusCode: 400,
                        error: `Requested asOfVersion ${asOfVersion} is outside retained history window.`,
                    };
                }
                versionTimestamp = ts;
                rootAtVersion = root;
            }
        }

        if (asOfMs !== null && versionTimestamp !== null && asOfMs < versionTimestamp) {
            return {
                ok: false,
                statusCode: 400,
                error: 'Provided asOfMs is earlier than the commit timestamp for requested asOfVersion.',
            };
        }

        const effectiveAsOfMs = asOfMs !== null && versionTimestamp !== null
            ? Math.min(asOfMs, versionTimestamp)
            : (asOfMs ?? versionTimestamp ?? null);

        const mode: TemporalScope['mode'] =
            asOfMs !== null && asOfVersion !== null ? 'time+version'
                : asOfVersion !== null ? 'version'
                    : asOfMs !== null ? 'time'
                        : 'current';

        return {
            ok: true,
            scope: {
                mode,
                asOfMs,
                asOfVersion,
                effectiveAsOfMs,
                rootAtVersion,
            },
        };
    };

    // Optional Bearer token auth — /metrics always bypasses
    if (apiKey) {
        server.addHook('onRequest', async (request, reply) => {
            if (probePaths.has(request.url)) return;
            const auth = request.headers.authorization;
            if (!auth || auth !== `Bearer ${apiKey}`) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        });
    }

    // Startup/readiness guard for strict orchestrator behavior.
    // Probes remain available while the service is still initializing.
    server.addHook('onRequest', async (request, reply) => {
        if (probePaths.has(request.url)) return;
        if (!orchestrator.isReady()) {
            reply.header('Retry-After', '1');
            return reply.status(503).send({
                error: 'Service unavailable: orchestrator not ready',
                ready: false,
            });
        }
    });

    /**
     * POST /access  —  Body: { "data": "Node_A" }
     */
    server.post('/access', async (request, reply) => {
        let item: string | undefined;
        let warmRead = false;
        try {
            const body = request.body as { data?: unknown; warmRead?: boolean };
            item = normalizeAtomInput(body.data) ?? undefined;
            warmRead = body.warmRead === true;
            if (!item) {
                return reply.status(400).send({ error: `Property 'data' invalid — ${SCHEMA_ERROR}` });
            }
            const report = await orchestrator.access(item);
            ttlRegistry.touch(item); // 14-C-1: reset TTL clock on access
            const result = report.predictedNext !== null ? 'hit' : 'miss';
            accessCounter.inc({ result });
            requestDuration.observe(report.latencyMs);
            return { ...report, verified: true };
        } catch (e: any) {
            if (warmRead && item) {
                const warm = orchestrator.tryWarmRead(item);
                if (warm) {
                    accessCounter.inc({ result: 'miss' });
                    requestDuration.observe(warm.latencyMs);
                    return warm;
                }
                if (pipeline.getQueuedAtoms().includes(item)) {
                    const queuedWarm = {
                        currentData: item,
                        currentProof: null,
                        predictedNext: null,
                        predictedProof: null,
                        latencyMs: 0,
                        treeVersion: orchestrator.getMasterVersion(),
                        verified: false,
                    };
                    accessCounter.inc({ result: 'miss' });
                    requestDuration.observe(queuedWarm.latencyMs);
                    return queuedWarm;
                }
            }
            accessCounter.inc({ result: 'error' });
            return reply.status(404).send({ error: e.message });
        }
    });

    /**
     * POST /batch-access  —  Body: { "items": ["v1.other.A", ...] }
     *
     * Performs batched reads with shard-level grouping and a single epoch read
     * ticket per shard batch. Unknown/tombstoned/pending items are returned as
     * per-item error records; the overall request still returns 200.
     */
    server.post('/batch-access', async (request, reply) => {
        try {
            const { items } = request.body as { items?: unknown };
            if (!Array.isArray(items) || items.length === 0) {
                return reply.status(400).send({ error: "Property 'items' must be a non-empty array." });
            }

            const normalized = items.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `Property 'items' invalid — ${SCHEMA_ERROR}` });
            }

            const results = await orchestrator.batchAccess(normalized as string[]);
            ttlRegistry.touchAll(normalized as string[]); // 14-C-1: reset TTL clocks on batch access
            return { results };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /policy  —  Return the current transition policy.
     */
    server.get('/policy', async () => {
        const policy = orchestrator.getPolicy();
        const isDefault = policy.isOpenPolicy();
        return {
            policy: isDefault ? 'default' : policy.toConfig(),
            isDefault,
        };
    });

    /**
     * POST /policy  —  Set restricted policy or reset to default.
     * Body: { policy: TypePolicyConfig } | { policy: 'default' }
     */
    server.post('/policy', async (request, reply) => {
        const { policy } = (request.body ?? {}) as { policy?: unknown };

        if (policy === 'default') {
            const next = TransitionPolicy.default();
            orchestrator.setPolicy(next);
            return {
                status: 'PolicyUpdated',
                isDefault: true,
                policy: next.toConfig(),
            };
        }

        const cfg = parsePolicyConfig(policy);
        if (!cfg) {
            return reply.status(400).send({
                error: "Property 'policy' must be 'default' or an object mapping valid AtomType keys to AtomType[] values.",
            });
        }

        const next = TransitionPolicy.fromConfig(cfg);
        orchestrator.setPolicy(next);
        return {
            status: 'PolicyUpdated',
            isDefault: next.isOpenPolicy(),
            policy: next.toConfig(),
        };
    });

    /**
     * GET /write-policy  —  Return current memory-write policy tiers.
     */
    server.get('/write-policy', async () => {
        const isDefault = writePolicy.defaultTier === 'auto-write' && Object.keys(writePolicy.byType).length === 0;
        return {
            policy: writePolicy,
            isDefault,
        };
    });

    /**
     * POST /write-policy  —  Set write policy tiers or reset to default.
     * Body: { policy: { defaultTier?: WritePolicyTier, byType?: Record<AtomType, WritePolicyTier> } }
     *    or: { policy: 'default' }
     */
    server.post('/write-policy', async (request, reply) => {
        const { policy } = (request.body ?? {}) as { policy?: unknown };

        if (policy === 'default') {
            writePolicy = createDefaultWritePolicy();
            return {
                status: 'WritePolicyUpdated',
                isDefault: true,
                policy: writePolicy,
            };
        }

        const parsed = parseWritePolicyConfig(policy);
        if (!parsed) {
            return reply.status(400).send({
                error: "Property 'policy' must be 'default' or an object with optional defaultTier and byType atom-type mappings to one of: auto-write, review-required, never-store.",
            });
        }

        writePolicy = parsed;
        const isDefault = writePolicy.defaultTier === 'auto-write' && Object.keys(writePolicy.byType).length === 0;
        return {
            status: 'WritePolicyUpdated',
            isDefault,
            policy: writePolicy,
        };
    });

    /**
     * POST /train  —  Body: { "sequence": ["Node_A", "Node_B"] }
     */
    server.post('/train', async (request, reply) => {
        try {
            const { sequence } = request.body as { sequence?: unknown };
            if (!sequence || !Array.isArray(sequence) || sequence.length === 0) {
                return reply.status(400).send({ error: "Property 'sequence' must be a non-empty array." });
            }
            const normalized = sequence.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `Property 'sequence' invalid — ${SCHEMA_ERROR}` });
            }
            await orchestrator.train(normalized as string[]);
            trainCounter.inc();
            trainSequenceLength.observe(normalized.length);

            for (let i = 0; i < normalized.length - 1; i++) {
                const fromType = parseAtomV1(normalized[i] as string)?.type ?? 'other';
                const toType = parseAtomV1(normalized[i + 1] as string)?.type ?? 'other';
                transitionByTypeTotal.inc({ from_type: fromType, to_type: toType });
            }

            // Update per-atom learning metrics.
            // Only iterates atoms that appeared as `from` in this sequence —
            // O(sequence_length - 1), never scans the full atom pool.
            const fromAtoms = new Set((normalized as string[]).slice(0, -1));
            for (const atom of fromAtoms) {
                const weights = orchestrator.getWeights(atom);
                if (weights && weights.length > 0) {
                    const total = weights.reduce((s, t) => s + t.effectiveWeight, 0);
                    atomDominanceRatio.set({ atom }, total > 0 ? weights[0].effectiveWeight / total : 0);
                    atomTrainedEdges.set({ atom }, weights.length);
                }
            }
            // Cluster-level totals — O(shards), not O(atoms)
            const stats = orchestrator.getClusterStats();
            clusterTotalEdges.set(stats.totalEdges);
            clusterTrainedAtoms.set(stats.trainedAtoms);

            return { status: 'Success', message: `Trained path of length ${normalized.length} across shards.` };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * POST /search  —  Semantic/lexical MVP retrieval over active atoms.
     * Body: { query: string, limit?: number, threshold?: number }
     */
    server.post('/search', async (request, reply) => {
        const startedAt = Date.now();
        const { query, limit, threshold, namespace, includeGlobal, asOfMs, asOfVersion } = (request.body ?? {}) as {
            query?: unknown;
            limit?: unknown;
            threshold?: unknown;
            namespace?: unknown;
            includeGlobal?: unknown;
            asOfMs?: unknown;
            asOfVersion?: unknown;
        };

        if (typeof query !== 'string' || query.trim().length === 0) {
            return reply.status(400).send({ error: "Property 'query' must be a non-empty string." });
        }

        const parsedLimit = parseSearchLimit(limit);
        if (parsedLimit === null) {
            return reply.status(400).send({ error: `Property 'limit' must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` });
        }

        const parsedThreshold = parseSearchThreshold(threshold);
        if (parsedThreshold === null) {
            return reply.status(400).send({ error: "Property 'threshold' must be a number between 0 and 1." });
        }

        const namespaceScope = parseNamespaceScope(namespace, includeGlobal, true);
        if (namespaceScope === null) {
            return reply.status(400).send({ error: "Property 'namespace' must be an object with optional user/project/task strings; includeGlobal must be boolean when provided." });
        }

        const temporal = resolveTemporalScope(asOfMs, asOfVersion);
        if (!temporal.ok) return reply.status(temporal.statusCode).send({ error: temporal.error });

        const activeAtoms = orchestrator
            .listAtoms()
            .filter(entry => entry.status === 'active')
            .filter(entry => matchesNamespaceScope(entry.atom, namespaceScope))
            .map(entry => orchestrator.inspectAtom(entry.atom))
            .filter(entry => {
                if (!entry) return false;
                // Use integer version comparison when asOfVersion is set — no timing ambiguity.
                if (temporal.scope.asOfVersion !== null) {
                    return entry.committedAtVersion <= temporal.scope.asOfVersion;
                }
                if (temporal.scope.effectiveAsOfMs === null) return true;
                return entry.createdAtMs <= temporal.scope.effectiveAsOfMs;
            })
            .filter((entry): entry is NonNullable<ReturnType<typeof orchestrator.inspectAtom>> => entry !== null);

        const conflictIndex = buildFactConflictIndex(activeAtoms.map(entry => ({
            atom: entry.atom,
            createdAtMs: entry.createdAtMs,
        })));

        const scored = activeAtoms
            .map(entry => {
                const parsed = parseAtomV1(entry.atom);
                const semanticText = parsed ? `${parsed.type} ${parsed.value} ${entry.atom}` : entry.atom;
                const similarity = semanticSimilarityScore(query, semanticText);
                return { entry, similarity };
            })
            .filter(item => item.similarity >= parsedThreshold)
            .sort((a, b) => {
                if (b.similarity !== a.similarity) return b.similarity - a.similarity;
                if (b.entry.createdAtMs !== a.entry.createdAtMs) return b.entry.createdAtMs - a.entry.createdAtMs;
                return a.entry.atom.localeCompare(b.entry.atom);
            })
            .slice(0, parsedLimit);

        const results = await Promise.all(
            scored.map(async (item, index) => {
                const report = await orchestrator.access(item.entry.atom);
                return {
                    atom: item.entry.atom,
                    similarity: Number(item.similarity.toFixed(6)),
                    rank: index + 1,
                    shardId: item.entry.shard,
                    proof: report.currentProof,
                    contradiction: getFactConflictForAtom(item.entry.atom, conflictIndex),
                };
            })
        );

        return {
            mode: 'semantic',
            query,
            namespace: namespaceScope,
            temporal: temporal.scope,
            results,
            searchTimeMs: Date.now() - startedAt,
            treeVersion: orchestrator.getMasterVersion(),
        };
    });

    /**
     * GET /weights/:atom  —  Introspect Markov weights for a single atom.
     * Read-only. Returns outgoing transitions sorted by weight descending.
     * Response includes dominanceRatio so callers can assess prediction confidence.
     */
    server.get('/weights/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        const transitions = orchestrator.getWeights(atom);
        if (transitions === null) {
            return reply.status(404).send({ error: `Atom '${atom}' not found in any shard.` });
        }
        const totalWeight = transitions.reduce((s, t) => s + t.weight, 0);
        const totalEffectiveWeight = transitions.reduce((s, t) => s + t.effectiveWeight, 0);
        return {
            atom,
            transitions,
            totalWeight,
            totalEffectiveWeight,
            dominantNext: transitions[0]?.to ?? null,
            dominanceRatio: totalEffectiveWeight > 0 ? transitions[0].effectiveWeight / totalEffectiveWeight : null,
        };
    });

    /**
     * GET /health  —  Live cluster health check.
     * Returns per-shard status: pending writes, snapshot version,
     * commit state, active reader count, plus aggregate cluster stats.
     */
    server.get('/health', async () => {
        return {
            status: 'ok',
            ready: orchestrator.isReady(),
            ...orchestrator.getClusterHealth(),
        };
    });

    /**
     * GET /ready  —  strict readiness endpoint for orchestrators.
     * 200 when serving traffic is safe; 503 otherwise.
     */
    server.get('/ready', async (_, reply) => {
        const ready = orchestrator.isReady();
        if (!ready) return reply.status(503).send({ ready: false });
        return { ready: true };
    });

    /**
     * GET /memory/context  —  Build a compact context block from active atoms.
     * Query: ?maxTokens=<positive integer, default 512, max 8000>&compact=<boolean>
     */
    server.get('/memory/context', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const { maxTokens, objectiveRank } = query as { maxTokens?: unknown, objectiveRank?: unknown };
        const budget = maxTokens === undefined ? DEFAULT_CONTEXT_MAX_TOKENS : parseMaxTokens(maxTokens);
        if (budget === null) {
            return reply.status(400).send({ error: "Query param 'maxTokens' must be a positive integer <= 8000." });
        }

        const namespaceScope = parseNamespaceScopeFromQuery(query);
        if (namespaceScope === null) {
            return reply.status(400).send({ error: "Namespace query params invalid. Use namespaceUser/namespaceProject/namespaceTask with [a-z0-9_-], includeGlobal as boolean." });
        }

        const compact = parseBooleanFlag(query.compact, false);
        if (compact === null) {
            return reply.status(400).send({ error: "Query param 'compact' must be boolean when provided." });
        }
        const contextFormat: ContextFormat = compact ? 'compact' : 'full';

        const rankByObjective = parseBooleanFlag(objectiveRank, false);
        if (objectiveRank !== undefined && rankByObjective === null) {
            return reply.status(400).send({ error: "Query param 'objectiveRank' must be boolean when provided." });
        }

        const temporal = resolveTemporalScope(query.asOfMs, query.asOfVersion);
        if (!temporal.ok) return reply.status(temporal.statusCode).send({ error: temporal.error });

        let activeAtoms = orchestrator
            .listAtoms()
            .filter(entry => entry.status === 'active')
            .filter(entry => matchesNamespaceScope(entry.atom, namespaceScope))
            .map(entry => orchestrator.inspectAtom(entry.atom))
            .filter(entry => {
                if (!entry) return false;
                // Use integer version comparison when asOfVersion is set — no timing ambiguity.
                if (temporal.scope.asOfVersion !== null) {
                    return entry.committedAtVersion <= temporal.scope.asOfVersion;
                }
                if (temporal.scope.effectiveAsOfMs === null) return true;
                return entry.createdAtMs <= temporal.scope.effectiveAsOfMs;
            })
            .filter((entry): entry is NonNullable<ReturnType<typeof orchestrator.inspectAtom>> => entry !== null);

        // If objective-aware ranking is requested, sort by relevance to current objective
        if (rankByObjective) {
            // Use the most recent 'objective' atom as the ranking reference
            const objectiveAtom = activeAtoms.find(a => a.atom.includes('objective_'));
            const objectiveText = objectiveAtom ? parseAtomV1(objectiveAtom.atom)?.value ?? '' : '';
            activeAtoms = activeAtoms
                .map(entry => {
                    const parsed = parseAtomV1(entry.atom);
                    const semanticText = parsed ? `${parsed.type} ${parsed.value} ${entry.atom}` : entry.atom;
                    const relevance = objectiveText ? semanticSimilarityScore(objectiveText, semanticText) : 0;
                    return { entry, relevance };
                })
                .sort((a, b) => {
                    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
                    if (b.entry.createdAtMs !== a.entry.createdAtMs) return b.entry.createdAtMs - a.entry.createdAtMs;
                    return a.entry.atom.localeCompare(b.entry.atom);
                })
                .map(row => row.entry);
        } else {
            // Default: sort by recency
            activeAtoms = activeAtoms.sort((a, b) => b.createdAtMs - a.createdAtMs);
        }

        const conflictIndex = buildFactConflictIndex(activeAtoms.map(entry => ({
            atom: entry.atom,
            createdAtMs: entry.createdAtMs,
        })));

        const entries: {
            atom: string;
            createdAtMs: number;
            transitions: number;
            dominantNext: string | null;
            contradiction: {
                hasConflict: boolean;
                conflictKey: string | null;
                competingClaims: FactConflictEntry[];
            };
        }[] = [];
        const lines: string[] = [];
        let estimatedTokens = 0;

        for (const item of activeAtoms) {
            const dominantNext = item.outgoingTransitions[0]?.to ?? null;
            const contradiction = getFactConflictForAtom(item.atom, conflictIndex);
            const line = contextFormat === 'compact'
                ? `${summarizeAtomForCompactContext(item.atom)} | t=${item.outgoingTransitions.length}${dominantNext ? ` | next=${summarizeAtomForCompactContext(dominantNext)}` : ''}${contradiction.hasConflict ? ' | conflict=1' : ''}`
                : `${item.atom} | createdAtMs=${item.createdAtMs} | transitions=${item.outgoingTransitions.length}${dominantNext ? ` | dominantNext=${dominantNext}` : ''}${contradiction.hasConflict ? ` | conflictKey=${contradiction.conflictKey}` : ''}`;
            const lineTokens = estimateTokens(line) + 1;
            if (estimatedTokens + lineTokens > budget) break;

            entries.push({
                atom: item.atom,
                createdAtMs: item.createdAtMs,
                transitions: item.outgoingTransitions.length,
                dominantNext,
                contradiction,
            });
            lines.push(line);
            estimatedTokens += lineTokens;
        }

        return {
            mode: 'context',
            contextFormat,
            context: lines.join('\n'),
            namespace: namespaceScope,
            temporal: temporal.scope,
            entries,
            includedAtoms: entries.length,
            estimatedTokens,
            maxTokens: budget,
            treeVersion: orchestrator.getMasterVersion(),
            generatedAtMs: Date.now(),
            objectiveRank: !!rankByObjective,
        };
    });

    /**
     * POST /memory/bootstrap  —  Single-call session bootstrap payload.
     * Body: { objective?: string, maxTokens?: number, limit?: number }
     *
     * Returns goals/constraints/preferences + top relevant memories with proof
     * metadata and a compact context block for session initialization.
     */
    server.post('/memory/bootstrap', async (request, reply) => {
        const { objective, maxTokens, limit, namespace, includeGlobal, asOfMs, asOfVersion, highImpact, evidenceThreshold } = (request.body ?? {}) as {
            objective?: unknown;
            maxTokens?: unknown;
            limit?: unknown;
            namespace?: unknown;
            includeGlobal?: unknown;
            asOfMs?: unknown;
            asOfVersion?: unknown;
            highImpact?: unknown;
            evidenceThreshold?: unknown;
        };

        if (objective !== undefined && (typeof objective !== 'string' || objective.trim().length === 0)) {
            return reply.status(400).send({ error: "Property 'objective' must be a non-empty string when provided." });
        }

        const budget = maxTokens === undefined ? DEFAULT_CONTEXT_MAX_TOKENS : parseMaxTokens(maxTokens);
        if (budget === null) {
            return reply.status(400).send({ error: "Property 'maxTokens' must be a positive integer <= 8000." });
        }

        const topLimit = parseBootstrapLimit(limit);
        if (topLimit === null) {
            return reply.status(400).send({ error: `Property 'limit' must be an integer between 1 and ${MAX_SEARCH_LIMIT}.` });
        }

        if (highImpact !== undefined && typeof highImpact !== 'boolean') {
            return reply.status(400).send({ error: "Property 'highImpact' must be boolean when provided." });
        }

        const parsedEvidenceThreshold = evidenceThreshold === undefined
            ? DEFAULT_HIGH_IMPACT_EVIDENCE_THRESHOLD
            : parseSearchThreshold(evidenceThreshold);
        if (parsedEvidenceThreshold === null) {
            return reply.status(400).send({ error: "Property 'evidenceThreshold' must be a number between 0 and 1." });
        }

        const namespaceScope = parseNamespaceScope(namespace, includeGlobal, true);
        if (namespaceScope === null) {
            return reply.status(400).send({ error: "Property 'namespace' must be an object with optional user/project/task strings; includeGlobal must be boolean when provided." });
        }

        const temporal = resolveTemporalScope(asOfMs, asOfVersion);
        if (!temporal.ok) return reply.status(temporal.statusCode).send({ error: temporal.error });

        const objectiveText = typeof objective === 'string' ? objective.trim() : '';
        const activeAtoms = orchestrator
            .listAtoms()
            .filter(entry => entry.status === 'active')
            .filter(entry => matchesNamespaceScope(entry.atom, namespaceScope))
            .map(entry => orchestrator.inspectAtom(entry.atom))
            .filter(entry => {
                if (!entry) return false;
                // Use integer version comparison when asOfVersion is set — no timing ambiguity.
                if (temporal.scope.asOfVersion !== null) {
                    return entry.committedAtVersion <= temporal.scope.asOfVersion;
                }
                if (temporal.scope.effectiveAsOfMs === null) return true;
                return entry.createdAtMs <= temporal.scope.effectiveAsOfMs;
            })
            .filter((entry): entry is NonNullable<ReturnType<typeof orchestrator.inspectAtom>> => entry !== null);

        const conflictIndex = buildFactConflictIndex(activeAtoms.map(entry => ({
            atom: entry.atom,
            createdAtMs: entry.createdAtMs,
        })));

        const ranked = activeAtoms
            .map(entry => {
                const parsed = parseAtomV1(entry.atom);
                const semanticText = parsed ? `${parsed.type} ${parsed.value} ${entry.atom}` : entry.atom;
                const relevance = objectiveText ? semanticSimilarityScore(objectiveText, semanticText) : 0;
                return { entry, relevance };
            })
            .sort((a, b) => {
                if (b.relevance !== a.relevance) return b.relevance - a.relevance;
                if (b.entry.createdAtMs !== a.entry.createdAtMs) return b.entry.createdAtMs - a.entry.createdAtMs;
                return a.entry.atom.localeCompare(b.entry.atom);
            });

        const top = ranked.slice(0, topLimit);
        const withProofs: BootstrapMemoryItem[] = await Promise.all(top.map(async row => {
            const report = await orchestrator.access(row.entry.atom);
            const parsed = parseAtomV1(row.entry.atom);
            return {
                atom: row.entry.atom,
                type: parsed?.type ?? 'other',
                value: parsed?.value ?? row.entry.atom,
                category: classifyBootstrapMemory(row.entry.atom),
                relevance: Number(row.relevance.toFixed(6)),
                createdAtMs: row.entry.createdAtMs,
                shardId: row.entry.shard,
                dominantNext: row.entry.outgoingTransitions[0]?.to ?? null,
                proof: report.currentProof,
                contradiction: getFactConflictForAtom(row.entry.atom, conflictIndex),
            };
        }));

        const evidenceGate = applyEvidenceThresholdGate(
            withProofs,
            highImpact === true,
            parsedEvidenceThreshold
        );

        const gatedMemories = evidenceGate.included;
        const masterVersion = orchestrator.getMasterVersion();
        const decisionEvidence = buildDecisionEvidence(
            gatedMemories,
            objectiveText,
            masterVersion,
            evidenceGate.evidenceByMemory,
            {
                applied: highImpact === true,
                threshold: parsedEvidenceThreshold,
            }
        );

        const goals = gatedMemories.filter(item => item.category === 'goal');
        const constraints = gatedMemories.filter(item => item.category === 'constraint');
        const preferences = gatedMemories.filter(item => item.category === 'preference');
        const conflictingFacts = Array.from(conflictIndex.values());

        const lines: string[] = [];
        let estimatedTokens = 0;
        for (const item of gatedMemories) {
            const line = `${item.atom} | category=${item.category} | relevance=${item.relevance}`;
            const lineTokens = estimateTokens(line) + 1;
            if (estimatedTokens + lineTokens > budget) break;
            lines.push(line);
            estimatedTokens += lineTokens;
        }

        return {
            mode: 'session_bootstrap',
            objective: objectiveText || null,
            namespace: namespaceScope,
            temporal: temporal.scope,
            highImpact: highImpact === true,
            goals,
            constraints,
            preferences,
            conflictingFacts,
            topMemories: gatedMemories,
            decisionEvidence,
            evidenceGate: {
                ...evidenceGate.gate,
                excluded: evidenceGate.excluded,
                fallbackReason: evidenceGate.gate.lowEvidenceFallback
                    ? 'Insufficient evidence after threshold gating; memory influence excluded for high-impact output.'
                    : null,
            },
            context: lines.join('\n'),
            includedAtoms: gatedMemories.length,
            estimatedTokens,
            maxTokens: budget,
            treeVersion: masterVersion,
            generatedAtMs: Date.now(),
        };
    });

    /**
     * GET /metrics  —  Prometheus scrape endpoint
     */
    server.get('/metrics', async (request, reply) => {
        reply.header('Content-Type', register.contentType);
        return register.metrics();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Dynamic atom management
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * POST /atoms  —  Queue new atoms for ingestion (non-blocking).
     * Body: { "atoms": ["new_atom_1", "new_atom_2", ...] }
     *
     * Atoms are accepted into the ingestion pipeline immediately.  They are
     * batched and committed asynchronously — reads are never blocked.
     * Use GET /atoms/pending to check what is queued but not yet committed.
     * Use POST /admin/commit to force an immediate flush.
     *
     * Returns: { queued, batchId, commitEtaMs }
     */
    server.post('/atoms', async (request, reply) => {
        try {
            const { atoms, reviewApproved, ttlMs } = request.body as {
                atoms?: unknown;
                reviewApproved?: unknown;
                /** 14-C-1: Optional TTL in milliseconds applied to all atoms in this batch. */
                ttlMs?: unknown;
            };
            if (!Array.isArray(atoms) || atoms.length === 0) {
                return reply.status(400).send({ error: "'atoms' must be a non-empty array." });
            }
            if (reviewApproved !== undefined && typeof reviewApproved !== 'boolean') {
                return reply.status(400).send({ error: "Property 'reviewApproved' must be boolean when provided." });
            }
            // Validate optional TTL
            const ttlMsNum = ttlMs !== undefined ? Number(ttlMs) : undefined;
            if (ttlMsNum !== undefined && (!Number.isFinite(ttlMsNum) || ttlMsNum <= 0)) {
                return reply.status(400).send({ error: "Property 'ttlMs' must be a positive number when provided." });
            }
            const normalized = atoms.map(normalizeAtomInput);
            if (normalized.some(x => x === null)) {
                return reply.status(400).send({ error: `'atoms' invalid — ${SCHEMA_ERROR}` });
            }

            const writeEvaluation = evaluateWritePolicy(
                normalized as string[],
                writePolicy,
                reviewApproved === true
            );

            if (writeEvaluation.decision === 'deny') {
                return reply.status(403).send({
                    status: 'Denied',
                    reason: 'Write policy blocked one or more atoms (never-store tier).',
                    writePolicyOutcome: writeEvaluation,
                    queued: 0,
                });
            }

            if (writeEvaluation.decision === 'review-required') {
                return reply.status(202).send({
                    status: 'ReviewRequired',
                    reason: 'Write policy requires explicit review approval before ingestion.',
                    writePolicyOutcome: writeEvaluation,
                    queued: 0,
                });
            }

            const admission = orchestrator.getWriteAdmission(
                pipeline.getStats().queueDepth,
                writeEvaluation.allowedAtoms.length
            );
            if (!admission.accept) {
                reply.header('Retry-After', String(admission.retryAfterSec));
                return reply.status(503).send({
                    error: 'Backpressure: write buffer is saturated. Retry later.',
                    retryAfterSec: admission.retryAfterSec,
                    pressure: {
                        highWaterMark: admission.highWaterMark,
                        totalShardPendingWrites: admission.totalShardPendingWrites,
                        projectedPendingWrites: admission.projectedPendingWrites,
                    },
                    writePolicyOutcome: writeEvaluation,
                });
            }
            const receipt = await pipeline.enqueue(writeEvaluation.allowedAtoms);
            // 14-C-1: Register TTL if requested
            if (ttlMsNum !== undefined) {
                for (const atom of writeEvaluation.allowedAtoms) {
                    ttlRegistry.set(atom, ttlMsNum);
                }
            }
            auditLog.record('atom.add', {
                atoms: writeEvaluation.allowedAtoms,
                count: writeEvaluation.allowedAtoms.length,
                requestId: request.id as string,
            });
            return {
                status: 'Queued',
                ...receipt,
                writePolicyOutcome: writeEvaluation,
            };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /atoms/pending  —  List atoms queued in the ingestion pipeline but
     * not yet committed to the Merkle snapshot.
     *
     * Returns: { queuedInPipeline, pipelineStats }
     */
    server.get('/atoms/pending', async () => {
        const stats = pipeline.getStats();
        return {
            queuedInPipeline: pipeline.getQueuedAtoms(),
            pipelineStats: stats,
        };
    });

    /**
     * GET /atoms/stale  —  List active atoms that haven't been accessed or updated
     * in more than `maxAgeDays` days (default: 30).  Optionally filter by type.
     *
     * Query params:
     *   maxAgeDays  — integer > 0, default 30
     *   type        — fact | event | relation | state | procedure | other (optional filter)
     *
     * Returns: { stale: [{ atom, type, createdAtMs, ageDays }], count, asOfMs, maxAgeDays }
     */
    server.get('/atoms/stale', async (request, reply) => {
        const query = (request.query ?? {}) as { maxAgeDays?: unknown; type?: unknown };

        const rawMaxAge = query.maxAgeDays !== undefined ? parseInt(String(query.maxAgeDays), 10) : 30;
        if (!Number.isInteger(rawMaxAge) || rawMaxAge <= 0) {
            return reply.status(400).send({ error: "Query param 'maxAgeDays' must be a positive integer." });
        }

        if (query.type !== undefined && !isAtomType(query.type)) {
            return reply.status(400).send({ error: "Query param 'type' must be one of: fact,event,relation,state,procedure,other." });
        }

        const now = Date.now();
        const cutoffMs = now - rawMaxAge * 24 * 60 * 60 * 1000;

        const allAtoms = orchestrator.listAtoms();
        const activeAtoms = allAtoms.filter(e => e.status === 'active');

        const staleEntries: { atom: string; type: string; createdAtMs: number; ageDays: number }[] = [];

        for (const entry of activeAtoms) {
            const parsed = parseAtomV1(entry.atom);
            if (!parsed) continue;
            if (query.type !== undefined && parsed.type !== query.type) continue;

            const record = orchestrator.inspectAtom(entry.atom);
            if (!record) continue;

            if (record.createdAtMs <= cutoffMs) {
                const ageDays = Math.floor((now - record.createdAtMs) / (24 * 60 * 60 * 1000));
                staleEntries.push({ atom: entry.atom, type: parsed.type, createdAtMs: record.createdAtMs, ageDays });
            }
        }

        // Sort oldest-first so the most stale atoms are easiest to identify
        staleEntries.sort((a, b) => a.createdAtMs - b.createdAtMs);

        return {
            stale: staleEntries,
            count: staleEntries.length,
            asOfMs: now,
            maxAgeDays: rawMaxAge,
        };
    });

    /**
     * POST /admin/commit  —  Force an immediate flush of the ingestion pipeline.
     * Useful for testing and for cases where you need atoms committed right away.
     *
     * Returns: { status, flushedCount }
     */
    server.post('/admin/commit', async (request, reply) => {
        try {
            const before = pipeline.getStats().totalCommitted;
            await pipeline.flush();
            const after = pipeline.getStats().totalCommitted;
            const flushedCount = after - before;
            auditLog.record('admin.commit', {
                count: flushedCount,
                requestId: request.id as string,
                treeVersion: orchestrator.getMasterVersion(),
            });
            return { status: 'Committed', flushedCount };
        } catch (e: any) {
            return reply.status(500).send({ error: e.message });
        }
    });

    /**
     * GET /admin/audit-log  —  Query the in-memory audit log of mutation events.
     *
     * Query params:
     *   ?limit=N         Maximum entries to return (default 100, max 1000).
     *   ?since=<ms>      Only return entries with timestampMs >= this value.
     *   ?event=<type>    Filter by event type: atom.add | atom.tombstone |
     *                    admin.commit | admin.import | admin.export
     *
     * Returns: { entries: [...], total, bufferSize, maxEntries }
     * Entries are sorted newest-first.
     *
     * Note: The log is in-memory and resets on server restart.
     */
    server.get('/admin/audit-log', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;

        const VALID_EVENTS = new Set(['atom.add', 'atom.tombstone', 'admin.commit', 'admin.import', 'admin.export']);

        const limitRaw = typeof query.limit === 'string' ? parseInt(query.limit, 10) : 100;
        if (!Number.isFinite(limitRaw) || limitRaw < 1) {
            return reply.status(400).send({ error: "Query param 'limit' must be a positive integer." });
        }

        const sinceRaw = typeof query.since === 'string' ? parseInt(query.since, 10) : undefined;
        if (sinceRaw !== undefined && !Number.isFinite(sinceRaw)) {
            return reply.status(400).send({ error: "Query param 'since' must be a Unix ms timestamp." });
        }

        const eventFilter = typeof query.event === 'string' ? query.event : undefined;
        if (eventFilter && !VALID_EVENTS.has(eventFilter)) {
            return reply.status(400).send({
                error: `Query param 'event' must be one of: ${[...VALID_EVENTS].join(' | ')}.`,
            });
        }

        const entries = auditLog.query({
            limit: limitRaw,
            since: sinceRaw,
            event: eventFilter as AuditEventType | undefined,
        });

        return {
            entries,
            total: auditLog.totalRecorded,
            bufferSize: auditLog.size,
            maxEntries: auditLog.maxEntries,
        };
    });

    /**
     * GET /admin/export  —  Snapshot all atoms as NDJSON for backup / migration.
     *
     * Each line is a JSON record:
     *   { atom, status, hash, createdAtMs, committedAtVersion, shard }
     *
     * Query params:
     *   ?status=active|tombstoned|all  (default: active)
     *   ?type=fact|state|event|relation|procedure|other   (filter by atom type segment)
     *
     * The response body is newline-delimited JSON (application/x-ndjson).
     * Every active atom that has been committed is included; pending atoms
     * (not yet in LevelDB) are excluded.
     */
    server.get('/admin/export', async (request, reply) => {
        const query = (request.query ?? {}) as Record<string, unknown>;
        const statusFilter = typeof query.status === 'string' ? query.status : 'active';
        const typeFilter   = typeof query.type   === 'string' ? query.type   : null;

        if (!['active', 'tombstoned', 'all'].includes(statusFilter)) {
            return reply.status(400).send({ error: "Query param 'status' must be active | tombstoned | all." });
        }
        if (typeFilter && !['fact', 'state', 'event', 'relation', 'procedure', 'other'].includes(typeFilter)) {
            return reply.status(400).send({ error: "Query param 'type' must be fact | state | event | relation | procedure | other." });
        }

        const entries = orchestrator.listAtoms();
        const lines: string[] = [];

        for (const entry of entries) {
            if (statusFilter !== 'all' && entry.status !== statusFilter) continue;
            if (typeFilter) {
                // atom format: v1.<type>.<value>
                const parts = entry.atom.split('.');
                if (parts[1] !== typeFilter) continue;
            }
            const record = orchestrator.inspectAtom(entry.atom);
            if (!record) continue; // should not happen, but guard
            lines.push(JSON.stringify({
                atom: record.atom,
                status: record.status,
                hash: record.hash,
                createdAtMs: record.createdAtMs,
                committedAtVersion: record.committedAtVersion,
                shard: record.shard,
            }));
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        auditLog.record('admin.export', { count: lines.length, requestId: request.id as string });
        reply.header('Content-Type', 'application/x-ndjson');
        reply.header('Content-Disposition', `attachment; filename="mmpm-export-${dateStr}.ndjson"`);
        return reply.send(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
    });

    /**
     * POST /admin/import  —  Ingest atoms from an NDJSON snapshot.
     *
     * Accepts the same NDJSON format produced by GET /admin/export, or any
     * newline-delimited JSON where each line has an "atom" string field.
     * Plain atom strings (without JSON wrapping) are also accepted per line.
     *
     * Returns: { imported, skipped, errors }
     *   imported — atoms accepted into the ingest pipeline
     *   skipped  — lines that were empty or already present
     *   errors   — lines that could not be parsed or had an invalid atom string
     */
    server.post('/admin/import', async (request, reply) => {
        const rawBody = typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body ?? '');

        const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
            return reply.status(400).send({ error: 'Request body is empty — expected NDJSON atom records.' });
        }

        const toIngest: string[] = [];
        let skipped = 0;
        const errors: string[] = [];

        for (const line of lines) {
            let atom: string | null = null;
            try {
                if (line.startsWith('{')) {
                    const obj = JSON.parse(line);
                    atom = typeof obj.atom === 'string' ? obj.atom : null;
                } else {
                    // bare atom string
                    atom = line;
                }
            } catch {
                errors.push(`JSON parse error: ${line.slice(0, 80)}`);
                continue;
            }

            if (!atom || !isAtomV1(atom)) {
                errors.push(`Invalid atom: ${String(atom ?? line).slice(0, 80)}`);
                continue;
            }

            // Skip atoms already present and active to avoid duplicates
            const existing = orchestrator.inspectAtom(atom);
            if (existing && existing.status === 'active') {
                skipped++;
                continue;
            }

            toIngest.push(atom);
        }

        if (toIngest.length > 0) {
            await pipeline.enqueue(toIngest);
        }

        auditLog.record('admin.import', {
            atoms: toIngest,
            count: toIngest.length,
            requestId: request.id as string,
        });

        return { imported: toIngest.length, skipped, errors };
    });

    /**
     * POST /verify  —  Standalone Merkle proof verification. No auth required.
     *
     * Accepts { atom, proof: { leaf, root, auditPath, index } } and recomputes
     * the Merkle path entirely from the supplied values — no DB read.
     * Returns { valid, atom, checkedAt }.
     *
     * Third-party auditors can call this endpoint without API credentials to
     * independently verify any proof retrieved from GET /atoms/:atom or
     * GET /memory/bootstrap.
     */
    server.post('/verify', async (request, reply) => {
        const body = request.body as Record<string, unknown> | null;
        if (!body || typeof body !== 'object') {
            return reply.status(400).send({ error: 'Request body must be JSON object with atom and proof fields.' });
        }
        const { atom, proof } = body as { atom?: unknown; proof?: unknown };

        if (typeof atom !== 'string' || !isAtomV1(atom)) {
            return reply.status(400).send({ error: `'atom' field invalid — ${SCHEMA_ERROR}` });
        }

        // Validate proof shape
        if (
            !proof ||
            typeof proof !== 'object' ||
            typeof (proof as any).leaf !== 'string' ||
            typeof (proof as any).root !== 'string' ||
            !Array.isArray((proof as any).auditPath) ||
            typeof (proof as any).index !== 'number'
        ) {
            return reply.status(400).send({
                error: "Field 'proof' must be an object with: leaf (string), root (string), auditPath (string[]), index (number).",
            });
        }

        const merkleProof: MerkleProof = {
            leaf: (proof as any).leaf,
            root: (proof as any).root,
            auditPath: (proof as any).auditPath,
            index: (proof as any).index,
        };

        const valid = MerkleSnapshot.verifyProof(merkleProof);

        return {
            valid,
            atom,
            checkedAt: Date.now(),
        };
    });

    /**
     * DELETE /atoms/:atom  —  Tombstone (soft-delete) a single atom.
     *
     * The atom's Merkle leaf is replaced with a zero sentinel.  No indices shift,
     * so proofs previously issued for other atoms remain valid at their treeVersion.
     * The tombstoned atom can no longer be accessed or used as a training endpoint.
     *
     * Returns: { status, tombstonedAtom, treeVersion }
     */
    server.delete('/atoms/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        if (!isAtomV1(atom)) {
            return reply.status(400).send({ error: `Path param 'atom' invalid — ${SCHEMA_ERROR}` });
        }
        try {
            const treeVersion = await orchestrator.removeAtom(atom);
            ttlRegistry.delete(atom); // 14-C-1: remove TTL tracking after tombstone
            auditLog.record('atom.tombstone', {
                atoms: [atom],
                count: 1,
                requestId: request.id as string,
                treeVersion,
            });
            return { status: 'Success', tombstonedAtom: atom, treeVersion };
        } catch (e: any) {
            return reply.status(404).send({ error: e.message });
        }
    });

    /**
     * GET /atoms  —  List all registered atoms across all shards.
     * Returns: { atoms: [{ atom, status: 'active' | 'tombstoned' }], treeVersion }
     */
    server.get('/atoms', async (request, reply) => {
        const query = (request.query ?? {}) as {
            type?: unknown;
            prefix?: unknown;
            limit?: unknown;
            offset?: unknown;
        };

        let atoms = orchestrator.listAtoms();

        if (query.type !== undefined) {
            if (!isAtomType(query.type)) {
                return reply.status(400).send({ error: "Query param 'type' must be one of: fact,event,relation,state,procedure,other." });
            }
            atoms = atoms.filter(entry => parseAtomV1(entry.atom)?.type === query.type);
        }

        if (query.prefix !== undefined) {
            if (typeof query.prefix !== 'string') {
                return reply.status(400).send({ error: "Query param 'prefix' must be a string." });
            }
            const prefix = query.prefix;
            atoms = atoms.filter(entry => entry.atom.startsWith(prefix));
        }

        const offset = parseOptionalNonNegativeInt(query.offset);
        if (offset === null) {
            return reply.status(400).send({ error: "Query param 'offset' must be a non-negative integer." });
        }

        const limit = parseOptionalPositiveInt(query.limit);
        if (query.limit !== undefined && limit === null) {
            return reply.status(400).send({ error: `Query param 'limit' must be an integer between 1 and ${MAX_ATOMS_PAGE_SIZE}.` });
        }

        if (offset > 0) atoms = atoms.slice(offset);
        if (limit !== null) atoms = atoms.slice(0, limit);

        return {
            atoms,
            treeVersion: orchestrator.getMasterVersion(),
        };
    });

    /**
     * GET /atoms/:atom  —  Inspect a single atom's stored record.
     * Returns shard assignment, status, hash, commit visibility, and
     * outgoing learned transitions.
     */
    server.get('/atoms/:atom', async (request, reply) => {
        const { atom } = request.params as { atom: string };
        const query = (request.query ?? {}) as Record<string, unknown>;
        if (!isAtomV1(atom)) {
            return reply.status(400).send({ error: `Path param 'atom' invalid — ${SCHEMA_ERROR}` });
        }

        const temporal = resolveTemporalScope(query.asOfMs, query.asOfVersion);
        if (!temporal.ok) return reply.status(temporal.statusCode).send({ error: temporal.error });

        const record = orchestrator.inspectAtom(atom);
        if (!record) {
            return reply.status(404).send({ error: `Atom '${atom}' not found in any shard.` });
        }
        // Use integer version comparison when asOfVersion is set — no timing ambiguity.
        if (temporal.scope.asOfVersion !== null) {
            if (record.committedAtVersion > temporal.scope.asOfVersion) {
                return reply.status(404).send({ error: `Atom '${atom}' did not exist at requested temporal scope.` });
            }
        } else if (temporal.scope.effectiveAsOfMs !== null && record.createdAtMs > temporal.scope.effectiveAsOfMs) {
            return reply.status(404).send({ error: `Atom '${atom}' did not exist at requested temporal scope.` });
        }

        const activeAtoms = orchestrator
            .listAtoms()
            .filter(entry => entry.status === 'active')
            .map(entry => orchestrator.inspectAtom(entry.atom))
            .filter((entry): entry is NonNullable<ReturnType<typeof orchestrator.inspectAtom>> => entry !== null);
        const conflictIndex = buildFactConflictIndex(activeAtoms.map(entry => ({
            atom: entry.atom,
            createdAtMs: entry.createdAtMs,
        })));

        const proof = orchestrator.getAtomProof(atom) ?? null;
        // 14-C-1: Include TTL metadata if this atom has a TTL registered
        const ttlEntry = ttlRegistry.get(atom) ?? null;

        return {
            ...record,
            proof,
            ttl: ttlEntry
                ? {
                    ttlMs: ttlEntry.ttlMs,
                    ttlExpiresAt: ttlEntry.ttlExpiresAt,
                    lastAccessedAtMs: ttlEntry.lastAccessedAtMs,
                }
                : null,
            contradiction: getFactConflictForAtom(record.atom, conflictIndex),
            temporal: temporal.scope,
        };
    });

    // 14-C-1: Background TTL reaper — checks expired atoms and tombstones them.
    const reaperIntervalMs = parseInt(process.env.MMPM_TTL_REAPER_INTERVAL_MS ?? '60000', 10);
    const reaperTimer = setInterval(async () => {
        const expired = ttlRegistry.expired();
        for (const entry of expired) {
            try {
                await orchestrator.removeAtom(entry.atom as any);
                ttlRegistry.delete(entry.atom);
                auditLog.record('atom.tombstone', {
                    atoms: [entry.atom],
                    count: 1,
                    treeVersion: orchestrator.getMasterVersion(),
                });
                logger.info({ atom: entry.atom, ttlMs: entry.ttlMs }, 'TTL reaper tombstoned expired atom');
            } catch {
                // Atom may already be tombstoned — that's fine
                ttlRegistry.delete(entry.atom);
            }
        }
    }, reaperIntervalMs);
    // Ensure the timer doesn't keep the process alive on graceful shutdown
    if (typeof reaperTimer.unref === 'function') reaperTimer.unref();

    return { server, orchestrator, pipeline, auditLog };
}

// ── S15-4: Startup key validation ─────────────────────────────────────────────
// Called once before buildApp(). Exits with a clear message rather than
// silently running unauthenticated or with a known-weak placeholder key.
function validateApiKeyAtStartup(): void {
    const key   = process.env.MMPM_API_KEY ?? '';
    const isProd = (process.env.NODE_ENV ?? 'development') === 'production';

    // Known placeholder values that must never be used in real deployments.
    const PLACEHOLDER_KEYS = new Set([
        '',
        'change-me-before-production',
        'your-api-key-from-.env',
        'your-api-key-here',
    ]);

    const isPlaceholder = PLACEHOLDER_KEYS.has(key.trim());
    const isTooShort    = key.length > 0 && key.length < 16;

    if (isProd && isPlaceholder) {
        console.error(
            '[MMPM] FATAL: MMPM_API_KEY is not set or is a placeholder value.\n' +
            '       In production you must set a strong key in .env:\n' +
            '         openssl rand -hex 32\n' +
            '       Then set MMPM_API_KEY=<that value> in .env and restart.'
        );
        process.exit(1);
    }

    if (isProd && isTooShort) {
        console.error(
            `[MMPM] FATAL: MMPM_API_KEY is only ${key.length} characters.\n` +
            '       Minimum 16 characters required in production.\n' +
            '       Generate a strong key:  openssl rand -hex 32'
        );
        process.exit(1);
    }

    if (!isProd && isPlaceholder) {
        // Development warning — non-fatal, but visible.
        console.warn(
            '[MMPM] WARNING: MMPM_API_KEY is not set. ' +
            'All write endpoints are unprotected. ' +
            'Set MMPM_API_KEY in .env before exposing this server.'
        );
    }
}

// Only run when invoked directly
if (require.main === module) {
    validateApiKeyAtStartup();

    const PORT = parseInt(process.env.PORT ?? '3000');
    const HOST = process.env.HOST ?? '0.0.0.0';
    const NUM_SHARDS = parseInt(process.env.SHARD_COUNT ?? '4');

    const { server, orchestrator, pipeline } = buildApp({
        numShards: NUM_SHARDS,
        atomSeedFile: process.env.MMPM_ATOM_FILE,
    });

    const shutdown = async () => {
        // Shutdown order matters:
        //   1. Stop accepting new requests and drain in-flight HTTP handlers.
        //      No new atoms can be enqueued after this point.
        await server.close();
        //   2. Drain the ingestion pipeline: clear the background flush timer
        //      and await any in-flight flush (including one started by the
        //      timer that fired concurrently with SIGTERM). All db.put() calls
        //      from addAtoms() are guaranteed to complete before we return.
        await pipeline.stop();
        //   3. Safe to close LevelDB — no write is in flight.
        await orchestrator.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Crash safety — ensure fatal errors are always logged before exit
    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'uncaughtException — process will exit');
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        logger.fatal({ reason }, 'unhandledRejection — process will exit');
        process.exit(1);
    });

    (async () => {
        try {
            await orchestrator.init();
            pipeline.start();
            await server.listen({ port: PORT, host: HOST });
            // 14-H-2: Single structured startup line — easy to grep and parse.
            logger.info({
                event: 'server_ready',
                port: PORT,
                host: HOST,
                shards: NUM_SHARDS,
                dbBasePath: process.env.DB_BASE_PATH ?? path.join(os.homedir(), '.mmpm', 'data'),
                logLevel: process.env.LOG_LEVEL ?? 'info',
                writePolicy: process.env.WRITE_POLICY ?? 'auto-write',
                apiKeySet: Boolean(process.env.MMPM_API_KEY),
            }, 'MMPM server ready');
        } catch (err) {
            logger.error(err);
            process.exit(1);
        }
    })();
}