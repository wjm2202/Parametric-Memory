# Changelog

All notable changes to Parametric-Memory are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- `procedure` atom type — first-class type for storing discovered working tools and techniques; cleanly queryable via `GET /atoms?type=procedure`; distinct from `fact` (preferences) and `other` (catch-all)
- `GET /admin/audit-log` — bounded in-memory ring buffer (1000 entries) of mutation events with `?limit`, `?since`, `?event` filters; event types: `atom.add`, `atom.tombstone`, `admin.commit`, `admin.import`, `admin.export`
- Merkle proof on `GET /atoms/:atom` — response now includes `proof: { leaf, root, auditPath, index }` field
- `POST /verify` — standalone proof verification; accepts `{ atom, proof }`, returns `{ valid: boolean }`
- `GET /admin/export` — NDJSON stream export with `?status` and `?type` filters
- `POST /admin/import` — accepts NDJSON or bare atom strings; deduplicates against active atoms
- Per-atom TTL via optional `ttlMs` field on `POST /atoms`; access-aware (TTL resets on touch); background reaper at `MMPM_TTL_REAPER_INTERVAL_MS` interval
- Request ID threading — monotonic counter per server instance; propagated via `x-request-id` header; readable as `request.id`
- Structured startup log: `{ event: 'server_ready', port, host, shards, dbBasePath, logLevel, writePolicy, apiKeySet }`
- New MCP tools: `memory_verify`, `memory_audit_log`, `memory_atoms_export`, `memory_atoms_import`

### Fixed
- `getAtomProof` now uses `shard.getAtomRecord()` instead of `shard.getHash()` — tombstoned atoms now correctly yield their historical Merkle proof for audit; previously returned `null`
- `POST /admin/import` correctly sets `Content-Type: text/plain` when calling the import endpoint from MCP

---

## [1.1.0] — 2026-03-06

### Added
- Full MCP adapter server at `tools/mcp/mmpm_mcp_server.ts` — read-only tools exposed by default; write tools enabled via `MMPM_MCP_ENABLE_MUTATIONS=1`
- MCP tool catalog: `tools/mcp/mmpm_tool_catalog.json`
- Claude Desktop config templates: `tools/mcp/claude_desktop_config.example.json` and `tools/mcp/claude_desktop_config.unsafe.example.json`
- MCP test suite: unit wiring tests (`mcp_tools.test.ts`) and stdio end-to-end integration tests (`mcp_stdio_integration.test.ts`)
- CI workflow for MCP + semantic coverage gate: `.github/workflows/mcp-semantic-gate.yml`
- `GET /atoms` query parameters: `type`, `prefix`, `limit`, `offset` for paginated browsing
- `createdAtMs` field visible on all atom inspection surfaces
- Stale atom surface: `GET /atoms/stale?type=&maxAgeDays=`
- Namespace scope on `/memory/context` and `/memory/bootstrap`: `user`, `project`, `task`, `includeGlobal`
- Write policy tiers: `auto-write` | `review-required` | `never-store` per atom type (configurable via `WRITE_POLICY`)
- Conflict detection on fact atoms with cosine similarity above threshold
- Grafana dashboard (36 panels) — ships in `grafana/`, starts with `docker-compose up`
- Claude Cowork skill: `integrations/claude-skill/SKILL.md`
- VSCode / Claude Code integration: `integrations/vscode/README.md`
- Claude Desktop integration: `integrations/claude-desktop/`
- One-step Claude Cowork install: `integrations/parametric-memory.skill`

### Changed
- Snapshot reference-count lifecycle — safe retirement without evicting live readers
- MCP server refactored for testability: exported builders + explicit startup entrypoint
- `npm run setup` bootstraps the full environment in one command

### Validation
- 36 test files, 533 tests passing (`npm test`)

---

## [1.0.0] — 2026-03-01

Initial public release.

### Added
- HTTP API server (`src/server.ts`) on Fastify with Bearer token auth
- Sharded LevelDB orchestrator (`src/orchestrator.ts`) — consistent hash routing across N shards
- Incremental Merkle tree engine (`src/incremental_merkle.ts`) — every atom has a cryptographic proof path
- Markov transition engine (`src/csr_matrix.ts`, `src/transition_policy.ts`) — sparse transition matrix updated on every access; prediction returned on every read
- Write-ahead log (`src/wal.ts`) with epoch-managed snapshot commits and WAL compaction
- Ingestion pipeline (`src/ingestion.ts`) — WAL + backpressure + auto-commit scheduling
- Atom schema validation (`src/atom_schema.ts`) — enforced `v1.<type>.<value>` format
- Prometheus metrics (`src/metrics.ts`) — throughput, latency histograms, Markov hit rate, shard GC
- Structured logging via Pino (`src/logger.ts`)
- Docker Compose stack with Prometheus and Grafana
- Benchmark harness (`tools/harness/`) — scientific runner, SLO gate, domain pilots, regression tracker
- CI workflows: readiness fast-tests, benchmark gate
- `start.sh` — build-if-needed + environment load + launch
- `.env.example` with full configuration reference

### Benchmark (v1.0 baseline, 10 independent trials, HTTP API mode)
- Throughput: 3,888 ops/sec
- p50 access latency: 1.22 ms
- p95 proof verify: 0.032 ms
- Markov hit rate: 64.0%
- Proof failures: 0
- Stale reads: 0

---

[Unreleased]: https://github.com/wjm2202/Parametric-Memory/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/wjm2202/Parametric-Memory/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/wjm2202/Parametric-Memory/releases/tag/v1.0.0
