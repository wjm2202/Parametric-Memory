# Agent Quickstart & Troubleshooting (Claude & VS Code)

## Quickstart Steps
1. Validate agent config files:
   - Claude: `tools/mcp/claude_desktop_config.example.json`
   - VS Code: `.vscode/tasks.json`, `.vscode/launch.json`
2. Always run commands from `markov-merkle-memory/` subfolder.
3. Start MCP server: `npm run mcp:serve`
4. Launch agents/subagents via CLI or VS Code tasks.
5. Run benchmarks (`tools/harness/cli.ts`, `agent_sim.ts`).
6. Update docs with benchmark results.

---

## Troubleshooting
- If agents fail to launch, check config file paths and API keys.
- If commands fail, verify working directory is `markov-merkle-memory/`.
- For latency or token issues, run benchmarks and check SLO gates.
- For Claude, ensure desktop config points to correct repo and API key.
- For VS Code, use provided tasks and launch configs for agent orchestration.

---

## References
- AGENT_SETUP.md
- TOKEN_OPTIMIZATION.md
- CLAUDE.md
- .github/copilot-instructions.md
- tools/mcp/README.md

---

## Durable Conventions
- Folder and command rules are persisted as memory atoms for all agents.
- Update onboarding docs and atoms as new best practices emerge.
