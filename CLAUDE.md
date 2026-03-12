# MMPM Project Notes

This file contains project-specific configuration for the MMPM codebase. General memory protocol is in the global CLAUDE.md — do not duplicate it here.

## MCP Environment Variables

The MCP server gates tools behind env vars. These must be set in your MCP configuration:

| Variable | Required | Unlocks |
|----------|----------|---------|
| `MMPM_MCP_ENABLE_MUTATIONS=1` | **Yes** | `session_checkpoint`, `memory_session_bootstrap`, `memory_atoms_add`, `memory_train`, `memory_commit` |
| `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` | Recommended | `memory_search`, `memory_context` |
| `MMPM_MCP_ENABLE_DANGEROUS=1` | Only when needed | `memory_atoms_delete`, `memory_atoms_import`, `memory_policy_set` |

If `session_checkpoint` fails, check `MMPM_MCP_ENABLE_MUTATIONS=1` first.

## Security

- **Secret blocking:** `MMPM_BLOCK_SECRET_ATOMS=1` rejects atoms that look like credentials (HTTP 422).
- **Injection detection:** Suspicious atom patterns may return HTTP 202 `ReviewRequired` instead of being ingested.
- **Audit trail:** Use `memory_audit_log` to review recent mutations after imports or bulk operations.

## Quality Gates

- Run `npm run typecheck` before marking any sprint complete.
- Never use `any`/unsafe casts when a type-safe solution exists.
- Ask explicit confirmation before any payment service action.

## Weekly Evaluation

Check `memory_weekly_eval_status` at session start. If `due: true`, run `memory_weekly_eval_run`. Track: predictionUsefulRate, predictionAccuracy, proof failures (must be zero).
