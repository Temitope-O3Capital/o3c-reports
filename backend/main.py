"""
O3C Cards Reporting API
FastAPI backend — dual source (MSSQL live + Supabase fallback)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from core.database import check_mssql_health, check_pg_health, pg_engine, Base
from routers import auth, overview, transactions, collections, recovery, sales, cards, cohort, admin
from routers import crm_contacts, crm_deals, crm_activities, crm_tasks, crm_requests, crm_reports
from routers import executive
from routers import income, uploads, eod
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s — %(message)s")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS o3c_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'call_centre',
  department    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "Accounts" (
  "CIF Number" TEXT, "Account Created Date" TIMESTAMPTZ,
  "First Name" TEXT, "Last Name" TEXT, "Full Address" TEXT,
  "Birthday" DATE, "Email" TEXT, "Job Title" TEXT, "State" TEXT, "City" TEXT
);
CREATE TABLE IF NOT EXISTS "Products" (
  "CIF Number" TEXT, "Name On Card" TEXT, "Account Manager" TEXT,
  "Product Name" TEXT, "Account Status" TEXT
);
CREATE TABLE IF NOT EXISTS "Transactions" (
  "Transaction Date" TIMESTAMPTZ, "Amount" NUMERIC,
  "Description" TEXT, "Merchant_Name" TEXT, "CIF Number" TEXT
);
CREATE TABLE IF NOT EXISTS "Monthly Activity" (
  "CIF Number" TEXT, "ActivityMonth" TIMESTAMPTZ,
  "TxnCount" INTEGER, "TotalSpend" NUMERIC
);
CREATE TABLE IF NOT EXISTS "Collections Log" (
  "Date" TIMESTAMPTZ, "CIF" TEXT, "Agent" TEXT, "Amount" NUMERIC,
  "Mode Of Payment" TEXT, "Payment Receipt" TEXT
);
CREATE TABLE IF NOT EXISTS "CIF Table" (
  "CIF Number" TEXT, "Cohort Date" TIMESTAMPTZ, "Cohort Label" TEXT
);
CREATE TABLE IF NOT EXISTS "Recovery Master Sheet" (
  "CIF Number" TEXT, "Recovery Date" TIMESTAMPTZ, "Recovery Amount" NUMERIC,
  "Recovery Method" TEXT, "Legal Stage" TEXT, "Agent" TEXT, "Status" TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_date      ON "Transactions" ("Transaction Date");
CREATE INDEX IF NOT EXISTS idx_txn_cif       ON "Transactions" ("CIF Number");
CREATE INDEX IF NOT EXISTS idx_acc_created   ON "Accounts" ("Account Created Date");
CREATE INDEX IF NOT EXISTS idx_coll_date     ON "Collections Log" ("Date");
CREATE INDEX IF NOT EXISTS idx_recovery_date ON "Recovery Master Sheet" ("Recovery Date");
CREATE INDEX IF NOT EXISTS idx_ma_month      ON "Monthly Activity" ("ActivityMonth");
CREATE INDEX IF NOT EXISTS idx_cif_cohort    ON "CIF Table" ("Cohort Date");
INSERT INTO o3c_users (email, password_hash, full_name, role, department)
VALUES (
  'admin@o3ccards.com',
  '$2b$12$GvzdUouzBgirlOTGF0J..OdSBCTJXB4gCtY6TNM3tWrjp/wVQpHuy',
  'O3C Admin', 'admin', 'Technology'
) ON CONFLICT (email) DO NOTHING;

-- ── CRM Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  order_index INT  NOT NULL,
  color       TEXT DEFAULT '#6B7280',
  is_won      BOOLEAN DEFAULT FALSE,
  is_lost     BOOLEAN DEFAULT FALSE
);
INSERT INTO crm_pipeline_stages (name, order_index, color, is_won, is_lost) VALUES
  ('New Lead',     0, '#6B7280', FALSE, FALSE),
  ('Contacted',    1, '#3B82F6', FALSE, FALSE),
  ('Interested',   2, '#8B5CF6', FALSE, FALSE),
  ('KYC Started',  3, '#F59E0B', FALSE, FALSE),
  ('KYC Complete', 4, '#0EA5E9', FALSE, FALSE),
  ('Card Issued',  5, '#10B981', TRUE,  FALSE),
  ('Lost',         6, '#EF4444', FALSE, TRUE)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_contacts (
  id            SERIAL PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  state         TEXT,
  city          TEXT,
  address       TEXT,
  date_of_birth DATE,
  gender        TEXT,
  occupation    TEXT,
  employer      TEXT,
  income_range  TEXT,
  id_type       TEXT,
  id_number     TEXT,
  source        TEXT DEFAULT 'walk_in',
  cif_number    TEXT,
  status        TEXT DEFAULT 'lead',
  assigned_to   INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  tags          TEXT,
  notes         TEXT,
  created_by    INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_cif    ON crm_contacts(cif_number);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner  ON crm_contacts(assigned_to);

CREATE TABLE IF NOT EXISTS crm_deals (
  id                   SERIAL PRIMARY KEY,
  contact_id           INT  REFERENCES crm_contacts(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  stage_id             INT  REFERENCES crm_pipeline_stages(id),
  product              TEXT,
  expected_value       NUMERIC,
  probability          INT  DEFAULT 50,
  expected_close_date  DATE,
  lost_reason          TEXT,
  assigned_to          INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_by           INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage   ON crm_deals(stage_id);

CREATE TABLE IF NOT EXISTS crm_activities (
  id              SERIAL PRIMARY KEY,
  contact_id      INT  REFERENCES crm_contacts(id) ON DELETE CASCADE,
  deal_id         INT  REFERENCES crm_deals(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  direction       TEXT,
  subject         TEXT,
  body            TEXT,
  outcome         TEXT,
  duration_mins   INT,
  next_follow_up  TIMESTAMPTZ,
  completed       BOOLEAN DEFAULT TRUE,
  completed_at    TIMESTAMPTZ,
  created_by      INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_act_contact ON crm_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_act_created ON crm_activities(created_at);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id           SERIAL PRIMARY KEY,
  contact_id   INT  REFERENCES crm_contacts(id) ON DELETE SET NULL,
  deal_id      INT  REFERENCES crm_deals(id)    ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  due_date     TIMESTAMPTZ,
  priority     TEXT DEFAULT 'medium',
  status       TEXT DEFAULT 'open',
  assigned_to  INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_by   INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_assigned ON crm_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_due      ON crm_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status   ON crm_tasks(status);

CREATE TABLE IF NOT EXISTS crm_requests (
  id            SERIAL PRIMARY KEY,
  contact_id    INT  REFERENCES crm_contacts(id) ON DELETE SET NULL,
  cif_number    TEXT,
  request_type  TEXT NOT NULL,
  subject       TEXT NOT NULL,
  description   TEXT,
  priority      TEXT DEFAULT 'medium',
  status        TEXT DEFAULT 'open',
  resolution    TEXT,
  sla_hours     INT  DEFAULT 24,
  assigned_to   INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  escalated_to  INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  created_by    INT  REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_req_status  ON crm_requests(status);
CREATE INDEX IF NOT EXISTS idx_crm_req_contact ON crm_requests(contact_id);

-- ── Income Report Tables ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS income_cycles (
  id         SERIAL PRIMARY KEY,
  cycle_date DATE        NOT NULL,
  label      TEXT        NOT NULL,
  loaded_at  TIMESTAMPTZ DEFAULT NOW(),
  loaded_by  INT         REFERENCES o3c_users(id) ON DELETE SET NULL,
  UNIQUE(cycle_date)
);

CREATE TABLE IF NOT EXISTS income_customers (
  id         SERIAL PRIMARY KEY,
  cycle_id   INT  REFERENCES income_cycles(id) ON DELETE CASCADE,
  cif        TEXT NOT NULL,
  first_name TEXT,
  last_name  TEXT,
  address    TEXT,
  state      TEXT,
  city       TEXT,
  phone      TEXT,
  email      TEXT,
  mobile     TEXT
);
CREATE INDEX IF NOT EXISTS idx_inc_cust_cif ON income_customers(cif, cycle_id);

CREATE TABLE IF NOT EXISTS income_interest (
  id           SERIAL PRIMARY KEY,
  cycle_id     INT     REFERENCES income_cycles(id) ON DELETE CASCADE,
  apnum        TEXT,
  cif          TEXT    NOT NULL,
  account      TEXT,
  currency     TEXT    DEFAULT 'NGN',
  product_code TEXT,
  product_name TEXT,
  interest     NUMERIC DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inc_int_cif     ON income_interest(cif, cycle_id);
CREATE INDEX IF NOT EXISTS idx_inc_int_product ON income_interest(product_name, cycle_id);

CREATE TABLE IF NOT EXISTS income_charges (
  id           SERIAL PRIMARY KEY,
  cycle_id     INT     REFERENCES income_cycles(id) ON DELETE CASCADE,
  apnum        TEXT,
  cif          TEXT    NOT NULL,
  account      TEXT,
  currency     TEXT    DEFAULT 'NGN',
  product_code TEXT,
  product_name TEXT,
  fees         NUMERIC DEFAULT 0,
  interest     NUMERIC DEFAULT 0,
  penalty      NUMERIC DEFAULT 0,
  purchase     NUMERIC DEFAULT 0,
  cash_advance NUMERIC DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inc_chg_cif ON income_charges(cif, cycle_id);

CREATE TABLE IF NOT EXISTS income_balances (
  id              SERIAL PRIMARY KEY,
  cycle_id        INT     REFERENCES income_cycles(id) ON DELETE CASCADE,
  apnum           TEXT,
  cif             TEXT    NOT NULL,
  account         TEXT,
  currency        TEXT    DEFAULT 'NGN',
  product_code    TEXT,
  product_name    TEXT,
  billed_bal      NUMERIC DEFAULT 0,
  current_bal     NUMERIC DEFAULT 0,
  outstanding_bal NUMERIC DEFAULT 0,
  overdue         NUMERIC DEFAULT 0,
  min_payment     NUMERIC DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inc_bal_cif ON income_balances(cif, cycle_id);

CREATE TABLE IF NOT EXISTS income_loc (
  id           SERIAL PRIMARY KEY,
  cycle_id     INT     REFERENCES income_cycles(id) ON DELETE CASCADE,
  apnum        TEXT,
  cif          TEXT    NOT NULL,
  account      TEXT,
  currency     TEXT    DEFAULT 'NGN',
  product_code TEXT,
  product_name TEXT,
  current_loc  NUMERIC DEFAULT 0,
  loc_change   NUMERIC DEFAULT 0,
  temp_loc     NUMERIC DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inc_loc_cif ON income_loc(cif, cycle_id);

-- ── EOD Transaction Tables ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eod_uploads (
  id          SERIAL PRIMARY KEY,
  txn_date    DATE        NOT NULL UNIQUE,
  filename    TEXT,
  txn_count   INT         DEFAULT 0,
  uploaded_by INT         REFERENCES o3c_users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eod_uploads_date ON eod_uploads(txn_date DESC);

CREATE TABLE IF NOT EXISTS eod_transactions (
  id            SERIAL PRIMARY KEY,
  upload_id     INT     REFERENCES eod_uploads(id) ON DELETE CASCADE,
  txn_date      DATE    NOT NULL,
  branch_code   TEXT,
  branch_name   TEXT,
  product_code  TEXT,
  product_name  TEXT,
  account_no    TEXT,
  cif           TEXT,
  customer      TEXT,
  arrears       NUMERIC DEFAULT 0,
  loc           NUMERIC DEFAULT 0,
  balance       NUMERIC DEFAULT 0,
  trace_num     TEXT,
  auth_num      TEXT,
  card_num      TEXT,
  txn_code      TEXT,
  txn_category  TEXT,
  amount        NUMERIC NOT NULL DEFAULT 0,
  sign          TEXT,
  currency      TEXT    DEFAULT 'NGN',
  merchant_id   TEXT,
  merchant_name TEXT,
  description   TEXT
);
CREATE INDEX IF NOT EXISTS idx_eod_txn_upload   ON eod_transactions(upload_id);
CREATE INDEX IF NOT EXISTS idx_eod_txn_date     ON eod_transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_eod_txn_cif      ON eod_transactions(cif);
CREATE INDEX IF NOT EXISTS idx_eod_txn_branch   ON eod_transactions(branch_code);
CREATE INDEX IF NOT EXISTS idx_eod_txn_product  ON eod_transactions(product_code);
CREATE INDEX IF NOT EXISTS idx_eod_txn_category ON eod_transactions(txn_category);

-- ── Upload Audit Log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_audit_log (
  id          SERIAL PRIMARY KEY,
  uploaded_by INT REFERENCES o3c_users(id) ON DELETE SET NULL,
  report_type TEXT NOT NULL,
  file_names  TEXT,
  cycle_label TEXT,
  row_counts  JSONB,
  status      TEXT DEFAULT 'success',
  error_msg   TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_at  ON upload_audit_log(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_who ON upload_audit_log(uploaded_by);

-- ── Onboarding columns (added idempotently) ───────────────────────────────
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE;
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
-- Existing admin account never needs forced reset
UPDATE o3c_users SET must_change_password = FALSE WHERE email = 'admin@o3ccards.com';
"""

@asynccontextmanager
async def lifespan(app: FastAPI):
    log = logging.getLogger("o3c.startup")
    try:
        from sqlalchemy import text as _text
        with pg_engine.connect() as conn:
            conn.execute(_text(SCHEMA_SQL))
            conn.commit()
        log.info("Schema migration complete")
    except Exception as e:
        log.warning(f"Schema migration skipped: {e}")
    yield

app = FastAPI(
    title="O3C Cards Reporting API",
    version="2.0.0",
    description="Dual-source reporting API: MSSQL (live) with Supabase fallback",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router,         prefix="/api/auth",         tags=["Auth"])
app.include_router(overview.router,     prefix="/api/overview",     tags=["Overview"])
app.include_router(transactions.router, prefix="/api/transactions",  tags=["Transactions"])
app.include_router(collections.router,  prefix="/api/collections",  tags=["Collections"])
app.include_router(recovery.router,     prefix="/api/recovery",     tags=["Recovery"])
app.include_router(sales.router,        prefix="/api/sales",        tags=["Sales"])
app.include_router(cards.router,        prefix="/api/cards",        tags=["Cards"])
app.include_router(cohort.router,       prefix="/api/cohort",       tags=["Cohort"])
app.include_router(admin.router)
app.include_router(crm_contacts.router,   prefix="/api/crm",  tags=["CRM"])
app.include_router(crm_deals.router,      prefix="/api/crm",  tags=["CRM"])
app.include_router(crm_activities.router, prefix="/api/crm",  tags=["CRM"])
app.include_router(crm_tasks.router,      prefix="/api/crm",  tags=["CRM"])
app.include_router(crm_requests.router,   prefix="/api/crm",  tags=["CRM"])
app.include_router(crm_reports.router,    prefix="/api/crm",  tags=["CRM"])
app.include_router(executive.router,      prefix="/api/executive", tags=["Executive"])
app.include_router(income.router,         prefix="/api/income",    tags=["Income"])
app.include_router(uploads.router,        prefix="/api/uploads",   tags=["Uploads"])
app.include_router(eod.router,            prefix="/api/eod",        tags=["EOD"])

# ── Health endpoint ───────────────────────────────────────────────────────────
@app.get("/api/health", tags=["Health"])
def health():
    mssql = check_mssql_health()
    pg    = check_pg_health()
    active_source = "mssql_live" if mssql["status"] == "online" else "supabase_snapshot"
    return {
        "api": "ok",
        "mssql":  mssql,
        "supabase": pg,
        "active_source": active_source,
    }
