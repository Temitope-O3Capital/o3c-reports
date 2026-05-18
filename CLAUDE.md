# O3C Cards Reporting Platform — Claude Code Instructions

This file is read by Claude Code automatically. It tells you everything about
this project so you can continue development without asking Temitope to re-explain context.

---

## What This Project Is

A full-stack web reporting dashboard for **O3C Cards** — a Nigerian fintech building
prepaid, credit, and international USD cards plus business loans.

The dashboard replaces Power BI with a live web app accessible from anywhere.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OFFICE (on-site)                                               │
│  ┌─────────────┐    ┌──────────────────┐   ┌─────────────────┐ │
│  │  MSSQL DB   │◄───│  sync_engine.py  │   │  cloudflared    │ │
│  │  (primary)  │    │  (daily 18:00 +  │   │  (tunnel agent) │ │
│  └─────────────┘    │   manual trigger)│   └────────┬────────┘ │
│                     └────────┬─────────┘            │          │
└─────────────────────────────┼──────────────────────┼──────────┘
                               │ syncs to             │ tunnel
                               ▼                      ▼
                        ┌─────────────┐      ┌───────────────┐
                        │  Supabase   │      │  Cloudflare   │
                        │ (PostgreSQL)│      │   Network     │
                        │  fallback  │      └───────┬───────┘
                        └─────┬───────┘              │
                              │                      │
                        ┌─────▼──────────────────────▼──────┐
                        │         Railway (FastAPI)          │
                        │   tries MSSQL first via tunnel     │
                        │   falls back to Supabase snapshot  │
                        │   shows data_source banner         │
                        └─────────────────┬─────────────────┘
                                          │ REST API
                                          ▼
                              ┌──────────────────────┐
                              │  Cloudflare Pages     │
                              │  (React + Vite)       │
                              │  accessible anywhere  │
                              └──────────────────────┘
```

---

## Tech Stack

| Layer          | Technology              | Notes                                      |
|----------------|-------------------------|--------------------------------------------|
| Frontend       | React 18 + Vite         | Deployed on Cloudflare Pages               |
| Styling        | Plain CSS (index.css)   | CSS variables, no Tailwind                 |
| Charts         | Recharts                | LineChart, BarChart, PieChart, custom heatmap |
| Routing        | React Router v6         | Protected routes, role-based nav           |
| Auth           | JWT (python-jose)       | 8hr tokens, role-based page access         |
| Backend        | FastAPI + Python 3.11   | Deployed on Railway                        |
| Primary DB     | MSSQL (on-site)         | Connected via Cloudflare Tunnel + pyodbc   |
| Fallback DB    | Supabase (PostgreSQL)   | Free tier, last-synced snapshot            |
| Sync engine    | Python + Flask          | Runs on office PC, pyodbc → psycopg2       |
| Tunnel         | Cloudflare Tunnel       | cloudflared on office PC → MSSQL port 1433 |

---

## O3C Brand

```
Navy:   #0E2841  (primary — headers, sidebar, table headers)
Red:    #C00000  (accent — charts, badges, CTAs)
White:  #FFFFFF
Grey:   #F4F6F8  (canvas background)
Green:  #166534  (positive metrics, high retention)
Amber:  #F59E0B  (medium retention, warnings)
Font:   DM Sans (body), DM Mono (numbers/code)
```

---

## Database Tables (MSSQL — exact names matter)

| MSSQL Table Name   | Supabase Table Name    | Key Column   | Rows (approx) |
|--------------------|------------------------|--------------|---------------|
| Accounts           | Accounts               | CIF Number   | 19,101        |
| Products           | Products               | CIF Number   | 19,887        |
| Transactions       | Transactions           | —            | 1,016,704     |
| MonthlyActivity    | Monthly Activity       | CIF Number   | 124,455       |
| CollectionsLog     | Collections Log        | —            | 220           |
| CIFTable           | CIF Table              | CIF Number   | 19,760        |
| RecoveryMasterSheet| Recovery Master Sheet  | CIF Number   | unknown       |

### Key Column Names (exact — used in queries)

**Accounts:** CIF Number, Account Created Date, First Name, Last Name,
              Full Address, Birthday, Email, Job Title, State, City

**Products:** CIF Number, Name On Card, Account Manager, Product Name, Account Status

**Transactions:** Transaction Date, Amount, Description, Merchant_Name, CIF Number

**Monthly Activity:** CIF Number, ActivityMonth, TxnCount, TotalSpend

**Collections Log:** Date, CIF, Agent, Amount, Mode Of Payment, Payment Receipt

**CIF Table:** CIF Number, Cohort Date, Cohort Label

**Recovery Master Sheet:** CIF Number, Recovery Date, Recovery Amount,
                           Recovery Method, Legal Stage, Agent, Status
                           (source: Excel on OneDrive — columns TBC with Temitope)

---

## User Roles & Page Access

```python
ROLE_PAGES = {
    "admin":       ["overview","transactions","collections","recovery","sales","cards","cohort"],
    "management":  ["overview","transactions","collections","recovery","sales","cards","cohort"],
    "collections": ["collections","recovery"],
    "sales":       ["sales","overview"],
    "cards_ops":   ["cards","transactions","overview"],
    "recovery":    ["recovery","collections"],
    "call_centre": ["overview","transactions"],
}
```

---

## Report Pages

| Page       | Route          | Data Sources                          |
|------------|----------------|---------------------------------------|
| Overview   | /              | All tables — executive KPIs           |
| Transactions | /transactions | Transactions, Monthly Activity        |
| Cards      | /cards         | Products, Accounts                    |
| Cohort     | /cohort        | CIF Table, Monthly Activity           |
| Collections| /collections   | Collections Log, Accounts             |
| Recovery   | /recovery      | Recovery Master Sheet, Accounts       |
| Sales      | /sales         | Accounts, Products                    |

---

## Dual-Source Pattern (CRITICAL)

Every API endpoint tries MSSQL first, falls back to Supabase.
The response always includes a `data_source` field.

```python
# Pattern used in every router
result, source = await dual_query(
    db_mssql, db_pg,
    mssql_query="SELECT ...",
    pg_query="SELECT ..."
)
return {"data": result, "data_source": source}
# source is either "mssql_live" or "supabase_snapshot"
```

Frontend reads `data_source` and shows a banner:
- 🟢 "Live data · MSSQL" — green banner
- 🟡 "Snapshot · Last synced [timestamp]" — amber banner

---

## File Structure

```
o3c_v2/
├── CLAUDE.md                  ← you are here
├── .env.example               ← copy to .env, fill in secrets
├── backend/
│   ├── main.py                ← FastAPI app entry point
│   ├── requirements.txt
│   ├── core/
│   │   ├── database.py        ← dual DB connections (MSSQL + Supabase)
│   │   ├── auth.py            ← JWT logic, role checker
│   │   └── dual_query.py      ← primary/fallback query pattern
│   └── routers/
│       ├── auth.py
│       ├── overview.py
│       ├── transactions.py
│       ├── collections.py
│       ├── recovery.py
│       ├── sales.py
│       ├── cards.py
│       └── cohort.py
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── .env                   ← VITE_API_URL, VITE_SYNC_URL
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── index.css          ← all styles, CSS variables
│       ├── hooks/
│       │   ├── useAuth.js     ← login, logout, canAccess()
│       │   └── useApi.js      ← data fetching with data_source support
│       ├── components/
│       │   ├── Charts.jsx     ← KpiCard, LineChartCard, BarChartCard, DonutCard
│       │   ├── DataBanner.jsx ← 🟢/🟡 live vs snapshot indicator
│       │   └── SyncPanel.jsx  ← admin sync trigger modal
│       └── pages/
│           ├── Login.jsx
│           ├── Overview.jsx
│           ├── Transactions.jsx
│           ├── Collections.jsx
│           ├── Recovery.jsx
│           ├── Sales.jsx
│           ├── Cards.jsx
│           └── Cohort.jsx
├── sync/
│   ├── sync_engine.py         ← MSSQL → Supabase sync + Flask API
│   ├── requirements.txt
│   └── .env                   ← MSSQL_SERVER, MSSQL_DB, SUPABASE_URL
└── docs/
    ├── DEPLOYMENT.md          ← step-by-step deploy guide
    ├── CLOUDFLARE_TUNNEL.md   ← tunnel setup for office PC
    └── SUPABASE_SETUP.md      ← SQL to run in Supabase dashboard
```

---

## Environment Variables

### backend/.env
```
DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres
MSSQL_SERVER=YOUR_MSSQL_SERVER_NAME_OR_IP
MSSQL_DATABASE=YOUR_DATABASE_NAME
MSSQL_TRUSTED=yes
SECRET_KEY=generate-with-openssl-rand-hex-32
SYNC_ENGINE_URL=http://YOUR_OFFICE_IP:5001
```

### frontend/.env
```
VITE_API_URL=https://your-app.railway.app
VITE_SYNC_URL=http://YOUR_OFFICE_IP:5001
```

### sync/.env
```
MSSQL_SERVER=YOUR_SERVER
MSSQL_DB=YOUR_DATABASE
SUPABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres
```

---

## Common Tasks for Claude Code

### Add a new API endpoint
1. Find the relevant router in `backend/routers/`
2. Use `dual_query()` from `core/dual_query.py` — always both MSSQL and PG versions
3. Add the route to the router, include `data_source` in response
4. Add a `useApi()` call in the relevant frontend page

### Add a new chart to a page
1. Import from `components/Charts.jsx`
2. Available: `KpiCard`, `LineChartCard`, `BarChartCard`, `DonutCard`, `fmt()`, `pct()`
3. Use O3C colours: navy `#0E2841`, red `#C00000`

### Add a new user role
1. Add to `ROLE_PAGES` in `backend/core/auth.py`
2. Add to `ROLE_PAGES` in `frontend/src/hooks/useAuth.js` (keep in sync)

### Add a new report page
1. Create `frontend/src/pages/NewPage.jsx`
2. Add route to `frontend/src/App.jsx`
3. Add nav item to `NAV_ITEMS` array in `App.jsx`
4. Add page key to `ROLE_PAGES` for relevant roles
5. Create router `backend/routers/new_page.py`
6. Register in `backend/main.py`

### Change sync schedule
Edit `sync/sync_engine.py` — find the `start_scheduler()` function.
Currently: Mon–Fri at 18:00. Uses the `schedule` library.

### Recovery Master Sheet columns
⚠️ Temitope has not yet confirmed the exact column names for Recovery Master Sheet
(it comes from Excel on OneDrive). Ask before writing queries against it.
Assumed columns: CIF Number, Recovery Date, Recovery Amount, Recovery Method,
Legal Stage, Agent, Status — but verify with Temitope.

---

## Known Issues / TODOs

- [ ] Recovery Master Sheet Excel column names need confirmation from Temitope
- [ ] OneDrive/Microsoft Graph API integration not yet built — Recovery data currently reads from Supabase only
- [ ] Date range filter not yet wired to API calls (filter bar UI exists, params not sent)
- [ ] Card Type slicer filter not yet wired
- [ ] Admin user creation UI not built — users created via SQL directly for now
- [ ] Mobile responsive layout needs testing below 600px

---

## Running Locally

```bash
# Terminal 1 — Backend
cd backend
pip install -r requirements.txt
cp ../.env.example .env   # fill in values
uvicorn main:app --reload --port 8000

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev               # http://localhost:3000

# Terminal 3 — Sync engine (office PC only)
cd sync
pip install -r requirements.txt
python sync_engine.py     # http://localhost:5001
```

First login: admin@o3ccards.com / Admin@O3C2026
(hash in SUPABASE_SETUP.md — change immediately after first login)

---

## Deployment

See `docs/DEPLOYMENT.md` for full step-by-step.
Short version:
- Backend → Railway (connect GitHub repo, set env vars)
- Frontend → Cloudflare Pages (connect GitHub repo, build: `npm run build`, output: `dist`)
- Tunnel → run `cloudflared` on office PC (see docs/CLOUDFLARE_TUNNEL.md)
- Sync engine → runs on office PC as Windows service
