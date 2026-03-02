/**
 * Test Scenarios — Fixture Definitions
 *
 * Each scenario is a complete, self-contained specification:
 *   - the exact atom pool that will be loaded
 *   - the training sequences (with optional repeat counts to build weight)
 *   - the precise expected predictions after training
 *
 * Scenarios serve as executable documentation for system behaviour.
 * Adding a new scenario here automatically runs it through the full
 * lifecycle harness in lifecycle.test.ts.
 */
import { DataAtom } from '../../types';
const atom = (value: string): DataAtom => `v1.other.${value}`;

export interface TrainingStep {
    /** Sequence of atoms to train in order, e.g. ['A', 'B', 'C'] */
    sequence: DataAtom[];
    /**
     * Number of times to repeat this training step.
     * Higher repeat counts strengthen the Markov weight for this path,
     * which is useful for testing weighted prediction (e.g. dominant vs minority paths).
     * Defaults to 1.
     */
    repeat?: number;
}

export interface PredictionExpectation {
    /** The atom being accessed */
    from: DataAtom;
    /**
     * The atom we expect the system to predict as the next step.
     * Set to null to assert that NO prediction should be made
     * (i.e. the atom is untrained or is a terminal node).
     */
    expectedNext: DataAtom | null;
    /** Human-readable explanation — used in assertion failure messages */
    reason: string;
}

export interface TestScenario {
    /** Short identifier — used as the describe() block name */
    name: string;
    /** Description of what behaviour this scenario exercises */
    description: string;
    /** Full pool of atoms to load into the cluster */
    atoms: DataAtom[];
    /** Ordered training steps to execute before running expectations */
    training: TrainingStep[];
    /** Exact predictions that must hold after all training is complete */
    expectations: PredictionExpectation[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Linear Chain
// The simplest possible case — one unambiguous path through all atoms.
// After training: A→B→C→D, each atom should predict exactly the next one.
// D is a terminal node, so it should predict null.
// ─────────────────────────────────────────────────────────────────────────────
export const LINEAR_CHAIN: TestScenario = {
    name: 'linear-chain',
    description: 'Single unambiguous path A→B→C→D. Each atom predicts the next; D predicts null.',
    atoms: [atom('Alpha'), atom('Beta'), atom('Gamma'), atom('Delta')],
    training: [
        { sequence: [atom('Alpha'), atom('Beta'), atom('Gamma'), atom('Delta')], repeat: 3 },
    ],
    expectations: [
        { from: atom('Alpha'), expectedNext: atom('Beta'),  reason: 'Alpha trained exclusively → Beta' },
        { from: atom('Beta'),  expectedNext: atom('Gamma'), reason: 'Beta trained exclusively → Gamma' },
        { from: atom('Gamma'), expectedNext: atom('Delta'), reason: 'Gamma trained exclusively → Delta' },
        { from: atom('Delta'), expectedNext: null,          reason: 'Delta is terminal — no outgoing transitions' },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: Forking Path — dominant vs minority branch
// From 'Root', two paths exist: Root→Dominant (trained 5×) and Root→Minority (trained 1×).
// The system must predict Dominant because it has the higher accumulated weight.
// ─────────────────────────────────────────────────────────────────────────────
export const FORKING_PATH: TestScenario = {
    name: 'forking-path',
    description: 'Root has two successors. Dominant path trained 5× should win over 1× Minority.',
    atoms: [atom('Root'), atom('Dominant'), atom('Minority'), atom('End')],
    training: [
        { sequence: [atom('Root'), atom('Dominant'), atom('End')], repeat: 5 },
        { sequence: [atom('Root'), atom('Minority'), atom('End')], repeat: 1 },
    ],
    expectations: [
        { from: atom('Root'),      expectedNext: atom('Dominant'), reason: 'Root→Dominant weight 5 > Root→Minority weight 1' },
        { from: atom('Dominant'),  expectedNext: atom('End'),      reason: 'Dominant trained exclusively → End' },
        { from: atom('Minority'),  expectedNext: atom('End'),      reason: 'Minority trained exclusively → End' },
        { from: atom('End'),       expectedNext: null,             reason: 'End is terminal in all training sequences' },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Circular Sequence
// A→B→C→A forms a loop. The system should predict the correct next atom
// regardless of where in the loop you enter.
// ─────────────────────────────────────────────────────────────────────────────
export const CIRCULAR: TestScenario = {
    name: 'circular',
    description: 'Loop A→B→C→A. Prediction should follow the ring regardless of entry point.',
    atoms: [atom('Loop_A'), atom('Loop_B'), atom('Loop_C')],
    training: [
        // Train the full cycle 4× to build strong weights on all three edges
        { sequence: [atom('Loop_A'), atom('Loop_B'), atom('Loop_C'), atom('Loop_A'), atom('Loop_B'), atom('Loop_C')], repeat: 4 },
    ],
    expectations: [
        { from: atom('Loop_A'), expectedNext: atom('Loop_B'), reason: 'Loop_A→Loop_B is the trained transition' },
        { from: atom('Loop_B'), expectedNext: atom('Loop_C'), reason: 'Loop_B→Loop_C is the trained transition' },
        { from: atom('Loop_C'), expectedNext: atom('Loop_A'), reason: 'Loop_C→Loop_A closes the ring' },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Convergent Paths
// Two distinct entry points (PathX_Start, PathY_Start) both converge on
// a shared Hub atom, then continue to End. Tests that the system correctly
// tracks per-atom outgoing transitions independently.
// ─────────────────────────────────────────────────────────────────────────────
export const CONVERGENT: TestScenario = {
    name: 'convergent',
    description: 'PathX and PathY both lead to Hub. Hub→End regardless of which path was taken.',
    atoms: [atom('PathX_Start'), atom('PathY_Start'), atom('Hub'), atom('End')],
    training: [
        { sequence: [atom('PathX_Start'), atom('Hub'), atom('End')], repeat: 3 },
        { sequence: [atom('PathY_Start'), atom('Hub'), atom('End')], repeat: 3 },
    ],
    expectations: [
        { from: atom('PathX_Start'), expectedNext: atom('Hub'), reason: 'PathX trained exclusively into Hub' },
        { from: atom('PathY_Start'), expectedNext: atom('Hub'), reason: 'PathY trained exclusively into Hub' },
        { from: atom('Hub'),         expectedNext: atom('End'), reason: 'Hub trained exclusively → End' },
        { from: atom('End'),         expectedNext: null,        reason: 'End is terminal' },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: Untrained Atom
// One atom in the pool is never included in any training sequence.
// The system must still accept an access() call for it (it exists in the
// Merkle tree) but must predict null — no Markov transitions recorded.
// ─────────────────────────────────────────────────────────────────────────────
export const UNTRAINED_ATOM: TestScenario = {
    name: 'untrained-atom',
    description: 'Orphan atom exists in the pool but receives no training. Proof valid, prediction null.',
    atoms: [atom('Trained_A'), atom('Trained_B'), atom('Orphan')],
    training: [
        { sequence: [atom('Trained_A'), atom('Trained_B')], repeat: 2 },
    ],
    expectations: [
        { from: atom('Trained_A'), expectedNext: atom('Trained_B'), reason: 'Trained_A→Trained_B is the only training path' },
        { from: atom('Orphan'),    expectedNext: null,               reason: 'Orphan has no outgoing transitions — no training' },
    ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Weight Reinforcement
// The same transition is trained repeatedly. This verifies weight accumulation
// and that the system still predicts correctly after many reinforcements
// (regression guard against overflow / normalisation bugs).
// ─────────────────────────────────────────────────────────────────────────────
export const REINFORCEMENT: TestScenario = {
    name: 'reinforcement',
    description: 'Same transition trained 20×. Weight accumulates; prediction remains stable.',
    atoms: [atom('Src'), atom('Dst'), atom('Noise')],
    training: [
        { sequence: [atom('Src'), atom('Dst')],   repeat: 20 },
        { sequence: [atom('Src'), atom('Noise')], repeat: 1  },
    ],
    expectations: [
        { from: atom('Src'), expectedNext: atom('Dst'), reason: 'Dst weight 20 dominates Noise weight 1' },
    ],
};

/** All scenarios — imported by lifecycle.test.ts for automated iteration */
export const ALL_SCENARIOS: TestScenario[] = [
    LINEAR_CHAIN,
    FORKING_PATH,
    CIRCULAR,
    CONVERGENT,
    UNTRAINED_ATOM,
    REINFORCEMENT,
];
