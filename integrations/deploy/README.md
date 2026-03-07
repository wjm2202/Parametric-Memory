# MMPM — Production Deployment Guide

This directory contains reference configurations for deploying MMPM behind a
TLS-terminating reverse proxy.

---

## Security baseline (S16)

Before exposing MMPM outside localhost, ensure these settings are in your `.env`:

| Setting | Recommended value | Why |
|---------|-------------------|-----|
| `HOST` | `127.0.0.1` | Loopback-only; nginx handles external traffic |
| `MMPM_API_KEY` | Strong random key (`openssl rand -hex 32`) | Auth for all endpoints |
| `MMPM_API_KEYS` | `mcp:<key>,claude:<key>,...` | Per-client keys for audit attribution |
| `MMPM_METRICS_PUBLIC` | `0` | /metrics behind auth (Prometheus can use Bearer) |
| `MMPM_BLOCK_SECRET_ATOMS` | `1` | Reject atoms that look like secrets/credentials |
| `WRITE_POLICY` | `review-required` | Require human review for external-facing deployments |

---

## nginx + TLS (recommended)

See [`nginx.conf.example`](nginx.conf.example) for a complete configuration with:

- HTTP → HTTPS redirect
- TLS 1.2/1.3 with Mozilla Intermediate cipher suite
- HSTS header
- Optional IP allowlist
- Proxy forwarding of real client IPs for audit logs
- `/admin/export` blocked at the proxy layer (loopback-only)

### Quick start

```bash
# Install
sudo apt install nginx certbot python3-certbot-nginx

# Get a certificate
sudo certbot --nginx -d memory.example.com

# Install the config
sudo cp nginx.conf.example /etc/nginx/sites-available/mmpm
sudo ln -s /etc/nginx/sites-available/mmpm /etc/nginx/sites-enabled/mmpm
sudo nginx -t && sudo systemctl reload nginx
```

### Self-signed certificate (internal / dev)

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/mmpm-selfsigned.key \
  -out /etc/ssl/certs/mmpm-selfsigned.crt \
  -subj "/CN=mmpm.internal"
```

Then update `ssl_certificate` and `ssl_certificate_key` in `nginx.conf.example`.

---

## Docker with TLS

When running via Docker Compose, mount the nginx config as a sidecar:

```yaml
services:
  mmpm:
    build: .
    environment:
      HOST: "127.0.0.1"       # still loopback inside the compose network
      PORT: "3000"
      MMPM_API_KEY: "${MMPM_API_KEY}"
    volumes:
      - mmpm-data:/root/.mmpm/data

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf.example:/etc/nginx/conf.d/mmpm.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    depends_on:
      - mmpm

volumes:
  mmpm-data:
```

> **Note:** Inside a Compose network `127.0.0.1` in the mmpm container is
> isolated from the nginx container.  Either set `HOST=0.0.0.0` *and* restrict
> the Compose network, or use the service name (`proxy_pass http://mmpm:3000`)
> and keep the port unexposed (`expose:` not `ports:`).

---

## Prometheus scraping

If your Prometheus scraper cannot send `Authorization` headers, set:

```
MMPM_METRICS_PUBLIC=1
```

And restrict `/metrics` at the nginx layer with an IP allowlist instead:

```nginx
location /metrics {
    allow 10.0.0.5;   # Prometheus server
    deny all;
    proxy_pass http://127.0.0.1:3000;
}
```

---

## Firewall checklist

- [ ] Port 3000 NOT exposed publicly (HOST=127.0.0.1 handles this)
- [ ] Port 443 open for HTTPS
- [ ] Port 80 open for HTTP→HTTPS redirect (or block and use 443-only)
- [ ] SSH key-based auth only (no password SSH)
- [ ] ufw / iptables default-deny inbound
