/**
 * Proof Format Compatibility Layer — Sprint 16.3
 *
 * Handles dual proof formats during the Merkle→Verkle transition:
 *   - proofVersion 1: SHA-256 Merkle (auditPath-based)
 *   - proofVersion 2: secp256k1 Verkle (IPA commitment-based)
 *
 * Both formats remain verifiable forever.  Old v1 proofs never expire.
 * New atoms get v2 proofs when the Verkle tree is enabled.
 *
 * This module is used by:
 *   - POST /verify endpoint
 *   - memory_verify MCP tool
 *   - memory_atom_get response
 *   - session_bootstrap evidence
 */

import type { MerkleProof, Hash } from '../types';
import type { VerkleProof } from './kzg';
import { MerkleSnapshot } from '../merkle_snapshot';
import { VerkleTree } from './verkle_tree';

// ─── Unified Proof Type ──────────────────────────────────────────────────

/**
 * A proof that can be either Merkle (v1) or Verkle (v2).
 * The proofVersion field discriminates between them.
 */
export type UnifiedProof =
    | (MerkleProof & { proofVersion?: 1 })
    | VerkleProof;

// ─── Type Guards ─────────────────────────────────────────────────────────

/** Check if a proof is a Verkle proof (version 2) */
export function isVerkleProof(proof: UnifiedProof): proof is VerkleProof {
    return 'proofVersion' in proof && (proof as any).proofVersion === 2;
}

/** Check if a proof is a Merkle proof (version 1 or unversioned) */
export function isMerkleProof(proof: UnifiedProof): proof is MerkleProof & { proofVersion?: 1 } {
    return !isVerkleProof(proof);
}

/** Get the proof version number */
export function getProofVersion(proof: UnifiedProof): 1 | 2 {
    if (isVerkleProof(proof)) return 2;
    return 1;
}

// ─── Unified Verification ────────────────────────────────────────────────

/**
 * Verify a proof of either version.
 * Dispatches to the appropriate verification algorithm based on proofVersion.
 *
 * @param proof The proof to verify (v1 Merkle or v2 Verkle)
 * @param expectedRoot Optional: expected root to check against
 * @returns true if the proof is valid
 */
export function verifyUnifiedProof(proof: UnifiedProof, expectedRoot?: Hash): boolean {
    if (isVerkleProof(proof)) {
        return VerkleTree.verifyProof(proof, expectedRoot);
    }

    // Merkle proof (v1)
    const merkleProof: MerkleProof = {
        leaf: proof.leaf,
        root: proof.root,
        auditPath: proof.auditPath,
        index: proof.index,
    };
    return MerkleSnapshot.verifyProof(merkleProof, expectedRoot);
}

/**
 * Annotate a Merkle proof with proofVersion: 1 for explicit versioning.
 * Useful when serializing proofs to JSON for the API.
 */
export function annotateMerkleProof(proof: MerkleProof): MerkleProof & { proofVersion: 1 } {
    return { ...proof, proofVersion: 1 };
}

/**
 * Validate the shape of a proof object for API input validation.
 * Returns a descriptive error string or null if valid.
 */
export function validateProofShape(proof: unknown): string | null {
    if (!proof || typeof proof !== 'object') {
        return 'Proof must be a non-null object';
    }

    const p = proof as Record<string, unknown>;

    // Check for Verkle proof shape
    if (p.proofVersion === 2) {
        if (typeof p.leaf !== 'string') return 'Verkle proof requires leaf (string)';
        if (typeof p.root !== 'string') return 'Verkle proof requires root (string)';
        if (typeof p.index !== 'number') return 'Verkle proof requires index (number)';
        if (!Array.isArray(p.openings)) return 'Verkle proof requires openings (array)';
        if (typeof p.depth !== 'number') return 'Verkle proof requires depth (number)';
        return null;
    }

    // Check for Merkle proof shape (v1 or unversioned)
    if (typeof p.leaf !== 'string') return 'Merkle proof requires leaf (string)';
    if (typeof p.root !== 'string') return 'Merkle proof requires root (string)';
    if (typeof p.index !== 'number') return 'Merkle proof requires index (number)';
    if (!Array.isArray(p.auditPath)) return 'Merkle proof requires auditPath (array)';
    return null;
}
