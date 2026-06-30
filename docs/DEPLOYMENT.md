# O3 Capital Workspace — Deployment Guide

---

## Step 1 — Supabase (Free PostgreSQL)

1. Go to https://supabase.com → Sign up → New Project
   - Name: `o3c-cards`
   - Password: choose a strong password (save it)
   - Region: `West EU` or `East US` (closest to Nigeria)

2. Go to **Settings → Database → Connection string → URI**
   Copy the connection string — it looks like:
   `postgresql://postgres:PASSWORD@db.XXXX.supabase.co:5432/postgres`

3. Go to **SQL Editor** and run this to create the users table:

```sql
CREATE TABLE o3c_users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL,
    department TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Admin user (password: Admin@O3C2026 — CHANGE AFTER FIRST LOGIN)
INSERT INTO o3c_users (email, password_hash, full_name, role, department)
VALUES (
    'admin@o3ccards.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMayhYkmfTRVZ5g3wlXdKTT9Ry',
    'Admin User', 'admin', 'Management'
);

-- Example: add a collections user
INSERT INTO o3c_users (email, password_hash, full_name, role, department)
VALUES (
    'collections@o3ccards.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMayhYkmfTRVZ5g3wlXdKTT9Ry',
    'Collections Team', 'collections', 'Collections'
);
```

---

## Step 2 — Push to GitHub

```bash
cd o3c_v2
git init
git add .
git commit -m "Initial O3 Capital Workspace"
# Create a repo on github.com called o3c-reports (private)
git remote add origin https://github.com/YOUR_USERNAME/o3c-reports.git
git push -u origin main
```

---

## Step 3 — Backend on Railway

1. Go to https://railway.app → New Project → Deploy from GitHub repo
2. Select `o3c-reports` → select the `backend` folder as root
3. Add these environment variables:
   ```
   DATABASE_URL     = postgresql://postgres:PASSWORD@db.XXXX.supabase.co:5432/postgres
   MSSQL_SERVER     = (leave blank for now — add after Cloudflare Tunnel setup)
   MSSQL_DATABASE   = (leave blank for now)
   SECRET_KEY       = (generate: python -c "import secrets; print(secrets.token_hex(32))")
   ```
4. Set start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Copy your Railway URL — looks like `https://o3c-reports-xxxx.railway.app`

---

## Step 4 — Frontend on Cloudflare Pages

1. Go to https://pages.cloudflare.com → Create a project → Connect GitHub
2. Select `o3c-reports` repo
3. Settings:
   - **Root directory:** `frontend`
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
4. Environment variables:
   ```
   VITE_API_URL  = https://o3c-reports-xxxx.railway.app
   VITE_SYNC_URL = http://YOUR_OFFICE_IP:5001
   ```
5. Deploy — your dashboard URL will be `https://o3capital-workspace.pages.dev`
   (you can add a custom domain like `reports.o3ccards.com` for free)

---

## Step 5 — Cloudflare Tunnel (Office PC)

See `CLOUDFLARE_TUNNEL.md` for full setup.
Short version:

```powershell
# On the office PC where MSSQL lives
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create o3c-mssql
cloudflared tunnel route dns o3c-mssql mssql.o3ccards.com
```

Then add to Railway env vars:
```
MSSQL_SERVER   = mssql.o3ccards.com,1433
MSSQL_DATABASE = YOUR_DATABASE_NAME
MSSQL_TRUSTED  = no
MSSQL_USER     = your_sql_user
MSSQL_PASSWORD = your_sql_password
```

---

## Step 6 — Sync Engine (Office PC)

```powershell
cd sync
pip install -r requirements.txt

# Create .env file
echo MSSQL_SERVER=YOUR_SERVER > .env
echo MSSQL_DB=YOUR_DATABASE >> .env
echo SUPABASE_URL=postgresql://postgres:PASSWORD@db.XXXX.supabase.co:5432/postgres >> .env

# Run it
python sync_engine.py

# To run as a Windows service (always on, survives reboots)
pip install pywin32
python sync_engine.py install
python sync_engine.py start
```

---

## Running Locally (Development)

```bash
# Terminal 1 — Backend
cd backend
pip install -r requirements.txt
cp .env.example .env  # fill in values
uvicorn main:app --reload --port 8000

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev           # http://localhost:3000

# Terminal 3 — Sync (optional, office PC only)
cd sync
python sync_engine.py
```

First login: `admin@o3ccards.com` / `Admin@O3C2026`

---

## Adding New Users

Currently done via SQL in Supabase dashboard.
Generate a bcrypt hash for the password:

```python
from passlib.context import CryptContext
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
print(pwd.hash("their_password"))
```

Then insert into Supabase:
```sql
INSERT INTO o3c_users (email, password_hash, full_name, role, department)
VALUES ('email@o3ccards.com', 'HASH', 'Full Name', 'role_name', 'Department');
```

Valid roles: `admin`, `management`, `collections`, `sales`, `cards_ops`, `recovery`, `call_centre`
