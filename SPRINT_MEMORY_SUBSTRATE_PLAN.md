# Sprint: Memory Substrate Readiness for AI-Native Operation

Date: 2026-03-04
Owner: Glen + AI pair
Objective: Implement the next capabilities required for MMPM to act as a dependable memory substrate for AI-derived processes.

## Working Style Applied (Glen)

1. Identify what we are working on.
2. Research the topic.
3. Give analysis and reason for suggestion.
4. Create sprint board with logical implementation items + metadata.
5. Create real-world tests.
6. Test new tests and then full suite to 100% pass.
7. Update documentation as required.
8. If change improves system, capture metrics.

## Sprint Board

## Epic A — Session Bootstrap and Context Reliability

A1. Single-call session bootstrap endpoint
- Priority: P0
- Size: M
- Description: Add one endpoint/tool returning goals, constraints, preferences, top relevant memories, and proof/version metadata in one response.
- Acceptance: one MCP call can initialize session context within target token budget.
- Test plan: integration test validates payload schema, proof fields, and deterministic ordering.
- Metric: bootstrap latency p95 and bootstrap usefulness score.

A2. Scoped namespace isolation
- Priority: P0
- Size: M
- Description: Add user/project/task namespace boundaries to avoid cross-context memory bleed.
- Acceptance: retrieval in namespace N excludes unrelated namespace atoms by default.
- Test plan: cross-namespace contamination tests.
- Metric: leakage rate = 0 in namespace isolation suite.

## Epic B — Memory Truth Management

B1. Contradiction-aware fact handling
- Priority: P0
- Size: L
- Description: Detect conflicting facts and store as competing claims with confidence/provenance instead of overwrite.
- Acceptance: conflicting writes are both preserved and surfaced in recall metadata.
- Test plan: conflict insertion + conflict retrieval ranking tests.
- Metric: contradiction detection precision on synthetic conflict set.

B2. Confidence lifecycle (decay + reinforcement)
- Priority: P1
- Size: M
- Description: Add time-aware confidence decay and reinforcement updates tied to observed success.
- Acceptance: confidence evolves predictably over time and with training events.
- Test plan: deterministic confidence progression unit tests.
- Metric: confidence calibration error over replayed sessions.

## Epic C — Temporal and Audit Semantics

C1. Time/version query support
- Priority: P0
- Size: M
- Description: Add first-class query semantics for “what was true at version/time T”.
- Acceptance: recall can be pinned to historical version windows.
- Test plan: replay tests across version checkpoints.
- Metric: historical recall correctness on versioned snapshots.

C2. Decision evidence bundles
- Priority: P1
- Size: M
- Description: Return memory IDs, proof references, and retrieval rationale as a decision bundle for high-impact outputs.
- Acceptance: every high-assurance response has traceable memory evidence.
- Test plan: end-to-end MCP call asserts evidence bundle completeness.
- Metric: evidence coverage ratio for high-impact tasks.

## Epic D — Write Policy and Safety Controls

D1. Memory write policy tiers
- Priority: P1
- Size: S
- Description: Add policy classes: auto-write, review-required, never-store.
- Acceptance: writes are gated by policy and policy outcome is observable.
- Test plan: policy gate tests for allow/review/deny states.
- Metric: blocked sensitive writes count and false-block rate.

D2. Retrieval evidence threshold gating
- Priority: P1
- Size: M
- Description: Require minimum evidence score before memory can influence high-impact decisions.
- Acceptance: low-evidence recall is flagged or excluded from decisive recommendations.
- Test plan: threshold and fallback behavior tests.
- Metric: high-impact low-evidence usage rate.

## Epic E — Performance + Governance Hardening

E1. AI-facing latency SLO profile
- Priority: P2
- Size: S
- Description: Define and enforce p95 targets for context load and recall operations.
- Acceptance: SLO checks run in CI benchmark gates.
- Test plan: benchmark CI profile assertions.
- Metric: SLO pass ratio over weekly runs.

E2. Domain pilot pack (critical workflow)
- Priority: P2
- Size: L
- Description: Build one domain pilot with before/after metrics and audit walkthrough.
- Acceptance: pilot demonstrates measurable utility + audit trace completeness.
- Test plan: scenario replay with known expected outcomes.
- Metric: task success delta and audit replay completeness.

## Execution Order

Wave 1 (P0): A1, A2, B1, C1
Wave 2 (P1): B2, C2, D1, D2
Wave 3 (P2): E1, E2

## Definition of Done

- New tests pass.
- Full suite passes at 100% for targeted branch.
- Docs updated.
- Metrics captured and compared to baseline.
- Sprint memory mirror updated through MCP.
