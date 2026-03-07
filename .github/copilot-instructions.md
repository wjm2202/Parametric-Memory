# MMPM Copilot Instructions (Workspace-wide)

These instructions are always-on for this repository.

## Required operating mode

- Treat MMPM memory as the primary knowledge base for all planning and execution.
- Before major planning or code changes, load memory context and check for stored procedures.
- Persist durable new learnings as typed atoms using schema `v1.<type>.<value>`.
- Never store secrets, private keys, tokens, or credentials in memory atoms.

## Session-start protocol (mandatory)

1. Use MCP tool `memory_ready`. If not ready, run `./start.sh` in background and retry.
2. Use `memory_weekly_eval_status`. If due, run `memory_weekly_eval_run`.
3. Use `memory_session_bootstrap` to load context + predictions.
4. Use `memory_atoms_list` for `fact`, `state`, and `relation` if context is sparse.
5. **Load procedures:** `memory_atoms_list` with `type: "procedure"` — these contain
   proven processes and human corrections. Apply them before starting work.
6. Produce a short **Current Sprint Status** summary:
   - where we are now,
   - what is in progress or blocked,
   - next 1-3 logical items.

## What to store in memory

### Always store (non-negotiable)

- **Architecture decisions** — why X over Y, constraints that drove the choice
- **Working processes** — step-by-step procedures that succeeded
- **Bug root causes** — what went wrong and the actual fix
- **Human corrections** — any time the user says "don't do X" or "always do Y"
- **Configuration facts** — paths, ports, env vars, versions that took effort to discover
- **Sprint/task state** — what's done, next, blocked
- **Test quality** — current pass count, known issues, coverage gaps
- **Integration details** — how systems connect, API patterns, auth flows

### Atom types

| Type | Use for |
|------|---------|
| `fact` | Stable project/user truths |
| `state` | Active work context, next steps |
| `event` | Dated outcomes and milestones |
| `relation` | Links between concepts or systems |
| `procedure` | **Proven processes and human corrections** |

## Human correction learning (critical)

When the user corrects the assistant's approach:

1. **Store immediately** as a `procedure` atom:
   `v1.procedure.always_diagnose_root_cause_not_guess_src_human`

2. **Reinforce** the corrected sequence via `session_checkpoint` with `train`:
   `[wrong_approach_event, correction_procedure, correct_outcome_event]`

3. **Apply in future:** At session start, load all procedures and check them
   before taking actions they constrain.

Examples of corrections that must be stored:
- "Don't guess, diagnose" → `v1.procedure.diagnose_root_cause_not_guess`
- "Run ALL tests" → `v1.procedure.always_run_full_test_suite`
- "Don't say failures are pre-existing" → `v1.procedure.all_tests_must_pass_for_pr`
- "Read the error properly" → `v1.procedure.read_full_error_before_proposing_fix`

## Process memory (what works)

When a multi-step workflow succeeds, store it as a `procedure`:
```
v1.procedure.debug_shard_worker_check_fake_timers_and_db_path_collisions
v1.procedure.fix_mcp_connection_verify_cwd_in_server_config_first
```

Reinforce via `session_checkpoint` with `train: [trigger, procedure, outcome]`.

## During-session behavior

- Use `memory_search` and/or `memory_access` before major decisions.
- **Check stored procedures** before taking any action they might constrain.
- Store high-value learnings via `session_checkpoint` immediately — do not
  accumulate until session end.
- When a useful action chain succeeds, reinforce with `train`.
- Save mid-session to protect against context loss.

**Triggers for immediate save:**
- Bug root cause identified
- Test suite passes after fixes
- Architecture decision made
- User provides a correction
- Configuration discovered or changed
- Sprint item completed

## Session-end protocol (mandatory)

1. Review: were any human corrections given? Store each as a `procedure`.
2. Review: were any new working processes discovered? Store each as a `procedure`.
3. Update `state` atoms for current work status.
4. Tombstone obsolete states via `session_checkpoint`'s `tombstone` field.
5. Train the session's most successful sequence.
6. Call `session_checkpoint` — this is non-negotiable.

**Do not** call `memory_atoms_delete` directly — it is a dangerous-tier tool
requiring `mcp:serve:unsafe`. Use the `tombstone` field instead.

## Retrieval priority

When answering users, retrieve in this order:
1. **Procedures** — check if a stored rule constrains the current action
2. **Facts and constraints** — explicit truths about the project
3. **Current state** — what's in progress, blocked, or next
4. **Relations** — links between current task and architecture/history
5. **Events** — recent outcomes for chronology
6. **Markov predictions** — hints, not absolute truth

## MCP permission tiers

| Script | Read | Write (add/train/checkpoint/commit) | Dangerous (delete/import/policy) |
|--------|------|-------------------------------------|----------------------------------|
| `mcp:serve:readonly` | ✅ | ❌ | ❌ |
| `mcp:serve` *(default)* | ✅ | ✅ | ❌ |
| `mcp:serve:unsafe` | ✅ | ✅ | ✅ |

## Quality constraints

- Do not invent atoms without clear evidence.
- Mark uncertain information with `_conf_low` suffix.
- Keep one concept per atom — concise, searchable values.
- If memory tools are unavailable, state this clearly and continue with local context.
- Never use `any`/unsafe casts as convenience shortcuts; prefer root-cause typing fixes.
- A sprint must not be reported as complete unless `npm run typecheck` passes.
