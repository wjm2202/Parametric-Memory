/**
 * Verkle Tree — Sprint 16.2
 *
 * A configurable-width tree (default 256) using Pedersen vector commitments
 * with IPA opening proofs.  Implements the same public interface as
 * IncrementalMerkleTree: appendLeaf(), updateLeaf(), getProof(), root, leafCount
 *
 * Tree structure:
 *   - Each internal node commits to up to `width` children using Pedersen commitment
 *   - Leaves are SHA-256 hashes of atom data (same as Merkle)
 *   - Tree depth = ceil(log_width(leafCount)) — typically 2-3 levels
 *   - Root is the compressed EC point of the top-level commitment
 *
 * Width must be a power of 2 (required by IPA).
 * Default: 256 (production).  Use 16 for fast tests.
 */

import { createHash } from 'crypto';
import type { Hash } from '../types';
import {
    CurvePoint,
    ECPoint,
    VerkleProof,
    VerkleOpening,
    GROUP_ORDER,
    compressPoint,
    hashToScalar,
    pedersenCommit,
    precomputeGenerators,
    ipaProve,
    ipaVerify,
    decompressPoint,
} from './kzg';

// ─── Constants ───────────────────────────────────────────────────────────

/** Default branching factor of the Verkle tree */
export const VERKLE_WIDTH = 256;

/** Log₂ of the default width */
export const VERKLE_WIDTH_LOG2 = 8;

/** Zero scalar — represents an empty/unused child slot */
const ZERO_SCALAR = 0n;

/** Per-width generator cache */
const generatorSets = new Map<number, ECPoint[]>();

function getGeneratorsForWidth(width: number): ECPoint[] {
    let gens = generatorSets.get(width);
    if (!gens) {
        gens = precomputeGenerators(width);
        generatorSets.set(width, gens);
    }
    return gens;
}

// ─── Internal Node ───────────────────────────────────────────────────────

interface VerkleNode {
    /** Child values as scalars (hashes converted to field elements) */
    children: bigint[];
    /** Pedersen commitment to children — cached, recomputed on change */
    commitment: CurvePoint;
    /** Whether the commitment needs recomputation */
    dirty: boolean;
}

// ─── Verkle Tree ─────────────────────────────────────────────────────────

export class VerkleTree {
    /** Flat leaf hashes (hex strings, same as IncrementalMerkleTree) */
    private _leaves: string[];
    /** Internal nodes, indexed by level (0 = root level) */
    private levels: VerkleNode[][];
    /** Tree depth (number of internal node levels) */
    private _depth: number;
    /** Branching factor (must be power of 2) */
    private _width: number;

    private constructor(leaves: string[], width: number) {
        if (width < 2 || (width & (width - 1)) !== 0) {
            throw new Error(`Width must be a power of 2 >= 2, got ${width}`);
        }
        this._leaves = leaves;
        this._width = width;
        this._depth = 0;
        this.levels = [];
        this.rebuild();
    }

    // ─── Static Constructors ─────────────────────────────────────────

    /** Build a Verkle tree from an array of leaf hashes (hex strings) */
    static fromLeaves(leaves: string[], width: number = VERKLE_WIDTH): VerkleTree {
        return new VerkleTree([...leaves], width);
    }

    /** Build an empty tree */
    static empty(width: number = VERKLE_WIDTH): VerkleTree {
        return new VerkleTree([], width);
    }

    // ─── Public Interface ────────────────────────────────────────────

    /** Root as a compressed EC point hex string */
    get root(): Hash {
        if (this._leaves.length === 0) {
            return '00'.repeat(33);
        }
        this.ensureClean();
        const topNode = this.levels[0][0];
        return compressPoint(topNode.commitment);
    }

    /** Number of leaves in the tree */
    get leafCount(): number {
        return this._leaves.length;
    }

    /** Tree depth (number of internal levels) */
    get depth(): number {
        return this._depth;
    }

    /** Tree width (branching factor) */
    get width(): number {
        return this._width;
    }

    /** Append a new leaf hash to the tree */
    appendLeaf(leafHash: string): void {
        this._leaves.push(leafHash);
        this.rebuild();
    }

    /** Update a leaf at a given index (for tombstoning or modification) */
    updateLeaf(index: number, newLeafHash: string): void {
        if (index < 0 || index >= this._leaves.length) {
            throw new RangeError(`Leaf index ${index} out of bounds [0, ${this._leaves.length})`);
        }
        this._leaves[index] = newLeafHash;
        this.rebuild(); // full rebuild (simpler, correct)
    }

    /** Generate a Verkle proof for a leaf at the given index */
    getProof(index: number): VerkleProof {
        if (index < 0 || index >= this._leaves.length) {
            throw new RangeError(`Leaf index ${index} out of bounds [0, ${this._leaves.length})`);
        }

        this.ensureClean();
        const generators = getGeneratorsForWidth(this._width);
        const openings: VerkleOpening[] = [];

        // Walk from root to the leaf's parent
        let currentIndex = index;
        for (let level = this._depth - 1; level >= 0; level--) {
            const nodeIndex = this.getNodeIndex(currentIndex, level);
            const childPos = this.getChildPosition(currentIndex, level);
            const node = this.levels[level][nodeIndex];

            // Generate IPA opening proof
            const padded = this.padToWidth(node.children);
            const val = padded[childPos];
            const proof = ipaProve(padded, generators, childPos, val);

            openings.unshift({
                commitment: compressPoint(node.commitment),
                proof,
                childIndex: childPos,
                value: val.toString(16).padStart(64, '0'),
            });

            currentIndex = Math.floor(currentIndex / this._width);
        }

        return {
            proofVersion: 2,
            leaf: this._leaves[index],
            root: this.root,
            index,
            openings,
            depth: this._depth,
            width: this._width,
        };
    }

    /** Get the leaf hash at a given index */
    getLeafHash(index: number): Hash {
        if (index < 0 || index >= this._leaves.length) {
            throw new RangeError(`Leaf index ${index} out of bounds [0, ${this._leaves.length})`);
        }
        return this._leaves[index];
    }

    // ─── Static Verification ─────────────────────────────────────────

    /**
     * Verify a Verkle proof without any tree state.
     * Purely from the proof data — suitable for third-party auditors.
     *
     * @param proof The VerkleProof to verify
     * @param expectedRoot Optional: check against a known root
     * @param width The tree width used (default 256, must match)
     */
    static verifyProof(proof: VerkleProof, expectedRoot?: string, width?: number): boolean {
        width = width ?? proof.width ?? VERKLE_WIDTH;
        if (proof.proofVersion !== 2) return false;
        if (proof.openings.length !== proof.depth) return false;
        if (proof.openings.length === 0) return false;

        const generators = getGeneratorsForWidth(width);

        // Root commitment must match
        if (expectedRoot && proof.root !== expectedRoot) return false;
        if (proof.openings[0].commitment !== proof.root) return false;

        // Verify chain: each opening's value should match the commitment of the next level
        for (let i = 0; i < proof.openings.length - 1; i++) {
            const opening = proof.openings[i];
            const nextOpening = proof.openings[i + 1];
            const nextCommitmentScalar = hashToScalar(
                createHash('sha256')
                    .update(Buffer.from(nextOpening.commitment, 'hex'))
                    .digest()
                    .toString('hex'),
            );
            if (opening.value !== nextCommitmentScalar.toString(16).padStart(64, '0')) {
                return false;
            }
        }

        // Bottommost opening's value should be the leaf hash as a scalar
        const bottomOpening = proof.openings[proof.openings.length - 1];
        const leafScalar = hashToScalar(proof.leaf);
        if (bottomOpening.value !== leafScalar.toString(16).padStart(64, '0')) {
            return false;
        }

        // Verify each IPA opening
        for (const opening of proof.openings) {
            const commitment = decompressPoint(opening.commitment);
            const value = BigInt('0x' + opening.value);
            const valid = ipaVerify(commitment, generators, opening.childIndex, value, opening.proof);
            if (!valid) return false;
        }

        return true;
    }

    // ─── Internal Methods ────────────────────────────────────────────

    /** Full tree rebuild from leaves */
    private rebuild(): void {
        if (this._leaves.length === 0) {
            this.levels = [];
            this._depth = 0;
            return;
        }

        this._depth = Math.max(1, Math.ceil(Math.log(this._leaves.length) / Math.log(this._width)));

        const generators = getGeneratorsForWidth(this._width);
        this.levels = [];

        // Bottom level: group leaves into nodes of width
        let currentValues: bigint[] = this._leaves.map(h => hashToScalar(h));

        for (let level = this._depth - 1; level >= 0; level--) {
            const nodeCount = Math.ceil(currentValues.length / this._width);
            const nodes: VerkleNode[] = [];

            for (let n = 0; n < nodeCount; n++) {
                const start = n * this._width;
                const children = currentValues.slice(start, start + this._width);
                const padded = this.padToWidth(children);
                const commitment = pedersenCommit(padded, generators);

                nodes.push({
                    children: children.slice(),
                    commitment,
                    dirty: false,
                });
            }

            this.levels[level] = nodes;

            // Next level's values are scalar hashes of the commitments
            currentValues = nodes.map(node => {
                const commitHex = compressPoint(node.commitment);
                return hashToScalar(
                    createHash('sha256')
                        .update(Buffer.from(commitHex, 'hex'))
                        .digest()
                        .toString('hex'),
                );
            });
        }
    }

    /** Pad a children array to width with zeros */
    private padToWidth(children: bigint[]): bigint[] {
        if (children.length >= this._width) return children.slice(0, this._width);
        const padded = new Array(this._width).fill(ZERO_SCALAR);
        for (let i = 0; i < children.length; i++) {
            padded[i] = children[i];
        }
        return padded;
    }

    /** Get the node index at a given level for a leaf index */
    private getNodeIndex(leafIndex: number, level: number): number {
        const levelsBelow = this._depth - 1 - level;
        return Math.floor(leafIndex / Math.pow(this._width, levelsBelow + 1));
    }

    /** Get the child position within a node at a given level */
    private getChildPosition(leafIndex: number, level: number): number {
        const levelsBelow = this._depth - 1 - level;
        return Math.floor(leafIndex / Math.pow(this._width, levelsBelow)) % this._width;
    }

    /** Ensure all commitments are up to date */
    private ensureClean(): void {
        // After rebuild, nothing is dirty. This is a safety check.
        for (const level of this.levels) {
            for (const node of level) {
                if (node.dirty) {
                    const padded = this.padToWidth(node.children);
                    node.commitment = pedersenCommit(padded, getGeneratorsForWidth(this._width));
                    node.dirty = false;
                }
            }
        }
    }
}
