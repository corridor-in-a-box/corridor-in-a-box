# Always-On Testnet Service & Rate Collector Deployment Guide

This guide documents the production deployment of `@corridor/service` and the background rate collector process on an always-on host for Stellar Testnet operations (RFC 0004 §3 and §6).

---

## 1. Overview & Architecture

Serverless environments (such as Vercel Edge/Serverless functions) cannot maintain persistent network listeners or background recurring quote/rate collection timers. `@corridor/service` and the route rate collector must run on an **always-on container host** (e.g. Fly.io, AWS ECS Fargate, Railway, or a dedicated Linux VM with Docker / systemd).

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          ALWAYS-ON HOST RUNTIME                        │
│                                                                        │
│  ┌───────────────────────┐             ┌────────────────────────────┐  │
│  │   @corridor/service   │             │       Rate Collector       │  │
│  │   (HTTP daemon: 8080) │             │    (Background Cron/Loop)  │  │
│  │                       │             │                            │  │
│  │   • GET /healthz      │             │  • Scrapes quotes/rates    │  │
│  │   • GET /readyz       │             │  • Pre-warms route cache   │  │
│  │   • POST /payments    │             │  • Checks circuit breaker  │  │
│  │   • GET /metrics      │             │                            │  │
│  └───────────┬───────────┘             └─────────────┬──────────────┘  │
│              │                                       │                 │
│              ▼                                       ▼                 │
│     Postgres Database (DATABASE_URL: Idempotency & Audit Records)     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Container Images

Deployments utilize the container image built and published by `.github/workflows/docker-publish.yml` from the root `Dockerfile`:

- **Image**: `ghcr.io/corridor-in-a-box/corridor-service:latest`
- **Runtime**: Node.js 22 LTS (Alpine base)
- **User**: Non-root `node` (UID 1000)
- **Ports**: `EXPOSE 8080`
- **Manifests**: Read-only `corridors/` copied at build time.

---

## 3. Secret Management (Zero-Leak Policy)

Secrets **must never be baked into container images or committed to git**. Configure secrets strictly via the hosting platform's secure secret store (e.g. AWS Secrets Manager, HashiCorp Vault, Fly Secrets, or encrypted environment stores).

### Environment Variables

| Variable                            |  Required   | Default / Example                     | Purpose                                                                                       |
| :---------------------------------- | :---------: | :------------------------------------ | :-------------------------------------------------------------------------------------------- |
| `PORT`                              |     No      | `8080`                                | Listening port for the HTTP service                                                           |
| `CORRIDOR_SIGNER`                   |     Yes     | `vault` (or `local`)                  | Key custody mechanism (`vault` recommended per [`docs/key-management.md`](key-management.md)) |
| `CORRIDOR_SIGNER_SECRET`            | Conditional | `S...`                                | Stellar secret seed (required if `CORRIDOR_SIGNER=local`; testnet only!)                      |
| `VAULT_ADDR`                        | Conditional | `https://vault.internal:8200`         | Transit vault address (if `CORRIDOR_SIGNER=vault`)                                            |
| `VAULT_TOKEN`                       | Conditional | `hvs...`                              | Transit vault access token                                                                    |
| `VAULT_TRANSIT_KEY`                 | Conditional | `corridor-signer`                     | Transit signing key identifier                                                                |
| `HORIZON_URL`                       |     Yes     | `https://horizon-testnet.stellar.org` | Stellar Testnet Horizon RPC endpoint                                                          |
| `DATABASE_URL`                      |     Yes     | `postgres://user:pass@host:5432/db`   | PostgreSQL connection for idempotency and audit logs                                          |
| `CORRIDOR_API_KEYS`                 |     Yes     | `key1,key2`                           | Comma-separated API keys for authorized clients                                               |
| `CORRIDOR_RATELIMIT_CAPACITY`       |     No      | `20`                                  | Max burst requests per client IP                                                              |
| `CORRIDOR_RATELIMIT_REFILL_PER_SEC` |     No      | `5`                                   | Refill rate per second                                                                        |
| `CORRIDORS_DIR`                     |     No      | `corridors`                           | Directory containing corridor manifests                                                       |

---

## 4. Health Checks: `/healthz` and `/readyz`

The service exposes standard HTTP probes configured for load balancers and container orchestrators:

### 1. Liveness Probe (`GET /healthz`)

- **Purpose**: Verifies that the process is alive and the Node.js event loop is responding.
- **Access**: Public, unmetered, no authentication required.
- **Behavior**: Always returns `200 OK` with JSON:
  ```json
  { "status": "ok" }
  ```
- **Orchestrator Config**:
  ```yaml
  livenessProbe:
    httpGet:
      path: /healthz
      port: 8080
    initialDelaySeconds: 5
    periodSeconds: 10
  ```

### 2. Readiness Probe (`GET /readyz`)

- **Purpose**: Verifies that all required backing services (Postgres database, RPC dependencies) are healthy and ready to process traffic.
- **Access**: Public, unmetered, no authentication required.
- **Behavior**:
  - **Healthy (`200 OK`)**: All registered readiness checks pass:
    ```json
    {
      "status": "ok",
      "checks": [{ "name": "store", "ok": true }]
    }
    ```
  - **Degraded (`503 Service Unavailable`)**: Any dependency check fails or times out (5-second timeout per check). Internal connection strings and stack traces are suppressed for security.
  - **Draining (`503 Service Unavailable`)**: When `SIGTERM` or `SIGINT` is received, the service enters draining mode: `/readyz` immediately returns 503 so upstream load balancers stop sending new requests while in-flight payments finish.

---

## 5. Deployment Recipes

### Option A: Docker Compose (VM / Always-On Instance)

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_DB: corridor
      POSTGRES_USER: corridor
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    secrets:
      - pg_password

  corridor-service:
    image: ghcr.io/corridor-in-a-box/corridor-service:latest
    restart: always
    ports:
      - "8080:8080"
    environment:
      PORT: "8080"
      HORIZON_URL: "https://horizon-testnet.stellar.org"
      DATABASE_URL: "postgres://corridor:password@postgres:5432/corridor"
      CORRIDOR_SIGNER: "local"
      CORRIDOR_SIGNER_SECRET_FILE: "/run/secrets/signer_secret"
      CORRIDOR_API_KEYS: "production-testnet-key"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
    depends_on:
      - postgres

secrets:
  pg_password:
    external: true
  signer_secret:
    external: true

volumes:
  pgdata:
```

### Option B: Fly.io Deployment

1. Launch app with secrets:

   ```bash
   fly secrets set \
     DATABASE_URL="postgres://..." \
     CORRIDOR_SIGNER_SECRET="S..." \
     CORRIDOR_API_KEYS="sec_key_..." \
     HORIZON_URL="https://horizon-testnet.stellar.org"
   ```

2. Configure `fly.toml` health checks:
   ```toml
   [http_service]
     internal_port = 8080
     force_https = true
     auto_stop_machines = false
     auto_start_machines = true
     min_machines_running = 1

     [[http_service.checks]]
       interval = "10s"
       timeout = "2s"
       grace_period = "5s"
       method = "get"
       path = "/readyz"
       protocol = "http"
   ```

---

## 6. Running the Background Rate Collector

The rate collector runs alongside the service to fetch exchange rates, evaluate fee tables, and maintain warm routing tables. In an always-on host environment, the collector runs either as a companion background process (via systemd or supervisord) or as a scheduled cron service:

```bash
# Run rate sweep / collection cycle
pnpm sweep:anchors --out /tmp/rate-sweep/
```

Keepers and monitoring dashboards consume the output from `/tmp/rate-sweep/sweep-report.json` to verify that all tracked anchors continuously advertise valid asset conversions and quotes.
