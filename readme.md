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

## CI Workflows

- `.github/workflows/readiness-fast-tests.yml` — fast readiness/regression suite on push + PR
- `.github/workflows/bench-ci-api.yml` — health-gated benchmark on push + PR

To enforce as merge gates, set both workflow checks as required in GitHub branch protection/rulesets.

## Docker + Grafana

- MMPM API: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

See `docker-readme.md` for full container operations.


