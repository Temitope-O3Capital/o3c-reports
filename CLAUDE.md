# O3 Capital Workspace — Claude Code Instructions

This file is read by Claude Code automatically. It tells you everything about
this project so you can continue development without asking Temitope to re-explain context.

---

## What This Project Is

A full-stack B2B operations platform for **O3 Capital** — a Nigerian fintech company
offering prepaid, credit, and international USD cards plus business loans.

O3 Capital Workspace is the internal staff platform: it consolidates loan origination,
cards ops, collections, recovery, sales/CRM, compliance, HR, helpdesk, campaigns,
finance, and executive reporting into a single authenticated web application.
It replaces a fragmented mix of Power BI dashboards and spreadsheets.

---

## Architecture

```
Frontend (React 18 + TypeScript + Tailwind v3)
  ↓ REST / SSE
Backend (Go + chi router)
  ↓
PostgreSQL (Supabase / Railway Postgres)
  ↓  (secondary)
MSSQL (on-site, via Cloudflare Tunnel — optional, for live card data)
```

| Layer       | Technology                        | Deploy              |
|-------------|-----------------------------------|---------------------|
| Frontend    | React 18 + Vite + TypeScript      | Cloudflare Pages    |
| Styling     | Tailwind v3 + inline styles       | —                   |
| Icons       | Material Symbols Rounded (CDN)    | Google Fonts        |
| Charts      | Recharts                          | —                   |
| Rich text   | Tiptap v3                         | —                   |
| Toasts      | Sonner                            | —                   |
| Backend     | Go (chi router)                   | Railway             |
| Auth        | JWT (HS256, 8 h access tokens)    | —                   |
| Primary DB  | PostgreSQL (Supabase)             | Supabase            |
| File store  | Supabase Storage                  | Supabase            |
| Mail        | SendGrid + Microsoft Graph        | —                   |
| Call center | Zoho Desk + Zoho Voice            | —                   |
| SMS/Push    | (configured per env)              | —                   |

---

## O3 Capital Brand

```
Navy:    #0E2841  — sidebar, headers, table headers, primary CTAs
Red:     #C00000  — accent, active nav, badges, charts
White:   #FFFFFF
Canvas:  #F4F6F8  — page background
Font:    DM Sans (body), DM Mono (numbers / mono)
Icons:   Material Symbols Rounded (Google CDN, variable font)
```

---

## Monorepo Layout

```
o3c-reports/
├── CLAUDE.md                      ← you are here
├── .github/workflows/deploy.yml   ← CI: frontend → Cloudflare Pages; backend → Railway
├── docs/DEPLOYMENT.md
│
├── frontend/
│   ├── index.html
│   ├── package.json               ← name: o3c-workspace
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   ├── .env.example               ← VITE_API_URL=http://localhost:8000
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                ← router, auth guard, layout shell, all routes
│       ├── lib/
│       │   ├── api.ts             ← apiFetch() wrapper (adds Authorization header)
│       │   └── fmt.ts             ← currency, date, number formatters
│       ├── hooks/
│       │   ├── useAuth.ts         ← JWT login/logout, role check, token refresh
│       │   └── useNotifications.ts← SSE bell via /api/notifications/sse
│       ├── components/
│       │   ├── Sidebar.tsx        ← accordion nav, collapse, user footer
│       │   ├── UI.tsx             ← shared design system components
│       │   ├── EmailBlockEditor.tsx← drag-drop email block builder
│       │   └── RichTextEditor.tsx ← Tiptap wrapper
│       └── pages/
│           ├── Login.tsx
│           ├── Overview.tsx       ← executive dashboard
│           ├── Approvals.tsx      ← cross-module approval queue
│           ├── Campaigns.tsx
│           ├── Settings.tsx
│           ├── admin/             ← UserManagement, RoleManagement, ApiKeys, MailHealth…
│           ├── cards/             ← Cards overview, cohort, customers
│           ├── collections/       ← Collections overview + ops
│           ├── collections-ops/
│           ├── compliance/        ← Audit findings, regulatory tracking
│           ├── crm/               ← CRM, reports
│           ├── customer-service/  ← Helpdesk tickets, CSAT
│           ├── customer360/       ← 360° customer view
│           ├── finance/           ← P&L, overview
│           ├── helpdesk/          ← Helpdesk queue, CSAT
│           ├── hr/                ← Employees, leaves, payroll
│           ├── kpi/               ← KPI tracker
│           ├── los/               ← Loan origination, applications, queue
│           ├── mail/              ← Mail inbox, composer
│           ├── marketing/         ← Message templates, campaign builder
│           ├── operations/        ← Fixed deposits, settlements
│           ├── recovery/          ← Recovery overview
│           ├── recovery-ops/      ← Recovery cases, visits, agents
│           ├── reports/           ← Report generation
│           ├── risk/              ← Risk dashboard
│           ├── sales/             ← Sales overview, cohort, customers
│           ├── settings/          ← User settings
│           └── statements/        ← Account statements
│
└── backend-go/
    ├── main.go                    ← chi router, middleware, route registration
    ├── go.mod / go.sum
    ├── .env.example
    └── handlers/
        ├── auth.go                ← login, bootstrap, password reset
        ├── admin.go               ← user management, API keys, roles
        ├── approvals.go
        ├── batch.go
        ├── campaigns.go / campaign_analytics.go
        ├── cards.go / card_trends.go / cohort.go
        ├── collections.go / collections_ops.go
        ├── compliance.go          ← audit findings (uses finding_ref_seq sequence)
        ├── crm.go / customer360.go / customer_service.go
        ├── eod.go / executive.go / income.go / kpi.go / overview.go
        ├── fixed_deposit.go
        ├── helpdesk.go
        ├── hr.go
        ├── loans.go / los.go
        ├── mail.go / mail_test.go / statement_emails.go
        ├── marketing/ message_templates.go / contact_lists.go / email_senders.go
        ├── notifications.go / notify.go / notification_prefs.go
        ├── reconciliation.go / reports.go / risk.go / sales.go / settlements.go
        ├── recovery.go / recovery_ops.go
        ├── transactions.go / credit_portfolio.go
        ├── uploads.go
        ├── voice.go / call_center.go / zoho.go
        ├── whatsapp.go
        ├── helpers.go / stubs.go / settings_handler.go
        └── core/
            ├── config.go          ← env vars, weak secret detection
            ├── db.go              ← PostgreSQL pool (pgx)
            └── (encryption, etc.)

---

## Dev Servers

| Service  | Command                                               | URL                  |
|----------|-------------------------------------------------------|----------------------|
| Frontend | `cd frontend && npm run dev`                          | http://localhost:3100 |
| Backend  | `cd backend-go && go run main.go` (or `go build`)    | http://localhost:8000 |

---

## Deployment

- **Frontend** → Cloudflare Pages, project name `o3c-workspace`, auto-deploys on push to `main`
- **Backend** → Railway, `railway redeploy --from-source --yes` from `backend-go/`
- **Never use Vercel** — Cloudflare Pages only

### Required GitHub Secrets (Actions)
| Secret                | Purpose                                       |
|-----------------------|-----------------------------------------------|
| `CLOUDFLARE_API_TOKEN`| Pages:Edit permission                         |
| `CF_ACCOUNT_ID`       | Cloudflare account ID                         |
| `VITE_API_URL`        | Backend Railway URL (e.g. https://…railway.app)|

### Required Railway Env Vars
| Var                   | Notes                                         |
|-----------------------|-----------------------------------------------|
| `DATABASE_URL`        | PostgreSQL connection string                  |
| `SECRET_KEY`          | JWT signing secret — 32+ chars, not "change-this*" |
| `ENCRYPTION_KEY`      | Exactly 32 bytes — not "change-this*"         |
| `ALLOWED_ORIGINS`     | Comma-separated CORS origins                  |
| `SENDGRID_API_KEY`    | Transactional email                           |
| `BOOTSTRAP_SECRET`    | Optional: guard on POST /api/auth/bootstrap   |
| `RESET_ADMIN_SECRET`  | Optional: guard on reset-admin endpoint       |

---

## Auth & Security Rules

- JWTs are 8-hour access tokens. Include `Authorization: Bearer <token>` on all API calls.
- `apiFetch()` in `src/lib/api.ts` handles this automatically.
- `config.go` rejects weak `SECRET_KEY`/`ENCRYPTION_KEY` at startup.
- `auth.go` uses `crypto/subtle.ConstantTimeCompare` for secret header checks.
- Rate limiter uses the **rightmost** `X-Forwarded-For` value (Railway appends real IP last).
- Bootstrap endpoint (`POST /api/auth/bootstrap`) is guarded by `BOOTSTRAP_SECRET` if set.
- API keys stored via AES-GCM encryption — `encryptValue()` fails hard if `ENCRYPTION_KEY` missing.

---

## Notification System (SSE)

1. Frontend calls `POST /api/notifications/sse-ticket` → receives `{ ticket: "..." }`
2. Frontend opens `EventSource` at `GET /api/notifications/sse?ticket=<ticket>`
3. Server streams events; ticket is single-use and expires in 30s.
- File: `frontend/src/hooks/useNotifications.ts`

---

## Financial / Data Rules

- All monetary amounts are stored in **kobo** (integer). Divide by 100 for display.
- Every financial operation must post double-entry GL journal entries.
- Audit finding refs use `finding_ref_seq` PostgreSQL sequence (race-free).

---

## Common Tasks

### Add a new page
1. Create `frontend/src/pages/<module>/NewPage.tsx`
2. Add route in `src/App.tsx` (lazy import)
3. Add nav item to the SECTIONS array in `src/components/Sidebar.tsx`
4. Create handler in `backend-go/handlers/<module>.go`
5. Register route in `backend-go/main.go`

### Add a new API endpoint
1. Add handler function to the relevant `handlers/*.go` file
2. Register the route in `main.go` under the appropriate `r.Route()` group
3. Call from frontend via `apiFetch('/api/...')` in `src/lib/api.ts`

### Add a new user role
1. Update role list in `backend-go/handlers/auth.go` / `admin.go`
2. Update route guards in `main.go` middleware
3. Update `canAccess()` in `frontend/src/hooks/useAuth.ts`

---

## What "Done" Means

1. Code change is made, reads correctly, no syntax errors.
2. `cd frontend && ./node_modules/.bin/tsc --noEmit` → zero errors.
3. `cd backend-go && go build ./...` → compiles cleanly.
4. Any required DB migration/sequence is idempotent.
5. Change is committed with a clear message.
6. For deployed changes: `railway redeploy --from-source --yes` run and health endpoint responds.
