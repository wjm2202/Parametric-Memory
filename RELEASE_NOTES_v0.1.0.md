# v0.1.0 — First Public Release

**Parametric-Memory: cryptographically verifiable, Markov-predictive memory for AI agents.**

Most AI memory systems can retrieve. None can prove.

Parametric-Memory (MMPM) stores atoms with cryptographic Merkle proof paths, learns Markov transition weights between atoms as the system is used, and returns the predicted next atom on every access — complete with its own proof. Every record is verifiable. Every sequence is learnable. Every version is replayable.

---

## Highlights

**Merkle proofs on every atom.** Every piece of stored knowledge has a cryptographic audit path verifiable against the current tree root. No trust required — verify independently with `POST /verify`.

**Markov prediction engine.** Weighted transitions are updated on every access. When you read an atom, MMPM predicts what you'll need next — and proves that prediction too. CSR sparse matrix with confidence decay so stale edges lose influence over time.

**MCP-native.** Ships a full Model Context Protocol server with 25+ tools across three permission tiers. Drop into Claude Desktop, Claude Code, or Claude Cowork with zero HTTP wiring.

**Temporal versioning.** Every commit increments a monotonic version. Any read endpoint accepts `asOfVersion` or `asOfMs` to replay exactly what memory looked like at any point in the past.

**Built for agents, not just search.** Write governance (auto-write / review-required / never-store per atom type), conflict detection, transition policies, per-client API keys with audit attribution, and secret-blocking filters.

---

## What's Inside

### Core
- Fastify HTTP API with Bearer token auth
- Sharded LevelDB orchestrator (consistent hash, N shards)
- Incremental Merkle tree engine with proof paths on every atom
- Markov transition engine (CSR sparse matrix, confidence half-life decay)
- Write-ahead log with epoch-managed snapshots and WAL compaction
- Ingestion pipeline with backpressure and auto-commit scheduling
- Six atom types: `fact`, `event`, `state`, `relation`, `procedure`, `other`
- Per-atom TTL with access-aware reset

### Security
- Startup API key validation (rejects placeholder keys)
- Secret-blocking filter (`MMPM_BLOCK_SECRET_ATOMS=1`)
- Per-client named keys with audit-log attribution
- Request ID threading via `x-request-id`

### Integrations
- **MCP server** — three tiers: `readonly`, `serve` (mutations), `unsafe` (dangerous ops)
- **Claude Cowork skill** — one-step `.skill` package install
- **Claude Desktop** — drop-in `claude_desktop_config.json`
- **VSCode / Claude Code** — `CLAUDE.md` template + scaffold scripts

### Observability
- Prometheus metrics (throughput, latency, Markov hit rate, proof verification)
- 36-panel Grafana dashboard in Docker Compose
- Audit log ring buffer (1000 entries)

### Data Safety
- DB defaults to `~/.mmpm/data` (outside the repo)
- `npm run backup` / `npm run restore`
- NDJSON export/import via API

---

## Quickstart

```bash
# Clone and setup
git clone https://github.com/wjm2202/Parametric-Memory.git
cd Parametric-Memory
npm run setup        # install, build, create .env
./start.sh           # start server at http://localhost:3000

# Or with Docker
docker-compose up
```

---

## Benchmark (10 independent trials, HTTP API mode)

| Metric | Value |
|---|---|
| Throughput | 3,888 ops/sec |
| p50 access latency | 1.22 ms |
| p95 proof verify | 0.032 ms |
| Markov hit rate | 64.0% |
| Proof failures | 0 |
| Stale reads | 0 |

---

## Validation

39 test files, 725 tests passing.

---

## License

Free for personal and open-source use. Commercial license required for organisations. See [LICENSE](LICENSE).

---

*memory with proof.*
