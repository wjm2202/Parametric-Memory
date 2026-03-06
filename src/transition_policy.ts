import { ATOM_TYPES, AtomType } from './atom_schema';

export type TypePolicyConfig = Partial<Record<AtomType, AtomType[]>>;

const TYPE_TO_INDEX: Record<AtomType, number> = {
    fact: 0,
    event: 1,
    relation: 2,
    state: 3,
    procedure: 4,
    other: 5,
};

export class TransitionPolicy {
    private readonly allowed: boolean[][];

    private constructor(allowed: boolean[][]) {
        this.allowed = allowed;
    }

    static default(): TransitionPolicy {
        const allAllowed = Array.from({ length: ATOM_TYPES.length }, () =>
            Array.from({ length: ATOM_TYPES.length }, () => true)
        );
        return new TransitionPolicy(allAllowed);
    }

    static fromConfig(cfg: TypePolicyConfig): TransitionPolicy {
        const matrix = Array.from({ length: ATOM_TYPES.length }, () =>
            Array.from({ length: ATOM_TYPES.length }, () => true)
        );

        for (const fromType of Object.keys(cfg) as AtomType[]) {
            const allowedTargets = cfg[fromType] ?? [];
            matrix[TYPE_TO_INDEX[fromType]] = Array.from({ length: ATOM_TYPES.length }, () => false);
            for (const toType of allowedTargets) {
                matrix[TYPE_TO_INDEX[fromType]][TYPE_TO_INDEX[toType]] = true;
            }
        }

        return new TransitionPolicy(matrix);
    }

    isAllowed(fromType: AtomType, toType: AtomType): boolean {
        return this.allowed[TYPE_TO_INDEX[fromType]][TYPE_TO_INDEX[toType]];
    }

    isOpenPolicy(): boolean {
        for (let from = 0; from < ATOM_TYPES.length; from++) {
            for (let to = 0; to < ATOM_TYPES.length; to++) {
                if (!this.allowed[from][to]) return false;
            }
        }
        return true;
    }

    toConfig(): TypePolicyConfig {
        const cfg: TypePolicyConfig = {};

        for (const fromType of ATOM_TYPES) {
            const row = this.allowed[TYPE_TO_INDEX[fromType]];
            const allAllowed = row.every(v => v === true);
            if (allAllowed) continue;

            cfg[fromType] = ATOM_TYPES.filter((toType) =>
                row[TYPE_TO_INDEX[toType]]
            );
        }

        return cfg;
    }
}
