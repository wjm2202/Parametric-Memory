# Claude Operating Strategy for MMPM Memory

This file defines how Claude should use MMPM memory during real work.

## Core Operating Principle

Store only information that improves future task quality, then reinforce successful behavior patterns with measurable feedback.

---

## 1) Session Start Protocol

1. Check readiness:
   - `GET /ready`
2. Check weekly evaluation freshness:
   - Read `tools/harness/weekly_eval_state.json`.
   - If `lastCompletedAt` is older than 7 days, run:
     - `bash tools/harness/weekly-memory-eval.sh`
   - If it is newer than 7 days, skip weekly eval for this session.
3. Ensure high-quality seed baseline exists (first run / empty memory):
   - `bash tools/harness/apply-seed-pack.sh`
   - Skip if seed already applied and memory is non-empty.
4. Load compact memory context:
   - `GET /memory/context?maxTokens=1200`
5. Load focused active memory slices:
   - `GET /atoms?type=fact&limit=200`
   - `GET /atoms?type=state&limit=200`
   - `GET /atoms?type=relation&limit=200`
6. Optionally run targeted search for current goal:
   - `POST /search` with query from user objective.
7. Always produce a short **Current Sprint Status** summary at session start:
    - Retrieve sprint memory mirror:
       - `GET /atoms?type=fact&prefix=v1.fact.sprint.item_&limit=300`
       - `GET /atoms?type=relation&prefix=v1.relation.sprint.&limit=300`
    - Cross-check against source plan file:
       - `MMPM_REFACTOR_PLAN.txt`
    - Report exactly:
       - where we are up to now,
       - what is in progress / blocked (if any),
       - next 1-3 logical items.

If memory is sparse/noisy, prefer `fact` + `relation` first, then `state`.

---

## 2) What Claude Must Store

When new durable information is learned, store typed atoms:

- Facts: stable user/project truths.
- States: active work context and near-term next steps.
- Events: dated outcomes and milestones.
- Relations: links between tasks, systems, and concepts.

Use schema: `v1.<type>.<value>`.

Include metadata in value when useful:
- source (`src_human|test|log|api`)
- confidence (`conf_high|medium|low`)
- scope (`scope_session|sprint|project`)
- date marker (`dt_YYYY_MM_DD`)

Never store secrets, private keys, or credentials.

---

## 3) Reinforcement Rule (Good Behavior)

After a successful workflow, Claude should train the sequence explicitly:

- trigger event -> reasoning/action state -> successful outcome event

Example pattern:
- `v1.event.user_requests_bug_fix`
- `v1.state.assistant_runs_targeted_tests_first`
- `v1.event.fix_validated_by_focused_and_full_tests`

Write sequence via `POST /train`.

Then verify confidence with `GET /weights/:atom` on the trigger atom.

Target reinforcement:
- desired `dominantNext`
- `dominanceRatio >= 0.70` sustained across repeated runs.

---

## 4) During Session Behavior

- On each meaningful new learning, `POST /atoms` in small batches.
- For high-value updates, call `POST /admin/commit` promptly.
- Use `POST /search` for relevance retrieval before major decisions.
- Use `/weights/:atom` when deciding whether a learned chain is reliable.
- If the user stops and corrects behavior, treat that correction as a durable workflow rule (not one-off).
- Persist that correction as a typed memory atom (fact/state/relation as appropriate), commit it, and reinforce the corrected sequence after successful execution.

If context window pressure appears, reduce retrieval to:
- highest-confidence facts,
- active states for current objective,
- 3-5 top related relations/events.

---

## 5) Session End Protocol

1. Persist key new facts/states/events/relations.
2. Tombstone obsolete states (`DELETE /atoms/:atom`).
3. Train one summary behavior sequence for the session.
4. Commit changes (`POST /admin/commit`).
5. Optionally verify one key chain confidence (`GET /weights/:atom`).

---

## 6) Scientific Verification Loop

At least weekly, validate memory quality with harness + metrics.

Track:
- `predictionUsefulRate`
- `predictionAccuracy`
- `accuracyProbe.accuracy`
- access latency p95
- proof failures (must remain zero)

If quality regresses:
1. tighten atom naming quality,
2. remove/tombstone low-value noisy states,
3. retrain only successful behavior sequences,
4. re-run the same profile and compare deltas.

### Weekly auto-cadence rule (mandatory)

- Claude must check `tools/harness/weekly_eval_state.json` at session start.
- If `lastCompletedAt` is >= 7 days old, Claude must run `bash tools/harness/weekly-memory-eval.sh` before major planning.
- The script updates `tools/harness/weekly_eval_state.json` with:
   - `lastCompletedAt`
   - `lastReportFile`
   - `lastPromFile`
   - `lastRunId`
   - `lastProfile`
- If the script fails, Claude must surface the failure and avoid claiming weekly validation is current.

---

## 7) Retrieval Priority Heuristic

When answering users:
1. Retrieve explicit facts and constraints first.
2. Retrieve current state atoms for active work.
3. Retrieve relations linking current task to architecture/history.
4. Use events for recency and chronology.
5. Use Markov predictions as hints, not absolute truth.

Prefer high-confidence, recent, and task-scoped memory.

---

## 8) Default Safety/Quality Constraints

- Do not invent atoms without clear evidence.
- Mark uncertain memory with lower confidence tags.
- Keep one concept per atom.
- Favor concise atom values that are easy to search and compare.
- Preserve reproducibility: if a claim is test-derived, include source metadata.
- Never choose `any`/unsafe casts as a convenience shortcut when a correct type-safe solution exists; prefer root-cause typing fixes.

### Sprint completion gate (mandatory)

- When marking a sprint as completed, Claude must run full repository typechecking first:
   - `npm run sprint:complete` (alias for `npm run typecheck:all`).
- A sprint must not be reported as complete if this gate fails.

This policy is mandatory for consistent, measurable memory behavior.
