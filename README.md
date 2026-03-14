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
│   (WAL + backpressure) │  (BM25 + semantic search + boot)   │
├────────────────────────┴────────────────────────────────────┤
│       Sharded Orchestrator (JumpHash consistent routing)    │
├──────────────┬──────────────┬──────────────┬────────────────┤
│   Shard 0    │   Shard 1    │   Shard 2    │   Shard N      │
│  (LevelDB)   │  (LevelDB)   │  (LevelDB)   │  (LevelDB)     │
├──────────────┴──────────────┴──────────────┴────────────────┤
│  Merkle Tree Engine  │ Variable-Order Markov Chain Engine   │
│  (proof paths +      │ (transition weights + HLR decay +   │
│   consistency proofs) │  predictive bootstrapping)          │
└─────────────────────────────────────────────────────────────┘
```

| Layer | What it does |
|---|---|
| **Merkle proof chains** | Every atom has a cryptographic proof path verifiable against the current tree root. Consistency proofs (RFC 6962) verify the tree evolved honestly between any two versions. |
| **Variable-Order Markov** | Higher-order context chains (not just bigrams) capture multi-step workflows. Predictions are backed by Merkle proofs. |
| **Half-Life Regression decay** | Transition weights decay with a 7-day half-life (`weight × 0.5^(days/7)`), so recently reinforced knowledge dominates stale edges. |
| **BM25 + semantic search** | Token-level retrieval via BM25 scoring with Jaccard overlap, plus optional semantic vector search. Bootstrap ranking: 55% semantic relevance, 25% proof presence, 10% category, 10% conflict-free. |
| **JumpHash sharding** | Atoms distributed across N shards via Google JumpHash for consistent, balanced routing. Each shard is an independent LevelDB instance. |
| **WAL + snapshot commits** | Write-ahead log with epoch-managed snapshots enables concurrent reads during writes. |
| **TTL with auto-promotion** | Atoms can be ingested with a time-to-live. If accessed before expiry, they auto-promote to permanent storage. |
| **Temporal versioning** | Every commit increments a monotonic master version; any read endpoint accepts `asOfVersion` or `asOfMs`. |
| **Conflict detection** | Fact atoms are checked for contradictions automatically. Conflicting claims surface in bootstrap results so you can tombstone the stale one. |
| **Compact proof mode** | Bootstrap can return server-verified proof summaries instead of full audit paths, reducing response tokens by ~60%. Server env vars can force full or compact mode regardless of client request. Full proofs always available via `/atoms/:atom`. |

---

## Quickstart

```bash
# Docker (recommended)
docker compose up

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
| `MMPM_BOOTSTRAP_FORCE_FULL_PROOFS` | `0` | Set to `1` to always return full Merkle proofs in bootstrap (ignores client request) |
| `MMPM_BOOTSTRAP_COMPACT_PROOFS` | `0` | Set to `1` to always return compact proofs in bootstrap (saves ~60% tokens) |
| `LOG_LEVEL` | `info` | Pino log level: `trace` \| `debug` \| `info` \| `warn` \| `error` |

---

## Deploy to a Server

MMPM ships a full production deployment stack: Docker Compose with nginx TLS termination, Let's Encrypt auto-renewal, and OAuth2 for MCP clients. Everything you need to go from a fresh Ubuntu droplet to a running MMPM instance at `https://your-domain.com`.

### Prerequisites

You need a server (Ubuntu 22.04, any cloud provider — a $6/mo droplet works fine) and a domain name with an A record pointing to the server's IP.

### Step 1 — SSH in and clone

```bash
ssh root@your-server-ip
git clone https://github.com/wjm2202/Parametric-Memory.git
cd Parametric-Memory
```

### Step 2 — Run the setup script

```bash
bash integrations/deploy/setup-droplet.sh
```

This single script handles everything:

1. Installs Docker and Docker Compose
2. Configures UFW firewall (SSH + HTTP + HTTPS only)
3. Generates strong API keys and writes `.env.production`
4. Obtains a Let's Encrypt TLS certificate via certbot
5. Builds and starts the production stack (API server + MCP server + nginx + certbot renewal)

When it finishes, you'll see the generated API keys — save them.

### Step 3 — Verify

```bash
curl https://your-domain.com/health
# → {"status":"ok","ready":true}
```

### What the production stack runs

The `integrations/deploy/docker-compose.production.yml` starts four containers:

| Container | Port | Role |
|---|---|---|
| `mmpm-service` | 3000 (internal) | Core HTTP API server with LevelDB, Merkle tree, Markov engine |
| `mmpm-mcp` | 3001 (internal) | MCP Streamable HTTP server with OAuth2 provider |
| `nginx` | 80, 443 (public) | TLS termination, routing, rate limiting, HSTS |
| `certbot` | — | Auto-renews Let's Encrypt certificates every 12 hours |

Nginx routes `/mcp` and `/oauth/*` to the MCP container, `/health` and `/ready` are public probes, `/admin/export` is blocked externally, and everything else goes to the API server with Bearer token auth.

### Custom domain

Set the `MMPM_DOMAIN` environment variable before running setup:

```bash
export MMPM_DOMAIN=memory.yourcompany.com
bash integrations/deploy/setup-droplet.sh
```

### Updating

```bash
cd ~/Parametric-Memory
git pull
source .env.production
docker compose -f integrations/deploy/docker-compose.production.yml up -d --build
```

Always rebuild with `--build` after pulling changes.

### Security baseline

Before exposing MMPM publicly, ensure these are set in `.env.production`:

| Setting | Recommended | Why |
|---|---|---|
| `MMPM_API_KEY` | Strong random key | Auth for all API endpoints |
| `MMPM_BLOCK_SECRET_ATOMS` | `1` | Reject atoms that look like secrets or credentials |
| `HOST` | `127.0.0.1` | Loopback — nginx handles external traffic |
| `MMPM_METRICS_PUBLIC` | `0` | Keep `/metrics` behind auth |

The setup script generates these automatically.

---

## Connect to Claude Cowork

Cowork is the fastest way to use MMPM — Claude gets persistent, cryptographically verifiable memory that survives across conversations. Here's how to set it up end-to-end.

### Step 1 — Add MMPM as a custom connector

1. Open Claude Desktop and switch to **Cowork** mode
2. Go to **Settings** (gear icon) → **Connectors**
3. Click **Add custom connector**
4. Enter your MMPM server URL: `https://your-domain.com/mcp`
5. Click **Connect**
6. OAuth completes automatically — the MCP server includes a built-in OAuth2 provider (auto-approve, single-tenant). No extra credentials to enter.

Once connected, you'll see MMPM's 25+ tools appear in Claude's tool palette — `session_checkpoint`, `memory_search`, `memory_session_bootstrap`, `memory_verify`, and more.

### Step 2 — Update global instructions (CLAUDE.md)

Cowork uses a global instructions file to tell Claude how to behave across all sessions. You need to add memory instructions so Claude knows to load context at session start, store findings as they happen, and save state before closing.

1. In Cowork, open **Settings** → **Global Instructions** (or edit `CLAUDE.md` directly)
2. Add the following memory instructions:

```markdown
# Persistent Memory (MMPM)

You have persistent memory via MMPM MCP tools. This memory survives across sessions. Use it.

## Session Start

Every session, before doing any work:

1. `memory_session_bootstrap` — pass `objective` from the user's opening message, `maxTokens: 1200`
2. `memory_atoms_list` with `type: "procedure"` — load all procedures. These are corrections and proven processes. Read them. Obey them.
3. `memory_atoms_list` with `type: "state"` — load current work state
4. Review `conflictingFacts` in bootstrap results. Surface contradictions to the user.

If memory is empty or the server is unreachable, say so and proceed without it.

## What to Store

Store immediately (don't wait for session end):
- User corrections (highest priority — store as `v1.procedure.*`)
- Architecture and design decisions (`v1.fact.*`)
- Bug root causes and fixes (`v1.fact.*`)
- Configuration that took effort (`v1.fact.*`)

Store at session end:
- Updated `v1.state.*` atoms reflecting where work stands
- Tombstone `v1.state.*` atoms that are no longer true

Never store: secrets, API keys, tokens, passwords, or speculative guesses.

## Session End

Always run before closing:

session_checkpoint({
  atoms: [...new facts, events, procedures...],
  tombstone: [...obsolete state atoms...]
})

Then reinforce key arcs separately:
memory_train({ sequence: [trigger, action, outcome] })
```

The full reference CLAUDE.md with advanced patterns (Markov training, correction handling, naming conventions, conflict resolution) is in the repo at `CLAUDE.md`.

### Step 3 — Test the connection

Start a new Cowork conversation and say something like:

> "Check your memory — what do you know about my projects?"

Claude should call `memory_session_bootstrap` and report back what it finds. If the memory is empty, ask Claude to store a test fact:

> "Remember that my preferred programming language is TypeScript"

Then start a new conversation and ask Claude what it remembers. The fact should persist.

### How it works under the hood

When Claude runs in Cowork with the MMPM connector:

1. **Session start** — Claude calls `memory_session_bootstrap` with the conversation objective. MMPM ranks atoms by Jaccard token overlap (55%), proof presence (25%), category (10%), and conflict-free status (10%), then returns the most relevant context with Merkle proofs.

2. **During work** — Claude stores findings via `session_checkpoint` as they happen. Facts, procedures, relations, and events are committed to the Merkle tree. Markov arcs are trained to link related knowledge.

3. **Session end** — Claude checkpoints final state, tombstones obsolete atoms, and reinforces successful workflow sequences via `memory_train`.

4. **Next session** — Bootstrap loads everything back. Markov predictions hint at what's needed next. Procedures (corrections) are loaded first so Claude doesn't repeat mistakes.

---

## API

### Write an atom

```bash
POST /atoms
Content-Type: application/json

{ "atoms": ["v1.fact.user_preference_dark_mode"] }
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
    "leaf": "d3ee269f...",
    "root": "7980c3db...",
    "auditPath": ["80c50cb9...", "a286003f...", "db56114e..."],
    "index": 32
  }
}
```

### Access with Markov prediction

```bash
POST /access
Content-Type: application/json

{ "atom": "v1.fact.user_preference_dark_mode" }
```

```json
{
  "currentData": "v1.fact.user_preference_dark_mode",
  "currentProof": { "leaf": "...", "root": "...", "auditPath": [...], "index": 32 },
  "predictedNext": "v1.state.ui_theme_applied",
  "predictedProof": { "leaf": "...", "root": "...", "auditPath": [...], "index": 33 },
  "verified": true
}
```

### Bootstrap agent context

```bash
POST /memory/bootstrap
Content-Type: application/json

{ "objective": "deploy the new API changes", "maxTokens": 1200 }
```

Returns ranked atoms with proofs, conflict detection, and retrieval rationale. Use this on agent session start to prime working memory.

### Semantic search

```bash
POST /search
Content-Type: application/json

{ "query": "database backup schedule", "limit": 5 }
```

Returns matching atoms ranked by semantic similarity, each with a Merkle proof.

### Verify a proof

```bash
POST /verify
Content-Type: application/json

{
  "atom": "v1.fact.user_preference_dark_mode",
  "proof": { "leaf": "...", "root": "...", "auditPath": [...], "index": 32 }
}
```

```json
{ "valid": true, "atom": "v1.fact.user_preference_dark_mode", "checkedAt": 1773079430777 }
```

Public endpoint — no auth required. Clients can independently verify any atom was genuinely committed.

### Verify tree consistency

```bash
POST /verify-consistency
Content-Type: application/json

{ "fromVersion": 10, "toVersion": 15 }
```

Proves the Merkle tree evolved honestly between two versions — no history was rewritten. Mirrors the consistency proof model from Certificate Transparency (RFC 6962).

### Historical replay

```bash
GET /atoms/v1.fact.user_preference_dark_mode?asOfMs=1709500000000
```

Returns the exact state of this atom at the given Unix timestamp, with proof against the version-pinned root.

### Key endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/atoms` | Ingest one or more atoms |
| `GET` | `/atoms/:atom` | Retrieve atom + Merkle proof |
| `POST` | `/access` | Access + update Markov weights + get prediction |
| `POST` | `/batch-access` | Batch associative recall for multiple atoms |
| `POST` | `/memory/bootstrap` | Prime agent context with objective-ranked atoms |
| `POST` | `/search` | Semantic search across all atoms |
| `GET` | `/atoms` | List/browse atoms with `type`, `prefix`, `limit`, `offset` |
| `GET` | `/atoms/stale` | Find atoms not accessed in N days |
| `GET` | `/atoms/pending` | Inspect queued-but-uncommitted atoms |
| `POST` | `/train` | Train a Markov transition sequence |
| `GET` | `/weights/:atom` | Inspect outgoing transition weights for an atom |
| `POST` | `/verify` | Verify a Merkle proof (public, no auth) |
| `POST` | `/verify-consistency` | Verify tree consistency between versions (public) |
| `GET` | `/tree-head` | Current master version, root hash, timestamp (public) |
| `POST` | `/admin/commit` | Force-flush the ingestion pipeline |
| `GET` | `/admin/audit-log` | Mutation event audit log |
| `GET` | `/admin/export` | NDJSON export of all atoms |
| `POST` | `/admin/import` | Import atoms from NDJSON or plain strings |
| `GET` | `/policy` | Current transition policy |
| `GET` | `/write-policy` | Current write policy tiers |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Readiness check |

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

MMPM ships a full [Model Context Protocol](https://modelcontextprotocol.io) server with two transport modes: stdio (for Claude Desktop and Claude Code) and Streamable HTTP (for Cowork and remote clients).

### Claude Desktop (stdio)

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "parametric-memory": {
      "command": "npm",
      "args": ["run", "mcp:serve"],
      "cwd": "/path/to/parametric-memory",
      "env": {
        "MMPM_MCP_BASE_URL": "http://127.0.0.1:3000",
        "MMPM_MCP_API_KEY": "REPLACE_WITH_YOUR_API_KEY"
      }
    }
  }
}
```

### Claude Cowork (remote, OAuth2)

See [Connect to Claude Cowork](#connect-to-claude-cowork) above. The deployed MCP server at `/mcp` handles OAuth automatically.

### Claude Code (terminal)

Drop the `CLAUDE.md.template` from `integrations/vscode/` into your project root and configure the MCP server in your Claude Code settings.

### Available MCP tools

| Tool | Description |
|---|---|
| `session_checkpoint` | Save atoms, tombstone stale state, train Markov arcs, and commit — all in one call |
| `memory_session_bootstrap` | Load agent context ranked by objective relevance with full proofs |
| `memory_access` | Access an atom + update Markov weights + get prediction with proof |
| `memory_batch_access` | Batch associative recall for multiple atoms |
| `memory_atoms_list` | List atoms by type, prefix, or namespace |
| `memory_atoms_add` | Queue new atoms for ingestion (supports TTL for auto-expiry) |
| `memory_search` | Semantic search across all atoms |
| `memory_train` | Train a Markov transition sequence |
| `memory_verify` | Verify a Merkle proof for any atom |
| `memory_verify_consistency` | Verify tree consistency between two versions |
| `memory_tree_head` | Get current master version and root hash |
| `memory_weights_get` | Inspect outgoing transition weights |
| `memory_atom_get` | Get a single atom with its full proof |
| `memory_atoms_stale` | Find atoms not accessed in N days |
| `memory_pending` | Inspect queued-but-uncommitted atoms |
| `memory_commit` | Force-flush the ingestion pipeline |
| `memory_audit_log` | Query mutation event audit log |
| `memory_atoms_export` | NDJSON export for backup or migration |
| `memory_context` | Context block generation for session bootstrap |
| `memory_policy_get` | Read current transition policy |
| `memory_write_policy_get` | Read current write policy tiers |
| `memory_health` / `memory_ready` | Server liveness and readiness checks |
| `memory_metrics` | Prometheus metrics text |
| `memory_weekly_eval_run` / `memory_weekly_eval_status` | Run and check weekly self-evaluation |

Three permission tiers: `mcp:serve:readonly` (read only), `mcp:serve` (read + write, default), `mcp:serve:unsafe` (all ops including delete/import/policy).

---

## Observability

A 36-panel Grafana dashboard ships with the Docker Compose stack:

- Ingestion throughput and commit latency histograms
- Per-shard GC and snapshot metrics
- Markov hit rate and prediction accuracy trends
- Write policy outcomes and backpressure event counts
- Merkle proof verification rate

```bash
docker compose up
# Grafana: http://localhost:3001  (default: admin/admin)
```

---

## Atom Format

Atoms are strings in the format `v1.<type>.<value>`:

| Type | Example | Use case |
|---|---|---|
| `fact` | `v1.fact.user_prefers_dark_mode` | Stable facts about entities |
| `event` | `v1.event.order_placed_2024_03` | Timestamped occurrences (immutable) |
| `state` | `v1.state.checkout_step_3` | Current agent or workflow state (tombstone when stale) |
| `relation` | `v1.relation.user_owns_order_42` | Entity relationships |
| `procedure` | `v1.procedure.always_check_memory_before_web_search` | Corrections, rules, and proven processes |
| `other` | `v1.other.custom_key` | Unclassified atoms |

Atoms can carry values after a colon: `v1.fact.widget_price_45_99: SKU WDG-001 | Industrial Widget A | $45.99`. The full string (name + value) is the atom identifier.

Provenance suffixes help with traceability: `_src_human` (user correction), `_src_research`, `_src_test`, `_dt_YYYY_MM_DD` (temporal context). These are stripped before conflict detection.

---

## Why not a vector database?

Vector DBs are excellent for semantic similarity search. MMPM is not a competitor — it's a different layer.

| Capability | Vector DB | MMPM |
|---|---|---|
| Semantic similarity search | Yes | Yes (BM25 + optional vectors) |
| Cryptographic proof of storage | No | Yes |
| Temporal versioning + historical replay | No | Yes |
| Tree consistency proofs (RFC 6962) | No | Yes |
| Markov prediction of next atom | No | Yes |
| Half-life regression decay | No | Yes |
| Write governance (review tiers) | No | Yes |
| Conflict detection | No | Yes |
| MCP-native agent interface | Rarely | Yes |
| TTL with access-aware auto-promotion | No | Yes |

Use a vector DB for "find things that are semantically similar to this query." Use MMPM for "prove what the agent knew, predict what it needs next, and govern what can be written."

---

## Integrations

MMPM ships with ready-made integrations for the most common AI development environments.

**Claude Cowork** — See [Connect to Claude Cowork](#connect-to-claude-cowork) above. Add as a custom connector via OAuth, update your global instructions, and Claude has persistent verifiable memory across every conversation.

**Claude Cowork skill** (`integrations/claude-skill/SKILL.md`) — Alternative to the connector approach. Drag `integrations/parametric-memory.skill` into Cowork to install in one step. Covers session-start context loading, atom storage, Markov prediction, and end-of-session save pattern.

**VSCode / Claude Code** (`integrations/vscode/`) — Three integration paths: MCP server config for Cline, Continue, and GitHub Copilot; `CLAUDE.md.template` for Claude Code in terminal (drop in your project root); and `.vscode/tasks.json` snippets to start/stop MMPM as a VSCode task. See `integrations/vscode/README.md` for step-by-step setup.

**Claude Desktop** (`integrations/claude-desktop/claude_desktop_config.json.example`) — Drop-in MCP config for Claude Desktop on macOS and Windows. Adds all MMPM tools directly to Claude's tool palette without any code.

**Production deployment** (`integrations/deploy/`) — Docker Compose production stack with nginx TLS, Let's Encrypt auto-renewal, OAuth2 MCP server, and one-script setup. See [Deploy to a Server](#deploy-to-a-server) above.

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

Source available — free for personal use, commercial license required for organisations. See [LICENSE](LICENSE) for full terms.

Personal, non-commercial, and academic use is free. Any commercial use — including use by companies, in paid products, or as a hosted service — requires a separate license. Contact [parametric-memory.dev](https://parametric-memory.dev) for commercial licensing.

---

*memory with proof.*
