# Claude Operating Strategy for MMPM Memory

This file defines how Claude should use MMPM memory during real work.
All operations use **MCP tools** when running via Claude Desktop or Cowork.
Curl equivalents are noted for reference only.

---

## Core Operating Principle

Store only information that improves future task quality, then reinforce
successful behaviour patterns with measurable feedback.

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

5. **Produce a Current Sprint Status summary**
   - Tool: `memory_atoms_list` with `prefix: "v1.fact.sprint"`, `limit: 300`
   - Report: where we are, what is in progress / blocked, next 1–3 items

If memory is sparse or noisy, prefer `fact` + `relation` first, then `state`.

---

## 2) What Claude Must Store

When new durable information is learned, store it immediately — do not
accumulate and save only at session end. Use:

- `fact` — stable user/project truths
- `state` — active work context and near-term next steps
- `event` — dated outcomes and milestones
- `relation` — links between tasks, systems, and concepts
- `procedure` — repeatable multi-step processes

Use schema: `v1.<type>.<value>` — snake_case, no spaces, no punctuation.

Include metadata in value when useful:
- source: `_src_human`, `_src_test`, `_src_log`
- confidence: `_conf_high`, `_conf_medium`, `_conf_low`
- scope: `_scope_session`, `_scope_sprint`, `_scope_project`
- date: `_dt_YYYY_MM_DD`

Never store secrets, private keys, or credentials.

---

## 3) Mid-Session Capture (automatic)

At each meaningful learning during the session — not just at the end:

- Tool: `session_checkpoint`
  - `atoms`: new facts, states, events, relations
  - `tombstone`: leave empty (tombstone only at session end)
  - `train`: omit unless a clear trigger→action→outcome arc just completed

This ensures memory survives even if the session is cut short.

---

## 4) Reinforcement Rule (Good Behaviour)

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

---

## 5) Session End Protocol

**Always** call `session_checkpoint` at session end. This is mandatory.

```
session_checkpoint({
  atoms: [
    "v1.event.completed_task_X_on_2026_03_07",
    "v1.state.next_task_is_Y",
    ...any new durable facts...
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

If the user corrects Claude's behaviour during the session, treat that
correction as a durable workflow rule. Store it as a `fact` or `procedure`
atom and reinforce the corrected sequence.

---

## 6) Scientific Verification Loop

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

## 7) Retrieval Priority Heuristic

When answering users:
1. Retrieve explicit facts and constraints first.
2. Retrieve current state atoms for active work.
3. Retrieve relations linking current task to architecture/history.
4. Use events for recency and chronology.
5. Use Markov predictions as hints, not absolute truth.

Prefer high-confidence, recent, and task-scoped memory.

---

## 8) Default Safety / Quality Constraints

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
