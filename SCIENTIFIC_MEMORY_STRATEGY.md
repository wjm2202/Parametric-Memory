# Scientific Strategy for MMPM AI Memory

## 1) Goal

Use MMPM as a long-term, testable memory substrate that:
- reinforces good assistant behavior,
- preserves relevant user/project metadata,
- improves retrieval quality over time,
- stays verifiable (proof-backed) and measurable.

This strategy is grounded in capabilities already present in this repository.

---

## 2) What to Store (Data Taxonomy)

Use strict schema atoms in canonical format:

- `v1.fact.<value>`
  - stable truths that should persist.
  - examples:
    - `v1.fact.user_name_glen_osborne`
    - `v1.fact.prefers_direct_concise_responses`
    - `v1.fact.primary_repo_markov_merkle_memory`

- `v1.state.<value>`
  - current work-in-progress context that changes frequently.
  - examples:
    - `v1.state.current_focus_mcp_semantic_gate`
    - `v1.state.blocker_none`
    - `v1.state.next_step_create_claude_policy`

- `v1.event.<value>`
  - timestamped milestones or outcomes.
  - examples:
    - `v1.event.2026_03_04_full_test_suite_passed_533`
    - `v1.event.2026_03_04_live_memory_cycle_validated`

- `v1.relation.<value>`
  - durable links between entities/tasks.
  - examples:
    - `v1.relation.mcp_tools_depend_on_server_endpoints`
    - `v1.relation.semantic_search_depends_on_atom_quality`

- `v1.other.<value>`
  - temporary scratch information; avoid for durable memory unless necessary.

### Metadata encoding pattern (scientifically useful)

For each learned item, encode observable metadata directly in atom value:

- source: `src_<human|test|log|api>`
- confidence: `conf_<high|medium|low>`
- scope: `scope_<session|sprint|project>`
- recency marker: `dt_YYYY_MM_DD`

Example:
- `v1.fact.prefers_minimal_ui_src_human_conf_high_scope_project_dt_2026_03_04`

This keeps storage schema-compatible while preserving analyzable metadata.

---

## 3) Reinforcement Model (Good Behavior Learning)

Model good behavior as repeatable sequences via `POST /train`.

### Behavior chain template

- Trigger event atom
- Desired reasoning/action state atom
- Desired outcome event atom

Example sequence:
1. `v1.event.user_requests_scientific_validation`
2. `v1.state.assistant_proposes_kpis_and_baseline`
3. `v1.event.assistant_runs_repeatable_harness`
4. `v1.event.results_compared_against_thresholds`

Train this sequence repeatedly when behavior is successful. Then validate confidence growth via `GET /weights/:atom`.

### Scientific reinforcement criterion

For each critical trigger atom, track:
- `dominantNext`
- `dominanceRatio`
- `totalWeight`

A behavior pattern is considered reinforced when:
- `dominanceRatio >= 0.70` for the desired next step, and
- this holds for at least 3 independent runs/days.

---

## 4) Retrieval Strategy for Useful Context

Use retrieval in this order:

1. `GET /memory/context?maxTokens=<budget>`
   - fast compact context block for prompt priming.

2. `GET /atoms?type=fact|state|relation&prefix=...&limit=...&offset=...`
   - focused structured fetch by type/scope.

3. `POST /search`
   - semantic/lexical MVP retrieval for relevance.

4. `GET /weights/:atom`
   - confidence-aware chain expansion from key trigger atoms.

### Context budget policy

- default working budget: 512 tokens.
- expanded planning/debug budget: 1200-2000 tokens.
- hard-stop at endpoint max (8000), but avoid large dumps unless explicitly needed.

---

## 5) Experimental Design (Scientifically Verifiable)

## 5.1 Hypotheses

H1: Structured atom taxonomy increases retrieval usefulness versus unstructured storage.

H2: Sequence reinforcement increases next-step prediction confidence (`dominanceRatio`) and practical usefulness.

H3: Context generated from typed atoms improves task success and reduces correction loops.

## 5.2 Controlled A/B setup

Run two conditions with matched tasks:

- Condition A (control): minimal/untyped atoms.
- Condition B (treatment): typed atoms + metadata + sequence reinforcement.

Keep constant:
- dataset size,
- operation profile,
- duration,
- target ops/sec,
- concurrency.

Use existing harness profiles in `tools/harness/continuous_client.ts`.

## 5.3 Primary KPIs

Use existing emitted stats/metrics:

- retrieval quality
  - `predictionUsefulRate`
  - `predictionAccuracy`
  - `accuracyProbe.accuracy`

- latency/performance
  - `mmpm_request_duration_ms` (p95)
  - harness access p95/p99
  - commit p95

- correctness/safety
  - proof verification failures (target 0)
  - stale reads / version mismatches

- memory growth hygiene
  - atoms queued vs committed
  - backpressure events
  - ratio of `state` atoms tombstoned per sprint

## 5.4 Acceptance thresholds (initial)

Start with conservative thresholds and tune later:

- `predictionUsefulRate >= 0.60`
- `predictionAccuracy >= 0.55`
- proof failures = 0
- no increasing trend in stale read mismatches across 3 runs
- access p95 regression <= 10% versus baseline snapshot

If thresholds are not met, do not expand memory capture scope; improve atom quality first.

---

## 6) Operational Setup Needed

## 6.1 Runtime

- keep API server running and readiness-gated (`/ready`).
- enable API key auth for non-probe routes.
- use explicit commit points (`POST /admin/commit`) after high-value writes.

## 6.2 Monitoring

- use built-in Prometheus endpoint `/metrics`.
- run live harness + Grafana flow:
  - `bash tools/harness/open-grafana-continuous.sh`
- capture run snapshots using existing harness reporting flows.

## 6.3 CI quality gates

Minimum gate before merging memory-related changes:
- semantic + MCP focused tests:
  - `src/__tests__/server.test.ts`
  - `src/__tests__/mcp_tools.test.ts`
  - `src/__tests__/mcp_stdio_integration.test.ts`
- periodic full suite run.

---

## 7) Data Hygiene Rules

- one concept per atom; avoid overloaded atoms.
- prefer facts/relations over free-form `other`.
- tombstone stale states when replaced.
- avoid storing secrets/credentials in atom values.
- require confidence tag for user-preference facts (`conf_high|medium|low`).

---

## 8) Weekly Scientific Review Loop

1. Export KPI snapshot from harness/metrics.
2. Compare with previous baseline.
3. Inspect top trigger atoms with `GET /weights/:atom`.
4. Identify weak/ambiguous chains (`dominanceRatio < 0.5`).
5. Refine atom naming and retrain successful behavior sequences.
6. Re-run same profile and record delta.

This produces a repeatable, evidence-based memory improvement cycle.

---

## 9) Minimal Starter Dataset (Recommended)

Seed at least:
- 15-30 `fact` atoms (user/project preferences and constraints)
- 10-20 `relation` atoms (architecture/task links)
- 10-20 `state` atoms (current sprint and active work)
- 20+ `event` atoms (dated milestones)

Then train 20-50 high-value behavior sequences and evaluate confidence/utility metrics.

### Seed pack files (added)

- Atoms seed pack (high quality):
  - `tools/harness/seed_pack_high_quality_atoms.v1.json`
- Reinforcement sequence seed pack:
  - `tools/harness/seed_pack_high_quality_sequences.v1.json`
- Apply both to a running server:
  - `bash tools/harness/apply-seed-pack.sh`

The seed pack is intentionally metadata-rich (`src_*`, `conf_*`, `scope_*`, `dt_*`) so retrieval, auditability, and evaluation analysis are stronger from day one.

---

## 9.1 Weekly Evaluation Automation

State file:
- `tools/harness/weekly_eval_state.json`

Run-once-if-due command:
- `bash tools/harness/weekly-memory-eval.sh`

Behavior:
- Reads `lastCompletedAt` from the state file.
- Skips if evaluation is newer than 7 days (unless `--force`).
- Runs concurrent benchmark profile and stores timestamped artifacts in `tools/harness/results/`.
- Updates state file with latest run metadata.

---

## 10) What Success Looks Like

After 1-2 weeks of disciplined operation:
- assistant loads concise context with minimal irrelevant spill,
- repeated successful workflows are suggested automatically,
- prediction usefulness and confidence trend upward,
- proofs and correctness counters remain clean,
- performance remains within agreed regression bounds.

---

## 10.1 Weekly Baseline Snapshot (2026-03-04)

Comparison:
- `tools/harness/results/weekly-2026-03-04T07-38-49Z.json`
- `tools/harness/results/weekly-2026-03-04T07-42-21Z.json`

| Metric | Previous | Latest | Delta | Delta % | Direction |
|---|---:|---:|---:|---:|---|
| ops/sec | 6133.20 | 6193.69 | +60.49 | +0.99% | Better |
| reads/sec | 4770.98 | 4818.36 | +47.38 | +0.99% | Better |
| access p50 (ms) | 0.0493 | 0.0463 | -0.0030 | -6.00% | Better |
| access p95 (ms) | 0.0922 | 0.0883 | -0.0040 | -4.29% | Better |
| access p99 (ms) | 0.1511 | 0.1404 | -0.0107 | -7.09% | Better |
| proof verify avg (ms) | 0.0303 | 0.0404 | +0.0101 | +33.37% | Worse |
| hit rate (%) | 70.00 | 70.00 | +0.00 | +0.00% | Flat |
| miss penalty (ms) | 0.0052 | 0.0000 | -0.0052 | -100.00% | Better |
| proof failures | 0 | 0 | 0 | n/a | Flat |
| stale reads | 0 | 0 | 0 | n/a | Flat |
| version mismatches | 0 | 0 | 0 | n/a | Flat |

Interpretation:
- Net performance and access latency improved while correctness remained clean.
- The single regression to investigate is proof verification average latency.
