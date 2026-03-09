import { describe, it, expect, vi } from 'vitest';
import { TtlRegistry } from '../ttl_registry';

// ---------------------------------------------------------------------------
// Tests — TTL Auto-Promotion (Memory Consolidation)
// ---------------------------------------------------------------------------

describe('TtlRegistry — Auto-Promotion', () => {

    describe('promotion threshold behaviour', () => {
        it('promotes atom after reaching access threshold (default 3)', () => {
            const promoted: string[] = [];
            const registry = new TtlRegistry({
                onPromote: (atom) => promoted.push(atom),
            });

            registry.set('v1.state.temp', 60_000);
            expect(registry.size).toBe(1);

            // Access 1 and 2: not promoted
            expect(registry.touch('v1.state.temp')).toBe('touched');
            expect(registry.touch('v1.state.temp')).toBe('touched');
            expect(promoted).toHaveLength(0);
            expect(registry.size).toBe(1);

            // Access 3: promoted!
            expect(registry.touch('v1.state.temp')).toBe('promoted');
            expect(promoted).toEqual(['v1.state.temp']);
            // Entry removed from registry after promotion
            expect(registry.size).toBe(0);
            expect(registry.get('v1.state.temp')).toBeUndefined();
        });

        it('promoted atoms are never returned by expired()', () => {
            const registry = new TtlRegistry({ promotionThreshold: 2 });
            registry.set('v1.state.temp', 1); // 1ms TTL — will expire instantly

            // Access twice to promote
            registry.touch('v1.state.temp');
            registry.touch('v1.state.temp');

            // Even after TTL would expire, promoted atom isn't in expired list
            const expired = registry.expired(Date.now() + 100_000);
            expect(expired).toHaveLength(0);
        });

        it('custom threshold of 1 promotes on first access', () => {
            const promoted: string[] = [];
            const registry = new TtlRegistry({
                promotionThreshold: 1,
                onPromote: (atom) => promoted.push(atom),
            });

            registry.set('v1.fact.important', 60_000);
            expect(registry.touch('v1.fact.important')).toBe('promoted');
            expect(promoted).toEqual(['v1.fact.important']);
        });

        it('threshold of 0 disables promotion', () => {
            const promoted: string[] = [];
            const registry = new TtlRegistry({
                promotionThreshold: 0,
                onPromote: (atom) => promoted.push(atom),
            });

            registry.set('v1.state.temp', 60_000);
            for (let i = 0; i < 100; i++) {
                registry.touch('v1.state.temp');
            }
            expect(promoted).toHaveLength(0);
            expect(registry.size).toBe(1);
        });

        it('threshold of Infinity disables promotion', () => {
            const registry = new TtlRegistry({ promotionThreshold: Infinity });
            registry.set('v1.state.temp', 60_000);
            for (let i = 0; i < 1000; i++) {
                registry.touch('v1.state.temp');
            }
            expect(registry.size).toBe(1);
        });
    });

    describe('access counting', () => {
        it('accessCount increments correctly', () => {
            const registry = new TtlRegistry({ promotionThreshold: 10 });
            registry.set('v1.fact.x', 60_000);

            registry.touch('v1.fact.x');
            registry.touch('v1.fact.x');
            registry.touch('v1.fact.x');

            const entry = registry.get('v1.fact.x');
            expect(entry?.accessCount).toBe(3);
        });

        it('set() resets accessCount to 0', () => {
            const registry = new TtlRegistry({ promotionThreshold: 10 });
            registry.set('v1.fact.x', 60_000);
            registry.touch('v1.fact.x');
            registry.touch('v1.fact.x');

            // Re-set the TTL — should reset counter
            registry.set('v1.fact.x', 120_000);
            const entry = registry.get('v1.fact.x');
            expect(entry?.accessCount).toBe(0);
            expect(entry?.ttlMs).toBe(120_000);
        });
    });

    describe('touchAll batch promotion', () => {
        it('returns promoted count when batch triggers promotions', () => {
            const promoted: string[] = [];
            const registry = new TtlRegistry({
                promotionThreshold: 2,
                onPromote: (atom) => promoted.push(atom),
            });

            // Set up 3 atoms with 1 access each
            registry.set('v1.state.a', 60_000);
            registry.set('v1.state.b', 60_000);
            registry.set('v1.state.c', 60_000);
            registry.touch('v1.state.a');
            registry.touch('v1.state.b');
            // c has 0 accesses

            // Batch touch: a (count→2 = promoted), b (count→2 = promoted), c (count→1 = touched)
            const result = registry.touchAll(['v1.state.a', 'v1.state.b', 'v1.state.c']);
            expect(result.promoted).toBe(2);
            expect(result.touched).toBe(1);
            expect(promoted).toEqual(['v1.state.a', 'v1.state.b']);
        });

        it('touchAll returns noop for unknown atoms', () => {
            const registry = new TtlRegistry();
            const result = registry.touchAll(['v1.fact.unknown', 'v1.fact.also_unknown']);
            expect(result.touched).toBe(0);
            expect(result.promoted).toBe(0);
        });
    });

    describe('totalPromoted counter', () => {
        it('tracks cumulative promotions', () => {
            const registry = new TtlRegistry({ promotionThreshold: 1 });
            expect(registry.totalPromoted).toBe(0);

            registry.set('v1.state.a', 60_000);
            registry.touch('v1.state.a');
            expect(registry.totalPromoted).toBe(1);

            registry.set('v1.state.b', 60_000);
            registry.touch('v1.state.b');
            expect(registry.totalPromoted).toBe(2);
        });
    });

    describe('onPromote callback safety', () => {
        it('callback error does not break the access path', () => {
            const registry = new TtlRegistry({
                promotionThreshold: 1,
                onPromote: () => { throw new Error('callback exploded'); },
            });

            registry.set('v1.state.fragile', 60_000);
            // Should not throw despite callback error
            expect(() => registry.touch('v1.state.fragile')).not.toThrow();
        });
    });

    describe('expiry with mixed promoted/unpromoted atoms', () => {
        it('only unpromoted atoms appear in expired()', () => {
            const registry = new TtlRegistry({ promotionThreshold: 2 });

            // Both set with 1ms TTL
            registry.set('v1.state.promoted', 1);
            registry.set('v1.state.expired', 1);

            // Promote the first one
            registry.touch('v1.state.promoted');
            registry.touch('v1.state.promoted');

            // Both have expired TTL time-wise
            const expired = registry.expired(Date.now() + 100_000);
            expect(expired).toHaveLength(1);
            expect(expired[0].atom).toBe('v1.state.expired');
        });
    });

    describe('backward compatibility', () => {
        it('default constructor works without options', () => {
            const registry = new TtlRegistry();
            expect(registry.threshold).toBe(3);
            registry.set('v1.fact.x', 60_000);
            expect(registry.touch('v1.fact.x')).toBe('touched');
        });

        it('touch returns noop for non-TTL atoms', () => {
            const registry = new TtlRegistry();
            expect(registry.touch('v1.fact.nonexistent')).toBe('noop');
        });
    });
});
