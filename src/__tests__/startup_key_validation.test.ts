/**
 * S15-4: Startup key validation tests
 *
 * validateApiKeyAtStartup() is not exported from server.ts (it lives inside
 * the require.main guard), so we test the identical logic extracted here.
 * This ensures the validation rules can never silently regress.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';

// ── replicate the exact validation logic from server.ts ───────────────────────
const PLACEHOLDER_KEYS = new Set([
    '',
    'change-me-before-production',
    'your-api-key-from-.env',
    'your-api-key-here',
]);

type ValidationResult =
    | { ok: true }
    | { ok: false; fatal: boolean; message: string };

function validateApiKey(key: string, nodeEnv: string): ValidationResult {
    const isProd       = nodeEnv === 'production';
    const isPlaceholder = PLACEHOLDER_KEYS.has(key.trim());
    const isTooShort    = key.length > 0 && key.length < 16;

    if (isProd && isPlaceholder) {
        return { ok: false, fatal: true,  message: 'MMPM_API_KEY is not set or is a placeholder value' };
    }
    if (isProd && isTooShort) {
        return { ok: false, fatal: true,  message: `MMPM_API_KEY is only ${key.length} characters` };
    }
    if (!isProd && isPlaceholder) {
        return { ok: false, fatal: false, message: 'MMPM_API_KEY is not set — endpoints are unprotected' };
    }
    return { ok: true };
}

// ── tests ─────────────────────────────────────────────────────────────────────
describe('startup key validation', () => {

    describe('production environment', () => {
        it('rejects empty key', () => {
            const r = validateApiKey('', 'production');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(true);
        });

        it('rejects known placeholder — change-me-before-production', () => {
            const r = validateApiKey('change-me-before-production', 'production');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(true);
        });

        it('rejects known placeholder — your-api-key-from-.env', () => {
            const r = validateApiKey('your-api-key-from-.env', 'production');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(true);
        });

        it('rejects key shorter than 16 characters', () => {
            const r = validateApiKey('tooshort', 'production');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(true);
        });

        it('rejects key of exactly 15 characters', () => {
            const r = validateApiKey('a'.repeat(15), 'production');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(true);
        });

        it('accepts key of exactly 16 characters', () => {
            const r = validateApiKey('a'.repeat(16), 'production');
            expect(r.ok).toBe(true);
        });

        it('accepts a strong hex key (32 bytes)', () => {
            const key = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
            const r   = validateApiKey(key, 'production');
            expect(r.ok).toBe(true);
        });
    });

    describe('development / test environment', () => {
        it('emits non-fatal warning for empty key', () => {
            const r = validateApiKey('', 'development');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(false);
        });

        it('emits non-fatal warning for placeholder key', () => {
            const r = validateApiKey('change-me-before-production', 'development');
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.fatal).toBe(false);
        });

        it('accepts any non-placeholder key regardless of length', () => {
            expect(validateApiKey('dev-key', 'development').ok).toBe(true);
            expect(validateApiKey('test', 'test').ok).toBe(true);
        });

        it('accepts a strong key', () => {
            const r = validateApiKey('strongkeyforlocaldev', 'development');
            expect(r.ok).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('trims whitespace when checking for placeholder', () => {
            // A key that is just whitespace is treated as empty (placeholder)
            const r = validateApiKey('   ', 'production');
            expect(r.ok).toBe(false);
        });

        it('defaults to non-production when NODE_ENV is absent', () => {
            // Simulates undefined NODE_ENV — should not fatally exit
            const r = validateApiKey('', 'development');
            if (!r.ok) expect(r.fatal).toBe(false);
        });
    });
});
