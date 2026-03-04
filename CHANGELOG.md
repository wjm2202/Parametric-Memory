# Changelog

## 2026-03-04

### Added
- MCP adapter server for MMPM at `tools/mcp/mmpm_mcp_server.ts` with read-only default tool exposure and env-gated mutating/semantic tools.
- MCP tooling assets:
  - `tools/mcp/mmpm_tool_catalog.json`
  - `tools/mcp/README.md`
  - Claude Desktop config templates:
    - `tools/mcp/claude_desktop_config.example.json`
    - `tools/mcp/claude_desktop_config.unsafe.example.json`
- MCP test coverage:
  - Unit wiring tests: `src/__tests__/mcp_tools.test.ts`
  - Stdio end-to-end integration tests: `src/__tests__/mcp_stdio_integration.test.ts`
- Dedicated CI workflow for MCP + semantic coverage:
  - `.github/workflows/mcp-semantic-gate.yml`

### Changed
- Added `mcp:serve` and `mcp:serve:unsafe` npm scripts in `package.json`.
- Refactored MCP server module for testability (exported builders + explicit startup entrypoint).
- Added atom creation timestamp visibility in API inspection surfaces (`createdAtMs`).
- Implemented snapshot reference-count lifecycle handling for safe snapshot retirement.
- Implemented additive `GET /atoms` query support for scalable browsing:
  - `type`, `prefix`, `limit`, `offset`
  - default no-query behavior remains unchanged.

### Validation
- MCP-focused gate passed:
  - `npm test -- src/__tests__/mcp_tools.test.ts src/__tests__/mcp_stdio_integration.test.ts src/__tests__/server.test.ts`
- Latest focused gate (with `/atoms` filtering + real semantic MCP integration) passed:
  - `npm test -- src/__tests__/server.test.ts src/__tests__/mcp_tools.test.ts src/__tests__/mcp_stdio_integration.test.ts`
  - Result: **3 files, 80 tests passed**.
- Full pre-merge gate passed:
  - `npm test`
  - Result: **36 files, 533 tests passed**.

### Compatibility
- Backward-compatible release: existing HTTP API behavior preserved; MCP support is additive.
