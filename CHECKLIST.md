# MMPM Production Readiness Checklist

## Phase 1 — Core Integrity

- [x] 1.1 Add `verifyProof()` to `MerkleKernel`
- [x] 1.2 Add `verified` field to `PredictionReport` and verify predicted proofs in `access()`
- [x] 1.3 Fix `comparison.ts` — use actual prediction results, invoke the function

## Phase 2 — Dynamic Data Model

- [x] 2.1 Add `addAtoms()` method to `PredictiveMemory`
- [x] 2.2 Incremental Merkle rebuild via `rebuildTree()`
- [x] 2.3 Persist data atoms in LevelDB under `d:` prefix, restore on `init()`
- [x] 2.4 Add `POST /register` endpoint to server

## Phase 3 — API Hardening

- [x] 3.1 Input validation on `/access`
- [x] 3.2 Input validation on `/train`
- [x] 3.3 Input validation on `/register`
- [x] 3.4 Structured error responses `{ error, code }`
- [x] 3.5 Request body size limit

## Phase 4 — Auth Layer

- [x] 4.1 `MMPM_API_KEY` env config
- [x] 4.2 Fastify `onRequest` hook (Bearer token, skip `/metrics`)
- [x] 4.3 Docker env passthrough

## Phase 5 — Persistence Fixes

- [x] 5.1 Fix `init()` prefix scan range (`gte`/`lt`)
- [x] 5.2 Graceful shutdown (`SIGTERM`/`SIGINT` → `db.close()`)
- [x] 5.3 Handle LevelDB open errors

## Phase 6 — Observability Polish

- [x] 6.1 Gauge: `mmpm_data_atoms_total`
- [x] 6.2 Counter: `mmpm_training_events_total`
- [x] 6.3 Histogram buckets for `accessLatency`
- [x] 6.4 `GET /health` endpoint

## Phase 7 — Test Suite

- [x] 7.1 Set up test framework (vitest)
- [x] 7.2 Unit tests: `MerkleKernel`
- [x] 7.3 Unit tests: `SparseTransitionMatrix`
- [x] 7.4 Unit tests: `PredictiveMemory`
- [x] 7.5 Integration tests: API endpoints
- [x] 7.6 CI: `npm test` in Dockerfile build stage

## Phase 8 — Infrastructure & Cleanup

- [x] 8.1 Delete empty `generator.ts`
- [x] 8.2 Remove unused `TransitionMap` type
- [x] 8.3 Remove unused `savedTime` variable in `index.ts`
- [x] 8.4 Create `test-api.sh` smoke test
- [x] 8.5 Fix README markdown formatting
- [x] 8.6 Add `decay()` to `SparseTransitionMatrix`
- [x] 8.7 Add matrix export/import methods
