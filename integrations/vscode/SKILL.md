# MMPM Memory Skill

**Gives your AI assistant persistent memory across sessions via a local Parametric-Memory (MMPM) server.**

Copy this file to your project root as `SKILL.md` (or to your Claude skills directory) to wire memory into every session automatically.

---

## Session protocol

### Start of every session
1. `memory_ready` — confirm server is up and mutations enabled
2. `memory_session_bootstrap` — load context, state, predictions in one call
3. `memory_atoms_list` with `type: "state"` if context is sparse
4. Summarise what you know: current task, recent decisions, where we left off

### During the session
- `session_checkpoint` at each meaningful learning (decisions, discoveries, state changes)
- Pass `atoms` with new facts/state/events — it commits automatically
- Do not wait until session end

### End of every session — mandatory
- `session_checkpoint` with all new atoms, tombstoned old states, and session arc in `train`
- Never close a session without this call

---

## MCP tools

| Tool | Purpose |
|------|---------|
| `memory_ready` | Preflight — server up + mutations enabled |
| `memory_session_bootstrap` | Session start — loads all context in one call |
| `session_checkpoint` | Save + tombstone + train + commit (primary save tool) |
| `memory_atoms_list` | Browse atoms by type (`fact`, `state`, `event`, etc.) |
| `memory_access` | Markov recall for one atom |
| `memory_search` | Search by text (requires `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`) |
| `memory_atoms_stale` | Find atoms not accessed recently |
| `memory_verify` | Verify a Merkle proof |
| `memory_weekly_eval_status` | Check if weekly memory eval is due |
| `memory_weekly_eval_run` | Run the weekly evaluation if due |

---

## Atom format

`v1.<type>.<value>` — snake_case, no spaces, no punctuation.

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable truths, preferences, project info | `v1.fact.project_uses_typescript` |
| `state` | Active work context, next steps | `v1.state.working_on_auth_feature` |
| `event` | Completed milestones with date | `v1.event.v1_0_released_2026_03_07` |
| `relation` | Links between concepts or systems | `v1.relation.api_depends_on_db` |
| `procedure` | Repeatable multi-step processes | `v1.procedure.run_tests_before_merge` |

---

## Server

- Default URL: `http://localhost:3000`
- DB: `~/.mmpm/data` (outside the repo — safe from git)
- Start: `cd /path/to/parametric-memory && ./start.sh`
- Health: `GET /health`

MCP config (`MMPM_MCP_ENABLE_MUTATIONS=1` required for all save tools):
see `.vscode/mcp.json` or `integrations/vscode/.vscode/mcp.json` in the parametric-memory repo.

---

## Curl fallback

If MCP is not connected:

```bash
# Session start
curl -s -X POST -H "Authorization: Bearer $MMPM_API_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3000/memory/bootstrap -d '{}'

# Save atom + commit
curl -s -X POST -H "Authorization: Bearer $MMPM_API_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3000/atoms \
  -d '{"atoms":["v1.fact.example"]}'
curl -s -X POST -H "Authorization: Bearer $MMPM_API_KEY" \
  http://localhost:3000/admin/commit
```

Full tool reference: `integrations/claude-skill/SKILL.md` in the parametric-memory repo.
