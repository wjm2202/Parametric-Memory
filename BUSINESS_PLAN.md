# mm-memory Business Plan

---

## 1. Product Overview

**Markov-Merkle Predictive Memory (mm-memory / MMPM)** is a sharded, cryptographically verifiable memory substrate for AI agents and LLM-powered applications.

It solves a critical gap in the AI stack: existing memory solutions (vector DBs, key-value stores) can retrieve what was stored but cannot prove it, predict what comes next, or enforce governance over what gets written. MMPM does all three.

### Core Architecture

| Layer | What it does |
|---|---|
| **Merkle proof chains** | Every atom has a cryptographic proof path. Integrity is verifiable at any point in history. |
| **Markov transition learning** | The system learns sequential relationships between atoms and predicts the next likely atom during retrieval. |
| **WAL + snapshot commits** | Write-ahead log with epoch-managed snapshots enables concurrent reads during writes and crash-safe recovery. |
| **Sharded orchestration** | Atoms are distributed across N shards via consistent hashing. Each shard is an independent LevelDB instance. |

---

## 2. Key Features & Value Drivers

### 2.1 Cryptographic Audit Trail (Merkle Proofs)
Every stored atom produces a Merkle proof path that can be independently verified against the current tree root. This enables:
- **Tamper detection** — any mutation invalidates the proof.
- **Regulatory compliance** — auditors can verify what was stored and when, without trusting the operator.
- **Historical pinning** — `asOfVersion` and `asOfMs` queries replay the exact tree state at any past version, giving true point-in-time auditability.

### 2.2 Predictive Retrieval (Markov Chain Engine)
MMPM learns weighted transition probabilities between atoms as the system is used. On every `POST /access`, the system returns not just the requested atom but the predicted next atom, complete with its own proof path. This enables:
- **Prefetching and cache warming** — agents can request what comes next before they need it.
- **Workflow continuity** — on session resume, the Markov chain surfaces the most contextually likely next step without a full search.
- **Behavioral analytics** — transition weights surface usage patterns invisible in flat retrieval logs.

### 2.3 Write Policy Governance
A configurable tiered write policy controls what gets committed automatically versus what requires review or elevated privilege:
- **Auto-write** — default tier; atoms are committed immediately on ingestion.
- **Review-required** — atoms are queued for operator approval before becoming visible.
- **Publish-everywhere** — high-trust atoms that replicate to all namespaces.
- Per-type overrides: different atom types (facts, events, states, relations) can have independent tier assignments.

This makes MMPM suitable for regulated environments where not all writes should be automatic.

### 2.4 Namespace Scoping
Atoms are addressable within hierarchical namespaces (`user`, `project`, `task`) encoded directly in the atom string. Queries against `/search`, `/retrieve`, and `/memory/bootstrap` can be scoped to any namespace combination, preventing data leakage across tenants or contexts.

### 2.5 Ingestion Pipeline with Backpressure
Writes flow through a batching ingestion pipeline with configurable commit thresholds and intervals. The pipeline exposes:
- **Backpressure controls** — when the pending write queue exceeds a high-water mark, `/atoms` returns `429` with a `Retry-After` header.
- **Force flush** — `POST /admin/commit` drains the pipeline immediately (used by CI and test harnesses).
- **Pending inspection** — `GET /atoms/pending` shows what is queued but not yet committed.

### 2.6 Temporal / Versioned Queries
Every commit increments a monotonic master version. All read endpoints (`/search`, `/retrieve`, `/memory/bootstrap`, `/atoms/:atom`) accept `asOfVersion` (integer) or `asOfMs` (Unix timestamp ms) parameters. This enables:
- **Historical reconstruction** — replay the exact memory state from any prior version.
- **Audit queries** — "what did the agent know at time T?" answered with cryptographic proof.
- **Regression testing** — pin a known-good memory state for deterministic benchmark runs.

### 2.7 Soft-Delete with Tombstoning
Atoms are never physically removed. `DELETE /atoms/:atom` tombstones the atom: it disappears from all active queries but its Merkle proof path remains valid. This preserves the integrity of historical proof chains while removing content from live retrieval.

### 2.8 Conflict Detection
A fact conflict index automatically identifies atoms with competing claims for the same key (e.g., two `fact` atoms asserting different values for the same subject). Conflicts are surfaced in search results so agents can resolve ambiguity explicitly rather than silently picking one.

### 2.9 MCP Server (Native Claude Tool Integration)
MMPM ships a full Model Context Protocol (MCP) server that exposes all memory operations as typed Claude tools. Agents running in Claude Desktop or compatible runtimes can read and write MMPM memory natively without constructing HTTP requests, enabling seamless memory persistence across agent sessions.

### 2.10 Production Observability (Prometheus + Grafana)
A 36-panel Grafana dashboard ships out of the box, covering:
- Ingestion throughput and commit latency
- Shard GC and snapshot metrics
- Markov hit rate and prediction accuracy
- Write policy outcomes and backpressure events
- Merkle proof verification rates

Prometheus metrics are exposed at `/metrics` (unauthenticated, probe-safe). The full stack launches with a single `docker-compose up`.

### 2.11 SLO Benchmarking & CI Gates
The project ships a benchmark harness with configurable SLO thresholds:
- `MMPM_SLO_ACCESS_P95_MS` (default 250ms)
- `MMPM_SLO_CONTEXT_P95_MS` (default 750ms)

CI workflows enforce these thresholds as merge gates. A 10-trial scientific run produces a citable performance baseline with mean, standard deviation, and confidence interval for each metric.

### 2.12 Domain Pilot Packs
Pre-built domain pilots (starting with e-commerce refund workflows) demonstrate end-to-end integration and produce a structured audit-trace report. These serve as reference implementations and sales accelerators for target verticals.

---

## 3. Market Research

### Target Markets
- **AI/ML infrastructure** — startups, research labs, enterprise AI teams building agentic systems.
- **Autonomous agent platforms** — RPA, scientific research, knowledge management.
- **SaaS platforms needing explainable, auditable memory** — finance, legal, healthcare.
- **LLM orchestration and agentic workflow tools** — LangChain, AutoGen, CrewAI integrators.

### Market Trends
- Explosive growth in autonomous agents and LLM-based workflows.
- Regulatory pressure (EU AI Act, HIPAA, SOC 2) driving demand for explainable, auditable AI.
- Shift from "retrieve and forget" vector DBs toward durable, stateful agent memory.
- MCP adoption creating a standardised tool interface for agent memory.

### Competitive Landscape

| Competitor | What they do | mm-memory's edge |
|---|---|---|
| Pinecone / Weaviate / Chroma | Vector similarity search | No proof chains, no prediction, no versioning |
| Neo4j / Stardog | Knowledge graphs | Heavy, expensive, no agent-native interface |
| OpenAI / Anthropic memory | Proprietary, closed | No auditability, no on-prem, vendor lock-in |
| LangChain memory | Thin abstraction layer | No cryptographic integrity, no write governance |

**mm-memory's unique position:** the only open-core memory substrate that combines cryptographic provenance, predictive retrieval, temporal versioning, and write governance in a single embeddable system.

---

## 4. Business Model & Go-to-Market

### Business Models
- **Open-core** — core runtime open source (AGPL/SSPL/BSL); advanced features (compliance dashboard, enterprise SSO, multi-region replication) paid.
- **SaaS** — managed mm-memory cloud with hosted dashboards, auto-scaling, and SLA guarantees.
- **Enterprise licensing** — on-prem deployment, compliance tooling, dedicated support.
- **Consulting/services** — integration, onboarding, custom domain pilots.

### Go-to-Market Steps
1. Launch open-source repo with strong docs, quick-start, and domain pilot packs.
2. Publish benchmark results and the citable scientific baseline.
3. Integrate with agent frameworks: LangChain, AutoGen, CrewAI, Claude MCP.
4. Offer hosted SaaS with Grafana dashboards and SLO monitoring.
5. Target early adopters in research, AI startups, and regulated industries.
6. Build reference customers and publish case studies per vertical.

---

## 5. Intellectual Property Protection

- **Copyright:** all source code, documentation, and onboarding materials.
- **Patents:** novel Markov-Merkle substrate and proof chain architecture (consult IP counsel).
- **Trademarks:** brand, logo, and product names (mm-memory, MMPM).
- **Contributor agreements:** CLA required for all external contributions.
- **Open source license:** AGPL/SSPL/BSL — prevents SaaS competitors from running the software without contributing back or purchasing a commercial license.

---

## 6. Marketing & Sales

### Marketing
- Technical blogs and benchmarks demonstrating performance and auditability advantages.
- Community building: Discord, GitHub discussions, monthly office hours.
- Conference talks and webinars targeting AI/MLOps and compliance-focused audiences.
- Thought leadership: whitepapers on explainable AI memory and agent governance.
- Partnerships with agent frameworks and cloud providers.

### Sales
- **Inbound:** open-source adoption and content marketing driving organic demand.
- **Outbound:** targeted enterprise outreach in regulated industries (finance, healthcare, legal).
- **Customer success:** structured onboarding, integration support, and domain pilot co-development.
- **Reference customers:** prioritise lighthouse accounts in each target vertical.
