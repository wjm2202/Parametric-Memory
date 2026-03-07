# Copilot Instructions — Parametric Memory (MMPM)

This workspace is connected to a local MMPM memory server. You must use it.

## Every session — mandatory

At the start of every session, load memory before doing anything else.

**Preferred — MCP tools (parametric-memory server must be connected):**
1. `memory_ready` — confirm server is up and mutations are enabled
2. `memory_session_bootstrap` — loads context, state, and Markov predictions in one call
3. `memory_atoms_list` with `type: "state"` if bootstrap context is sparse

**Fallback — if MCP is not connected:**
```bash
curl -s -X POST \
  -H "Authorization: Bearer ${MMPM_API_KEY}" \
  -H "Content-Type: application/json" \
  http://localhost:3000/memory/bootstrap \
  -d '{}'
```

## During the session

Save at each meaningful learning — do not wait until the end.

**MCP:** `session_checkpoint` with `atoms` containing new facts, state, or events.
**Fallback:** `POST /atoms` then `POST /admin/commit`.

## End of session — mandatory

Always call `session_checkpoint` before closing. Never skip this.

```
session_checkpoint({
  atoms:     ["v1.event.completed_X_DATE", "v1.state.next_task_is_Y"],
  tombstone: ["v1.state.old_completed_state"],
  train:     ["v1.event.session_started", "v1.state.next_task_is_Y", "v1.event.completed_X_DATE"]
})
```

## Atom format

`v1.<type>.<value>` — snake_case, no spaces.

| Type | Use for |
|------|---------|
| `fact` | Stable truths, preferences, project info |
| `state` | Current working context, next steps |
| `event` | Completed milestones with date |
| `relation` | Links between systems or concepts |
| `procedure` | Repeatable multi-step processes |

> ⚠️ **Never store secrets as atoms.** Passwords, API keys, tokens, and
> credentials must not be stored in MMPM atoms.  Use a dedicated secret
> manager for sensitive values.

## MCP tools

| Tool | Purpose |
|------|---------|
| `memory_ready` | Session preflight — confirms server + mutations enabled |
| `memory_session_bootstrap` | Session start — loads all context in one call |
| `session_checkpoint` | Save + tombstone + train + commit in one call |
| `memory_atoms_list` | Browse atoms by type or prefix |
| `memory_access` | Markov recall for one atom |
| `memory_atoms_stale` | Find atoms to clean up |
| `memory_verify` | Verify a Merkle proof |

Full reference: `integrations/claude-skill/SKILL.md` in the parametric-memory repo.
