# Parametric-Memory

**A cryptographically verifiable, Markov-predictive memory substrate for AI agents.**

[![CI](https://img.shields.io/badge/CI-passing-00d4ff)](#)
[![License: Personal Free / Commercial Paid](https://img.shields.io/badge/License-Personal%20Free%20%7C%20Commercial%20Paid-white.svg)](#)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-00d4ff)](#)

---

Most AI memory systems can retrieve. None can prove.

Parametric-Memory (MMPM) stores atoms with cryptographic Merkle proof paths, learns Markov transition weights between atoms as the system is used, and returns the predicted next atom on every access — complete with its own proof. Every record is verifiable. Every sequence is learnable. Every version is replayable.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP API / MCP Server                  │
├────────────────────────┬────────────────────────────────────┤
│   Ingestion Pipeline   │      Query Engine                  │
│   (WAL + backpressure) │  (search / retrieve / bootstrap)   │
├────────────────────────┴────────────────────────────────────┤
│              Sharded Orchestrator (consistent hash)         │
├──────────────┬──────────────┬──────────────┬────────────────┤
│   Shard 0    │   Shard 1    │   Shard 2    │   Shard N      │
│  (LevelDB)   │  (LevelDB)   │  (LevelDB)   │  (LevelDB)     │
├──────────────┴──────────────┴──────────────┴────────────────┤
│         Merkle Tree Engine │ Markov Chain Engine            │
│         (proof paths)      │ (transition weights)           │
└─────────────────────────────────────────────────────────────┘
```

| Layer | What it does |
|---|---|
| **Merkle proof chains** | Every atom has a cryptographic proof path verifiable against the current tree root |
| **Markov transition learning** | Weighted transitions between atoms are updated on access; retrieval predicts what comes next |
| **WAL + snapshot commits** | Write-ahead log with epoch-managed snapshots enables concurrent reads during writes |
| **Sharded orchestration** | Atoms distributed across N shards via consistent hashing; each shard is an independent LevelDB instance |
| **Temporal versioning** | Every commit increments a monotonic master version; any read endpoint accepts `asOfVersion` or `asOfMs` |

---

## Quickstart

```bash
# Docker (recommended)
docker-compose up

# Server is ready at http://localhost:3000
# Prometheus metrics: http://localhost:3000/metrics
# Grafana dashboard: http://localhost:3001
```

```bash
# From source
npm install
npm run build
node dist/server.js
```

Environment variables (see `.env.example` for the full list):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback unless behind a TLS reverse proxy. |
| `DB_BASE_PATH` | `~/.mmpm/data` | LevelDB storage directory (outside the repo) |
| `SHARD_COUNT` | `4` | Number of LevelDB shards |
| `MMPM_API_KEY` | *(none)* | Bearer token for auth. Generate: `openssl rand -hex 32` |
| `MMPM_API_KEYS` | *(none)* | Per-client named keys: `name:key,name:key,...` (appear in audit log) |
| `WRITE_POLICY` | `auto-write` | `auto-write` \| `review-required` \| `never-store` |
| `MMPM_METRICS_PUBLIC` | `0` | Set to `1` to expose `/metrics` without auth (Prometheus scraping) |
| `MMPM_BLOCK_SECRET_ATOMS` | `0` | Set to `1` to reject atoms matching credential patterns (recommended in prod) |
| `LOG_LEVEL` | `info` | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` |

---

## API

### Write an atom

```bash
POST /atoms
Content-Type: application/json

{ "atom": "v1.fact.user_preference_dark_mode" }
```

### Read with Merkle proof

```bash
GET /atoms/v1.fact.user_preference_dark_mode
```

```json
{
  "atom": "v1.fact.user_preference_dark_mode",
  "version": 42,
  "proof": {
    "path": ["sha256:a1b2...", "sha256:c3d4...", "sha256:e5f6..."],
    "root": "sha256:deadbeef...",
    "verified": true
  }
}
```

### Access with Markov prediction

```bash
POST /access
Content-Type: application/json

{ "data": "v1.fact.user_preference_dark_mode" }
```

```json
{
  "atom": "v1.fact.user_preference_dark_mode",
  "predicted_next": "v1.state.ui_theme_applied",
  "prediction_confidence": 0.74,
  "proof": { "verified": true }
}
```

### Bootstrap agent context

```bash
POST /memory/bootstrap
Content-Type: application/json

{ "namespace": "user", "limit": 20 }
```

Returns the top-N most likely next atoms for the given namespace, ranked by Markov transition weight. Use this on agent session start to prime working memory.

### Historical replay

```bash
GET /atoms/v1.fact.user_preference_dark_mode?asOfMs=1709500000000
```

Returns the exact state of this atom at the given Unix timestamp, with proof against the version-pinned root.

### Key endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/atoms` | Ingest one or more atoms |
| `GET` | `/atoms/:atom` | Retrieve atom + proof |
| `POST` | `/access` | Access + update Markov weights + get prediction |
| `POST` | `/memory/bootstrap` | Prime agent context from Markov state |
| `GET` | `/search` | Full-text + namespace search |
| `POST` | `/retrieve` | Batch retrieval by atom list |
| `GET` | `/atoms/pending` | Inspect queued-but-uncommitted atoms |
| `POST` | `/admin/commit` | Force-flush the ingestion pipeline |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/health` | Liveness check |

---

## Benchmark

Scientific benchmark — 10 independent trials, HTTP API mode, fresh server + database per trial, real mixed read/write/train workload.

| Metric | Mean | Std Dev | CV |
|---|---|---|---|
| Throughput | 3,888 ops/sec | — | — |
| p50 access latency | 1.22 ms | 0.33 ms | 0.27 |
| p95 proof verify | 0.032 ms | 0.004 ms | 0.117 |
| Markov hit rate | 64.0% | 0.0% | 0.000 |
| Stale reads | 0 | — | — |
| Proof failures | 0 | — | — |

Benchmark harness, protocol, and SLO gate configuration are in `tools/harness/`. Reproduce with:

```bash
./tools/harness/scientific_runner.sh --preset concurrent --trials 10 --print
```

---

## MCP Integration

MMPM ships a full [Model Context Protocol](https://modelcontextprotocol.io) server. Claude Desktop and compatible agent runtimes can read and write MMPM memory natively, without constructing HTTP requests.

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mmpm": {
      "command": "node",
      "args": ["path/to/mmpm/dist/mcp-server.js"],
      "env": {
        "MMPM_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

Available MCP tools:

- `mmpm_store` — write atoms
- `mmpm_retrieve` — read atoms with proof verification
- `mmpm_access` — access + get Markov prediction
- `mmpm_bootstrap` — load agent context from memory
- `mmpm_search` — search atoms by content or namespace

---

## Observability

A 36-panel Grafana dashboard ships with the Docker Compose stack:

- Ingestion throughput and commit latency histograms
- Per-shard GC and snapshot metrics
- Markov hit rate and prediction accuracy trends
- Write policy outcomes and backpressure event counts
- Merkle proof verification rate

```bash
docker-compose up
# Grafana: http://localhost:3001  (default: admin/admin)
```

---

## Atom Format

Atoms are strings in the format `v1.<type>.<value>`:

| Type | Example | Use case |
|---|---|---|
| `fact` | `v1.fact.user_prefers_dark_mode` | Stable facts about entities |
| `event` | `v1.event.order_placed_2024_03` | Timestamped occurrences |
| `state` | `v1.state.checkout_step_3` | Current agent or workflow state |
| `relation` | `v1.relation.user_owns_order_42` | Entity relationships |
| `procedure` | `v1.procedure.pip_install.always_add_break_system_packages` | Discovered techniques and working approaches |
| `other` | `v1.other.custom_key` | Unclassified atoms |

Atoms are namespace-scoped: the value portion can encode namespace hierarchy (`user.42.preference.theme`).

---

## Why not a vector database?

Vector DBs are excellent for semantic similarity search. MMPM is not a competitor — it's a different layer.

| Capability | Vector DB | MMPM |
|---|---|---|
| Semantic similarity search | ✅ | ❌ (exact match + namespace) |
| Cryptographic proof of storage | ❌ | ✅ |
| Temporal versioning + historical replay | ❌ | ✅ |
| Markov prediction of next atom | ❌ | ✅ |
| Write governance (review tiers) | ❌ | ✅ |
| Conflict detection | ❌ | ✅ |
| MCP-native agent interface | Rarely | ✅ |

Use a vector DB for "find things that are semantically similar to this query." Use MMPM for "prove what the agent knew, predict what it needs next, and govern what can be written."

---

## Integrations

MMPM ships with ready-made integrations for the most common AI development environments.

**Claude Cowork skill** (`integrations/claude-skill/SKILL.md`) — Install in Claude Cowork to give Claude persistent, cryptographically verifiable memory backed by your local MMPM server. Drag `integrations/parametric-memory.skill` into Cowork to install in one step. Covers session-start context loading, atom storage, Markov prediction, and end-of-session save pattern.

**VSCode / Claude Code** (`integrations/vscode/`) — Three integration paths: MCP server config for Cline, Continue, and GitHub Copilot; `CLAUDE.md.template` for Claude Code in terminal (drop in your project root); and `.vscode/tasks.json` snippets to start/stop MMPM as a VSCode task. See `integrations/vscode/README.md` for step-by-step setup.

**Claude Desktop** (`integrations/claude-desktop/claude_desktop_config.json.example`) — Drop-in MCP config for Claude Desktop on macOS and Windows. Adds all MMPM tools directly to Claude's tool palette without any code.

To rebuild the `.skill` package after editing the skill file:

```bash
npm run skill:pack
```

---

## Contributing

Contributions welcome. Please open an issue before a large PR.

For AI-assisted codebase navigation, [jCodeMunch-mcp](https://github.com/jcodemunch/jcodemunch-mcp) enables symbol-level exploration of the TypeScript codebase via Claude Desktop without reading all files.

---

## License

Source available — free for personal use, commercial license required for organisations. See [LICENSE](LICENSE).

Free for open-source and self-hosted use. If you run MMPM as a hosted service, AGPL-3.0 requires you to release your modifications. Enterprise licensing (on-prem, compliance tooling, SLA) available at [parametric-memory.dev](https://parametric-memory.dev).

---

*memory with proof.*
