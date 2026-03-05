# Token Optimization Strategies for Claude & VS Code Agents

## Overview
This document summarizes best practices for minimizing token usage and maximizing efficiency for all agent workflows in this project.

---

## 1. Compact Contexts
- Use `GET /memory/context?compact=true` to reduce context payload size.
- Typical reduction: 30–50% fewer tokens per context block.

## 2. Objective-Aware Ranking
- Use `GET /memory/context?objectiveRank=true` to prioritize atoms relevant to current objective.
- Reduces irrelevant context, further lowering token count.

## 3. Batch Operations
- Use `/batch-access` and `/search` endpoints for bulk memory operations.
- Fewer API calls, lower total token usage.

## 4. Session Bootstrap
- Use session start protocol (see AGENT_SETUP.md) to load only necessary context and memory slices.

## 5. Benchmarking & SLOs
- Run benchmarks with `tools/harness/cli.ts` and `agent_sim.ts`.
- Enforce latency and token SLOs with `tools/harness/slo_gate.ts`.

## 6. Durable Token Optimization Rules
- Always use `compact` and `objectiveRank` flags for `/memory/context`.
- Prefer batch endpoints (`/batch-access`, `/search`) for bulk operations.
- Use session bootstrap and targeted search to minimize context size.
- Benchmark regularly and update docs with real numbers.
- Persist durable workflow rules as memory atoms for all agents.

---

## Example Benchmark Numbers
| Mode         | Avg Tokens | P95 Latency (ms) |
|--------------|------------|------------------|
| Compact      |    210     |      120         |
| Full         |    340     |      180         |
| ObjectiveRank|    180     |      130         |

*Update these numbers after running benchmarks for your agent setup.*

---

## References
- AGENT_SETUP.md
- CLAUDE.md
- OPTIMIZATION_REVIEW.md
- tools/harness/README.md

---

## Durable Rules
- Persist workflow rules (e.g., run commands from correct folder) as memory atoms for all agents.
- Never store secrets or credentials in memory atoms.
