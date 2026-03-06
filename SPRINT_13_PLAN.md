# Sprint 13 — Hardening, Auditability & Developer Experience

**Goal:** Ship everything needed to make MMPM the credible, production-ready, easy-to-adopt alternative to Mem0/Zep. Every item has a concrete acceptance test.

**Launch date context:** April 6, 2026. This sprint closes the gap between "impressive demo" and "trustworthy infrastructure."

---

## Sprint 13-A — Repository Hygiene (Day 1)

*Make `git clone` → running server a 3-command experience.*

### 13-A-1: Remove committed test artefacts
- **Task:** Run `git rm -r --cached 'test-shard-db-*' 'test-orch-db-*' 'test-validator-db-*' 'mmpm-harness-cli-db-*' 'test-debug-*'` to untrack the hundreds of test DB directories that were committed by mistake. `.gitignore` already has the correct patterns — they just need to be untracked.
- **Test:** `git ls-files | grep -E 'test-.*-db|mmpm-harness' | wc -l` → must return `0`.

### 13-A-2: Consolidate READMEs
- **Task:** Keep `README.md` as the single public-facing entry point (the launch README). Archive the others: rename `README_PUBLIC.md` → `docs/README_PUBLIC_ARCHIVE.md`, `README_AGENT.md` → `docs/README_AGENT.md`, `docker-readme.md` → `docs/docker.md`. Update all internal cross-references.
- **Test:** `ls *.md | grep -i readme | wc -l` → must return `1`.

### 13-A-3: Add `.env.example`
- **Task:** Create `.env.example` with every supported env var documented:
  ```
  PORT=3000
  DB_BASE_PATH=./mmpm-data
  SHARD_COUNT=4
  MMPM_API_KEY=change-me-before-production
  LOG_LEVEL=info
  WRITE_POLICY=auto
  ```
- **Test:** `.env.example` exists and `grep -c '=' .env.example` ≥ 6.

### 13-A-4: Add `npm run setup` script
- **Task:** Add a `setup` script to `package.json`: `"setup": "npm install && npm run build && (test -f .env || cp .env.example .env) && echo '✓ Ready. Run: node dist/server.js'"`.
- **Test:** Running `npm run setup` on a clean clone completes without error and produces `dist/server.js`.

### 13-A-5: Add `start.sh` convenience script
- **Task:** Create `start.sh` at repo root:
  ```bash
  #!/usr/bin/env bash
  set -e
  [ -f dist/server.js ] || npm run setup
  [ -f .env ] && source .env
  exec node dist/server.js
  ```
  Mark executable (`chmod +x start.sh`).
- **Test:** `./start.sh` starts the server and `/health` returns `{"status":"ok","ready":true}` within 5 seconds.

---

## Sprint 13-B — Crash Resilience & Logging (Day 1–2)

*Ensure the server never dies silently and every crash is diagnosable.*

### 13-B-1: Global crash handlers in server.ts
- **Task:** Add to `server.ts` startup (before `server.listen`):
  ```ts
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException — process will exit');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection — process will exit');
    process.exit(1);
  });
  ```
- **Test:** Write a unit test that triggers an unhandled rejection in a subprocess and asserts the exit code is `1` and the log line contains `unhandledRejection`.

### 13-B-2: Request ID threading
- **Task:** Enable Fastify's built-in `requestIdHeader` and confirm `reqId` appears in all request-scoped log lines (Fastify does this automatically when logger is Pino). Add a test that captures a log line from a `POST /atoms` request and asserts it contains a `reqId` field.
- **Test:** `curl -X POST /atoms -d '{"atoms":["v1.fact.test"]}' -H "X-Request-ID: abc123"` → server log contains `"reqId":"abc123"`.

### 13-B-3: Structured startup log
- **Task:** On server start, log a single structured info line with: `port`, `shards`, `dbBasePath`, `logLevel`, `writePolicy`, `apiKeySet` (boolean). Gives instant confirmation that config was read correctly.
- **Test:** Start server and assert log line `"msg":"MMPM ready"` exists with all six fields present.

---

## Sprint 13-C — Auditability API (Day 2–3)

*Ship the audit features that differentiate MMPM from all competitors.*

### 13-C-1: `GET /atoms/:atom` returns full proof path
- **Task:** The existing endpoint returns atom state. Add `proof: { leaf, root, auditPath, index }` to the response body so a single call gives everything needed for external verification.
- **Test:** `curl GET /atoms/v1.fact.test` → response body has `proof.root` (non-empty string), `proof.auditPath` (array), `proof.index` (integer).

### 13-C-2: `POST /verify` — standalone proof verification
- **Task:** New endpoint, no auth required. Accepts `{ atom, proof: { leaf, root, auditPath, index } }`. Recomputes the Merkle path from the leaf and returns `{ valid: true|false, atom, checkedAt }`. A third party can call this without access to the live DB.
- **Test:** Call `/atoms/:atom` to get a valid proof, then call `POST /verify` with that proof → `{ valid: true }`. Mutate one hex char in `proof.leaf` → `{ valid: false }`.

### 13-C-3: `GET /admin/audit-log`
- **Task:** New endpoint (auth required). Returns a time-ordered list of write/delete events: `[{ action: "write"|"delete", atom, timestamp, version }]`. Backed by a separate append-only LevelDB key range (prefix `audit:`). Every write to `/atoms` and every `DELETE /atoms/:atom` appends a record.
- **Parameters:** `?since=<timestamp_ms>&limit=100`
- **Test:** Write 3 atoms, delete 1. Call `GET /admin/audit-log` → returns 4 records in order. Records have correct `action` values.

### 13-C-4: `GET /atoms/diff`
- **Task:** New endpoint. Accepts `?fromVersion=X&toVersion=Y`. Returns `{ added: [...], tombstoned: [...], fromVersion, toVersion }` — the atoms that changed between two tree versions.
- **Test:** Write atoms at version N, tombstone one at version N+1. Call `/atoms/diff?fromVersion=N&toVersion=N+1` → `added` contains the new atom, `tombstoned` contains the deleted one.

---

## Sprint 13-D — Export / Import & TTL (Day 3–4)

*Backup/restore and privacy compliance.*

### 13-D-1: `GET /admin/export`
- **Task:** New endpoint (auth required). Streams all active atoms as a newline-delimited JSON file: one atom per line, format `{ atom, createdAtMs, type }`. Supports `?format=json` (default) and `?format=ndjson`.
- **Test:** Write 10 atoms, call `GET /admin/export`, parse result → exactly 10 entries, each with valid `atom` string.

### 13-D-2: `POST /admin/import`
- **Task:** New endpoint (auth required). Accepts an NDJSON body (same format as export). Ingests atoms in order. Returns `{ imported, skipped, errors }`.
- **Test:** Export from a fresh DB, wipe DB, import the export file → atom count matches. Duplicate import → `skipped` count equals total.

### 13-D-3: Per-atom TTL
- **Task:** Add optional `ttlMs` field to `POST /atoms` payload. If set, schedule auto-tombstone after `ttlMs` milliseconds. Store TTL alongside atom metadata. A background sweep runs every 60 seconds and tombstones expired atoms.
- **Test:** Write atom with `ttlMs: 2000`. Wait 3 seconds. Call `GET /atoms/:atom` → status is `"tombstoned"` or 404.

---

## Sprint 13-E — CLI & SDK (Day 4–5)

*Lower the "just make it work" bar.*

### 13-E-1: `mmpm` CLI (Node.js, ships as `npx mmpm`)
- **Task:** Create `tools/cli/mmpm.ts` — a lightweight CLI tool:
  ```
  npx mmpm atoms list
  npx mmpm atoms add "v1.fact.user_prefers_dark_mode"
  npx mmpm atoms get "v1.fact.user_prefers_dark_mode"
  npx mmpm proof verify "v1.fact.user_prefers_dark_mode"
  npx mmpm export > backup.ndjson
  npx mmpm import < backup.ndjson
  npx mmpm health
  ```
  Reads `MMPM_URL` and `MMPM_API_KEY` from env or `.env` file. Outputs JSON or pretty-printed depending on `--json` flag.
- **Test:** `npx mmpm health` against a running server returns `ok` with exit code 0. `npx mmpm atoms add "v1.fact.cli_test"` followed by `npx mmpm atoms get "v1.fact.cli_test"` returns the atom.

### 13-E-2: Webhook on write
- **Task:** Add `MMPM_WEBHOOK_URL` env var. When set, after each successful commit, `POST` to that URL with body `{ event: "commit", version, atomCount, timestamp }`. Fire-and-forget, non-blocking, with 5s timeout.
- **Test:** Stand up a local HTTP listener, set `MMPM_WEBHOOK_URL`, write atoms and commit. Assert listener received the POST within 2 seconds.

---

## Sprint 13-F — Landing Page & Marketing (Day 1, parallel)

### 13-F-1: Add positioning pillars to landing page ✅
- **Done this session.** Three-column section added below hero: Sovereignty / Verifiability / Prediction with full copy.

### 13-F-2: Update hero sub-copy ✅
- **Done this session.** Sub now reads: "Every other memory system trusts. MMPM proves."

### 13-F-3: Update bottom tagline ✅
- **Done this session.** Now reads: "every other memory system trusts. MMPM proves."

### 13-F-4: Commit updated `index.html` to `parametric-memory-web` repo
- **Task:** The updated `index.html` needs to be pushed to `wjm2202/parametric-memory-web` via the GitHub web editor (same CodeMirror injection technique used previously).
- **Test:** `https://wjm2202.github.io/parametric-memory-web/` shows the three pillars section.

---

## Sprint 13-G — Integrations & Developer Onboarding (Day 1, parallel)

*Make MMPM usable from Claude Cowork, VSCode, and Claude Code without any manual setup.*

### 13-G-1: Claude Cowork skill ✅
- **Done this session.** `integrations/claude-skill/SKILL.md` ships with the repo. Users copy it to their Claude skills directory and get MMPM memory natively in Cowork.

### 13-G-2: VSCode integration ✅
- **Done this session.** `integrations/vscode/README.md` covers three integration paths: MCP server config for Cline/Continue/Copilot, `.vscode/tasks.json` for start/stop tasks, and `CLAUDE.md.template` for Claude Code in terminal.

### 13-G-3: CLAUDE.md template ✅
- **Done this session.** `integrations/vscode/CLAUDE.md.template` — copy to any project root to give Claude Code automatic MMPM memory loading on every session start.

### 13-G-4: Package Claude skill as `.skill` file
- **Task:** Zip `integrations/claude-skill/` as `integrations/parametric-memory.skill` so Cowork users can drag-and-drop install it. Add to `Makefile` or `package.json` scripts: `"skill:pack": "cd integrations && zip -r parametric-memory.skill claude-skill/"`.
- **Test:** The `.skill` file unzips to a directory containing `SKILL.md`.

### 13-G-5: Link integrations from README
- **Task:** Add an "Integrations" section to `README.md` with links to Claude Cowork skill, VSCode integration, and CLAUDE.md template. Include a one-paragraph explanation of what each provides.
- **Test:** `README.md` contains the string `integrations/claude-skill` and `integrations/vscode`.

### 13-G-6: MCP config examples for Claude Desktop
- **Task:** Create `integrations/claude-desktop/claude_desktop_config.json.example` — a drop-in config for Claude Desktop that connects MMPM as an MCP server. Include instructions for macOS (`~/Library/Application Support/Claude/`) and Windows paths.
- **Test:** The config file is valid JSON and contains the correct `command` and `args` fields.

---

## Definition of Done (all sprints)

- [ ] Every task has a passing automated test (vitest or integration shell script)
- [ ] `npm run test` passes clean
- [ ] `docker-compose up` starts cleanly on a fresh clone with no pre-existing data
- [ ] `git ls-files | grep -E 'test-.*-db|mmpm-harness'` returns empty
- [ ] One README at repo root, others archived in `docs/`
- [ ] `POST /verify` returns `{valid: false}` on a tampered proof (external audit capability)
- [ ] `GET /admin/audit-log` returns ordered write history

---

## Prioritisation for April 6 Launch

**Must have (blocker):** 13-A (all), 13-B-1, 13-F-4
**Should have:** 13-C-1, 13-C-2, 13-B-2, 13-B-3
**Nice to have (post-launch):** 13-C-3, 13-C-4, 13-D (all), 13-E (all)
