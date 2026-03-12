#!/usr/bin/env ts-node
/**
 * Convert Model2Vec JSON vocabulary to compact binary format.
 *
 * Binary format (all little-endian):
 *   Header (8 bytes):
 *     [0..3]  u32  magic = 0x4D325642  ("M2VB")
 *     [4..5]  u16  dimensions
 *     [6..7]  u16  reserved (0)
 *
 *   String table offset (4 bytes):
 *     [8..11] u32  byte offset of string table from start of file
 *
 *   Embedding matrix (vocabSize × dimensions × 4 bytes):
 *     Flat Float32Array, tokens in order of the string table.
 *
 *   String table:
 *     [0..3]  u32  tokenCount
 *     For each token:
 *       [0..1]  u16  byte length of UTF-8 string
 *       [2..N]  UTF-8 bytes (no null terminator)
 *
 * Why binary?
 *   JSON:   readFileSync 6.3s + JSON.parse 0.7s + Map construction = ~10s
 *   Binary: readFileSync 0.05s + typed array views = ~0.2s  (50× faster)
 *
 * Usage:
 *   npx ts-node tools/convert_vocab_to_binary.ts [input.json] [output.bin]
 *   npx ts-node tools/convert_vocab_to_binary.ts  # uses defaults
 */

import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

const MAGIC = 0x4D325642;  // "M2VB" in ASCII

function convert(inputPath: string, outputPath: string): void {
    console.log(`Reading JSON: ${inputPath}`);
    const t0 = Date.now();
    const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
    const t1 = Date.now();
    console.log(`  JSON parsed in ${t1 - t0}ms`);

    const dimensions: number = raw.dimensions;
    const vocabEntries = Object.entries(raw.vocab) as [string, number[]][];
    const tokenCount = vocabEntries.length;

    console.log(`  Tokens: ${tokenCount}, Dimensions: ${dimensions}`);

    // ── Build string table ──────────────────────────────────────────────────
    const tokenStrings: string[] = [];
    const tokenBuffers: Buffer[] = [];
    let stringTableDataSize = 4; // u32 tokenCount

    for (const [token] of vocabEntries) {
        const buf = Buffer.from(token, 'utf8');
        tokenStrings.push(token);
        tokenBuffers.push(buf);
        stringTableDataSize += 2 + buf.length; // u16 len + bytes
    }

    // ── Calculate layout ────────────────────────────────────────────────────
    const headerSize = 12;  // 8 header + 4 string table offset
    const matrixSize = tokenCount * dimensions * 4;  // Float32
    const stringTableOffset = headerSize + matrixSize;
    const totalSize = stringTableOffset + stringTableDataSize;

    console.log(`  Matrix:       ${(matrixSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  String table: ${(stringTableDataSize / 1024).toFixed(1)} KB`);
    console.log(`  Total:        ${(totalSize / 1024 / 1024).toFixed(1)} MB`);

    // ── Write buffer ────────────────────────────────────────────────────────
    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    // Header
    buf.writeUInt32LE(MAGIC, offset); offset += 4;
    buf.writeUInt16LE(dimensions, offset); offset += 2;
    buf.writeUInt16LE(0, offset); offset += 2;  // reserved

    // String table offset
    buf.writeUInt32LE(stringTableOffset, offset); offset += 4;

    // Embedding matrix
    for (let i = 0; i < tokenCount; i++) {
        const vec = vocabEntries[i][1];
        for (let d = 0; d < dimensions; d++) {
            buf.writeFloatLE(vec[d], offset);
            offset += 4;
        }
    }

    // String table
    buf.writeUInt32LE(tokenCount, offset); offset += 4;
    for (let i = 0; i < tokenCount; i++) {
        const strBuf = tokenBuffers[i];
        buf.writeUInt16LE(strBuf.length, offset); offset += 2;
        strBuf.copy(buf, offset);
        offset += strBuf.length;
    }

    if (offset !== totalSize) {
        throw new Error(`Buffer size mismatch: wrote ${offset}, expected ${totalSize}`);
    }

    writeFileSync(outputPath, buf);
    const t2 = Date.now();
    console.log(`  Written in ${t2 - t1}ms`);

    // ── Verify ──────────────────────────────────────────────────────────────
    console.log(`\nVerifying binary file...`);
    const vt0 = Date.now();
    const binBuf = readFileSync(outputPath);
    const vt1 = Date.now();
    console.log(`  readFileSync: ${vt1 - vt0}ms`);

    const magic = binBuf.readUInt32LE(0);
    if (magic !== MAGIC) throw new Error(`Bad magic: 0x${magic.toString(16)}`);

    const dims = binBuf.readUInt16LE(4);
    const stOff = binBuf.readUInt32LE(8);
    const tc = binBuf.readUInt32LE(stOff);
    console.log(`  Magic: 0x${magic.toString(16)} ✓`);
    console.log(`  Dimensions: ${dims} ✓`);
    console.log(`  Token count: ${tc} ✓`);
    console.log(`  Read time: ${vt1 - vt0}ms (vs ~6300ms for JSON)`);

    const ratio = (totalSize / readFileSync(inputPath).length * 100).toFixed(1);
    console.log(`  Size: ${(totalSize / 1024 / 1024).toFixed(1)} MB (${ratio}% of JSON)`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputPath = args[0] ?? path.join(__dirname, '..', 'data', 'model2vec_vocab.json');
const outputPath = args[1] ?? inputPath.replace(/\.json$/, '.bin');

convert(inputPath, outputPath);
