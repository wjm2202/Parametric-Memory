import pino from 'pino';

/**
 * Shared pino logger for the MMPM cluster.
 * Level is configured via LOG_LEVEL env var (default: 'info').
 * In test environments, vitest suppresses output via the test runner;
 * set LOG_LEVEL=silent to disable all logging in tests.
 */
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    name: 'mmpm',
});
