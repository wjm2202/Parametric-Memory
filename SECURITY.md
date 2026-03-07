# Security Policy

## Scope

This document covers the MMPM (Markov-Merkle Parametric Memory) server and
all tooling in this repository.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Send a private report to the maintainer via GitHub's
[Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
feature (Security → Report a vulnerability on this repo's page).

Include:
- A description of the vulnerability
- Steps to reproduce / proof-of-concept
- Affected versions
- Suggested fix (optional)

You will receive an acknowledgment within 72 hours.  Critical issues (RCE,
auth bypass, data exfiltration) will be patched and released within 7 days.

---

## Supported versions

| Branch / version | Security fixes |
|-----------------|----------------|
| `main`          | ✅ Yes          |
| Older tags      | ❌ No           |

---

## Security architecture

### Authentication

MMPM uses Bearer token authentication on all endpoints except probe paths
(`/health`, `/ready`, `/verify`).

- Set `MMPM_API_KEY` to a strong random secret (`openssl rand -hex 32`).
- For multi-client deployments use `MMPM_API_KEYS=name:key,name:key,...` to
  issue per-integration named keys. Client names appear in audit log entries.
- If neither variable is set, **authentication is disabled** — acceptable only
  on a loopback-only, single-user machine.

### Network binding

MMPM binds to `127.0.0.1` by default (since S16-1).  To expose it to remote
clients, run it behind a TLS-terminating reverse proxy (see
[`integrations/deploy/`](integrations/deploy/)) and **leave `HOST=127.0.0.1`**.

Setting `HOST=0.0.0.0` without TLS exposes the API key in plaintext over the
network — do not do this in production.

### Prompt-injection defence (S16-4)

Atoms are returned in context blocks prefixed with `[MEMORY]` to signal to AI
models that the content is data, not instructions.  Atoms whose values contain
instruction-like tokens (`ignore`, `override`, `bypass`, `system_prompt`, etc.)
are automatically flagged and require `reviewApproved:true` to be stored.

**Never store user-supplied free-text directly as atom values** without
sanitisation.  Atom values should be short, snake_case identifiers, not
natural-language sentences.

### Secrets in atoms (S16-7)

Set `MMPM_BLOCK_SECRET_ATOMS=1` to reject atoms whose values match common
secret/credential patterns (`password`, `api_key`, `token`, `private_key`,
`secret`, `credential`, `access_token`).

**Do not store passwords, API keys, or credentials as atom values.**
MMPM is a semantic memory store, not a secret manager.  Use a dedicated
secrets manager (Vault, AWS Secrets Manager, 1Password) for credentials.

### Audit log

All mutation and significant read operations are recorded in an in-memory
ring buffer (default 1 000 entries).  Query it via `GET /audit`:

```bash
curl -H "Authorization: Bearer $MMPM_API_KEY" http://localhost:3000/audit
```

The audit log records:
- `atom.add` / `atom.tombstone` — write operations, with client name
- `admin.commit` / `admin.import` / `admin.export` — admin operations
- `review.bypass` — when `reviewApproved:true` bypassed the review tier
- `memory.bootstrap` / `memory.context` / `atoms.list` — read operations
- `memory.time_travel` — historical queries (`asOfMs` / `asOfVersion`)

The audit log is in-memory and does not survive server restarts.  For
persistent audit trails, configure `MMPM_WEBHOOK_URL` to receive events.

### Time-travel API

The `asOfMs` and `asOfVersion` query parameters allow reading historical atom
states, including soft-deleted (tombstoned) atoms.  This is intentional for
auditability.  All time-travel queries are recorded in the audit log (`memory.time_travel`).

If your threat model prohibits reading tombstoned atoms, restrict access to the
`/memory/context` and `/memory/bootstrap` endpoints at the proxy layer.

### Export endpoint

`GET /admin/export` streams the full atom database as NDJSON.  It is protected
by Bearer auth but represents a full data dump.  Consider blocking it at the
nginx layer for all IPs except your backup host:

```nginx
location /admin/export {
    allow 10.0.0.5;   # backup server only
    deny all;
    proxy_pass http://127.0.0.1:3000;
}
```

---

## Known limitations

| Item | Status |
|------|--------|
| No per-IP rate limiting | Low priority; mitigated by Bearer auth |
| Audit log is in-memory only | Use webhook for persistence |
| Merkle history is bounded | Configurable retention window |
| No mTLS | Use IP allowlist at nginx layer for equivalent isolation |

---

## Security hardening checklist

- [ ] `MMPM_API_KEY` set to a strong random key
- [ ] `HOST=127.0.0.1` (default) — not `0.0.0.0`
- [ ] TLS via nginx reverse proxy for any remote access
- [ ] `MMPM_BLOCK_SECRET_ATOMS=1` in production
- [ ] `/admin/export` blocked at proxy except for backup host
- [ ] `MMPM_METRICS_PUBLIC=0` (default) — or restrict via nginx IP allowlist
- [ ] Webhook configured for persistent audit trail
- [ ] Per-client keys (`MMPM_API_KEYS`) for multi-integration deployments
