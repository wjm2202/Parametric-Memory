# Contributing to Parametric-Memory

Thanks for taking an interest in contributing. Please read this before opening a PR.

---

## Before you start

For anything beyond a small bug fix, **open an issue first**. Describe what you want to add or change and why. This saves everyone time — architectural or scope questions are much cheaper to resolve before code is written.

---

## Development setup

```bash
git clone https://github.com/wjm2202/Parametric-Memory.git
cd Parametric-Memory
npm run setup
```

`npm run setup` installs dependencies, compiles TypeScript, and creates `.env` from `.env.example` if it doesn't exist. After that:

```bash
node dist/server.js    # start the server
npm test               # run all tests
npm run typecheck      # type-check src + tests
```

---

## Project layout

```
src/                  TypeScript source
  server.ts           Fastify HTTP server — all routes
  orchestrator.ts     Sharded LevelDB coordination
  ingestion.ts        Write-ahead log + ingestion pipeline
  incremental_merkle.ts  Merkle tree engine
  csr_matrix.ts       Sparse transition matrix
  transition_policy.ts   Per-type write policy
  atom_schema.ts      Atom format + validation
  audit_log.ts        In-memory audit ring buffer
  ttl_registry.ts     Per-atom TTL tracking

src/__tests__/        Vitest test suite (38 files, 671 tests)

tools/
  harness/            Benchmark harness + SLO gate
  mcp/                MCP server + tool catalog

integrations/
  claude-skill/       Claude Cowork skill
  claude-desktop/     Claude Desktop MCP config
  vscode/             VSCode / Claude Code integration

scripts/              Smoke tests and demo scripts
docs/                 Architecture docs, benchmark protocol
grafana/              Grafana dashboard panels
```

---

## Code style

- TypeScript — strict mode, no `any` without a comment explaining why
- No external formatter enforced currently; match the style of the file you're editing
- Prefer explicit types on function signatures
- Keep source files focused — one responsibility per module

---

## Tests

Every change to `src/` should have test coverage. Run the relevant test file during development:

```bash
npm test -- server.test        # server API tests
npm test -- ingestion.test     # ingestion pipeline tests
npm test                       # full suite
```

All 671 tests must pass before submitting a PR. Run `npm run typecheck` as well — TypeScript errors will fail CI.

---

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all 671 tests)
- [ ] New behaviour is covered by tests
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] PR description explains *what* changed and *why*

---

## Atom schema changes

Adding a new atom type requires changes in four places:

1. `src/atom_schema.ts` — add to `ATOM_TYPES` array and update `V1_PATTERN` regex
2. `src/transition_policy.ts` — add to `TYPE_TO_INDEX` (must be exhaustive)
3. `src/server.ts` — update all type enum strings
4. `tools/mcp/mmpm_mcp_server.ts` — update all type enum arrays

---

## License

By contributing you agree that your contributions will be licensed under the project [LICENSE](LICENSE) (personal use free; commercial use requires a paid agreement).
