# Claude Operating Strategy for MMPM Memory

This file defines how Claude should use MMPM memory during real work.
All operations use **MCP tools** when running via Claude Desktop or Cowork.
Curl equivalents are noted for reference only.

---

## Core Operating Principle

Memory is the foundation of effective assistance. Claude must:

1. **Remember** everything that improves future task quality
2. **Learn** from corrections — never repeat a mistake the user already fixed
3. **Predict** what context is relevant before the user asks
4. **Prove** what it knows — every atom has a cryptographic audit trail

Memory capture is **automatic** — Claude must not require the user to
prompt it to save. Every session ends with a `session_checkpoint` call.

---

## 1) Session Start Protocol

Call these tools in order at the start of every session:

1. **Check server is ready — start it if not**
   - Tool: `memory_ready`
   - If the server is **not reachable** (tool fails or returns not ready):
     1. Run `./start.sh` from the project root directory in the background
     2. Wait 1 second, then check `memory_ready` (or `curl -s http://localhost:3000/ready`)
     3. Only proceed once `{"ready":true}` is returned
     4. If the server does not become ready within 5 seconds, report the
        failure to the user and stop

2. **Check weekly evaluation freshness**
   - Tool: `memory_weekly_eval_status`
   - If `due: true`, run: `memory_weekly_eval_run`

3. **Load session bootstrap** (facts + state + predictions in one call)
   - Tool: `memory_session_bootstrap`
   - Pass `objective` from the user's opening message if available
   - Use `maxTokens: 1200` to keep context tight

4. **Load focused active slices** (if bootstrap context is sparse)
   - Tool: `memory_atoms_list` with `type: "fact"`, `limit: 200`
   - Tool: `memory_atoms_list` with `type: "state"`, `limit: 200`

5. **Load procedures and corrections** (always)
   - Tool: `memory_atoms_list` with `type: "procedure"`, `limit: 200`
   - These contain learned workflows and human corrections — apply them
     before starting any work

6. **Produce a Current Sprint Status summary**
   - Tool: `memory_atoms_list` with `prefix: "v1.fact.sprint"`, `limit: 300`
   - Report: where we are, what is in progress / blocked, next 1–3 items

If memory is sparse or noisy, prefer `fact` + `relation` first, then `state`.

---

## 2) What Claude Must Store

### Store immediately — not at session end

When new durable information is learned, store it right away via
`session_checkpoint`. Do not accumulate and save only at session end.
If the session is cut short, unsaved knowledge is lost forever.

### Atom types and when to use them

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable project/user truths | `v1.fact.stack_is_TypeScript_Fastify_LevelDB` |
| `state` | Active work context, next steps | `v1.state.working_on_launch_prep` |
| `event` | Dated outcomes and milestones | `v1.event.all_725_tests_passing_dt_2026_03_08` |
| `relation` | Links between concepts | `v1.relation.shard_worker_uses_injectable_clock` |
| `procedure` | **Proven processes that work** | `v1.procedure.always_run_typecheck_before_marking_sprint_done` |

### What MUST be stored (non-negotiable)

1. **Architecture decisions** — why we chose X over Y, constraints that drove the choice
2. **Working processes** — step-by-step procedures that succeeded (build, test, deploy sequences)
3. **Bug root causes** — what went wrong and the actual fix, not just the symptom
4. **Human corrections** — any time the user says "don't do X" or "always do Y" (see §3)
5. **Configuration facts** — paths, ports, env vars, tool versions that took effort to discover
6. **Sprint/task state** — what's done, what's next, what's blocked
7. **Test counts and quality gates** — current pass count, known flaky tests, coverage gaps
8. **Integration details** — how systems connect, which APIs are used, auth patterns
9. **Naming conventions** — atom naming patterns that work well for search and recall

### Atom naming schema

Use: `v1.<type>.<value>` — snake_case, no spaces, no punctuation.

Include metadata suffixes when useful:
- source: `_src_human`, `_src_test`, `_src_log`
- confidence: `_conf_high`, `_conf_medium`, `_conf_low`
- scope: `_scope_session`, `_scope_sprint`, `_scope_project`
- date: `_dt_YYYY_MM_DD`

**Never store secrets, private keys, or credentials.**

---

## 3) Human Correction Learning (Reinforcement)

When the user corrects Claude's behaviour, this is the **highest-value
learning event** in the session. Handle it with three steps:

### Step 1: Store the correction as a durable rule

```
v1.procedure.never_guess_root_cause_always_diagnose_with_evidence
v1.procedure.always_run_full_tests_before_claiming_done
v1.procedure.do_not_dismiss_test_failures_as_pre_existing
```

Use `procedure` type with a clear, searchable name that describes
the rule. Include `_src_human` suffix if helpful.

### Step 2: Reinforce the corrected sequence

Train the wrong→correction→right arc so the Markov chain learns:

```
session_checkpoint({
  atoms: ["v1.procedure.never_guess_root_cause_always_diagnose_with_evidence"],
  train: [
    "v1.event.user_corrected_guessing_behaviour",
    "v1.procedure.never_guess_root_cause_always_diagnose_with_evidence",
    "v1.event.fix_found_by_systematic_diagnosis"
  ]
})
```

### Step 3: Apply in future sessions

At session start, procedures are loaded (Step 5 of §1). Before taking
any action, check if a stored procedure constrains that action.

**Examples of corrections that MUST be stored:**
- "Don't guess, diagnose the root cause" → `v1.procedure.diagnose_root_cause_not_guess`
- "Run the full tests, not just the ones you think are relevant" → `v1.procedure.always_run_full_test_suite`
- "You can't say these failures are pre-existing" → `v1.procedure.all_tests_must_pass_for_pr`
- "Stop apologising and fix it" → `v1.procedure.fix_errors_directly_minimize_apology`
- "Read the error message properly" → `v1.procedure.read_full_error_before_proposing_fix`

---

## 4) Process Memory (What Works)

When a multi-step workflow succeeds, store the process so it can be
repeated exactly in future sessions.

### What to capture as procedures

- Build and deploy sequences that work
- Debugging approaches that found the root cause
- Test strategies that caught real bugs
- Configuration sequences (e.g., "to set up MCP: do X, then Y, then Z")
- Workarounds for known tool/environment quirks

### Format

```
v1.procedure.debug_shard_worker_check_fake_timers_and_db_path_collisions
v1.procedure.fix_mcp_connection_verify_cwd_in_server_config_first
v1.procedure.restore_atoms_use_npm_run_restore_not_manual_curl
```

### Reinforce successful processes

```
session_checkpoint({
  atoms: ["v1.procedure.debug_shard_worker_check_fake_timers_and_db_path_collisions"],
  train: [
    "v1.event.shard_worker_tests_failing",
    "v1.procedure.debug_shard_worker_check_fake_timers_and_db_path_collisions",
    "v1.event.all_shard_worker_tests_passing"
  ]
})
```

---

## 5) Mid-Session Capture (automatic)

At each meaningful learning during the session — not just at the end:

- Tool: `session_checkpoint`
  - `atoms`: new facts, states, events, relations, procedures
  - `tombstone`: leave empty (tombstone only at session end)
  - `train`: include when a clear trigger→action→outcome arc just completed

**Triggers for mid-session save:**
- A bug root cause is identified
- A test suite passes after fixes
- A new architecture decision is made
- The user provides a correction or preference
- A configuration is discovered or changed
- A sprint item is completed

This ensures memory survives even if the session is cut short.

---

## 6) Session End Protocol

**Always** call `session_checkpoint` at session end. This is mandatory.

```
session_checkpoint({
  atoms: [
    "v1.event.completed_task_X_on_2026_03_07",
    "v1.state.next_task_is_Y",
    ...any new durable facts...
    ...any new procedures learned...
  ],
  tombstone: [
    "v1.state.old_completed_task_state",
    ...any states that are no longer true...
  ],
  train: [
    "v1.event.session_started",
    "v1.state.next_task_is_Y",
    "v1.event.completed_task_X_on_2026_03_07"
  ]
})
```

The tool automatically commits to disk — no separate commit call needed.

### End-of-session checklist

Before the final checkpoint, review:
1. Were any human corrections given? Store each as a `procedure`.
2. Were any new working processes discovered? Store each as a `procedure`.
3. Did any architecture decisions get made? Store each as a `fact`.
4. What is the current state of work? Update `state` atoms.
5. What states are no longer true? Add them to `tombstone`.

---

## 7) Reinforcement Rule (Behaviour Training)

After a successful workflow, train the arc explicitly:

- trigger event → action state → successful outcome event

Example:
```
v1.event.user_requests_bug_fix
v1.state.assistant_runs_targeted_tests_first
v1.event.fix_validated_by_focused_and_full_tests
```

- Tool: `session_checkpoint` with `train: [trigger, action, outcome]`

Then verify confidence:
- Tool: `memory_weights_get` on the trigger atom
- Target: `dominanceRatio >= 0.70`

### What to reinforce

- Debugging approaches that found real root causes
- Test strategies that caught real bugs
- Human corrections (always reinforce the corrected sequence)
- Deployment processes that succeeded
- Communication patterns the user responded well to

### What NOT to reinforce

- Lucky guesses
- Workarounds that masked the real problem
- Approaches the user later corrected

---

## 8) Retrieval Priority Heuristic

When answering users:
1. **Procedures first** — check if a stored procedure constrains the current action
2. **Facts and constraints** — retrieve explicit truths about the project
3. **Current state** — what's in progress, blocked, or next
4. **Relations** — links between the current task and architecture/history
5. **Events** — recent outcomes for chronology and recency
6. **Markov predictions** — use as hints, not absolute truth

Prefer high-confidence, recent, and task-scoped memory.

---

## 9) Scientific Verification Loop

At least weekly, validate memory quality using:
- Tool: `memory_weekly_eval_status`
- Tool: `memory_weekly_eval_run` (if due)

Track:
- `predictionUsefulRate`
- `predictionAccuracy`
- `accuracyProbe.accuracy`
- access latency p95
- proof failures (must remain zero)

If quality regresses:
1. tighten atom naming quality,
2. tombstone low-value noisy states,
3. retrain only successful behaviour sequences,
4. re-run the same profile and compare deltas.

---

## 10) Default Safety / Quality Constraints

- Do not invent atoms without clear evidence.
- Mark uncertain memory with lower confidence tags.
- Keep one concept per atom.
- Favour concise atom values that are easy to search and compare.
- Preserve reproducibility: if a claim is test-derived, include source metadata.
- Never choose `any`/unsafe casts as a convenience shortcut when a correct
  type-safe solution exists; prefer root-cause typing fixes.

### Sprint completion gate (mandatory)

When marking a sprint as completed, run full typechecking first:
- `npm run typecheck`

A sprint must not be reported as complete if this gate fails.

### Payment services (mandatory)

Claude must always ask for explicit confirmation before taking any action
involving payment services or stored payment methods. Even if a connector
is authenticated, each payment action requires fresh explicit approval.

---

## MCP Tool Quick Reference

| Intent | Tool |
|--------|------|
| Session start | `memory_session_bootstrap` |
| Load atoms by type | `memory_atoms_list` |
| Recall by association | `memory_access` |
| Save + commit (mid/end session) | `session_checkpoint` |
| Check server health | `memory_health` / `memory_ready` |
| Find stale atoms | `memory_atoms_stale` |
| Verify a proof | `memory_verify` |
| Check weekly eval | `memory_weekly_eval_status` |
| Run weekly eval | `memory_weekly_eval_run` |

### MCP permission tiers

The server exposes tools in three modes. The default `mcp:serve` covers all normal operations.

| Script | Read | Write (add/train/checkpoint/commit) | Dangerous (delete/import/policy) |
|--------|------|-------------------------------------|----------------------------------|
| `mcp:serve:readonly` | ✅ | ❌ | ❌ |
| `mcp:serve` *(default)* | ✅ | ✅ | ❌ |
| `mcp:serve:unsafe` | ✅ | ✅ | ✅ |

**Always tombstone via `session_checkpoint`'s `tombstone` field** — not by calling `memory_atoms_delete` directly. `memory_atoms_delete` is a dangerous-tier tool and is unavailable in the default mode.
