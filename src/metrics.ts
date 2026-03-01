/**
 * MMPM Custom Prometheus Metrics
 *
 * Uses lazy-singleton helpers so the module is safe to import across multiple
 * test files without triggering prom-client's "duplicate metric" error.
 */
import { Counter, Histogram, register } from 'prom-client';

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
