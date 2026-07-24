# O3 Capital Workspace — Deployment Guide

**Stack:** Go backend (chi router) + React 18/TypeScript frontend  
**Backend host:** On-premises server | **Frontend:** Served by Nginx on the same server | **DB:** PostgreSQL (self-hosted or Supabase)

---

## Architecture Overview

```
Internet
   │
   ▼
Nginx (80/443)  ← handles TLS, serves React SPA, proxies /api/*
   │
   ├── /api/* ──────────► Go API container (port 8000, internal only)
   │                           │
   └── /* (static) ◄──── frontend/dist/ (built by CI, synced via rsync)
                              │
                          PostgreSQL (on-prem or Supabase)
```

Docker Compose manages the Go API and Nginx as containers. The React frontend is built on CI and copied to the server as static files — no Node.js needed on the server at runtime.

---

## Server Prerequisites

Run once on the on-prem server:

```bash
# Install Docker + Docker Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # let current user run docker without sudo
newgrp docker

# Create deploy user (CI SSHes in as this user)
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy

# Add your CI public key to the deploy user's authorized_keys
sudo -u deploy bash -c "mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Clone the repo
sudo mkdir -p /opt/o3c
sudo chown deploy:deploy /opt/o3c
sudo -u deploy git clone https://github.com/Temitope-O3Capital/o3c-reports.git /opt/o3c
```

### TLS certificate (Let's Encrypt)

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d workspace.o3ccards.com
# Cert lands at /etc/letsencrypt/live/workspace.o3ccards.com/
```

Certbot auto-renews. Update `nginx.conf` with your actual domain where it says `YOUR_DOMAIN`.

---

## Environment Variables

Create `/opt/o3c/backend-go/.env` on the server (never commit this file):

```bash
# Database
DATABASE_URL=postgres://user:password@host:5432/o3c_prod

# Auth
SECRET_KEY=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -base64 24 | head -c 32>

# CORS — must include your frontend origin
ALLOWED_ORIGINS=https://workspace.o3ccards.com

# Security
BOOTSTRAP_SECRET=<openssl rand -hex 16>
METRICS_TOKEN=<openssl rand -hex 16>

# Optional integrations
SENDGRID_API_KEY=
TERMII_API_KEY=
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
MSSQL_SERVER=
MSSQL_DATABASE=
MSSQL_USER=
MSSQL_PASSWORD=
```

**Never** use placeholder values in production. The backend rejects weak `SECRET_KEY` and `ENCRYPTION_KEY` at startup.

---

## GitHub Secrets

In **GitHub → Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|--------|-------|
| `SERVER_HOST` | IP address or hostname of the on-prem server |
| `SSH_PRIVATE_KEY` | Private key that matches the public key added to the `deploy` user |
| `VITE_API_URL` | Backend URL visible to the browser, e.g. `https://workspace.o3ccards.com` |

---

## First Deployment

### 1. Database

If self-hosting PostgreSQL:
```bash
# On the server — run Postgres in Docker or install natively
docker run -d --name postgres \
  -e POSTGRES_PASSWORD=strong-password \
  -e POSTGRES_DB=o3c_prod \
  -p 127.0.0.1:5432:5432 \
  -v pgdata:/var/lib/postgresql/data \
  postgres:16
```

If using Supabase, copy the connection pooler URL into `DATABASE_URL`.

The backend auto-runs all `migrations/*.sql` files on startup via the embedded migration runner — no manual `psql` needed.

### 2. Deploy

```bash
# On the server as the deploy user
cd /opt/o3c

# Edit nginx.conf — replace YOUR_DOMAIN with your actual domain
nano nginx.conf

# First time: build frontend manually (CI will handle subsequent deploys)
cd frontend && npm ci && VITE_API_URL=https://workspace.o3ccards.com npm run build && cd ..

# Start everything
docker compose up -d --build
docker compose ps        # both api and nginx should be Up
```

### 3. Create the first admin account

```bash
curl -X POST https://workspace.o3ccards.com/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Secret: $BOOTSTRAP_SECRET" \
  -d '{"email":"admin@o3ccards.com","password":"<strong-password>","full_name":"Admin"}'
```

**Change the password immediately after first login.**

---

## Routine Redeploy

CI handles this automatically on every push to `main`:
1. Runs tests + type-check
2. Builds the React frontend
3. `rsync`s the built `dist/` to `/opt/o3c/frontend/dist/` on the server
4. SSHes in and runs `git pull && docker compose up -d --build api`

To deploy manually:
```bash
# On the server
cd /opt/o3c
git pull origin main
docker compose up -d --build api   # rebuilds Go binary; Nginx picks up new static files automatically
```

---

## Rollback

### Backend

Docker Compose keeps the previous image layer cached. To roll back to the previous build:

```bash
# On the server
cd /opt/o3c
git log --oneline -5      # find the commit to roll back to
git checkout <commit-sha>
docker compose up -d --build api
```

To roll back to a specific tagged release:
```bash
git checkout v1.2.3
docker compose up -d --build api
```

### Frontend

The Nginx container serves whatever is in `frontend/dist/`. To roll back:
```bash
# Re-run CI from the previous commit, or manually on the server:
git checkout <commit-sha> -- frontend/
cd frontend && npm ci && VITE_API_URL=https://workspace.o3ccards.com npm run build && cd ..
# Nginx picks up the new files immediately — no restart needed
```

### Database

There is no automated migration rollback. If a migration must be reversed, write a new SQL migration that undoes the change. Back up before applying any migration to production:

```bash
pg_dump $DATABASE_URL > backup-$(date +%Y%m%d-%H%M%S).sql
```

---

## Staging Environment

Run a second Docker Compose stack pointing at a separate database:

```bash
# On the server — create a staging env file
cp /opt/o3c/backend-go/.env /opt/o3c/backend-go/.env.staging
# Edit .env.staging: change DATABASE_URL, ALLOWED_ORIGINS, BOOTSTRAP_SECRET

# Deploy staging on a different port
docker compose -f docker-compose.yml --env-file backend-go/.env.staging \
  up -d --build api
```

Or run the staging API on port 8001 and add a second Nginx `server {}` block for a `staging.` subdomain.

---

## Architecture Notes

### Migrations

Run automatically on startup via `runMigrations()` in `migrate.go`. Embedded in the binary, tracked in `schema_migrations`. A `pg_advisory_lock` prevents concurrent runs during restarts.

```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;
```

### RLS disabled by design

Row-Level Security is not enabled. O3 Capital Workspace is a single-tenant internal tool — access control is enforced via JWT role claims + per-route middleware. See full rationale in `docs/DEPLOYMENT.md` under "Row-Level Security Decision".

### Rate limiting

`httprate.Limit(300/min)` uses an in-memory counter inside the Go process. On a single server (one process) this is authoritative — no distributed state needed.

### Health check

`GET /api/health` returns `{"status":"ok"}` (200) or `{"status":"degraded","db":"unreachable"}` (503). It bypasses the rate limiter and is used by the Docker Compose healthcheck and any monitoring you set up.

---

## Monitoring (optional)

The API exposes Prometheus metrics at `GET /metrics` (requires `Authorization: Bearer $METRICS_TOKEN`). To scrape:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: o3c-api
    scheme: https
    static_configs:
      - targets: ['workspace.o3ccards.com']
    metrics_path: /metrics
    bearer_token: YOUR_METRICS_TOKEN
```

---

## Cloudflare Tunnel (MSSQL on-site data)

See `CLOUDFLARE_TUNNEL.md`. The MSSQL database runs on-site; Cloudflare Tunnel exposes it to the on-prem server without opening a firewall port.

```
Set in backend-go/.env:
MSSQL_SERVER   = mssql.o3ccards.com,1433
MSSQL_DATABASE = YOUR_DATABASE_NAME
MSSQL_USER     = your_sql_user
MSSQL_PASSWORD = your_sql_password
```

The backend pings the MSSQL connection every 60 seconds and notifies IT Admin + CTO if it goes offline.

---

## Local Development

```bash
# Backend
cd backend-go
cp .env.example .env   # fill in values
go run .               # http://localhost:8000

# Frontend
cd frontend
npm install
npm run dev            # http://localhost:3100
```
