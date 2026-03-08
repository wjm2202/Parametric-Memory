# MMPM Copilot Instructions (Workspace-wide)

These instructions are always-on for this repository.
All operations use **MCP tools** when running via Copilot Chat.
Curl equivalents are noted for reference only.

---

## 0) MCP Environment Setup

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

---

## Required Operating Mode

- Treat MMPM memory as the primary knowledge base for all planning and execution.
- Before major planning or code changes, load memory context and check for stored procedures.
- Persist durable new learnings as typed atoms using schema `v1.<type>.<value>`.
- Never store secrets, private keys, tokens, or credentials in memory atoms.

Memory capture is **automatic** — do not require the user to prompt you to
save. Every session ends with a `session_checkpoint` call.

---

## 1) Session Start Protocol (mandatory)

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
   - For **critical decisions** (production deploys, architecture choices),
     add `highImpact: true` and `evidenceThreshold: 0.75` to filter out
     low-confidence atoms (see §11)
   - Review the `conflictingFacts` field in the response — if present,
     flag contradictions to the user before proceeding

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

---

## 2) What to Store in Memory

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
10. **Relations** — when storing a procedure triggered by an event, also store
    a `v1.relation.*` linking them. Relations are what make Markov predictions
    powerful — they are the edges between concepts.

### Atom naming schema

Use: `v1.<type>.<value>` — snake_case, no spaces, no punctuation.

Include metadata suffixes when useful:
- source: `_src_human`, `_src_test`, `_src_log`
- confidence: `_conf_high`, `_conf_medium`, `_conf_low`
- scope: `_scope_session`, `_scope_sprint`, `_scope_project`
- date: `_dt_YYYY_MM_DD`

**Never store secrets, private keys, or credentials.** The server can
enforce this with `MMPM_BLOCK_SECRET_ATOMS=1` — atoms that look like
credentials (API keys, tokens, passwords) will be rejected with HTTP 422.

---

## 3) Human Correction Learning (Reinforcement)

When the user corrects the assistant's behaviour, this is the **highest-value
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

Note: always store a `relation` atom linking the correction event to the
procedure. This strengthens Markov predictions for future similar triggers.

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

After each checkpoint, optionally verify success:
- Tool: `memory_audit_log` with `limit: 5`, `event: "atom.add"`
- Confirm the atoms you just stored appear in the log

---

## 6) Session End Protocol (mandatory)

**Always** call `session_checkpoint` at session end. This is non-negotiable.

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
6. Were any relations between concepts discovered? Store each as a `relation`.

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
5. **Semantic search** — if exact atom names don't match but you know roughly
   what you're looking for, use `memory_search` to find by meaning
6. **Events** — recent outcomes for chronology and recency
7. **Markov predictions** — use as hints, not absolute truth

Prefer high-confidence, recent, and task-scoped memory.

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

### Memory hygiene (during weekly eval or when memory is noisy)

1. **Find stale atoms:**
   - Tool: `memory_atoms_stale` with `maxAgeDays: 14`
   - Review the list — tombstone atoms that are no longer relevant
   - Especially clean up `state` atoms for completed work

2. **Check audit log:**
   - Tool: `memory_audit_log` with `limit: 50`
   - Verify recent mutations look correct
   - Look for unexpected tombstones or imports

3. **Verify proofs haven't broken:**
   - Tool: `memory_atom_get` on a few critical facts
   - Tool: `memory_verify` with the returned proof
   - Proof failures must remain zero

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

Always ask for explicit confirmation before taking any action
involving payment services or stored payment methods. Even if a connector
is authenticated, each payment action requires fresh explicit approval.

### Security awareness

The server includes security features from Sprint 16 hardening:

- **Injection detection**: Atoms with suspicious patterns (e.g.,
  `ignore_previous_instructions`, `system_prompt_override`) are flagged and
  may return HTTP 202 with a `ReviewRequired` status instead of being
  immediately ingested. If this happens, the atom needs explicit approval
  via the HTTP API's `reviewApproved: true` parameter (not available via MCP).

- **Secret blocking**: When `MMPM_BLOCK_SECRET_ATOMS=1` is set on the server,
  atoms that look like credentials are rejected with HTTP 422. This is a
  server-side safety net — never attempt to store secrets regardless.

- **Audit trail**: Use `memory_audit_log` to review recent mutations. This
  is especially important after imports or bulk operations.

---

## 11) Evidence-Based Retrieval (High-Impact Decisions)

When making a decision that affects production, deployments,
architecture, or other high-stakes outcomes, use evidence gating to filter
out low-confidence atoms:

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
- `decisionEvidence.retrievalRationale` — per-atom evidence scores and reasons

**When to use evidence gating:**
- Production deployment decisions
- Architecture choices that are hard to reverse
- Marking a sprint as complete
- Answering user questions about system reliability

**When NOT to use it:**
- Routine session start (use default bootstrap)
- Exploratory recall during debugging
- Loading procedures and corrections

---

## 12) Time-Travel Queries

MMPM supports querying memory as it existed at a specific point in time.
This is critical for auditing past decisions and understanding how memory evolved.

### Query by timestamp

```
memory_atom_get({
  atom: "v1.fact.some_architecture_decision",
  asOfMs: 1772000000000   // Unix ms timestamp
})
```

### Query by version

```
memory_atom_get({
  atom: "v1.fact.some_architecture_decision",
  asOfVersion: 42   // Tree version number
})
```

### Compare memory then vs now

Use `memory_session_bootstrap` with `asOfMs` to load what memory looked
like at a past point in time, then compare with current memory:

```
// What did we know 3 days ago?
const then = memory_session_bootstrap({ asOfMs: threeDaysAgo })

// What do we know now?
const now = memory_session_bootstrap({})

// Diff: what atoms were added, tombstoned, or changed?
```

**When to use time-travel:**
- Debugging a past decision that now looks wrong
- Understanding why a procedure was created
- Auditing what the AI knew when it made a recommendation
- Verifying that memory wasn't tampered with

---

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
| `memory_atoms_stale` | Find atoms not accessed in N days | `maxAgeDays` (default 30), `type` |
| `memory_pending` | View ingestion queue | — |
| `memory_verify` | Verify a Merkle proof (no auth needed) | `atom`, `proof` |
| `memory_audit_log` | Query mutation history | `limit`, `since`, `event` |
| `memory_atoms_export` | Export all atoms as NDJSON | `status`, `type` |
| `memory_policy_get` | Read transition policy | — |
| `memory_write_policy_get` | Read write-policy tiers | — |
| `memory_metrics` | Prometheus metrics | — |
| `memory_weekly_eval_status` | Weekly eval due status | — |

### Semantic tools (require `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_search` | Find atoms by meaning (semantic search) | `query`, `limit`, `threshold`, `namespace`, `asOfMs`, `asOfVersion` |
| `memory_context` | Token-budgeted context block | `maxTokens`, `namespace`, `asOfMs`, `asOfVersion` |

### Mutation tools (require `MMPM_MCP_ENABLE_MUTATIONS=1`)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_session_bootstrap` | Session start — loads context + predictions | `objective`, `maxTokens`, `limit`, `highImpact`, `evidenceThreshold`, `namespace`, `asOfMs`, `asOfVersion` |
| `session_checkpoint` | **Primary save tool** — atoms + tombstone + train + commit | `atoms[]`, `tombstone[]`, `train[]` |
| `memory_atoms_add` | Low-level: queue atoms for ingestion | `atoms[]`, `ttlMs` |
| `memory_train` | Low-level: train a Markov sequence | `sequence[]` |
| `memory_commit` | Low-level: flush pending to disk | — |
| `memory_weekly_eval_run` | Run weekly scientific evaluation | `force` |

### Dangerous tools (require `MMPM_MCP_ENABLE_DANGEROUS=1` + mutations)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `memory_atoms_delete` | Tombstone one atom | `atom` |
| `memory_atoms_import` | Import NDJSON snapshot | `ndjson` |
| `memory_policy_set` | Update transition policy | `policy` |
| `memory_write_policy_set` | Update write-policy tiers | `policy` |

### MCP permission tiers

The server exposes tools in four modes based on environment variables:

| Configuration | Read (16 tools) | Semantic (2 tools) | Mutation (6 tools) | Dangerous (4 tools) |
|---------------|-----------------|--------------------|--------------------|---------------------|
| Default (no env vars) | ✅ | ❌ | ❌ | ❌ |
| `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` | ✅ | ✅ | ❌ | ❌ |
| `MMPM_MCP_ENABLE_MUTATIONS=1` | ✅ | ❌ | ✅ | ❌ |
| Both mutations + dangerous | ✅ | ❌/✅ | ✅ | ✅ |

**Always tombstone via `session_checkpoint`'s `tombstone` field** — not by calling `memory_atoms_delete` directly. `memory_atoms_delete` is a dangerous-tier tool and is unavailable in the default mode.

### Ephemeral atoms with TTL

Use `memory_atoms_add` with `ttlMs` to create atoms that auto-expire.
This is ideal for temporary session-scoped state that should not persist:

```
memory_atoms_add({
  atoms: ["v1.state.currently_debugging_shard_worker_timeout"],
  ttlMs: 3600000   // expires in 1 hour
})
```

**When to use TTL:**
- Debugging state ("currently investigating X")
- Temporary hypotheses that need validation before committing
- Short-lived context that is only relevant to this session

**When NOT to use TTL:**
- Human corrections (always permanent)
- Architecture decisions (always permanent)
- Sprint state (use tombstone when complete instead)

### HTTP-only parameters (not available via MCP)

These parameters exist on the HTTP API but are **not** exposed through
the MCP tool wrappers:

| Endpoint | Parameter | Purpose |
|----------|-----------|---------|
| `POST /atoms` | `reviewApproved: true` | Bypass injection review gate |

To use this, call the HTTP API directly via curl.
