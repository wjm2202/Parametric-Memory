import { DataAtom } from './types';

export const ATOM_SCHEMA_VERSION = 'v1' as const;
export const ATOM_TYPES = ['fact', 'event', 'relation', 'state', 'procedure', 'other'] as const;

export type AtomType = typeof ATOM_TYPES[number];

export interface AtomV1 {
    schemaVersion: typeof ATOM_SCHEMA_VERSION;
    type: AtomType;
    value: string;
}

type AtomV1Input = {
    schemaVersion?: 'v1' | 1;
    type?: unknown;
    value?: unknown;
};

const V1_PATTERN = /^v1\.(fact|event|relation|state|procedure|other)\.(.+)$/;

function isAtomType(input: unknown): input is AtomType {
    return typeof input === 'string' && (ATOM_TYPES as readonly string[]).includes(input);
}

function normalizeValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/[\r\n]/.test(trimmed)) return null;
    return trimmed;
}

export function encodeAtomV1(type: AtomType, value: string): DataAtom {
    const normalized = normalizeValue(value);
    if (!normalized) throw new Error('Atom value must be a non-empty single-line string.');
    return `${ATOM_SCHEMA_VERSION}.${type}.${normalized}`;
}

export function parseAtomV1(atom: DataAtom): AtomV1 | null {
    if (typeof atom !== 'string') return null;
    const match = atom.match(V1_PATTERN);
    if (!match) return null;
    const type = match[1];
    const value = match[2]?.trim();
    if (!isAtomType(type) || !value || /[\r\n]/.test(value)) return null;
    return {
        schemaVersion: ATOM_SCHEMA_VERSION,
        type,
        value,
    };
}

export function isAtomV1(atom: DataAtom): boolean {
    return parseAtomV1(atom) !== null;
}

export function normalizeAtomInput(input: unknown): DataAtom | null {
    if (typeof input === 'string') {
        return isAtomV1(input) ? input : null;
    }

    if (input && typeof input === 'object') {
        const candidate = input as AtomV1Input;
        if (!isAtomType(candidate.type)) return null;
        if (
            candidate.schemaVersion !== undefined &&
            candidate.schemaVersion !== 'v1' &&
            candidate.schemaVersion !== 1
        ) {
            return null;
        }
        const normalized = normalizeValue(candidate.value);
        if (!normalized) return null;
        return encodeAtomV1(candidate.type, normalized);
    }

    return null;
}

export function assertAtomV1(atom: DataAtom, label: string = 'atom'): void {
    if (!isAtomV1(atom)) {
        throw new Error(
            `${label} must be schema v1: 'v1.<type>.<value>' with type in {fact,event,relation,state,procedure,other}.`
        );
    }
}

export function assertAtomsV1(atoms: DataAtom[], label: string = 'atoms'): void {
    for (let i = 0; i < atoms.length; i++) {
        assertAtomV1(atoms[i], `${label}[${i}]`);
    }
}
