// vitest.config.mjs — plain ESM so Node loads it natively.
// A .ts config requires vite's CJS loader to require() vite v6, which is
// ESM-only and throws ERR_REQUIRE_ESM when the project tsconfig targets CJS.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Load .env.test into process.env before every test file.
        setupFiles: ['./src/__tests__/setup.ts'],
    },
});
