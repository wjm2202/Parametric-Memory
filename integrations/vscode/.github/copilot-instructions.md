# Copilot Instructions — Parametric Memory (MMPM)

This workspace is connected to a local MMPM memory server. You must use it.

## MCP Environment Setup

The MCP server gates tools behind environment variables:

| Variable | Required | What it unlocks |
|----------|----------|-----------------|
| `MMPM_MCP_ENABLE_MUTATIONS=1` | **Yes** | `session_checkpoint`, `memory_session_bootstrap`, `memory_atoms_add`, `memory_train`, `memory_commit`, `memory_weekly_eval_run` — **without this, memory cannot be saved** |
| `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` | Recommended | `memory_search`, `memory_context` — semantic recall by meaning |
| `MMPM_MCP_ENABLE_DANGEROUS=1` | Only when needed | `memory_atoms_delete`, `memory_atoms_import`, `memory_policy_set`, `memory_write_policy_set` — destructive operations |

If `session_checkpoint` calls fail, check whether `MMPM_MCP_ENABLE_MUTATIONS=1` is set.

## Every session — mandatory

At the start of every session, load memory before doing anything else.

**Preferred — MCP tools (parametric-memory server must be connected):**
1. `memory_ready` — confirm server is up
2. `memory_weekly_eval_status` — if `due: true`, run `memory_weekly_eval_run`
3. `memory_session_bootstrap` — loads context, state, and Markov predictions in one call
   - Pass `objective` from the user's opening message
   - Use `maxTokens: 1200` to keep context tight
   - For critical decisions, add `highImpact: true` and `evidenceThreshold: 0.75`
   - Review `conflictingFacts` in the response — flag contradictions to the user
4. `memory_atoms_list` with `type: "fact"` and `type: "state"` if bootstrap context is sparse
5. `memory_atoms_list` with `type: "procedure"` — these contain human corrections and proven processes. Apply them before starting work.
6. Produce a **Current Sprint Status** summary

**Fallback — if MCP is not connected:**
```bash
curl -s -X POST \
  -H "Authorization: Bearer ${MMPM_API_KEY}" \
  -H "Content-Type: application/json" \
  http://localhost:3000/memory/bootstrap \
  -d '{}'
```

### Multi-project isolation

When working across multiple codebases, pass `namespace` to scope memory:
```
memory_session_bootstrap({
  objective: "...",
  namespace: { project: "mmpm-website" },
  includeGlobal: true
})
```

## During the session

Save at each meaningful learning — do not wait until the end.

**MCP:** `session_checkpoint` with `atoms` containing new facts, state, events, relations, or procedures.
**Fallback:** `POST /atoms` then `POST /admin/commit`.

**Triggers for immediate save:**
- Bug root cause identified
- Test suite passes after fixes
- Architecture decision made
- User provides a correction
- Configuration discovered or changed
- Sprint item completed

### Human correction learning

When the user corrects the assistant's approach, this is the **highest-value learning event**:
1. Store the correction as a `procedure` atom with `_src_human` suffix
2. Store a `relation` atom linking the correction event to the procedure
3. Reinforce with `train`: `[wrong_event, correction_procedure, correct_outcome_event]`
4. In future sessions, load procedures first and check them before taking actions they constrain

## End of session — mandatory

Always call `session_checkpoint` before closing. Never skip this.

```
session_checkpoint({
  atoms:     ["v1.event.completed_X_DATE", "v1.state.next_task_is_Y", ...new procedures...],
  tombstone: ["v1.state.old_completed_state"],
  train:     ["v1.event.session_started", "v1.state.next_task_is_Y", "v1.event.completed_X_DATE"]
})
```

### End-of-session checklist

1. Were any human corrections given? Store each as a `procedure`.
2. Were any new working processes discovered? Store each as a `procedure`.
3. Did any architecture decisions get made? Store each as a `fact`.
4. What is the current state of work? Update `state` atoms.
5. What states are no longer true? Add them to `tombstone`.
6. Were any relations between concepts discovered? Store each as a `relation`.

## Atom format

`v1.<type>.<value>` — snake_case, no spaces.

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable truths, preferences, project info | `v1.fact.stack_is_TypeScript_Fastify_LevelDB` |
| `state` | Current working context, next steps | `v1.state.working_on_launch_prep` |
| `event` | Completed milestones with date | `v1.event.all_725_tests_passing_dt_2026_03_08` |
| `relation` | Links between systems or concepts | `v1.relation.shard_worker_uses_injectable_clock` |
| `procedure` | Repeatable multi-step processes and human corrections | `v1.procedure.always_run_typecheck_before_marking_sprint_done` |

Include metadata suffixes when useful:
- source: `_src_human`, `_src_test`, `_src_log`
- confidence: `_conf_high`, `_conf_medium`, `_conf_low`
- date: `_dt_YYYY_MM_DD`

> **Never store secrets as atoms.** The server enforces this with
> `MMPM_BLOCK_SECRET_ATOMS=1` — atoms that look like credentials are
> rejected with HTTP 422.

## MCP Tool Quick Reference

### Read-only tools (always available)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_ready` | Check server readiness | — |
| `memory_health` | Detailed cluster health | — |
| `memory_access` | Markov recall for one atom with proof | `atom`, `warmRead` |
| `memory_batch_access` | Batch recall for multiple atoms | `atoms[]` |
| `memory_atoms_list` | Browse atoms by type/prefix | `type`, `prefix`, `limit`, `offset` |
| `memory_atom_get` | Inspect one atom + Merkle proof | `atom`, `asOfMs`, `asOfVersion` |
| `memory_weights_get` | Markov transition weights | `atom` |
| `memory_atoms_stale` | Find atoms not accessed in N days | `maxAgeDays`, `type` |
| `memory_pending` | View ingestion queue | — |
| `memory_verify` | Verify a Merkle proof | `atom`, `proof` |
| `memory_audit_log` | Query mutation history | `limit`, `since`, `event` |
| `memory_atoms_export` | Export all atoms as NDJSON | `status`, `type` |
| `memory_policy_get` | Read transition policy | — |
| `memory_write_policy_get` | Read write-policy tiers | — |
| `memory_metrics` | Prometheus metrics | — |
| `memory_weekly_eval_status` | Weekly eval due status | — |

### Semantic tools (require `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_search` | Find atoms by meaning | `query`, `limit`, `threshold`, `namespace` |
| `memory_context` | Token-budgeted context block | `maxTokens`, `namespace` |

### Mutation tools (require `MMPM_MCP_ENABLE_MUTATIONS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_session_bootstrap` | Session start — loads context + predictions | `objective`, `maxTokens`, `highImpact`, `evidenceThreshold`, `namespace` |
| `session_checkpoint` | **Primary save tool** — atoms + tombstone + train + commit | `atoms[]`, `tombstone[]`, `train[]` |
| `memory_atoms_add` | Low-level: queue atoms for ingestion | `atoms[]`, `ttlMs` |
| `memory_train` | Low-level: train a Markov sequence | `sequence[]` |
| `memory_commit` | Low-level: flush pending to disk | — |
| `memory_weekly_eval_run` | Run weekly scientific evaluation | `force` |

### Dangerous tools (require `MMPM_MCP_ENABLE_DANGEROUS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_atoms_delete` | Tombstone one atom | `atom` |
| `memory_atoms_import` | Import NDJSON snapshot | `ndjson` |
| `memory_policy_set` | Update transition policy | `policy` |
| `memory_write_policy_set` | Update write-policy tiers | `policy` |

### Ephemeral atoms with TTL

Use `memory_atoms_add` with `ttlMs` for auto-expiring temporary atoms:
```
memory_atoms_add({
  atoms: ["v1.state.currently_debugging_timeout"],
  ttlMs: 3600000   // expires in 1 hour
})
```

Use TTL for: debugging state, temporary hypotheses, session-scoped context.
Do NOT use TTL for: human corrections, architecture decisions, sprint state.

Full documentation: see `CLAUDE.md` in the project root.
