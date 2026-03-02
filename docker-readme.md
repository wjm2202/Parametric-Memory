# Docker Operations — MMPM

## Stack overview

| Service | Image | Port | Profile |
|---|---|---|---|
| `mmpm-service` | Built from `Dockerfile` (`production` stage) | `3000` | default |
| `prometheus` | `prom/prometheus:latest` | `9090` | default |
| `grafana` | `grafana/grafana:latest` | `3001` | default |
| `mmpm-test` | Built from `Dockerfile` (`test` stage) | — | `test` |

`mmpm-test` has `profiles: [test]` so it is **never started** by `docker compose up`.
It only runs when explicitly invoked.

---

## Daily workflow

```bash
# First-time or after any source change: build and start the full stack
docker compose up -d --build

# Start the stack using the existing image (no rebuild)
docker compose up -d

# Stop the stack (keeps volumes)
docker compose down

# Stop and wipe all persistent data (LevelDB + Grafana state)
docker compose down -v
```

Readiness behavior:
- `mmpm-service` reports healthy only when `GET /ready` returns `200`.
- `prometheus` and `grafana` wait for `mmpm-service` health before starting.
- You can inspect readiness directly with `curl -i http://localhost:3000/ready`.
- CI one-step benchmark: `npm run bench:ci:api` (starts compose, waits for healthy, runs benchmark, tears down).

---

## Building

```bash
# Build only mmpm-service (skips prometheus, grafana, mmpm-test)
docker compose build

# Force a full rebuild ignoring the layer cache
docker compose build --no-cache

# Build just the test image in isolation
docker build --target test -t mmpm-test .
```

`docker compose build` builds everything that has a `build:` block **and** no restricting profile.
That means only `mmpm-service` — Prometheus and Grafana use pre-pulled images; `mmpm-test` is hidden by its profile.

Both `mmpm-service` and `mmpm-test` share the same build context (`.`) and the same `builder` stage, so Docker's layer cache is reused between them. A `--build mmpm-test` after a normal build is fast.

---

## Running tests in the container

```bash
# Build the test image and run the full suite (exits when done)
docker compose run --rm mmpm-test

# Force a fresh rebuild of the test image first (use after source changes)
docker compose run --rm --build mmpm-test

# Run a single test file
docker compose run --rm mmpm-test npx vitest run src/__tests__/security.test.ts

# Run with verbose per-test output
docker compose run --rm mmpm-test npx vitest run --reporter=verbose

# Run just the load tests
docker compose run --rm mmpm-test npx vitest run src/__tests__/load.test.ts
```

The test DB lives on a `tmpfs` mount inside the container — it never touches host disk and is discarded on exit.

---

## Image stage layout

```
builder  ──owns──▶  npm install (all deps)  +  tsc  +  src/__tests__/
   │
   ├──▶  test stage       (FROM builder — inherits everything; runs npm test)
   │
   └──▶  production stage (FROM node:20-alpine — copies only dist/ from builder)
                           ╰── test files, devDependencies, src/ never reach here
```

Why `src/__tests__/` was removed from `.dockerignore`:
the builder needs the test files to run `npm test` in the `test` stage.
The production stage never copies them because it only does `COPY --from=builder /app/dist ./dist`.

---

## Heap limit

The production and test containers both set:

```
ENV NODE_OPTIONS=--max-old-space-size=512
```

V8's automatic heuristic uses ~75 % of container-visible RAM, which varies unpredictably under Docker memory limits. The explicit ceiling prevents silent OOM kills on memory-constrained hosts.

Override at runtime for larger workloads:

```bash
docker run -e NODE_OPTIONS=--max-old-space-size=1024 ...
# or via compose
docker compose run -e NODE_OPTIONS=--max-old-space-size=1024 mmpm-test
```

---

## Grafana password drift

Grafana persists the admin password in the `grafana-data` named volume on first boot.
On subsequent restarts, `GF_SECURITY_ADMIN_PASSWORD` is **ignored** if the volume already exists.

**Symptom:** login with `admin/admin` fails after changing the password env var.

**Fix:**

```bash
# Option 1: reset the password in the running container
docker exec markov-merkle-memory-grafana-1 grafana-cli admin reset-admin-password admin

# Option 2: wipe the volume and let Grafana re-initialise from env vars
docker compose down -v
docker compose up -d
```

---

## Grafana Live / WebSocket logs

Grafana's frontend always attempts a WebSocket connection to `/api/live/ws` on page load.
Unauthenticated attempts (second tabs, pre-login refreshes) produce `status=401 error="context canceled"` log lines. These are harmless — Grafana handled them correctly.

Suppressed via `GF_LOG_FILTERS=context:warn` in `docker-compose.yml`.
Grafana Live itself remains enabled (needed for Unified Alerting and streaming datasources).

---

## Removing the obsolete `version:` warning

```
WARN: the attribute `version` is obsolete, it will be ignored
```

Remove the `version: '3.8'` line from the top of `docker-compose.yml` to silence it.
It has no effect on behaviour — Compose V2 ignores it.
