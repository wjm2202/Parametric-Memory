/**
 * MMPM Custom Prometheus Metrics
 *
 * Uses lazy-singleton helpers so the module is safe to import across multiple
 * test files without triggering prom-client's "duplicate metric" error.
 */
import { Counter, Histogram, Gauge, register } from 'prom-client';

function getOrCreate<T>(name: string, factory: () => T): T {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as unknown as T;
    return factory();
}

/** Total /access calls, labelled by prediction result: hit | miss | error */
export const accessCounter = getOrCreate(
    'mmpm_access_total',
    () => new Counter({
        name: 'mmpm_access_total',
        help: 'Total /access calls by prediction result',
        labelNames: ['result'] as const,
    })
);

/** End-to-end /access latency in milliseconds (from PredictionReport.latencyMs) */
export const requestDuration = getOrCreate(
    'mmpm_request_duration_ms',
    () => new Histogram({
        name: 'mmpm_request_duration_ms',
        help: 'End-to-end /access latency in milliseconds',
        buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
    })
);

/** Total /train calls */
export const trainCounter = getOrCreate(
    'mmpm_train_total',
    () => new Counter({
        name: 'mmpm_train_total',
        help: 'Total /train calls',
    })
);

/** Distribution of sequence lengths passed to /train */
export const trainSequenceLength = getOrCreate(
    'mmpm_train_sequence_length',
    () => new Histogram({
        name: 'mmpm_train_sequence_length',
        help: 'Distribution of /train sequence lengths',
        buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
    })
);

// ─── Learning / weight evolution metrics ─────────────────────────────────────
// Cardinality design: O(atoms), never O(atoms²).
// Per-edge labels (from + to) are intentionally avoided.

/**
 * Prediction confidence per atom: dominant_weight / total_weight.
 * 0 = untrained, 1 = single deterministic successor.
 * Label cardinality: one series per atom in the cluster.
 */
export const atomDominanceRatio = getOrCreate(
    'mmpm_atom_dominance_ratio',
    () => new Gauge({
        name: 'mmpm_atom_dominance_ratio',
        help: 'Prediction confidence per atom (top_weight / total_weight). Updated on /train.',
        labelNames: ['atom'] as const,
    })
);

/**
 * Outgoing trained edge count (out-degree) per atom.
 * Shows how many distinct successors each atom has learned.
 */
export const atomTrainedEdges = getOrCreate(
    'mmpm_atom_trained_edges',
    () => new Gauge({
        name: 'mmpm_atom_trained_edges',
        help: 'Number of outgoing trained edges per atom. Updated on /train.',
        labelNames: ['atom'] as const,
    })
);

/** Total trained edges across the entire cluster (scalar, O(1) cardinality). */
export const clusterTotalEdges = getOrCreate(
    'mmpm_cluster_total_edges',
    () => new Gauge({
        name: 'mmpm_cluster_total_edges',
        help: 'Total trained edges across all shards in the cluster.',
    })
);

/** Atoms with at least one outgoing trained transition (scalar, O(1) cardinality). */
export const clusterTrainedAtoms = getOrCreate(
    'mmpm_cluster_trained_atoms',
    () => new Gauge({
        name: 'mmpm_cluster_trained_atoms',
        help: 'Atoms with at least one outgoing trained transition.',
    })
);

// ─── Commit / epoch metrics (Story 7.1) ──────────────────────────────────────

/** End-to-end snapshot commit latency per shard (ms). */
export const commitLatency = getOrCreate(
    'mmpm_commit_latency_ms',
    () => new Histogram({
        name: 'mmpm_commit_latency_ms',
        help: 'Time to complete a snapshot commit per shard (ms)',
        labelNames: ['shard'] as const,
        buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
    })
);

/** Total committed snapshots per shard. */
export const commitsTotal = getOrCreate(
    'mmpm_commits_total',
    () => new Counter({
        name: 'mmpm_commits_total',
        help: 'Total snapshot commits per shard',
        labelNames: ['shard'] as const,
    })
);

/** Total epoch transitions (= successful commits) per shard. */
export const epochTransitionsTotal = getOrCreate(
    'mmpm_epoch_transitions_total',
    () => new Counter({
        name: 'mmpm_epoch_transitions_total',
        help: 'Total epoch transitions (commit completions) per shard',
        labelNames: ['shard'] as const,
    })
);

/** Current pending (uncommitted) write count per shard. */
export const pendingWritesGauge = getOrCreate(
    'mmpm_pending_writes_count',
    () => new Gauge({
        name: 'mmpm_pending_writes_count',
        help: 'Number of pending (uncommitted) writes per shard',
        labelNames: ['shard'] as const,
    })
);

// ─── Phase 2 metrics (Stories 12.1 / 12.2) ─────────────────────────────────

/** CSR build time per shard (ms), observed at commit-time rebuild. */
export const csrBuildMs = getOrCreate(
    'mmpm_csr_build_ms',
    () => new Histogram({
        name: 'mmpm_csr_build_ms',
        help: 'Time to build CsrTransitionMatrix per shard (ms)',
        labelNames: ['shard'] as const,
        buckets: [0.1, 0.5, 1, 2, 5, 10, 25],
    })
);

/** Edge count in CSR after each build. */
export const csrEdgeCount = getOrCreate(
    'mmpm_csr_edge_count',
    () => new Gauge({
        name: 'mmpm_csr_edge_count',
        help: 'Total edge count in CSR per shard after rebuild',
        labelNames: ['shard'] as const,
    })
);

/** Number of predictions changed/nullified by type policy filtering. */
export const predictionTypeFilteredTotal = getOrCreate(
    'mmpm_prediction_type_filtered_total',
    () => new Counter({
        name: 'mmpm_prediction_type_filtered_total',
        help: 'Total predictions altered by type policy filtering',
        labelNames: ['shard'] as const,
    })
);

/** Warm-read fallback predictions returned due to restricted type policy. */
export const warmPredictionFallbackTotal = getOrCreate(
    'mmpm_warm_prediction_fallback_total',
    () => new Counter({
        name: 'mmpm_warm_prediction_fallback_total',
        help: 'Total warm-read type-fallback predictions emitted',
        labelNames: ['shard'] as const,
    })
);

/** Transition count matrix by parsed atom types in /train traffic. */
export const transitionByTypeTotal = getOrCreate(
    'mmpm_transition_by_type_total',
    () => new Counter({
        name: 'mmpm_transition_by_type_total',
        help: 'Total trained transitions by from/to atom type',
        labelNames: ['from_type', 'to_type'] as const,
    })
);

// ─── Cache metrics (Sprint 11) ───────────────────────────────────────────────

/** Total ARC cache hits across all shards. */
export const cacheHitsTotal = getOrCreate(
    'mmpm_cache_hits_total',
    () => new Counter({
        name: 'mmpm_cache_hits_total',
        help: 'Total ARC cache hits',
    })
);

/** Total ARC cache misses across all shards. */
export const cacheMissesTotal = getOrCreate(
    'mmpm_cache_misses_total',
    () => new Counter({
        name: 'mmpm_cache_misses_total',
        help: 'Total ARC cache misses',
    })
);

/** Total ARC cache evictions across all shards. */
export const cacheEvictionsTotal = getOrCreate(
    'mmpm_cache_evictions_total',
    () => new Counter({
        name: 'mmpm_cache_evictions_total',
        help: 'Total ARC cache evictions',
    })
);

/** Current number of entries in the ARC cache. */
export const cacheSizeGauge = getOrCreate(
    'mmpm_cache_size',
    () => new Gauge({
        name: 'mmpm_cache_size',
        help: 'Current number of entries in the ARC cache',
    })
);
