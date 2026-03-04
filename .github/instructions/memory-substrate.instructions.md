---
name: "MMPM Memory Workflow"
description: "Enforce memory-substrate-first workflow for coding sessions"
applyTo: "**"
---

#tool:mmpm-memory/memory_ready
#tool:mmpm-memory/memory_context
#tool:mmpm-memory/memory_atoms_list
#tool:mmpm-memory/memory_search
#tool:mmpm-memory/memory_access
#tool:mmpm-memory/memory_atoms_add
#tool:mmpm-memory/memory_commit
#tool:mmpm-memory/memory_train
#tool:mmpm-memory/memory_weekly_eval_status
#tool:mmpm-memory/memory_weekly_eval_run

Follow this workflow whenever tools are available:

1. Start with `memory_ready`, `memory_weekly_eval_status`, and `memory_context`.
2. Retrieve active memory with `memory_atoms_list` (`fact`, `state`, `relation`) and targeted `memory_search`.
3. Before major decisions, perform at least one memory retrieval call (`memory_search` or `memory_access`).
4. Persist durable learnings with `memory_atoms_add`, then `memory_commit`.
5. Reinforce successful behavior sequences with `memory_train`.
6. If weekly eval is due, run `memory_weekly_eval_run` before major planning.

Output expectation at session start:

- Always include a concise **Current Sprint Status** with: current position, in-progress/blocked items, next 1-3 actions.

Safety constraints:

- Never persist secrets/credentials.
- Do not invent memory facts without evidence from user input, repo state, tests, or tool output.
- If the user corrects the assistant's approach, store that correction as durable memory and apply it as a standing workflow rule.
- Prefer type-safe root-cause fixes over convenience casts (`any`/unsafe assertions).