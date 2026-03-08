---
name: "MMPM Memory Workflow"
description: "Enforce memory-substrate-first workflow for coding sessions"
applyTo: "**"
---

#tool:mmpm-memory/memory_ready
#tool:mmpm-memory/memory_session_bootstrap
#tool:mmpm-memory/memory_context
#tool:mmpm-memory/memory_atoms_list
#tool:mmpm-memory/memory_search
#tool:mmpm-memory/memory_access
#tool:mmpm-memory/memory_batch_access
#tool:mmpm-memory/memory_atom_get
#tool:mmpm-memory/memory_atoms_add
#tool:mmpm-memory/memory_commit
#tool:mmpm-memory/memory_train
#tool:mmpm-memory/session_checkpoint
#tool:mmpm-memory/memory_weights_get
#tool:mmpm-memory/memory_atoms_stale
#tool:mmpm-memory/memory_audit_log
#tool:mmpm-memory/memory_verify
#tool:mmpm-memory/memory_weekly_eval_status
#tool:mmpm-memory/memory_weekly_eval_run

Follow this workflow whenever tools are available:

1. Start with `memory_ready`. If not ready, run `./start.sh` in background and retry.
2. Check `memory_weekly_eval_status`. If due, run `memory_weekly_eval_run`.
3. Call `memory_session_bootstrap` with `objective` from the user's opening message and `maxTokens: 1200`.
   - For critical decisions, add `highImpact: true` and `evidenceThreshold: 0.75`.
   - Review `conflictingFacts` in the response — flag contradictions to the user.
4. Load procedures: `memory_atoms_list` with `type: "procedure"` — these contain human corrections and proven processes. Apply them before starting work.
5. Retrieve active memory with `memory_atoms_list` (`fact`, `state`, `relation`) and targeted `memory_search` if needed.
6. Before major decisions, perform at least one memory retrieval call (`memory_search`, `memory_access`, or `memory_batch_access`).
7. Persist durable learnings immediately via `session_checkpoint` with `atoms`, `tombstone`, and `train`.
8. When a human correction is given, store it as a `procedure` atom with a `relation` linking the correction to its trigger, and reinforce with `train`.
9. After successful workflows, reinforce with `train`: `[trigger_event, action_procedure, outcome_event]`.
10. Verify confidence with `memory_weights_get` — target `dominanceRatio >= 0.70`.
11. At session end, always call `session_checkpoint` — this is non-negotiable.

Output expectation at session start:

- Always include a concise **Current Sprint Status** with: current position, in-progress/blocked items, next 1-3 actions.

Retrieval priority:

1. **Procedures** — check if a stored rule constrains the current action
2. **Facts and constraints** — explicit truths about the project
3. **Current state** — what's in progress, blocked, or next
4. **Relations** — links between current task and architecture/history
5. **Semantic search** — use `memory_search` when exact atom names don't match
6. **Events** — recent outcomes for chronology
7. **Markov predictions** — hints, not absolute truth

Safety constraints:

- Never persist secrets/credentials. Server enforces this with `MMPM_BLOCK_SECRET_ATOMS=1`.
- Do not invent memory facts without evidence from user input, repo state, tests, or tool output.
- If the user corrects the assistant's approach, store that correction as a `procedure` atom, store a `relation` linking it to the trigger, and reinforce the corrected sequence with `train`.
- Prefer type-safe root-cause fixes over convenience casts (`any`/unsafe assertions).
- A sprint must not be reported as complete unless `npm run typecheck` passes.
- Always tombstone via `session_checkpoint`'s `tombstone` field, not `memory_atoms_delete`.
