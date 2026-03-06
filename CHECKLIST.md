# MMPM Sprint Checklist (Current)

Source of truth for detailed stories: `../MMPM_REFACTOR_PLAN.txt`.

## Completed Sprints

- [x] Sprint 1 — Snapshot + epoch foundation
- [x] Sprint 2 — WAL + streaming ingestion
- [x] Sprint 3 — Incremental Merkle + commit scheduling
- [x] Sprint 4 — Simplification + observability
- [x] Sprint 5 — Validation (stress + recovery)
- [x] Sprint 6 — Hardening (backpressure + warm reads + WAL compaction)
- [x] Sprint 7 — Harness & CI gating
- [x] Sprint 8 — CSR core
- [x] Sprint 9 — Batch access
- [x] Sprint 10 — Type policy
- [x] Sprint 11 — Observability + validation

## Sprint 7 — Harness & CI Gating

- [x] Structured data generator (`tools/harness/generator.ts`)
- [x] Continuous ingestion driver (`tools/harness/ingest_driver.ts`)
- [x] Recall benchmark engine (`tools/harness/recall_bench.ts`)
- [x] Benchmark report generator (`tools/harness/report.ts`)
- [x] CLI runner presets (`tools/harness/cli.ts`)
	- Implemented: `smoke`, `standard`, `stress`, `concurrent` + custom numeric overrides
- [x] Concurrent AI-agent simulator (`tools/harness/agent_sim.ts`)
- [x] Regression tracker / compare tool (`tools/harness/track.ts`)

## Sprint 12 — Hardening, Validation, and Citable Baseline

Full plan: `SPRINT_12_PLAN.md`

### Epic F — Proof Instrumentation
- [ ] F1. Split proof-verify latency by proof type (current / predicted / shardRoot) in `recall_bench.ts` + `report.ts`

### Epic G — Substrate Feature Validation
- [ ] G1. Bootstrap endpoint contract tests (≥12 test cases)
- [ ] G2. Namespace isolation correctness suite (≥8 scenarios, leakage rate = 0)
- [ ] G3. Temporal retrieval correctness (`asOfMs` / `asOfVersion` across all endpoints)
- [ ] G4. Contradiction surface-and-rank validation (≥6 conflict scenarios)
- [ ] G5. Write-policy tier end-to-end (≥6 tests, 2 per tier)

### Epic H — Citable Scientific Baseline
- [ ] H1. Clean commit + full 10-trial concurrent citable run (git_dirty = false, results archived)

### Epic I — Documentation and Memory Hygiene
- [ ] I1. Update CHECKLIST.md (this file) with Sprint 13 placeholder
- [ ] I2. Add 2026-03-06 session entry to `MMPM_REFACTOR_PLAN.txt`
- [ ] I3. Stale atom audit — tombstone resolved investigation flags

## Sprint 13 Candidates (not yet scoped)

- [ ] Diff / state-delta API (`GET /atoms/diff?fromVersion=N&toVersion=M`)
- [ ] Relation/graph traversal (ancestors, descendants, shortest path for `v1.relation.*`)
- [ ] Per-atom access control (atom- or namespace-level read/write policy)
- [ ] Python SDK (typed HTTP client matching MCP tool catalog)

## Operational Gates (Implemented)

- [x] Strict readiness endpoint (`GET /ready`) and startup guard
- [x] Docker healthcheck on readiness
- [x] PR CI workflow: fast readiness tests
- [x] PR CI workflow: health-gated API benchmark

## PR Merge Enforcement (Repo Settings)

- [ ] Set GitHub branch ruleset to require status checks:
	- `readiness-fast-tests`
	- `bench-ci-api`

## Sprint Completion Gate (Mandatory)

- [ ] Run full typecheck before declaring sprint complete:
	- `npm run sprint:complete`
