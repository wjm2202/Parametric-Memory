# Unified Agent Onboarding Guide (Claude & VS Code)

## Overview
This guide enables seamless agent/subagent workflows for both Claude and VS Code Copilot, with scientific strategies for token efficiency, benchmarking, and troubleshooting.

---

## 1. Session Start Protocol
- Always run commands from `markov-merkle-memory/` subfolder.
- Check readiness: `GET /ready`
- Weekly eval: run `tools/harness/weekly-memory-eval.sh` if needed.
- Seed baseline: `tools/harness/apply-seed-pack.sh` (if memory is empty).
- Load compact context: `GET /memory/context?maxTokens=1200&compact=true`
- Load active memory slices: `GET /atoms?type=fact|state|relation&limit=200`
- Targeted search: `POST /search` with user objective.

## 2. Subagent Orchestration
- Use MCP endpoints for agent/subagent coordination.
- Launch subagents via CLI (`tools/harness/cli.ts`, `agent_sim.ts`) or VS Code tasks.
- Example: `npm run mcp:serve` from `markov-merkle-memory/`.
- For Claude: use `claude_desktop_config.example.json` (safe) or `unsafe.example.json` (mutating tools enabled).

## 3. Token Cost Optimization
- Use `compact` and `objectiveRank` flags for context endpoints.
- Prefer batch endpoints (`/batch-access`, `/search`) for bulk operations.
- Benchmark with `tools/harness/cli.ts` and `agent_sim.ts`.
- Enforce SLOs with `tools/harness/slo_gate.ts`.

## 4. Troubleshooting & Validation
- Validate config files before agent launch.
- Use provided example configs and update API keys/cwd as needed.
- Check logs and benchmark reports for latency/token usage.

## 5. Scientific Benchmarking
- Run `tools/harness/cli.ts` and `agent_sim.ts` with presets (`smoke`, `standard`, `stress`, `concurrent`).
- Record latency, token usage, and agent throughput.
- Update docs with benchmark numbers for each agent setup.

## 6. Subagent Orchestration & Token Efficiency Best Practices

### Subagent Orchestration
- Use MCP endpoints for all agent/subagent coordination (Claude and VS Code).
- Launch subagents via:
  - CLI: `node tools/harness/agent_sim.ts --api --baseUrl http://localhost:3000 --agents N --durationMs 10000`
  - VS Code: tasks in `.vscode/tasks.json` (add agent simulation as a task).
  - Claude: configure subagent tools in `claude_desktop_config.example.json`.
- Use `tools/harness/cli.ts` for multi-agent, stress, and concurrent benchmarks.
- Always validate configs before launching subagents.

### Token Efficiency
- Always use `compact` and `objectiveRank` flags for `/memory/context`.
- Use `/batch-access` and `/search` endpoints for bulk memory operations.
- Prefer session bootstrap and targeted search to minimize context size.
- Run benchmarks (`tools/harness/cli.ts`, `agent_sim.ts`) to measure token and latency impact.
- Persist durable workflow rules as memory atoms to avoid repeated setup and wasted tokens.

---

## References
- CLAUDE.md
- .github/copilot-instructions.md
- OPTIMIZATION_REVIEW.md
- tools/harness/README.md
- tools/mcp/README.md

---

## Example Benchmark Results
| Mode         | Avg Tokens | P95 Latency (ms) | Agent Throughput |
|--------------|------------|------------------|------------------|
| Compact      |    210     |      120         |      50/s        |
| Full         |    340     |      180         |      38/s        |
| ObjectiveRank|    180     |      130         |      52/s        |

*Numbers are illustrative; update after running benchmarks.*

---

## 7. Folder and Command Conventions
- **Always run all project commands from the `markov-merkle-memory/` subfolder.**
- Validate agent config files before launching agents or subagents.
- Use provided scripts and tasks for launching, testing, and benchmarking.
- Durable convention: this rule is persisted as a memory atom for all agents.

---

## 8. Config Validation & Troubleshooting Tips
- Use `tools/validate_agent_config.sh` to check Claude and VS Code config files for presence and valid JSON.
- Ensure API keys and working directories are set correctly in all configs.
- For Claude: update `claude_desktop_config.example.json` or `unsafe.example.json` with your API key and correct `cwd`.
- For VS Code: check `.vscode/tasks.json` and `.vscode/launch.json` for agent tasks and launch configs.
- If agents fail to launch, check config file paths, API keys, and working directory.
- For latency or token issues, run benchmarks and check SLO gates.
- See README_AGENT.md for more troubleshooting.

---

## 9. Best-of-Breed Onboarding Sections
- This onboarding guide integrates the best practices from CLAUDE.md, .github/copilot-instructions.md, and OPTIMIZATION_REVIEW.md.
- All session start, orchestration, and troubleshooting steps are cross-referenced for both Claude and VS Code agents.
- For Claude: follow the session protocol and config steps in this guide and CLAUDE.md.
- For VS Code: use the tasks and launch configs, and follow the durable conventions in this guide.
- For all agents: always validate configs, use compact/objective-aware context, and persist workflow rules as memory atoms.
- See README_AGENT.md for a quickstart and troubleshooting summary.

---

## Quickstart
1. Validate configs (`tools/mcp/claude_desktop_config.example.json`, `.vscode/tasks.json`).
2. Start MCP server: `npm run mcp:serve` (from subfolder).
3. Launch agents/subagents via CLI or VS Code tasks.
4. Run benchmarks and update docs with results.
