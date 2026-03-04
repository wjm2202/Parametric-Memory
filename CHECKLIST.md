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

## Next Backlog Item

- [ ] Backlog grooming: no unchecked story IDs currently listed in `MMPM_REFACTOR_PLAN.txt`

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
