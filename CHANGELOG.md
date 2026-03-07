# Changelog

All notable changes to Parametric-Memory are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

*Nothing yet.*

---

## [0.1.0] — 2026-04-06

First public release.

### Core Engine
- HTTP API server on Fastify with Bearer token auth and per-client named keys
- Sharded LevelDB orchestrator — consistent hash routing across N shards
- Incremental Merkle tree engine — every atom has a cryptographic proof path
- Markov transition engine — CSR sparse matrix updated on every access; prediction returned on every read
- Write-ahead log with epoch-managed snapshot commits and WAL compaction
- Ingestion pipeline with backpressure and auto-commit scheduling
- Unified injectable clock for sub-millisecond timestamp precision across all transitions and decay calculations
- Atom schema validation — enforced `v1.<type>.<value>` format with six types: `fact`, `event`, `state`, `relation`, `procedure`, `other`
- Per-atom TTL with access-aware reset and background reaper
- Confidence decay — exponential half-life on transition weights so stale edges lose influence over time

### Query and Retrieval
- `POST /access` — access atom + update Markov weights + get prediction with proof
- `POST /memory/bootstrap` — prime agent context from Markov state with namespace scoping
- `GET /atoms/:atom` — retrieve atom with full Merkle proof (`leaf`, `root`, `auditPath`, `index`)
- `POST /verify` — standalone proof verification (no auth required)
- `GET /atoms` — paginated browsing with `type`, `prefix`, `limit`, `offset` filters
- `GET /atoms/stale` — find atoms not accessed in N days
- Temporal versioning — every read endpoint accepts `asOfVersion` or `asOfMs` for historical replay
- Write policy tiers: `auto-write` | `review-required` | `never-store` per atom type
- Conflict detection on fact atoms with cosine similarity threshold
- Transition policy — configurable allowed-type rules for Markov predictions

### Security (Sprint 16)
- Startup API key validation — rejects known placeholder keys, refuses to bind `0.0.0.0` with default key
- `MMPM_BLOCK_SECRET_ATOMS=1` — rejects atoms matching credential patterns (API keys, tokens, passwords)
- Per-client named keys via `MMPM_API_KEYS` env var with audit-log attribution
- Request ID threading — monotonic counter propagated via `x-request-id` header

### Observability
- Prometheus metrics — throughput, latency histograms, Markov hit rate, shard GC, proof verification rate
- 36-panel Grafana dashboard — ships with Docker Compose stack
- `GET /admin/audit-log` — bounded ring buffer (1000 entries) of mutation events
- Structured startup log with resolved configuration

### MCP Integration
- Full Model Context Protocol server with three permission tiers: `mcp:serve:readonly` (read), `mcp:serve` (read + mutations), `mcp:serve:unsafe` (read + mutations + dangerous)
- 25+ MCP tools covering atoms, access, bootstrap, search, train, checkpoint, verify, audit, export, import, policy, and weekly evaluation
- `session_checkpoint` — single-call save: atoms + tombstones + train + commit
- Claude Cowork skill with one-step `.skill` package install
- Claude Desktop drop-in config templates
- VSCode / Claude Code integration with CLAUDE.md template and scaffold scripts

### Data Safety
- Default DB path at `~/.mmpm/data` — outside the git repo to survive `git clean` and IDE resets
- `npm run backup` — exports all active atoms and weights to `~/.mmpm/backups/`
- `npm run restore` — imports from backup JSON (idempotent, skips existing atoms)
- `GET /admin/export` — NDJSON stream export with `?status` and `?type` filters
- `POST /admin/import` — accepts NDJSON or bare atom strings with deduplication

### DevEx
- `npm run setup` — one-command bootstrap (install, build, create .env)
- `start.sh` — build-if-needed, environment load, launch with resolved DB path printed
- Docker Compose stack with Prometheus and Grafana
- Benchmark harness with scientific runner, SLO gate, and regression tracker
- CONTRIBUTING.md, SECURITY.md, and full API documentation in README

### Benchmark (10 independent trials, HTTP API mode)
- Throughput: 3,888 ops/sec
- p50 access latency: 1.22 ms
- p95 proof verify: 0.032 ms
- Markov hit rate: 64.0%
- Proof failures: 0
- Stale reads: 0

### Validation
- 39 test files, 725 tests passing

---

[Unreleased]: https://github.com/wjm2202/Parametric-Memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wjm2202/Parametric-Memory/releases/tag/v0.1.0
