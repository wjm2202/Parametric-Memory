# Parametric-Memory (MMPM) — Claude Skill

**Gives Claude persistent, cryptographically verifiable memory across sessions, backed by your local MMPM server.**

---

## What this skill does

Connects Claude to your running Parametric-Memory (MMPM) server so it can:

- **Remember** facts, events, state, and relations across sessions — stored as typed atoms
- **Recall** context automatically at the start of every session
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

### 3. Install this skill

Copy `integrations/claude-skill/` to your Claude skills directory, or drag
`integrations/parametric-memory.skill` into Cowork.

### 4. Verify

Ask Claude: *"Check my MMPM memory and tell me what you know."*
Claude will call `memory_session_bootstrap` and report back.

---

## Atom format

MMPM stores typed atoms as `v1.<type>.<value>` — snake_case, no spaces:

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable truths, preferences, project info | `v1.fact.user_prefers_dark_mode` |
| `state` | Current working context, next steps | `v1.state.working_on_sprint_15` |
| `event` | Completed milestones, dated outcomes | `v1.event.sprint_14_completed_2026_03_01` |
| `relation` | Links between concepts | `v1.relation.MMPM_uses_LevelDB` |
| `procedure` | Repeatable multi-step processes | `v1.procedure.run_full_test_suite_before_merge` |
| `other` | Hub seeds and navigation roots | `v1.other.hub_session` |

Optional metadata suffixes: `_src_human`, `_conf_high`, `_scope_project`, `_dt_2026_03_07`

---

## Session protocol (automatic)

Claude follows this automatically when MMPM is connected:

### Session start
1. `memory_ready` — confirm server is up
2. `memory_weekly_eval_status` — check if weekly eval is due; run `memory_weekly_eval_run` if so
3. `memory_session_bootstrap` — load facts, state, predictions in one call
4. `memory_atoms_list` — load focused slices if bootstrap context is sparse
5. Summarise current sprint status from `v1.fact.sprint.*` atoms

### During session
- `session_checkpoint` — called at each meaningful learning, not just at end
  - Pass `atoms` to store new facts/events/state
  - Pass `tombstone` for obsolete atoms
  - Pass `train` for trigger→action→outcome arcs
  - Automatically commits to disk

### Session end
- `session_checkpoint` — mandatory final call with all new atoms, tombstones, and session arc

---

## MCP tool reference

All tools are exposed via the MCP server (`npm run mcp:serve`).

### Read-only tools (always available)

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `memory_ready` | `GET /ready` | Check server readiness |
| `memory_health` | `GET /health` | Detailed health status |
| `memory_session_bootstrap` | `POST /memory/bootstrap` | Session start — loads context + predictions |
| `memory_access` | `POST /access` | Markov recall for one atom with proof |
| `memory_batch_access` | `POST /batch-access` | Recall multiple atoms at once |
| `memory_atoms_list` | `GET /atoms` | Browse atoms by type/prefix/page |
| `memory_atom_get` | `GET /atoms/:atom` | Inspect one atom + its Merkle proof |
| `memory_atoms_stale` | `GET /atoms/stale` | Find atoms not accessed in N days |
| `memory_pending` | `GET /atoms/pending` | View ingestion queue |
| `memory_weights_get` | `GET /weights/:atom` | Markov transition weights for an atom |
| `memory_verify` | `POST /verify` | Verify a Merkle proof (no auth needed) |
| `memory_audit_log` | `GET /admin/audit-log` | Recent mutations (add/tombstone/commit) |
| `memory_atoms_export` | `GET /admin/export` | Export all atoms as NDJSON |
| `memory_policy_get` | `GET /policy` | Read transition policy |
| `memory_write_policy_get` | `GET /write-policy` | Read write-policy tiers |
| `memory_metrics` | `GET /metrics` | Prometheus metrics |
| `memory_weekly_eval_status` | local file | Weekly eval due status |

### Mutation tools (require `MMPM_MCP_ENABLE_MUTATIONS=1`)

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `session_checkpoint` | `/atoms` + `/train` + `/admin/commit` | **Primary save tool** — atoms + tombstones + train + commit |
| `memory_atoms_add` | `POST /atoms` | Low-level: queue atoms for ingestion |
| `memory_atoms_delete` | `DELETE /atoms/:atom` | Low-level: tombstone one atom |
| `memory_train` | `POST /train` | Low-level: train a Markov sequence |
| `memory_commit` | `POST /admin/commit` | Low-level: flush pending to disk |
| `memory_atoms_import` | `POST /admin/import` | Import NDJSON snapshot |
| `memory_policy_set` | `POST /policy` | Update transition policy |
| `memory_write_policy_set` | `POST /write-policy` | Update write-policy tiers |
| `memory_weekly_eval_run` | local script | Run weekly scientific evaluation |

### Semantic tools (require `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`)

| Tool | Endpoint | Purpose |
|------|----------|---------|
| `memory_search` | `POST /search` | Semantic search by meaning |
| `memory_context` | `GET /memory/context` | Context block with token budget |

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

## Verification

```bash
# Verify a specific atom proof (no API key required)
curl -s -X POST http://localhost:3000/verify \
  -H "Content-Type: application/json" \
  -d '{"atom":"v1.fact.example","proof":{...}}'

# Point-in-time replay — what did memory look like yesterday?
curl -s -H "Authorization: Bearer $MMPM_API_KEY" \
  "http://localhost:3000/memory/context?asOfMs=1772000000000"
```

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- Claude Desktop config: `integrations/claude-desktop/`
- VSCode integration: `integrations/vscode/`
- Operating guide for Claude: `CLAUDE.md`
