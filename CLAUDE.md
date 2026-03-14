# MMPM Project — Claude Instructions

## Stack
TypeScript, Fastify, LevelDB. Production on DigitalOcean droplet at mmpm.co.nz.

## MCP Env Vars
If `session_checkpoint` fails → check `MMPM_MCP_ENABLE_MUTATIONS=1`.
Semantic search needs `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1`.
Dangerous ops need `MMPM_MCP_ENABLE_DANGEROUS=1`.
Bootstrap proof mode: `MMPM_BOOTSTRAP_FORCE_FULL_PROOFS=1` (enterprise) or `MMPM_BOOTSTRAP_COMPACT_PROOFS=1` (token-saving). Client `compactProofs` param is overridden by server env vars.

## Quality Gates
Run `npm run typecheck` before marking any sprint complete. No `any`/unsafe casts. Confirm before payment service actions.

## Weekly Eval
Check `memory_weekly_eval_status` at session start. If due, run `memory_weekly_eval_run`.

## Docker Warning
Never `docker compose down -v` — the `-v` flag destroys memory volumes permanently.

## Known Atom Naming Issue
Numbered suffixes like `security_critical_1` / `security_critical_4` trigger false conflict detection. Use descriptive suffixes instead (e.g., `security_critical_dockerfile_env_leak`).
