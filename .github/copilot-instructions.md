# MMPM Copilot Instructions (Workspace-wide)

These instructions are always-on for this repository.

## Required operating mode

- Treat MMPM memory as the default context substrate for planning and execution.
- Before major planning or code changes, check memory readiness and load memory context.
- Persist durable new learnings as typed atoms using schema `v1.<type>.<value>`.
- Never store secrets, private keys, tokens, or credentials in memory atoms.

## Session-start protocol (mandatory)

1. Use MCP tool `memory_ready`.
2. Use `memory_weekly_eval_status`.
3. If weekly eval is due, run `memory_weekly_eval_run` before major planning.
4. Use `memory_context` to load compact context.
5. Load active slices with `memory_atoms_list` for `fact`, `state`, and `relation`.
6. Produce a short **Current Sprint Status** summary:
   - where we are now,
   - what is in progress or blocked,
   - next 1-3 logical items.

## During-session behavior

- Use `memory_search` and/or `memory_access` before major decisions.
- Store high-value durable facts/states/events/relations via `memory_atoms_add`.
- Commit important updates via `memory_commit`.
- When a useful action chain succeeds, reinforce with `memory_train`.
- If the user explicitly corrects the assistant's approach, treat that correction as a durable workflow rule, store it in memory, and apply it in future steps.
- Avoid `any` and unsafe casts as convenience shortcuts; prefer type-correct root-cause fixes.

## Session-end protocol

1. Persist key new atoms.
2. Tombstone obsolete state atoms with `memory_atoms_delete`.
3. Train one summary successful sequence via `memory_train`.
4. Flush writes with `memory_commit`.

## Validation and quality

- Prefer high-confidence, recent, task-scoped atoms.
- Keep one concept per atom.
- Mark uncertain information with explicit lower-confidence tags in atom value.
- If memory tools are unavailable, state this clearly and continue with local repository context.