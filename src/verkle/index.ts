/**
 * Verkle Tree Module — Sprint 16
 *
 * Re-exports all Verkle tree primitives.
 */

export {
    // Field and curve primitives
    FIELD_P,
    GROUP_ORDER,
    fieldAdd,
    fieldSub,
    fieldMul,
    fieldPow,
    fieldInv,
    compressPoint,
    decompressPoint,
    hashToCurve,
    getGenerator,
    precomputeGenerators,
    pedersenCommit,
    hashToScalar,
    scalarMul,
    pointAdd,
    pointNeg,
    pointEq,
    multiScalarMul,
    Transcript,
    ipaProve,
    ipaVerify,
} from './kzg';
export type {
    ECPoint,
    CurvePoint,
    IpaProof,
    VerkleOpening,
    VerkleProof,
} from './kzg';

export {
    VerkleTree,
    VERKLE_WIDTH,
    VERKLE_WIDTH_LOG2,
} from './verkle_tree';

export {
    aggregateProofs,
    verifyMultiproof,
    estimateMultiproofSize,
    estimateMerkleEquivalentSize,
} from './multiproof';
export type {
    GroupedOpening,
    VerkleMultiproof,
} from './multiproof';

export {
    isVerkleProof,
    isMerkleProof,
    getProofVersion,
    verifyUnifiedProof,
    annotateMerkleProof,
    validateProofShape,
} from './proof_compat';
export type {
    UnifiedProof,
} from './proof_compat';
