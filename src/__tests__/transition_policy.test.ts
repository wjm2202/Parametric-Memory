import { describe, expect, it } from 'vitest';
import { ATOM_TYPES } from '../atom_schema';
import { TransitionPolicy } from '../transition_policy';

describe('TransitionPolicy', () => {
    it('default() allows all 25 type pairs', () => {
        const policy = TransitionPolicy.default();
        for (const from of ATOM_TYPES) {
            for (const to of ATOM_TYPES) {
                expect(policy.isAllowed(from, to)).toBe(true);
            }
        }
    });

    it('fromConfig({fact:[fact]}) allows only fact→fact and blocks fact→event', () => {
        const policy = TransitionPolicy.fromConfig({ fact: ['fact'] });
        expect(policy.isAllowed('fact', 'fact')).toBe(true);
        expect(policy.isAllowed('fact', 'event')).toBe(false);
        expect(policy.isAllowed('fact', 'relation')).toBe(false);
        expect(policy.isAllowed('event', 'fact')).toBe(true);
    });

    it('fromConfig with missing key keeps unlisted fromTypes fully open', () => {
        const policy = TransitionPolicy.fromConfig({ relation: ['state'] });
        expect(policy.isAllowed('relation', 'state')).toBe(true);
        expect(policy.isAllowed('relation', 'fact')).toBe(false);
        expect(policy.isAllowed('fact', 'event')).toBe(true);
        expect(policy.isAllowed('other', 'state')).toBe(true);
    });

    it('isOpenPolicy() true for default and false for restricted config', () => {
        expect(TransitionPolicy.default().isOpenPolicy()).toBe(true);
        expect(TransitionPolicy.fromConfig({ fact: ['fact'] }).isOpenPolicy()).toBe(false);
    });

    it('toConfig() round-trips through fromConfig()', () => {
        const cfg = {
            fact: ['fact', 'relation'],
            event: ['state'],
            other: [],
        } as const;
        const policy = TransitionPolicy.fromConfig(cfg);
        const roundTrip = TransitionPolicy.fromConfig(policy.toConfig());
        for (const from of ATOM_TYPES) {
            for (const to of ATOM_TYPES) {
                expect(roundTrip.isAllowed(from, to)).toBe(policy.isAllowed(from, to));
            }
        }
    });

    it('isAllowed() same-type transitions are allowed by default', () => {
        const policy = TransitionPolicy.default();
        for (const type of ATOM_TYPES) {
            expect(policy.isAllowed(type, type)).toBe(true);
        }
    });

    it('fromConfig with empty array blocks all outgoing from that type', () => {
        const policy = TransitionPolicy.fromConfig({ state: [] });
        for (const to of ATOM_TYPES) {
            expect(policy.isAllowed('state', to)).toBe(false);
        }
        expect(policy.isAllowed('fact', 'event')).toBe(true);
    });
});
