# Markov-Merkle Predictive Memory (MMPM)

MMPM is a sharded, verifiable memory system that combines:
- Merkle proofs for integrity,
- Markov transition learning for prediction,
- WAL + snapshot-based commits for concurrent read/write safety.

## Quick Start

Prereqs: Node.js 20+, npm, Docker (for container flow).

```bash
npm install
npm run build
npm run dev
```

API default: `http://localhost:3000`

## Core Endpoints

- `POST /access` — access atom with proof path (`warmRead: true` optional)
- `POST /train` — train sequence transitions
- `POST /atoms` — queue atoms for ingestion pipeline
- `GET /atoms/pending` — queued-but-not-yet-committed atoms
- `POST /admin/commit` — force ingestion flush/commit
- `GET /atoms` / `DELETE /atoms/:atom` — list / tombstone atoms
- `GET /health` — cluster status + `ready` flag
- `GET /ready` — strict readiness probe (`200` ready, `503` not ready)
- `GET /metrics` — Prometheus metrics

## Atom Schema (Strict v1)

- Strict enforcement is enabled now (no legacy atom fallback).
- Allowed types in schema v1: `fact`, `event`, `relation`, `state`, `other`.
- Canonical atom format: `v1.<type>.<value>` (single-line, non-empty value).
- Endpoints that accept atoms (`/access`, `/train`, `/atoms`) accept either:
  - canonical string form, or
  - object form: `{ "type": "event", "value": "checkout.started" }`
- Existing DBs with legacy atom strings must be reset before startup.

When `MMPM_API_KEY` is set, bearer auth is required for non-probe routes.
Probe routes (`/metrics`, `/health`, `/ready`) are intentionally unauthenticated.

## Readiness & Startup Guard

- Server rejects non-probe traffic with `503` until orchestrator initialization completes.
- `/ready` is the contract for orchestrators and load balancers.
- Docker healthcheck uses `/ready` and marks `mmpm-service` healthy only at readiness.

## Test & Benchmark Commands

- Full tests: `npm test`
- Smoke API test: `npm run test:smoke`
- Fast readiness-focused tests:
  - `npm run test -- src/__tests__/api_ready.test.ts src/__tests__/server.test.ts src/__tests__/ingest_driver.test.ts src/__tests__/recall_bench.test.ts`
- Embedded benchmark: `npm run bench:run`
- API benchmark (expects running server): `npm run bench:run:api`
- Concurrent benchmark preset: `npm run bench:run:concurrent`
- Real-world shard stress (large related dataset + validation queries):
  - `npm run bench:run:realworld`
  - `npm run bench:run:realworld:large`
- Continuous scientific load client (ongoing traffic + retrieval quality scoring):
  - `npm run bench:continuous`
  - `npm run bench:continuous:policy`
  - Live exporter mode for Grafana overlays (offered vs served):
    - `npm run bench:continuous:live`
    - Exposes `/metrics` and `/health` on `http://127.0.0.1:9470`
  - Custom profile example:
    - `ts-node tools/harness/continuous_client.ts --profile read-heavy --duration-ms 180000 --target-ops 200 --concurrency 12 --dataset-flows 48 --strong-repeats 12 --weak-repeats 2 --metrics-port 9470 --metrics-host 0.0.0.0`
  - Report includes:
    - ingestion evidence (`writesQueued`, `commits`, `ingestionVerifiedReads`)
    - retrieval usefulness (`predictionUsefulRate`)
    - retrieval accuracy (`predictionAccuracy`, `accuracyProbe.accuracy`)
- Atom content + sparse tree inspection:
  - Show stored atom text from LevelDB shard: `npm run bench:inspect:db`
  - Render sparse transition tree (Mermaid): `npm run bench:inspect:tree`
  - Custom example:
    - `ts-node tools/harness/inspect_db.ts --db ./mmpm-db --shard 3 --atom "user|u000001|region:na|tier:free" --depth 2 --branch 5 --out tools/harness/results/my-tree.mmd`
- CI-style benchmark gate:
  - `npm run bench:ci:api`
  - Starts Docker Compose, waits for `mmpm-service` health, runs benchmark, tears down.
- Benchmark tracking:
  - Save latest snapshot: `npm run bench:track:save`
  - Compare two snapshots: `npm run bench:track -- compare tools/harness/results/base.json tools/harness/results/latest.json --threshold 0.10`
  - `compare` exits non-zero when regressions exceed threshold (CI-friendly).
- One-command Grafana flow (stack + benchmark + exporter + browser):
  - `npm run bench:grafana`
  - Optional preset: `bash tools/harness/open-grafana.sh concurrent`
  - If dashboard is empty, wait 5-15s and refresh (Prometheus scrape interval is 5s).
  - For live continuous-client overlays, run `npm run bench:continuous:live` in a separate terminal while Grafana is open.
  - Or run one-command orchestration with automatic teardown on Ctrl+C:
    - `bash tools/harness/open-grafana-continuous.sh`
    - Optional profile: `bash tools/harness/open-grafana-continuous.sh policy-stress`

## CI Workflows

- `.github/workflows/readiness-fast-tests.yml` — readiness/regression suite + health-gated API benchmark on push + PR
- `.github/workflows/bench-ci-api.yml` — manual-only API benchmark runner (`workflow_dispatch`)

To enforce as merge gates, set both workflow checks as required in GitHub branch protection/rulesets.

## Docker + Grafana

- MMPM API: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

See `docker-readme.md` for full container operations.


