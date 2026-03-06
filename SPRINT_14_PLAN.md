# Sprint 14 — Buyer Value: Auditability, Export/Import, TTL, CLI

**Goal:** Ship the features that turn "impressive demo" into "infrastructure I can trust, comply with, and build on." Every item maps directly to a question a serious buyer asks before committing.

**Context:** Sprint 13 complete — repo hygiene, crash handlers, landing page, integrations. Python SDK moves to Sprint 15 (post-launch). This sprint targets the remaining launch-critical gaps.

**Target:** April 6, 2026 launch (14-A, 14-B, 14-C, 14-H). Post-launch (14-D CLI, 14-E webhook).

---

## TTL Design Decision: Opt-in, Access-Aware, Not a Blunt Timer

> **Concern:** A global TTL risks tombstoning valuable long-lived memory (project state, user preferences, agent goals). An atom written once and then genuinely needed six months later should survive.

The design resolves this as follows:

**No TTL by default.** Atoms without an explicit `ttlMs` never expire. The background sweep only touches atoms that have been explicitly marked.

**TTL is intended for ephemeral data only.** The right use cases are: session tokens, one-time auth codes, temporary task state, GDPR-subject PII. Long-lived facts, user preferences, and agent knowledge should never carry a TTL.

**Access renews TTL.** Every call to `POST /access` or `POST /batch-access` on an atom with an active TTL resets the `ttlExpiresAt` clock. An atom that is actively being used cannot expire without deliberate inaction. The formula becomes:

```
ttlExpiresAt = max(lastAccessedAtMs, createdAtMs) + ttlMs
```

This preserves the GDPR compliance story (a truly dormant PII atom will auto-tombstone) while protecting memory that agents are actively referencing.

**For GDPR right-to-erasure:** The recommended approach for bulk user data deletion is a namespace-scoped delete (`DELETE /atoms?namespace=user:<uuid>`), not TTL. TTL is for atom-level expiry, not user-level erasure. Both mechanisms will be documented.

**The sweep is conservative.** TTL sweep runs every 60 seconds but only tombstones atoms where `ttlExpiresAt <= now - 30s` (a 30-second grace buffer). This prevents a race where an atom is swept milliseconds before a read that would have renewed it.

---

## MCP Tool Coverage

The existing MCP server (`npm run mcp:serve`) already has 22 tools. The new Sprint 14 endpoints that agents need to access directly are:

| New endpoint | MCP tool | Notes |
|---|---|---|
| `POST /verify` | `memory_verify` | Always available (no auth). Core audit tool for self-verifying agents. |
| `GET /atoms/diff` | `memory_atoms_diff` | Read-only, auth required. Agents use this to understand what changed between sessions. |
| `GET /admin/audit-log` | `memory_audit_log` | Read-only, auth required. Useful for compliance workflows. |
| `GET /admin/export` | `memory_atoms_export` | Mutation-gated (`MMPM_MCP_ENABLE_MUTATIONS=1`). Agents orchestrating backups. |
| `POST /admin/import` | `memory_atoms_import` | Mutation-gated. Agents orchestrating restore. |

The existing `memory_atom_get` tool (wraps `GET /atoms/:atom`) automatically gains the proof block from 14-A-1 — no MCP change needed there.

The CLI (14-D) is for human developers, not agents. No MCP equivalent needed.

Webhook (14-E) is outbound infrastructure. No MCP tool needed.

---

## Breaking Change Risk Assessment

None of the Sprint 14 items break the existing API contract. Specifics:

| Item | Risk | Notes |
|------|------|-------|
| 14-A-1 proof on atom read | **Additive only** | New `proof` field in response. Existing callers ignore unknown fields. Only breaks strict JSON schema validation — document as additive. |
| 14-A-2 POST /verify | **None** | New endpoint. No existing callers. |
| 14-A-3 audit-log | **None for API** | New endpoint + new LevelDB keyspace (`audit_log:`). Historical events won't exist before deploy — document this. Empty log on fresh deploy is correct behaviour. |
| 14-A-4 atoms/diff | **None** | New endpoint. |
| 14-B-1 export | **None** | New endpoint. |
| 14-B-2 import | **Low** | New endpoint. The merge-on-duplicate-skip behaviour must be clearly documented to avoid surprise on repeated imports. |
| 14-C-1 TTL | **Low — opt-in only** | No existing atom is affected unless `ttlMs` is explicitly passed. The background sweep process is new infrastructure — existing DBs are unaffected. One edge case: re-adding a previously tombstoned atom — test that TTL resets correctly on re-write. |
| 14-D-1 CLI | **None** | New `bin` entry in package.json. |
| 14-E-1 webhook | **None** | Env var, fire-and-forget. Server behaviour unchanged when unset. |
| 14-H-1 req ID | **Log schema only** | `reqId` appears in log lines. Log parsers expecting fixed schema need updating. Grafana/Loki dashboards unaffected (they filter by `msg` not schema). |
| 14-H-2 startup log | **Additive** | New log line at startup. |

**One item to watch:** 14-A-3 (audit log) requires that every write path also writes to the `audit_log:` keyspace. This touches the hot write path. The atomic write must not increase p95 latency — measure before and after.

---

## Sprint 14-A — Auditability API

*The single biggest differentiator over Mem0, Zep, and Letta.*

### 14-A-1: `GET /atoms/:atom` — include full proof path in response

**Why it matters:** Right now a single atom lookup returns state but not proof. Auditing one memory requires a separate `/memory/bootstrap` call. Self-contained single-atom auditing removes that friction and makes the demo compelling.

**Task:** Add `proof: { leaf, root, auditPath, index }` to the `GET /atoms/:atom` response. Proof generation already runs on every write — this is exposing it on read.

```ts
// Response shape addition
{
  atom: "v1.fact.user_prefers_dark_mode",
  status: "active",
  createdAtMs: 1712000000000,
  masterVersion: 42,
  proof: {
    leaf: "a3f4...",
    root: "b7e1...",
    auditPath: ["c2a1...", "d9f3...", "e0b2..."],
    index: 7
  }
}
```

**MCP impact:** Existing `memory_atom_get` tool gains proof automatically — no MCP code change needed.

**Tests:**
- `GET /atoms/v1.fact.test` → response has `proof.root` (non-empty hex string), `proof.auditPath` (array ≥1 entry), `proof.index` (integer ≥ 0).
- `proof.root` matches the root from `GET /memory/bootstrap` at the same `masterVersion`.
- Tombstoned atom → still returns `proof` (historical audit must work post-deletion).
- Existing tests for `GET /atoms/:atom` still pass (no fields removed).

---

### 14-A-2: `POST /verify` — standalone proof verification (no auth)

**Why it matters:** A third party with no access to your MMPM instance can take an atom + proof from your logs and independently verify it. No competitor does this. It's the "GPG signature for memory" story — the marketing lead and the killer demo moment.

**Task:** New endpoint, no authentication required. Pure computation — no DB read.

```
POST /verify
Content-Type: application/json

{
  "atom": "v1.fact.user_prefers_dark_mode",
  "proof": {
    "leaf": "a3f4...",
    "root": "b7e1...",
    "auditPath": ["c2a1...", "d9f3...", "e0b2..."],
    "index": 7
  }
}
```

Response:
```json
{ "valid": true, "atom": "v1.fact.user_prefers_dark_mode", "checkedAt": 1712000000000 }
```

**New MCP tool:** `memory_verify` — always available (no mutations flag needed, no auth required).

```
memory_verify({ atom, proof: { leaf, root, auditPath, index } })
→ { valid: boolean, atom: string, checkedAt: number }
```

**Tests:**
1. Call `GET /atoms/:atom` to get a real proof. Call `POST /verify` → `{ valid: true }`.
2. Flip one hex char in `proof.leaf` → `{ valid: false }`.
3. Mutate one entry in `proof.auditPath` → `{ valid: false }`.
4. Returns 200 with no `Authorization` header (no auth required).
5. Invalid JSON body → 400 with descriptive error.
6. MCP: `memory_verify` with valid proof → `valid: true`. With tampered proof → `valid: false`.

---

### 14-A-3: `GET /admin/audit-log`

**Why it matters:** Compliance buyers need a human-readable event stream. The WAL handles crash recovery but is not exposed as a readable log. This answers "who wrote what and when" without WAL inspection.

**Implementation note:** Log bootstraps empty on first deploy — this is correct and expected. Document it. There is no back-fill of historical events from the WAL. The audit log is forward-only from deploy date.

**Performance constraint:** The audit record write must be atomic with the atom write. Benchmark p95 latency before and after — must not increase by more than 5%.

**Task:** New endpoint, auth required. Append-only LevelDB keyspace `audit_log:<timestamp_ms>:<uuid>`. Appended on every `POST /atoms` commit and every `DELETE /atoms/:atom`.

```
GET /admin/audit-log?since=1712000000000&limit=100
```

Response:
```json
{
  "events": [
    { "action": "write",  "atom": "v1.fact.x", "timestamp": 1712000001000, "version": 41 },
    { "action": "write",  "atom": "v1.fact.y", "timestamp": 1712000002000, "version": 42 },
    { "action": "delete", "atom": "v1.fact.x", "timestamp": 1712000003000, "version": 43 }
  ],
  "count": 3,
  "nextSince": 1712000003001
}
```

**New MCP tool:** `memory_audit_log` — read-only, auth-gated.

```
memory_audit_log({ since?: number, limit?: number })
→ { events: AuditEvent[], count: number, nextSince: number }
```

**Tests:**
- Write 3 atoms, delete 1 → 4 events in chronological order with correct `action` values.
- `?since=<after second write>` → only the delete event returned.
- `?limit=2` on 4 events → 2 events + `nextSince` cursor.
- Without auth → 401.
- Fresh DB → empty events array (not 404).
- p95 write latency with audit logging enabled ≤ p95 without + 5%.

---

### 14-A-4: `GET /atoms/diff`

**Why it matters:** "What changed between last week and today" is a basic audit question. Zep has nothing like this. The memory changelog is an enterprise differentiator.

**Task:** New endpoint, auth required.

```
GET /atoms/diff?fromVersion=40&toVersion=43
```

Response:
```json
{
  "added":      ["v1.fact.y", "v1.fact.z"],
  "tombstoned": ["v1.fact.x"],
  "fromVersion": 40,
  "toVersion":   43
}
```

**New MCP tool:** `memory_atoms_diff` — read-only, auth-gated. Agents use this to detect what changed in memory since their last session.

```
memory_atoms_diff({ fromVersion: number, toVersion: number })
→ { added: string[], tombstoned: string[], fromVersion: number, toVersion: number }
```

**Tests:**
- At version N, write A and B. Tombstone A at N+1. Write C at N+2.
- `diff?fromVersion=N&toVersion=N+2` → `added: [A, B, C]`, `tombstoned: [A]`.
- `fromVersion === toVersion` → empty diff.
- `fromVersion > toVersion` → 400 error.
- Non-integer version → 400 error.
- MCP: `memory_atoms_diff({ fromVersion: N, toVersion: N+2 })` matches HTTP response.

---

## Sprint 14-B — Export / Import

*"Can I back this up?" is a day-one question.*

### 14-B-1: `GET /admin/export`

**Task:** New endpoint, auth required. Streams all active atoms as NDJSON.

```
GET /admin/export
```

Response: `Content-Type: application/x-ndjson`. One atom per line:
```json
{"atom":"v1.fact.user_prefers_dark_mode","createdAtMs":1712000000000,"type":"fact","masterVersion":42}
```

Tombstoned atoms excluded by default. `?include_tombstoned=true` includes them with `"tombstoned":true`.

**New MCP tool:** `memory_atoms_export` — mutation-gated (`MMPM_MCP_ENABLE_MUTATIONS=1`).

**Tests:**
- Write 10 atoms, tombstone 2 → 8 lines each valid JSON.
- `?include_tombstoned=true` → 10 lines, 2 have `"tombstoned":true`.
- Without auth → 401.
- Empty DB → 200 with 0 lines (not 404).

---

### 14-B-2: `POST /admin/import`

**Merge behaviour (important):** Duplicate atoms (key already present and active) are **skipped silently**, not errored. This allows safe re-import of a backup file without double-writing. If the caller wants to overwrite existing atoms, they must delete first.

**Task:** New endpoint, auth required. Accepts NDJSON body.

Response:
```json
{ "imported": 2, "skipped": 0, "errors": [] }
```

**New MCP tool:** `memory_atoms_import` — mutation-gated.

**Tests:**
- Export → wipe DB → import → atom count matches, `imported` equals original count.
- Re-import same file → `skipped` equals total, `imported` equals 0, no duplicates created.
- Mix of valid + one malformed line → valid lines imported, malformed line in `errors[0]`.
- Without auth → 401.

---

## Sprint 14-C — Per-atom TTL (Access-Aware)

*Opt-in ephemeral memory for session state and GDPR-scoped PII. Long-lived facts are unaffected.*

### 14-C-1: TTL field on `POST /atoms`

**When to use TTL:**
- ✅ Session tokens, one-time codes, temporary task state
- ✅ GDPR-subject PII where you want automatic erasure
- ❌ User preferences, agent goals, project context, long-lived facts

**Access renews TTL.** Each `POST /access` or `POST /batch-access` on an expiring atom resets the clock. Atoms in active use cannot expire accidentally.

**Task:** Add optional `ttlMs` field to `POST /atoms`. No TTL by default. `ttlExpiresAt = lastAccessedAtMs + ttlMs` (access-aware formula).

```json
POST /atoms
{ "atoms": ["v1.state.session_token_xyz"], "ttlMs": 3600000 }
```

Background sweep runs every 60 seconds. Only tombstones atoms where `ttlExpiresAt <= now - 30000` (30-second grace buffer against sweep races).

Tombstone appears in audit log as:
```json
{ "action": "delete", "reason": "ttl_expired", "atom": "v1.state.session_token_xyz", ... }
```

**New MCP tool:** `memory_atom_extend_ttl` — mutation-gated. Allows agents to explicitly renew TTL without needing to access the atom for other reasons.

```
memory_atom_extend_ttl({ atom: string, ttlMs: number })
→ { atom: string, ttlExpiresAt: number }
```

**Tests:**
- Write atom with `ttlMs: 3000`. Wait 4 seconds without accessing. → tombstoned.
- Write atom with `ttlMs: 3000`. Access at t=2s. Wait until t=5s. → still active (access renewed TTL).
- Write atom without `ttlMs`. Wait 4 seconds → still active (no TTL = never expires).
- Write atom with `ttlMs: 3000`. Re-write same atom (no ttlMs). → TTL cleared (permanent once re-written without TTL).
- Previously tombstoned atom: re-write with new `ttlMs` → new TTL applies from re-write time.
- TTL expiry appears in `GET /admin/audit-log` with `reason: "ttl_expired"`.
- `GET /admin/export` excludes TTL-expired atoms by default.

---

## Sprint 14-D — CLI Tool (Should-have at launch)

*Lower the barrier for first-time developers.*

### 14-D-1: `npx mmpm` CLI

**Task:** `tools/cli/mmpm.ts`. Reads `MMPM_URL` and `MMPM_API_KEY` from env or `.env`.

```bash
npx mmpm health
npx mmpm atoms list
npx mmpm atoms add "v1.fact.user_pref_dark"
npx mmpm atoms get "v1.fact.user_pref_dark"        # includes proof block
npx mmpm atoms delete "v1.fact.user_pref_dark"
npx mmpm proof verify "v1.fact.user_pref_dark"     # calls POST /verify
npx mmpm export > backup.ndjson
npx mmpm import < backup.ndjson
npx mmpm audit-log
npx mmpm diff --from 40 --to 43
```

Flags: `--json` (raw JSON), `--url`, `--key`.

**Tests:**
- `npx mmpm health` → exit 0, output `ok`.
- `atoms add` → `atoms get` round-trips the atom string.
- `proof verify` on a real atom → output contains `valid: true`.
- No server running → exit 1, human-readable error (no stack trace).

---

## Sprint 14-E — Webhook on Write (Post-launch)

### 14-E-1: `MMPM_WEBHOOK_URL`

Fire-and-forget POST after each commit. 5s timeout. Non-blocking — commit succeeds regardless of webhook outcome.

```json
{ "event": "commit", "version": 43, "atomCount": 3, "timestamp": 1712000000000, "namespace": "user:alice" }
```

**Tests:**
- Local listener receives POST within 2s with correct `version` and `atomCount`.
- Listener returns 500 → commit still succeeds, warning logged.
- Unset → no HTTP call made.

---

## Sprint 14-H — Logging Completeness (Should-have at launch)

### 14-H-1: Request ID threading

Enable `requestIdHeader: 'x-request-id'` in Fastify config. `reqId` flows to all Pino log lines automatically.

**Breaking note:** Log lines gain a `reqId` field. Existing log parsers and Grafana panels that filter on exact field lists should be checked — they are unlikely to break but worth a 5-minute review.

**Test:** `curl -H "X-Request-ID: abc123" POST /atoms ...` → log contains `"reqId":"abc123"`.

---

### 14-H-2: Structured startup log

Single `info` line on server start: `msg: "MMPM ready"` with `port`, `shards`, `dbBasePath`, `logLevel`, `writePolicy`, `apiKeySet`.

**Test:** Start server → assert log line has all six fields.

---

## Definition of Done (Sprint 14)

- [ ] `POST /verify` returns `{ valid: false }` on tampered proof
- [ ] `memory_verify` MCP tool works without auth
- [ ] `GET /atoms/:atom` includes `proof` block, existing tests still pass
- [ ] `memory_atoms_diff` and `memory_audit_log` MCP tools registered
- [ ] `GET /admin/export` → `POST /admin/import` round-trips cleanly
- [ ] Atom with `ttlMs: 3000` and no access → tombstoned within 65s
- [ ] Atom with `ttlMs: 3000` + access at t=2s → still active at t=5s
- [ ] `npx mmpm health` exits 0 against running server
- [ ] `npm test` passes clean
- [ ] p95 write latency with audit-log enabled ≤ baseline + 5%
- [ ] `docker-compose up` still works on a fresh clone

---

## Priority for April 6 Launch

| Priority | Items |
|----------|-------|
| **Must-have (launch blocker)** | 14-A-1, 14-A-2 + MCP, 14-B-1, 14-B-2, 14-C-1 |
| **Should-have (launch)** | 14-A-3 + MCP, 14-A-4 + MCP, 14-D-1, 14-H-1, 14-H-2 |
| **Post-launch** | 14-E-1 (webhook), Python SDK → see Sprint 15 |

---

## Dependency Map

```
14-A-1 (proof on read) ──▶ 14-A-2 (POST /verify + MCP)   proof format confirmed first
14-B-1 (export)        ──▶ 14-B-2 (import)                import format mirrors export
14-A-2 (verify)        ──▶ 14-D-1 (CLI proof verify)      CLI wraps endpoint
14-B-1 (export)        ──▶ 14-D-1 (CLI export)            CLI wraps endpoint
14-A-3 (audit log)     ──▶ 14-C-1 (TTL)                   TTL expiry writes to audit log
14-A-1 (proof on read) ──▶ 14-A-3 (audit log)             nice-to-have: include proof ref in audit events
```

---

## What Moves to Sprint 15

- Python SDK (`pip install parametric-memory`) — post-launch, full sprint
- Namespace-scoped bulk delete (`DELETE /atoms?namespace=user:alice`) — GDPR complement to TTL
- Async/streaming export for large DBs (>1M atoms)
