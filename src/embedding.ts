/**
 * Pluggable embedding provider for MMPM hybrid search.
 *
 * Architecture: EmbeddingProvider interface decouples the scoring layer from
 * the specific embedding algorithm.  Ships with NgramHashEmbedding (zero
 * external deps); can be swapped for Model2Vec / GloVe when available.
 *
 * NgramHashEmbedding uses character n-gram feature hashing (fastText-style):
 *   1. Tokenise text into words
 *   2. For each word, generate char 2/3/4/5-grams + the full word token
 *   3. Hash each feature to a bucket in a fixed-size float32 vector
 *   4. L2-normalise the vector
 *
 * This captures morphological similarity ("fast" ↔ "fastify", "test" ↔ "testing")
 * and partial subword overlaps without requiring pre-trained weights.
 */

import { tokenizeText } from './bm25';

// ─── Public interface ───────────────────────────────────────────────────────

export interface EmbeddingProvider {
    /** Embed a text string into a dense float vector. */
    embed(text: string): Float32Array;

    /** Cosine similarity between two vectors (pre-normalised: just dot product). */
    similarity(a: Float32Array, b: Float32Array): number;

    /** Dimensionality of the embedding vectors. */
    readonly dimensions: number;
}

// ─── NgramHashEmbedding ─────────────────────────────────────────────────────

/** Default number of hash buckets (embedding dimensions). */
const DEFAULT_DIMS = 256;

/** Minimum n-gram size. */
const MIN_NGRAM = 3;

/** Maximum n-gram size. */
const MAX_NGRAM = 5;

/**
 * FNV-1a 32-bit hash — fast, well-distributed, deterministic.
 * Used to map character n-grams to bucket indices.
 */
function fnv1a32(str: string): number {
    let hash = 0x811c9dc5;  // FNV offset basis
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) | 0;  // FNV prime, keep 32-bit
    }
    return hash >>> 0;  // unsigned
}

/**
 * Generate character n-grams for a single word.
 * For words shorter than MIN_NGRAM, returns the word itself as a feature.
 * Also includes the full word as a feature (word-level matching).
 */
function wordNgrams(word: string): string[] {
    const features: string[] = [];

    // Always include the full word (ensures exact token matching)
    features.push(`w:${word}`);

    if (word.length < MIN_NGRAM) {
        // For very short tokens (e.g., "db", "ai"), include as-is
        if (word.length >= 2) {
            features.push(`n:${word}`);
        }
        return features;
    }

    // Generate n-grams from MIN_NGRAM to MAX_NGRAM
    for (let n = MIN_NGRAM; n <= MAX_NGRAM; n++) {
        if (n > word.length) break;
        for (let i = 0; i <= word.length - n; i++) {
            features.push(`n:${word.substring(i, i + n)}`);
        }
    }

    return features;
}

/**
 * NgramHashEmbedding — zero-dependency character n-gram embeddings.
 *
 * Captures morphological and subword similarity between texts.
 * Vectors are L2-normalised so similarity() is just the dot product.
 */
export class NgramHashEmbedding implements EmbeddingProvider {
    readonly dimensions: number;

    constructor(dimensions: number = DEFAULT_DIMS) {
        this.dimensions = dimensions;
    }

    /**
     * Embed a text string into a dense float vector.
     *
     * Process:
     *   1. Tokenise into words (same tokeniser as BM25 for consistency)
     *   2. Generate character n-grams for each word
     *   3. Hash each n-gram feature to a bucket index
     *   4. Increment the bucket (frequency counting)
     *   5. L2-normalise
     */
    embed(text: string): Float32Array {
        const tokens = tokenizeText(text);
        const vec = new Float32Array(this.dimensions);

        if (tokens.length === 0) return vec;

        for (const token of tokens) {
            const features = wordNgrams(token);
            for (const feat of features) {
                const hash = fnv1a32(feat);
                const bucket = hash % this.dimensions;
                // Use sign hashing to reduce bucket collisions:
                // hash bit 31 determines +1 or -1 contribution
                const sign = (hash & 0x80000000) ? -1 : 1;
                vec[bucket] += sign;
            }
        }

        // L2 normalise
        let norm = 0;
        for (let i = 0; i < this.dimensions; i++) {
            norm += vec[i] * vec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < this.dimensions; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }

    /**
     * Cosine similarity between two L2-normalised vectors.
     * Since both vectors are unit-length, this is just the dot product.
     */
    similarity(a: Float32Array, b: Float32Array): number {
        let dot = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
        }
        // Clamp to [-1, 1] to handle floating-point drift
        return Math.max(-1, Math.min(1, dot));
    }
}

// ─── Model2VecEmbedding ─────────────────────────────────────────────────────

export interface Model2VecVocab {
    dimensions: number;
    vocab: Record<string, number[]>;
}

/**
 * Model2VecEmbedding — semantic embeddings from a distilled sentence transformer.
 *
 * Uses a pre-exported vocabulary lookup table (token → 256-dim vector).
 * Text embedding = L2-normalised mean of subword token vectors.
 *
 * WordPiece tokenisation: words not in vocab are split into subwords
 * using greedy longest-match with "##" continuation prefix.
 *
 * Captures true semantic similarity ("web framework" ↔ "fastify server")
 * that character n-grams cannot bridge.
 */
export class Model2VecEmbedding implements EmbeddingProvider {
    readonly dimensions: number;
    private readonly vocab: Map<string, Float32Array>;

    constructor(vocabData: Model2VecVocab) {
        this.dimensions = vocabData.dimensions;
        this.vocab = new Map();
        for (const [token, vec] of Object.entries(vocabData.vocab)) {
            this.vocab.set(token, new Float32Array(vec));
        }
    }

    /** Binary format magic number: "M2VB" */
    private static readonly BINARY_MAGIC = 0x4D325642;

    /**
     * Construct directly from a pre-built vocab Map (used by binary loader).
     */
    private static fromMap(dimensions: number, vocab: Map<string, Float32Array>): Model2VecEmbedding {
        const instance = Object.create(Model2VecEmbedding.prototype) as Model2VecEmbedding;
        (instance as any).dimensions = dimensions;
        (instance as any).vocab = vocab;
        return instance;
    }

    /**
     * Load vocabulary from a binary (.bin) file.
     * ~50× faster than JSON: binary reads in ~200ms vs ~7000ms for JSON.
     *
     * Binary format (little-endian):
     *   [0..3]   u32  magic (0x4D325642)
     *   [4..5]   u16  dimensions
     *   [6..7]   u16  reserved
     *   [8..11]  u32  string table byte offset
     *   [12..]   Float32 embedding matrix (tokenCount × dimensions)
     *   [stOff]  u32  tokenCount
     *   For each token: u16 byteLen + UTF-8 bytes
     */
    static fromBinaryFile(filePath: string): Model2VecEmbedding {
        const fs = require('fs');
        const buf: Buffer = fs.readFileSync(filePath);

        // Header
        const magic = buf.readUInt32LE(0);
        if (magic !== Model2VecEmbedding.BINARY_MAGIC) {
            throw new Error(`Invalid M2VB magic: 0x${magic.toString(16)}`);
        }
        const dimensions = buf.readUInt16LE(4);
        const stringTableOffset = buf.readUInt32LE(8);

        // String table (read token names first to pair with matrix rows)
        const tokenCount = buf.readUInt32LE(stringTableOffset);
        const tokens: string[] = new Array(tokenCount);
        let strOffset = stringTableOffset + 4;
        for (let i = 0; i < tokenCount; i++) {
            const len = buf.readUInt16LE(strOffset); strOffset += 2;
            tokens[i] = buf.toString('utf8', strOffset, strOffset + len);
            strOffset += len;
        }

        // Embedding matrix — bulk copy via ArrayBuffer for speed
        const vocab = new Map<string, Float32Array>();
        const matrixStart = 12; // after header
        const bytesPerVector = dimensions * 4;
        // Copy the entire matrix region into a single ArrayBuffer for alignment
        const matrixBytes = buf.subarray(matrixStart, matrixStart + tokenCount * bytesPerVector);
        const aligned = new ArrayBuffer(matrixBytes.length);
        new Uint8Array(aligned).set(matrixBytes);
        const allFloats = new Float32Array(aligned);
        for (let i = 0; i < tokenCount; i++) {
            vocab.set(tokens[i], allFloats.subarray(i * dimensions, (i + 1) * dimensions));
        }

        return Model2VecEmbedding.fromMap(dimensions, vocab);
    }

    /**
     * Load vocabulary from a JSON or binary file.
     * Resolution order:
     *   1. If path is .bin and exists → load binary
     *   2. If path is .json, check for .bin sibling → load binary
     *   3. If path is .bin but missing, check for .json sibling → load JSON
     *   4. Load whatever path was given as JSON
     */
    static fromFile(filePath: string): Model2VecEmbedding {
        const fs = require('fs');

        // Given a .bin path
        if (filePath.endsWith('.bin')) {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return Model2VecEmbedding.fromBinaryFile(filePath);
            }
            // .bin missing — try .json sibling
            const jsonPath = filePath.replace(/\.bin$/, '.json');
            if (fs.existsSync(jsonPath) && fs.statSync(jsonPath).isFile()) {
                const data: Model2VecVocab = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                return new Model2VecEmbedding(data);
            }
            throw new Error(`Model2Vec vocab not found at ${filePath} or ${jsonPath}`);
        }

        // Given a .json path — prefer .bin sibling
        if (filePath.endsWith('.json')) {
            const binPath = filePath.replace(/\.json$/, '.bin');
            if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
                return Model2VecEmbedding.fromBinaryFile(binPath);
            }
        }

        // Fallback: load as JSON
        const data: Model2VecVocab = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return new Model2VecEmbedding(data);
    }

    /**
     * WordPiece-style tokenisation: split a word into subwords found in vocab.
     * Greedy longest-match from left to right.
     * First piece uses the raw token; continuation pieces use "##" prefix.
     */
    private wordPieceTokenize(word: string): string[] {
        // Try full word first
        if (this.vocab.has(word)) return [word];

        const pieces: string[] = [];
        let pos = 0;

        while (pos < word.length) {
            const prefix = pos === 0 ? '' : '##';
            let bestLen = 0;

            // Greedy longest match
            for (let len = word.length - pos; len >= 1; len--) {
                const piece = prefix + word.substring(pos, pos + len);
                if (this.vocab.has(piece)) {
                    pieces.push(piece);
                    bestLen = len;
                    break;
                }
            }

            if (bestLen === 0) {
                // Character not in vocab — skip it
                pos++;
            } else {
                pos += bestLen;
            }
        }

        return pieces;
    }

    /**
     * Embed text by:
     *   1. Lowercase and split into words (same as BM25 tokeniser)
     *   2. WordPiece-tokenise each word into subword pieces
     *   3. Look up each piece's vector in the vocabulary
     *   4. Average all vectors and L2-normalise
     */
    embed(text: string): Float32Array {
        const words = tokenizeText(text);
        const vec = new Float32Array(this.dimensions);

        if (words.length === 0) return vec;

        let count = 0;
        for (const word of words) {
            const pieces = this.wordPieceTokenize(word);
            for (const piece of pieces) {
                const pieceVec = this.vocab.get(piece);
                if (pieceVec) {
                    for (let i = 0; i < this.dimensions; i++) {
                        vec[i] += pieceVec[i];
                    }
                    count++;
                }
            }
        }

        if (count === 0) return vec;

        // Average
        for (let i = 0; i < this.dimensions; i++) {
            vec[i] /= count;
        }

        // L2 normalise
        let norm = 0;
        for (let i = 0; i < this.dimensions; i++) {
            norm += vec[i] * vec[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < this.dimensions; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }

    /**
     * Cosine similarity between two L2-normalised vectors (dot product).
     */
    similarity(a: Float32Array, b: Float32Array): number {
        let dot = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
        }
        return Math.max(-1, Math.min(1, dot));
    }

    /** Number of tokens in the vocabulary (for diagnostics). */
    get vocabSize(): number { return this.vocab.size; }
}

// ─── EmbeddingIndex — manages per-atom cached embeddings ────────────────────

export interface EmbeddingIndexOptions {
    provider?: EmbeddingProvider;
}

/**
 * EmbeddingIndex — caches per-atom embeddings for fast similarity lookup.
 *
 * Mirrors the Bm25Index lifecycle:
 *   - build() from corpus at startup
 *   - addDocument() / removeDocument() for incremental updates
 *   - score() for query-time similarity
 */
export class EmbeddingIndex {
    private readonly provider: EmbeddingProvider;
    /** atom → cached embedding vector */
    private readonly cache: Map<string, Float32Array> = new Map();

    private constructor(provider: EmbeddingProvider) {
        this.provider = provider;
    }

    /**
     * Build an embedding index from a corpus.
     * @param corpus  Array of {atom, semanticText} — same format as Bm25Index.build()
     * @param opts    Optional embedding provider (defaults to NgramHashEmbedding)
     */
    static build(
        corpus: Array<{ atom: string; semanticText: string }>,
        opts: EmbeddingIndexOptions = {},
    ): EmbeddingIndex {
        const provider = opts.provider ?? new NgramHashEmbedding();
        const index = new EmbeddingIndex(provider);
        for (const { atom, semanticText } of corpus) {
            index.cache.set(atom, provider.embed(semanticText));
        }
        return index;
    }

    /** Build an empty index. */
    static empty(opts: EmbeddingIndexOptions = {}): EmbeddingIndex {
        return new EmbeddingIndex(opts.provider ?? new NgramHashEmbedding());
    }

    /**
     * Add a document incrementally.  No-op if already present.
     */
    addDocument(atom: string, semanticText: string): void {
        if (this.cache.has(atom)) return;
        this.cache.set(atom, this.provider.embed(semanticText));
    }

    /**
     * Remove a document incrementally.  No-op if not present.
     */
    removeDocument(atom: string): void {
        this.cache.delete(atom);
    }

    /**
     * Score a query against a candidate atom already in the index.
     * Returns cosine similarity in [-1, 1], normalised to [0, 1] for
     * compatibility with BM25's [0, 1] range.
     */
    score(query: string, candidateAtom: string): number {
        const cached = this.cache.get(candidateAtom);
        if (!cached) return 0;
        const queryVec = this.provider.embed(query);
        const raw = this.provider.similarity(queryVec, cached);
        // Map from [-1, 1] to [0, 1]:  (raw + 1) / 2
        return (raw + 1) / 2;
    }

    /**
     * Score a query against arbitrary semantic text (not necessarily in index).
     * Used for scoring atoms not yet indexed (edge case during same commit cycle).
     */
    scoreBySemanticText(query: string, semanticText: string): number {
        const queryVec = this.provider.embed(query);
        const docVec = this.provider.embed(semanticText);
        const raw = this.provider.similarity(queryVec, docVec);
        return (raw + 1) / 2;
    }

    /** Number of atoms in the index. */
    get size(): number { return this.cache.size; }

    /** Access the provider (for testing). */
    get embeddingProvider(): EmbeddingProvider { return this.provider; }
}
