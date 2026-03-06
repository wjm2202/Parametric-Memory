# Parametric-Memory — Launch Orchestration Plan

> Coordinated by: Entity One
> Persona: Anonymous technical founder, Satoshi-style — cryptographically provable work speaks louder than identity.
> Brand: **Parametric-Memory** | Product: MMPM (Markov-Merkle Predictive Memory)
> Repo: `wjm2202/Parametric-Memory` (private until coordinated launch)
> Twitter/X: `@_EntityOne`
> Domain: `parametric-memory.dev`
> License: AGPL-3.0
> **Launch Date: April 6, 2026**

---

## Overview

This document defines the sub-agent orchestration structure for executing the Parametric-Memory launch. Each agent operates in a defined domain, receives specific instructions, and reports outcomes to the Launch Coordinator. The Launch Coordinator (this document's owner) sequences the gates between stages.

**Principle:** Do not announce before everything is ready. Every asset, post, and profile should be finalized and staged before a single thing goes live. Satoshi didn't tweet about Bitcoin before the genesis block.

---

## Agent Roster

| Agent | Domain | Primary Deliverable |
|---|---|---|
| **Architect** | Technical README + docs | Public-ready README.md, API reference stub |
| **Brand** | Identity + visual assets | Logo (done), color system, taglines |
| **Content** | Copywriting + messaging | Launch post drafts, bio copy |
| **GitHub** | Public repo setup | Profile README, pinned repo, topics/tags |
| **Twitter/X** | Social presence | Account bio, pinned tweet, 5-post launch sequence |
| **LinkedIn** | Professional presence | Profile/page update, announcement post |
| **Launch Coord** | Sequencing + go-live | Checklist, timing, coordinated publish |

---

## Stage Gates

```
[STAGE 0: Assets]         Logo ✅  |  Taglines ✅  |  Color System ✅
        │                 Twitter header banner ✅
        ▼
[STAGE 1: Tech Readout]   README ✅  |  Benchmark summary ✅  |  API docs ✅
        │                 Landing page ✅  |  LICENSE file ✅  |  CI badge ⬜
        ▼
[STAGE 2: Profiles]       GitHub profile README ✅  |  Repo metadata ✅
        │                 Twitter/X @_EntityOne ⬜ (register manually)
        │                 LinkedIn ⬜ (post manually on launch day)
        ▼
[STAGE 3: Content Staged] Launch posts written ✅  |  LinkedIn post ✅
        │                 Posts staged as drafts in Twitter ⬜ (after account created)
        ▼
[STAGE 4: Repo Public]    git push origin graph + merge to main ⬜ (YOU run this)
        │                 v0.1.0 draft release ✅ (attach benchmark .md + publish April 6)
        │                 Repo → public April 6 ⬜
        ▼
[STAGE 5: Launch]         Coordinated publish across all channels ⬜
```

---

## Agent Instructions

### Agent: Architect

**Mission:** Write a README.md that makes a senior ML engineer stop scrolling.

**Tone:** Technical, precise, no fluff. Show benchmarks, not claims. Let the numbers explain the product.

**Key sections to include:**
- One-line summary ("A cryptographically verifiable, Markov-predictive memory substrate for AI agents")
- Architecture diagram (ASCII or Mermaid)
- Quickstart (Docker one-liner)
- API surface (5 key endpoints)
- Benchmark results (from scientific run: 64% Markov hit rate, 0.032ms p95 proof verify, 0 stale reads)
- Why not a vector DB? (positioned as complementary, not competing)
- MCP integration section
- License + contributing

**Do not include:** Roadmap promises, investor language, feature wishlists. Only what ships today.

---

### Agent: Brand

**Mission:** Define and lock the visual identity for all channels.

**Confirmed assets:**
- **Logo:** Merkle tree, 7 nodes, electric teal (#00d4ff) on deep space black (#0a0a0f), subtle "P" shape. ✅
- **Primary color:** Electric teal `#00d4ff`
- **Background:** Deep space black `#0a0a0f`
- **Secondary:** Pure white `#ffffff`
- **Accent:** Midnight navy `#0d1117` (GitHub-compatible background)

**Tagline options (select one or hybrid):**
1. *"Memory with proof."*  — minimal, cryptographic
2. *"AI memory that can prove it."* — accessible
3. *"Verifiable. Predictive. Sovereign."* — three pillars
4. **Recommended:** `"Memory with proof."` — 3 words, works at any size, prints on a t-shirt

**Persona voice (Entity One):**
- Never says "I built this" — says "this was built"
- References math and systems, never hype
- Doesn't explain why they're anonymous — just isn't
- Engages technically, ignores noise
- Posts are sparse, precise, and quotable

---

### Agent: Content

**Mission:** Write all launch copy in advance. Nothing should be typed live on launch day.

**Deliverables:**

#### Twitter/X — Bio
```
cryptographic memory for AI agents. verifiable. predictive. sovereign.
parametric-memory.dev  (or github link until domain)
```

#### Twitter/X — Pinned tweet (post launch)
```
memory that can prove itself.

MMPM: a sharded Merkle-Markov memory substrate for AI agents.

→ every stored atom has a cryptographic proof path
→ the system predicts what comes next as you retrieve
→ 64% Markov hit rate / 0 stale reads / p95 proof verify 0.032ms

parametric-memory.dev
```

#### Twitter/X — 5-post launch sequence

**Post 1 (T+0h, launch trigger):**
```
memory with proof.

open-source AI memory substrate. every atom cryptographically verifiable.
transitions learned. retrieval predictive.

Parametric-Memory.

parametric-memory.dev
```

**Post 2 (T+2h, technical hook):**
```
most AI memory systems can retrieve.

none can prove.

Merkle proof paths on every atom.
tamper-evident. audit-ready. historically pinnable to any prior version.

you asked the agent what it knew at 14:32:11 UTC on March 3rd.
it can show you. cryptographically.
```

**Post 3 (T+6h, prediction angle):**
```
retrieval is half the picture.

the other half: what comes next?

MMPM learns weighted Markov transitions between atoms as the system is used.
on every access, it returns the predicted next atom — with its own proof.

64% hit rate on benchmark corpus. cold start.
```

**Post 4 (T+24h, benchmark drop):**
```
numbers, not claims.

10-trial scientific benchmark. HTTP API mode. fresh server per trial.

3,888 ops/sec mixed read/write
p50 access: 1.22ms
p95 proof verify: 0.032ms
stale reads: 0
proof failures: 0

protocol in the repo. reproduce it yourself.
```

**Post 5 (T+48h, MCP + ecosystem angle):**
```
ships with a full MCP server.

Claude agents can read and write MMPM memory natively —
no HTTP plumbing, no JSON serialisation.
just tools.

one-line Docker start. Prometheus metrics at /metrics. 36-panel Grafana out of the box.

memory infrastructure. not a product feature.
```

#### LinkedIn — Announcement post (hold until repo is public)

```
Today I'm releasing Parametric-Memory — an open-source memory substrate for AI agents that does something most memory systems can't: prove what it stored.

Every atom in MMPM carries a cryptographic Merkle proof path. Any record can be independently verified against the current tree root. Nothing can be silently altered — every mutation invalidates the proof.

On top of that, the system learns. Markov transition weights are updated on every access, so retrieval doesn't just return what you asked for — it predicts what comes next. At 64% hit rate on a cold benchmark corpus, the prediction layer is useful from day one.

Some numbers from the scientific benchmark (10 independent trials, HTTP API mode):

• 3,888 ops/sec mixed read/write throughput
• p50 access latency: 1.22ms
• p95 proof verification: 0.032ms
• Stale reads: 0
• Proof failures: 0

It's fully open-source, ships with a complete MCP server for Claude integration, a Prometheus + Grafana stack, and a reproducible benchmark harness with SLO gates.

For teams building regulated AI systems, agents that need persistent cross-session memory, or anyone who has asked "what exactly did the model know at time T?" — this is the infrastructure layer that's been missing.

→ parametric-memory.dev

#AIAgents #OpenSource #MachineLearning #CryptographicSystems
```

---

### Agent: GitHub

**Mission:** Make the public GitHub presence credible on first click.

**Checklist:**
- [x] Repo description: "Cryptographically verifiable, Markov-predictive memory substrate for AI agents" ✅
- [x] Topics/tags: `ai-memory`, `merkle-tree`, `markov-chain`, `llm`, `mcp`, `typescript`, `ai-agents`, `memory-substrate`, `verifiable-ai` ✅
- [x] Profile README (wjm2202/wjm2202) live ✅
- [ ] Push public README to remote and merge to `main`:
  ```bash
  cd markov-merkle-memory
  git push origin graph
  # then open PR: graph → main, or merge directly
  ```
  > ⚠️ README.md (public launch version) is committed on the `graph` branch locally. Must be pushed and merged before repo goes public on April 6.
- [ ] Pin Parametric-Memory repo on profile (after it goes public)
- [ ] Logo as social preview image (Settings → Social preview)
- [ ] License: AGPL-3.0 ✅ (set in package.json)
- [ ] GitHub Actions badge in README (CI status)
- [ ] Releases: Tag v0.1.0 with benchmark report attached

**Profile README (wjm2202):**
```markdown
### entity one

building memory infrastructure for AI agents.

→ [Parametric-Memory](https://parametric-memory.dev) — verifiable. predictive. sovereign.
```

---

### Agent: Twitter/X

**Mission:** Account ready to go, everything staged, nothing published until launch gate opens.

**Account setup:**
- Handle: `@_EntityOne` ✅
- Display name: `Parametric-Memory`
- Bio: see Content agent
- Profile picture: Logo (Merkle tree icon)
- Header: Simple teal/black gradient with tagline "memory with proof."
- Location: `parametric-memory.dev`
- Pinned tweet: Staged (see Content agent — Post 1)

---

### Agent: LinkedIn

**Mission:** Single high-impact announcement post. Hold until all other channels are ready.

**Profile update (Entity One persona — or operate as product page):**
- Bio: "Building memory infrastructure for AI agents."
- Link: repo URL
- Banner: Teal/black with logo

**Post:** See Content agent — LinkedIn announcement post

**Timing:** LinkedIn fires LAST. Highest signal-to-noise, longest shelf life. Post after Twitter sequence is live.

---

### Agent: Launch Coordinator

**Mission:** Nothing goes live until all gates pass. Then everything goes live within a 2-hour window.

**Launch Checklist:**
- [ ] Logo finalized and saved as PNG + SVG
- [ ] README.md final review
- [ ] Repo set to public
- [ ] GitHub topics set
- [ ] Twitter/X account created, bio set, all 5 posts staged as drafts
- [ ] LinkedIn post drafted and saved
- [ ] Benchmark report attached to v0.1.0 release
- [ ] Launch date confirmed
- [ ] T+0: Repo goes public
- [ ] T+0: Twitter Post 1 fires
- [ ] T+2h: Twitter Post 2
- [ ] T+6h: Twitter Post 3
- [ ] T+24h: Twitter Post 4 (benchmark drop)
- [ ] T+48h: Twitter Post 5 (MCP)
- [ ] T+72h: LinkedIn announcement post

---

## Open Questions (Entity One to Decide)

1. **Domain:** `parametric-memory.dev` ✅ — register at Cloudflare Registrar (~$10/yr, HTTPS-only by default). Verified available 2026-03-06.
2. **Twitter handle:** `@_EntityOne` ✅
3. **License:** AGPL-3.0 ✅ (open-core — network deployment requires source disclosure, driving enterprise upsells)
4. **Launch date:** April 6, 2026 ✅
5. **v0.1.0 tag:** Ready to cut a release tag on current main?

---

## jCodeMunch-MCP Integration Note

jCodeMunch-mcp is a token-efficient MCP server that indexes the codebase using tree-sitter ASTs, enabling symbol-level navigation without reading whole files. Adding it to MMPM would:

- Allow contributors to explore the codebase via Claude Desktop without reading all files
- Demonstrate MMPM's MCP ecosystem compatibility
- Signal technical depth to the open-source community

**Recommendation:** Add as optional dev dependency with instructions in CONTRIBUTING.md. Do not bundle in the default install. Include a note in README: "For contributors: jCodeMunch-mcp enables AI-assisted codebase navigation."

---

*This document is the single source of truth for launch coordination. Update stage gates as each item is completed.*
