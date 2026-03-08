---
name: mmpm-memory
description: |
  Use this skill whenever the user wants Claude to remember something across sessions, load previous context from memory, save what was learned in a conversation, recall past facts or project state, or interact with the MMPM (Markov-Merkle Predictive Memory) server. Trigger on phrases like "check my memory", "load your context", "what do you remember", "save this for next time", "remember that I...", "we discussed this last time", "save what we accomplished", "store this fact", or any time persistent memory across conversations is involved. Also trigger proactively at the start of a session if the user says "let's pick up where we left off" or similar. If the MMPM server is mentioned at all, always use this skill.
---

# Parametric-Memory (MMPM) — Claude Skill

**Gives Claude persistent, cryptographically verifiable memory across sessions, backed by your local MMPM server.**

---

## What this skill does

Connects Claude to your running Parametric-Memory (MMPM) server so it can:

- **Remember** facts, events, state, and relations across sessions — stored as typed atoms
- **Recall** context automatically at the start of every session
- **Learn** from corrections — never repeat a mistake the user already fixed
- **Prove** what it remembered — every atom has a Merkle audit path
- **Predict** what is most relevant next, via the Markov chain engine
- **Capture** memory automatically — no manual steps required

---

## Setup

### 1. Start your MMPM server

```bash
cd your-parametric-memory-repo
./start.sh
```

Server runs at `http://localhost:3000` by default.
DB is stored at `~/.mmpm/data` — outside the repo, safe from git operations.

> ⚠️ **Never run `docker compose down -v`** if you are using Docker.
> The `-v` flag destroys named volumes and **will permanently delete all memory.**
> Use `docker compose down` (without `-v`) to stop safely.
> If you do lose memory, restore from backup: `npm run restore -- --file memory/project-context.json`

### 2. Configure the API key

Copy `.env.example` to `.env` and set:

```
MMPM_API_KEY=<your-key>   # generate: openssl rand -hex 32
```

### 3. MCP environment variables

The MCP server gates tools behind environment variables. These must be set
in your MCP configuration for full functionality:

| Variable | Required | What it unlocks |
|----------|----------|-----------------|
| `MMPM_MCP_ENABLE_MUTATIONS=1` | **Yes** | `session_checkpoint`, `memory_session_bootstrap`, `memory_atoms_add`, `memory_train`, `memory_commit`, `memory_weekly_eval_run` — **without this, memory cannot be saved** |
| `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` | Recommended | `memory_search`, `memory_context` — semantic recall by meaning |
| `MMPM_MCP_ENABLE_DANGEROUS=1` | Only when needed | `memory_atoms_delete`, `memory_atoms_import`, `memory_policy_set`, `memory_write_policy_set` — destructive operations |
| `MMPM_MCP_BASE_URL` | No (default `http://127.0.0.1:3000`) | Override server address |
| `MMPM_MCP_API_KEY` | No (falls back to `MMPM_API_KEY`) | Override API key for MCP |

Server-side variables that affect behaviour:

| Variable | Effect |
|----------|--------|
| `MMPM_BLOCK_SECRET_ATOMS=1` | Rejects atoms that look like credentials (API keys, tokens, passwords) with HTTP 422 |

If `session_checkpoint` calls fail, the first thing to check is whether
`MMPM_MCP_ENABLE_MUTATIONS=1` is set.

### 4. Install this skill

Copy `integrations/claude-skill/` to your Claude skills directory, or drag
`integrations/parametric-memory.skill` into Cowork.

### 5. Verify

Ask Claude: *"Check my MMPM memory and tell me what you know."*
Claude will call `memory_session_bootstrap` and report back.

---

## Atom format

MMPM stores typed atoms as `v1.<type>.<value>` — snake_case, no spaces:

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable truths, preferences, project info | `v1.fact.stack_is_TypeScript_Fastify_LevelDB` |
| `state` | Current working context, next steps | `v1.state.working_on_sprint_18` |
| `event` | Completed milestones, dated outcomes | `v1.event.all_725_tests_passing_dt_2026_03_08` |
| `relation` | Links between concepts | `v1.relation.shard_worker_uses_injectable_clock` |
| `procedure` | **Proven processes and human corrections** | `v1.procedure.always_run_typecheck_before_marking_sprint_done` |
| `other` | Hub seeds and navigation roots | `v1.other.hub_session` |

Optional metadata suffixes:
- source: `_src_human`, `_src_test`, `_src_log`
- confidence: `_conf_high`, `_conf_medium`, `_conf_low`
- scope: `_scope_session`, `_scope_sprint`, `_scope_project`
- date: `_dt_YYYY_MM_DD`

### What MUST be stored (non-negotiable)

1. **Architecture decisions** — why we chose X over Y, constraints that drove the choice
2. **Working processes** — step-by-step procedures that succeeded (build, test, deploy sequences)
3. **Bug root causes** — what went wrong and the actual fix, not just the symptom
4. **Human corrections** — any time the user says "don't do X" or "always do Y" (see Human Correction Learning below)
5. **Configuration facts** — paths, ports, env vars, tool versions that took effort to discover
6. **Sprint/task state** — what's done, what's next, what's blocked
7. **Test counts and quality gates** — current pass count, known flaky tests, coverage gaps
8. **Integration details** — how systems connect, which APIs are used, auth patterns
9. **Naming conventions** — atom naming patterns that work well for search and recall
10. **Relations** — when storing a procedure triggered by an event, also store a `v1.relation.*` linking them. Relations are the edges that make Markov predictions powerful.

> ⚠️ **Never store secrets as atoms.** Passwords, API keys, tokens, and
> credentials must never be stored in MMPM. Atoms are semantic identifiers,
> not a secret manager. If `MMPM_BLOCK_SECRET_ATOMS=1` is set the server
> will reject them with HTTP 422.

---

## Session protocol (automatic)

Claude follows this automatically when MMPM is connected:

### Session start

1. **`memory_ready`** — confirm server is up. If not reachable, run `./start.sh` in background and retry within 5 seconds.
2. **`memory_weekly_eval_status`** — check if weekly eval is due; run `memory_weekly_eval_run` if so
3. **`memory_session_bootstrap`** — load facts, state, predictions in one call
   - Pass `objective` from the user's opening message if available
   - Use `maxTokens: 1200` to keep context tight
   - For **critical decisions** (production deploys, architecture choices), add `highImpact: true` and `evidenceThreshold: 0.75` to filter low-confidence atoms
   - Review `conflictingFacts` in the response — flag contradictions to the user before proceeding
4. **`memory_atoms_list`** with `type: "fact"` and `type: "state"` — load focused slices if bootstrap context is sparse
5. **`memory_atoms_list`** with `type: "procedure"` — **always load these**. They contain human corrections and proven processes. Apply them before starting any work.
6. **Summarise current sprint status** from `v1.fact.sprint.*` atoms — where we are, in progress/blocked, next 1–3 items

### Multi-project isolation

When working across multiple codebases, pass `namespace` to scope memory:

```
memory_session_bootstrap({
  objective: "...",
  namespace: { project: "mmpm-website" },
  includeGlobal: true   // still include global procedures/corrections
})
```

Set `includeGlobal: false` to fully isolate context per project.

### During session

- **`session_checkpoint`** — called at each meaningful learning, not just at end
  - `atoms`: new facts, states, events, relations, procedures
  - `tombstone`: leave empty mid-session (tombstone only at session end)
  - `train`: include when a clear trigger→action→outcome arc just completed
  - Automatically commits to disk

**Triggers for immediate save:**
- Bug root cause identified
- Test suite passes after fixes
- Architecture decision made
- User provides a correction or preference
- Configuration discovered or changed
- Sprint item completed

After each checkpoint, optionally verify:
- `memory_audit_log` with `limit: 5`, `event: "atom.add"` — confirm your atoms appear

### Session end

**`session_checkpoint`** — mandatory final call. Never skip this.

```
session_checkpoint({
  atoms: [
    "v1.event.completed_task_X_on_2026_03_08",
    "v1.state.next_task_is_Y",
    ...any new durable facts, procedures, relations...
  ],
  tombstone: [
    "v1.state.old_completed_task_state",
    ...any states that are no longer true...
  ],
  train: [
    "v1.event.session_started",
    "v1.state.next_task_is_Y",
    "v1.event.completed_task_X_on_2026_03_08"
  ]
})
```

### End-of-session checklist

1. Were any human corrections given? Store each as a `procedure`.
2. Were any new working processes discovered? Store each as a `procedure`.
3. Did any architecture decisions get made? Store each as a `fact`.
4. What is the current state of work? Update `state` atoms.
5. What states are no longer true? Add them to `tombstone`.
6. Were any relations between concepts discovered? Store each as a `relation`.

---

## Human correction learning

When the user corrects the assistant's behaviour, this is the **highest-value
learning event** in the session. Handle it with three steps:

### Step 1: Store the correction as a durable rule

```
v1.procedure.never_guess_root_cause_always_diagnose_with_evidence
v1.procedure.always_run_full_tests_before_claiming_done
v1.procedure.do_not_dismiss_test_failures_as_pre_existing
```

Use `procedure` type with a clear, searchable name. Include `_src_human` suffix if helpful.

### Step 2: Reinforce the corrected sequence

Train the wrong→correction→right arc so the Markov chain learns. Always store a `relation` atom linking the correction event to the procedure:

```
session_checkpoint({
  atoms: [
    "v1.procedure.never_guess_root_cause_always_diagnose_with_evidence",
    "v1.relation.guessing_behaviour_corrected_to_systematic_diagnosis"
  ],
  train: [
    "v1.event.user_corrected_guessing_behaviour",
    "v1.procedure.never_guess_root_cause_always_diagnose_with_evidence",
    "v1.event.fix_found_by_systematic_diagnosis"
  ]
})
```

### Step 3: Apply in future sessions

At session start, procedures are loaded (step 5). Before taking any action, check if a stored procedure constrains that action.

**Examples of corrections that MUST be stored:**
- "Don't guess, diagnose the root cause" → `v1.procedure.diagnose_root_cause_not_guess`
- "Run the full tests, not just the ones you think are relevant" → `v1.procedure.always_run_full_test_suite`
- "You can't say these failures are pre-existing" → `v1.procedure.all_tests_must_pass_for_pr`
- "Stop apologising and fix it" → `v1.procedure.fix_errors_directly_minimize_apology`
- "Read the error message properly" → `v1.procedure.read_full_error_before_proposing_fix`

---

## Reinforcement (Markov training)

After a successful workflow, train the arc explicitly:

```
session_checkpoint({
  train: [trigger_event, action_procedure, outcome_event]
})
```

Then verify confidence:
- `memory_weights_get` on the trigger atom
- Target: `dominanceRatio >= 0.70`

**What to reinforce:** debugging approaches that found root causes, test strategies that caught real bugs, human corrections, deployment processes that succeeded, communication patterns the user responded well to.

**What NOT to reinforce:** lucky guesses, workarounds that masked the real problem, approaches the user later corrected.

---

## Retrieval priority

When answering users, retrieve in this order:
1. **Procedures first** — check if a stored rule constrains the current action
2. **Facts and constraints** — explicit truths about the project
3. **Current state** — what's in progress, blocked, or next
4. **Relations** — links between current task and architecture/history
5. **Semantic search** — use `memory_search` when exact atom names don't match
6. **Events** — recent outcomes for chronology
7. **Markov predictions** — hints, not absolute truth

### When to use which recall tool

| Situation | Tool |
|-----------|------|
| Know the exact atom name | `memory_access` (returns proof + prediction) |
| Need multiple atoms at once | `memory_batch_access` (efficient batch read) |
| Know roughly what you need but not the name | `memory_search` (semantic, requires `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`) |
| Need a token-budgeted context block | `memory_context` (semantic, requires `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`) |
| Need to browse by type or prefix | `memory_atoms_list` with `type` or `prefix` filter |
| Need to inspect one atom with its proof | `memory_atom_get` |

---

## Evidence-based retrieval (high-impact decisions)

When making decisions that affect production, deployments, architecture, or
other high-stakes outcomes, use evidence gating:

```
memory_session_bootstrap({
  objective: "Should we ship to production?",
  highImpact: true,
  evidenceThreshold: 0.75
})
```

The response includes:
- `evidenceGate.excluded` — atoms filtered out due to low evidence
- `evidenceGate.fallbackReason` — why atoms were excluded
- `decisionEvidence.retrievalRationale` — per-atom evidence scores

**Use for:** production deploys, architecture choices, marking sprints complete, system reliability questions.
**Don't use for:** routine session start, exploratory debugging, loading procedures.

---

## Time-travel queries

MMPM supports querying memory as it existed at a specific point in time:

```
// By timestamp
memory_atom_get({ atom: "v1.fact.some_decision", asOfMs: 1772000000000 })

// By version
memory_atom_get({ atom: "v1.fact.some_decision", asOfVersion: 42 })

// Compare then vs now
memory_session_bootstrap({ asOfMs: threeDaysAgo })  // what we knew then
memory_session_bootstrap({})                         // what we know now
```

**Use for:** debugging past decisions, understanding why a procedure was created, auditing AI recommendations, verifying memory integrity.

---

## Memory hygiene

### Find and clean stale atoms
- `memory_atoms_stale` with `maxAgeDays: 14`
- Tombstone atoms that are no longer relevant, especially `state` atoms for completed work

### Audit recent mutations
- `memory_audit_log` with `limit: 50`
- Verify recent mutations look correct
- Look for unexpected tombstones or imports

### Verify proof integrity
- `memory_atom_get` on a few critical facts
- `memory_verify` with the returned proof
- Proof failures must remain zero

### Weekly scientific evaluation
- `memory_weekly_eval_status` — check if due
- `memory_weekly_eval_run` — run if due
- Track: `predictionUsefulRate`, `predictionAccuracy`, `accuracyProbe.accuracy`, access latency p95, proof failures

---

## Ephemeral atoms with TTL

Use `memory_atoms_add` with `ttlMs` for auto-expiring temporary atoms:

```
memory_atoms_add({
  atoms: ["v1.state.currently_debugging_shard_worker_timeout"],
  ttlMs: 3600000   // expires in 1 hour
})
```

**Use TTL for:** debugging state, temporary hypotheses, session-scoped context.
**Do NOT use TTL for:** human corrections (always permanent), architecture decisions (always permanent), sprint state (use tombstone when complete instead).

---

## Security awareness

The server includes security features from Sprint 16 hardening:

- **Injection detection**: Atoms with suspicious patterns (e.g., `ignore_previous_instructions`, `system_prompt_override`) are flagged and may return HTTP 202 with a `ReviewRequired` status. The atom then needs explicit approval via the HTTP API's `reviewApproved: true` parameter (not available via MCP).

- **Secret blocking**: When `MMPM_BLOCK_SECRET_ATOMS=1` is set, atoms that look like credentials are rejected with HTTP 422.

- **Audit trail**: Use `memory_audit_log` to review recent mutations, especially after imports or bulk operations.

---

## MCP tool reference

All tools are exposed via the MCP server (`npm run mcp:serve`).

### Read-only tools (16 — always available)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_ready` | Check server readiness | — |
| `memory_health` | Detailed cluster health | — |
| `memory_access` | Markov recall for one atom with proof | `atom`, `warmRead` |
| `memory_batch_access` | Batch recall for multiple atoms | `atoms[]` |
| `memory_atoms_list` | Browse atoms by type/prefix | `type`, `prefix`, `limit`, `offset` |
| `memory_atom_get` | Inspect one atom + Merkle proof | `atom`, `asOfMs`, `asOfVersion` |
| `memory_weights_get` | Markov transition weights | `atom` |
| `memory_atoms_stale` | Find atoms not accessed in N days | `maxAgeDays` (default 30), `type` |
| `memory_pending` | View ingestion queue | — |
| `memory_verify` | Verify a Merkle proof (no auth needed) | `atom`, `proof` |
| `memory_audit_log` | Query mutation history | `limit`, `since`, `event` |
| `memory_atoms_export` | Export all atoms as NDJSON | `status`, `type` |
| `memory_policy_get` | Read transition policy | — |
| `memory_write_policy_get` | Read write-policy tiers | — |
| `memory_metrics` | Prometheus metrics | — |
| `memory_weekly_eval_status` | Weekly eval due status | — |

### Semantic tools (2 — require `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_search` | Find atoms by meaning (semantic search) | `query`, `limit`, `threshold`, `namespace`, `asOfMs`, `asOfVersion` |
| `memory_context` | Token-budgeted context block | `maxTokens`, `namespace`, `asOfMs`, `asOfVersion` |

### Mutation tools (6 — require `MMPM_MCP_ENABLE_MUTATIONS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_session_bootstrap` | Session start — loads context + predictions | `objective`, `maxTokens`, `limit`, `highImpact`, `evidenceThreshold`, `namespace`, `asOfMs`, `asOfVersion` |
| `session_checkpoint` | **Primary save tool** — atoms + tombstone + train + commit | `atoms[]`, `tombstone[]`, `train[]` |
| `memory_atoms_add` | Low-level: queue atoms for ingestion | `atoms[]`, `ttlMs` |
| `memory_train` | Low-level: train a Markov sequence | `sequence[]` |
| `memory_commit` | Low-level: flush pending to disk | — |
| `memory_weekly_eval_run` | Run weekly scientific evaluation | `force` |

### Dangerous tools (4 — require `MMPM_MCP_ENABLE_DANGEROUS=1` + mutations)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_atoms_delete` | Tombstone one atom | `atom` |
| `memory_atoms_import` | Import NDJSON snapshot | `ndjson` |
| `memory_policy_set` | Update transition policy | `policy` |
| `memory_write_policy_set` | Update write-policy tiers | `policy` |

### MCP permission tiers

| Configuration | Read (16) | Semantic (2) | Mutation (6) | Dangerous (4) |
|---------------|-----------|--------------|--------------|----------------|
| Default (no env vars) | ✅ | ❌ | ❌ | ❌ |
| `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` | ✅ | ✅ | ❌ | ❌ |
| `MMPM_MCP_ENABLE_MUTATIONS=1` | ✅ | ❌ | ✅ | ❌ |
| Both mutations + dangerous | ✅ | ❌/✅ | ✅ | ✅ |

**Always tombstone via `session_checkpoint`'s `tombstone` field** — not `memory_atoms_delete`. The delete tool is dangerous-tier and unavailable in default mode.

### HTTP-only parameters (not available via MCP)

| Endpoint | Parameter | Purpose |
|----------|-----------|---------|
| `POST /atoms` | `reviewApproved: true` | Bypass injection review gate |

To use this, call the HTTP API directly via curl.

---

## Quality constraints

- Do not invent atoms without clear evidence.
- Mark uncertain memory with `_conf_low` suffix.
- Keep one concept per atom — concise, searchable values.
- Never choose `any`/unsafe casts as convenience shortcuts; prefer root-cause typing fixes.
- A sprint must not be reported as complete unless `npm run typecheck` passes.

---

## Backup and restore

Memory lives at `~/.mmpm/data` on your host, shared by Docker, `./start.sh`, and MCP.

```bash
# Back up all atoms to ~/.mmpm/backups/
npm run backup

# Restore from a backup file
npm run restore -- --file ~/.mmpm/backups/mmpm-backup-2026-03-07.json

# Restore project context after data loss
npm run restore -- --file memory/project-context.json

# Preview what would be restored (no changes)
npm run restore -- --file memory/project-context.json --dry-run
```

> ⚠️ **Destructive Docker warning:**
> `docker compose down -v` deletes all Docker volumes including memory data.
> Always use `docker compose down` (no `-v`) to stop the stack safely.

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- Claude Desktop config: `integrations/claude-desktop/`
- VSCode integration: `integrations/vscode/`
- Full operating guide: `CLAUDE.md` in the project root
