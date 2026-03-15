// vitest.config.mjs — plain ESM so Node loads it natively.
// A .ts config requires vite's CJS loader to require() vite v6, which is
// ESM-only and throws ERR_REQUIRE_ESM when the project tsconfig targets CJS.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Only discover tests inside the TypeScript source tree.
        // This prevents vitest from also picking up the compiled CJS copies
        // in dist/__tests__/ which fail with "Vitest cannot be imported in a
        // CommonJS module using require()".
        include: ['src/**/*.{test,spec}.ts'],
        // Belt-and-braces: never run anything under dist/ or node_modules/.
        exclude: ['dist/**', 'node_modules/**'],
        // Load .env.test into process.env before every test file.
        setupFiles: ['./src/__tests__/setup.ts'],
        // The concurrent stress test creates 4 full LevelDB shards with all
        // Sprint 15+ features (tier engine, consolidation, HLR, access log).
        // Use vmThreads instead of forks to avoid doubling process memory
        // overhead — critical on memory-constrained CI / dev environments.
        pool: 'vmThreads',
    },
});
