#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${MMPM_BASE_URL:-http://127.0.0.1:3000}"
ATOMS_FILE="tools/harness/seed_pack_high_quality_atoms.v1.json"
SEQS_FILE="tools/harness/seed_pack_high_quality_sequences.v1.json"

if [[ ! -f "$ATOMS_FILE" ]]; then
  echo "ERROR: Missing $ATOMS_FILE" >&2
  exit 1
fi

if [[ ! -f "$SEQS_FILE" ]]; then
  echo "ERROR: Missing $SEQS_FILE" >&2
  exit 1
fi

node <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const baseUrl = process.env.MMPM_BASE_URL || 'http://127.0.0.1:3000';
const envPath = path.join(root, '.env');
const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const keyMatch = envText.match(/^MMPM_API_KEY=(.*)$/m);
const apiKey = keyMatch ? keyMatch[1].trim() : '';
const headers = { 'content-type': 'application/json' };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;

const atomsFile = path.join(root, 'tools/harness/seed_pack_high_quality_atoms.v1.json');
const seqsFile = path.join(root, 'tools/harness/seed_pack_high_quality_sequences.v1.json');

const atoms = JSON.parse(fs.readFileSync(atomsFile, 'utf8'));
const sequences = JSON.parse(fs.readFileSync(seqsFile, 'utf8'));

async function ensureReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/ready`);
      if (res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`API not ready at ${baseUrl}/ready`);
}

async function postJson(path, payload) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

(async () => {
  await ensureReady();

  const addResp = await postJson('/atoms', { atoms });
  const commitResp = await postJson('/admin/commit', {});

  let trained = 0;
  for (const sequence of sequences) {
    await postJson('/train', { sequence });
    trained++;
  }

  const commitResp2 = await postJson('/admin/commit', {});

  console.log(JSON.stringify({
    status: 'ok',
    baseUrl,
    atomsLoaded: atoms.length,
    sequencesTrained: trained,
    commit1: commitResp,
    commit2: commitResp2,
    queueReceipt: addResp,
  }, null, 2));
})().catch(err => {
  console.error(err);
  process.exit(1);
});
NODE
