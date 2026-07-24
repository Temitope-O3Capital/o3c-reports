# O3 Capital Workspace — Deployment Guide

**Stack:** Go backend (chi router) + React 18/TypeScript frontend  
**Backend host:** Railway | **Frontend host:** Cloudflare Pages | **DB:** Supabase (PostgreSQL)

---

## Prerequisites

- Railway account + `railway` CLI (`npm i -g @railway/cli`)
- Cloudflare account (Pages)
- Supabase project with a PostgreSQL database
- `RAILWAY_TOKEN` set in GitHub repository secrets

---

## Environment Variables

### Backend (Railway)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Supabase pooler URL (`-pooler.` host) |
| `DIRECT_DATABASE_URL` | optional | Non-pooler URL for LISTEN/NOTIFY; falls back to DATABASE_URL |
| `SECRET_KEY` | ✅ | JWT signing secret — 32+ random bytes (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | ✅ | Exactly 32 bytes (`openssl rand -base64 24 \| head -c 32`) |
| `ALLOWED_ORIGINS` | ✅ | Comma-separated CORS origins e.g. `https://o3capital-workspace.pages.dev` |
| `BOOTSTRAP_SECRET` | ✅ in production | Guards first-admin creation endpoint |
| `SENDGRID_API_KEY` | optional | Transactional email |
| `METRICS_TOKEN` | ✅ in production | Bearer token for `GET /metrics` Prometheus scrape |
| `ZOHO_IMPORT_SECRET` | optional | Guards Zoho ticket/call import endpoints |
| `TERMII_API_KEY` | optional | SMS |
| `MSSQL_SERVER` | optional | On-site card data via Cloudflare Tunnel |
| `MSSQL_DATABASE` | optional | |
| `MSSQL_USER` / `MSSQL_PASSWORD` | optional | |

**Never** use the default values from `.env.example` in production. The backend rejects weak `SECRET_KEY` and `ENCRYPTION_KEY` at startup.

### Frontend (Cloudflare Pages)

| Variable | Notes |
|---|---|
| `VITE_API_URL` | Backend Railway URL e.g. `https://o3c-reports-production.up.railway.app` |

---

## First Deployment

### 1. Supabase — Database

1. Create a new Supabase project.
2. In **Settings → Database → Connection string → URI** copy the **connection pooler** URL.
3. Set `DATABASE_URL` in Railway to that URL.
4. The backend auto-runs all `migrations/*.sql` files on startup via the embedded migration runner.

### 2. Backend — Railway

```bash
# In the backend-go/ directory
railway link          # link to your Railway project
railway redeploy --from-source --yes
```

Or via CI: push to `main` — the `deploy-backend` GitHub Actions job runs automatically after tests pass.

### 3. Create the first admin account

The `/api/auth/bootstrap` endpoint creates the first admin user. It is rate-limited and guarded by `BOOTSTRAP_SECRET`.

```bash
curl -X POST https://YOUR_BACKEND.railway.app/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Secret: $BOOTSTRAP_SECRET" \
  -d '{"email":"admin@o3ccards.com","password":"<strong-password>","full_name":"Admin"}'
```

**Change the password immediately after first login.**

### 4. Frontend — Cloudflare Pages

Push to `main` — the `deploy-frontend` GitHub Actions job deploys automatically.

Manual deploy:
```bash
cd frontend
npm run build
npx wrangler pages deploy dist --project-name o3c-workspace
```

---

## Routine Redeploy

```bash
# Backend — from backend-go/
railway redeploy --from-source --yes

# Frontend — CI auto-deploys on push to main; or from frontend/
npm run build && npx wrangler pages deploy dist --project-name o3c-workspace
```

---

## Rollback Runbook

### Backend (Railway)

```bash
# List recent deployments
railway deployments list

# Roll back to a specific deployment ID
railway rollback <deployment-id>
```

Or via the Railway dashboard: **Project → Service → Deployments** → click the target deployment → **Rollback**.

### Frontend (Cloudflare Pages)

In the Cloudflare Pages dashboard: **Pages → o3c-workspace → Deployments** → find the target deployment → **Rollback to this deployment**.

### Database (Supabase)

Supabase provides Point-in-Time Recovery (PITR) on paid plans. To restore:
1. Go to **Supabase Dashboard → Database → Backups**.
2. Select **Point in Time** and choose the restore timestamp.
3. Restore to a new database, verify, then update `DATABASE_URL` in Railway.

There is no automated migration rollback. If a migration must be reversed, write a new SQL migration that undoes the change and deploy it.

---

## Architecture Notes

### RLS disabled by design

Row-Level Security is not enabled on this database. O3 Capital Workspace is a single-tenant, staff-only internal tool. Access control is enforced at the application layer via JWT role claims and the `RequirePages` middleware. This is a documented architectural decision — compensating controls are JWT auth + HTTPS + Railway private networking.

### Migrations

Migrations run automatically on startup via `runMigrations()` in `migrate.go`. They are embedded in the binary and tracked in the `schema_migrations` table. A PostgreSQL advisory lock (`pg_advisory_lock`) prevents concurrent migration runs during rolling restarts.

To check migration state:
```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;
```

---

## Cloudflare Tunnel (MSSQL on-site data)

See `CLOUDFLARE_TUNNEL.md` for full setup. Summary:

```powershell
# On the office PC where the card MSSQL database lives
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create o3c-mssql
cloudflared tunnel route dns o3c-mssql mssql.o3ccards.com
```

Then set in Railway:
```
MSSQL_SERVER   = mssql.o3ccards.com,1433
MSSQL_DATABASE = YOUR_DATABASE_NAME
MSSQL_USER     = your_sql_user
MSSQL_PASSWORD = your_sql_password
```

The backend pings the MSSQL connection every 60 seconds. If it goes offline, IT Admin and CTO receive an in-app notification.

---

## Staging Environment (M25)

A Railway staging environment is not yet provisioned. To create one:

1. In the Railway dashboard, open the project and click **New Environment** → name it `staging`.
2. Copy all production environment variables into the staging environment, replacing `DATABASE_URL` with a separate Supabase staging project URL.
3. Update `ALLOWED_ORIGINS` to include the staging Cloudflare Pages preview URL.
4. Deploy with `railway up --environment staging --detach` from `backend-go/`.
5. In Cloudflare Pages, add a `staging` deployment mapping `staging` branch → environment variable `VITE_API_URL` pointing at the staging Railway service.

Until a staging environment is provisioned, test migrations against a local Postgres or a Supabase branch database before applying to production.

---

## Database Backup and Point-in-Time Recovery (M26)

Supabase includes automatic daily backups and Point-in-Time Recovery (PITR) on paid plans.

**Current backup policy:**
- **Daily backups**: enabled by default on all Supabase projects. Retained for 7 days (Pro plan) or 30 days (Team/Enterprise).
- **PITR**: available on Pro plan and above. Enables restore to any second within the retention window.
- To enable PITR: Supabase Dashboard → **Settings → Backups → Enable Point-in-Time Recovery**.

**Recovery procedure:**
1. Go to Supabase Dashboard → **Backups**.
2. Select a restore point (PITR: choose exact timestamp; daily: choose backup date).
3. Click **Restore** — Supabase spins up a new DB from the snapshot. Do NOT overwrite the live DB; restore to a new branch or project for verification first.
4. Once verified, update `DATABASE_URL` in Railway to the restored database URL.
5. Run `SELECT filename FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;` to confirm migration head matches `backend-go/migrations/` count.

**RPO/RTO targets (informational):**
- RPO (data loss tolerance): ≤ 1 second with PITR enabled; ≤ 24 hours with daily backups only.
- RTO (downtime target): ≤ 2 hours for a PITR restore; ≤ 4 hours for a daily-backup restore.

---

## Row-Level Security (RLS) Decision (M27)

**RLS is intentionally disabled on all tables in this application.** This is a documented architectural decision, not an oversight.

**Why RLS is not used here:**
- O3 Capital Workspace is a **single-tenant internal tool** — all authenticated users belong to the same organisation. There is no multi-tenant data boundary to enforce at the database layer.
- All access control is implemented at the application layer via JWT role claims + per-route middleware (`core.RequirePages()`). Every handler validates the user's role before touching the database.
- Supabase's default PostgREST / direct DB access is not exposed to end users — the only path to data is through the Go API.
- Enabling RLS would add per-query overhead and require policy maintenance without providing a meaningful security boundary for a single-tenant app.

**Compensating controls:**
- All unauthenticated access returns 401 (JWT middleware applied to every route except `/api/auth/*` and `/api/health`).
- Admin-only routes are guarded by `core.RequirePages("admin")` middleware.
- Sensitive columns (credentials, API keys) use AES-GCM encryption at the application layer.
- Audit trail: every non-GET authenticated request is logged to `o3c_activity_log`.

If the product evolves to serve multiple tenants from the same database, RLS should be re-evaluated at that time.

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
