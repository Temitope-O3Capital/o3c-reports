# Supabase Setup Guide

Run these SQL statements in the **Supabase SQL Editor** (supabase.com → your project → SQL Editor).

---

## 1. Create the users table

```sql
CREATE TABLE IF NOT EXISTS o3c_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'call_centre',
  department    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## 2. Create the first admin user

Generate the password hash on your local machine:
```bash
python -c "from passlib.context import CryptContext; print(CryptContext(schemes=['bcrypt']).hash('Admin@O3C2026'))"
```

Then paste the hash into this SQL:
```sql
INSERT INTO o3c_users (email, password_hash, full_name, role, department)
VALUES (
  'admin@o3ccards.com',
  '$2b$12$PASTE_YOUR_HASH_HERE',
  'O3C Admin',
  'admin',
  'Technology'
);
```

**Change the password immediately after first login.**

---

## 3. Create reporting tables

These are populated by the sync engine. Run once to create the empty structure.

```sql
-- Accounts
CREATE TABLE IF NOT EXISTS "Accounts" (
  "CIF Number"           TEXT,
  "Account Created Date" TIMESTAMPTZ,
  "First Name"           TEXT,
  "Last Name"            TEXT,
  "Full Address"         TEXT,
  "Birthday"             DATE,
  "Email"                TEXT,
  "Job Title"            TEXT,
  "State"                TEXT,
  "City"                 TEXT
);

-- Products
CREATE TABLE IF NOT EXISTS "Products" (
  "CIF Number"     TEXT,
  "Name On Card"   TEXT,
  "Account Manager" TEXT,
  "Product Name"   TEXT,
  "Account Status" TEXT
);

-- Transactions
CREATE TABLE IF NOT EXISTS "Transactions" (
  "Transaction Date" TIMESTAMPTZ,
  "Amount"           NUMERIC,
  "Description"      TEXT,
  "Merchant_Name"    TEXT,
  "CIF Number"       TEXT
);

-- Monthly Activity
CREATE TABLE IF NOT EXISTS "Monthly Activity" (
  "CIF Number"    TEXT,
  "ActivityMonth" TIMESTAMPTZ,
  "TxnCount"      INTEGER,
  "TotalSpend"    NUMERIC
);

-- Collections Log
CREATE TABLE IF NOT EXISTS "Collections Log" (
  "Date"            TIMESTAMPTZ,
  "CIF"             TEXT,
  "Agent"           TEXT,
  "Amount"          NUMERIC,
  "Mode Of Payment" TEXT,
  "Payment Receipt" TEXT
);

-- CIF Table
CREATE TABLE IF NOT EXISTS "CIF Table" (
  "CIF Number"  TEXT,
  "Cohort Date" TIMESTAMPTZ,
  "Cohort Label" TEXT
);

-- Recovery Master Sheet
CREATE TABLE IF NOT EXISTS "Recovery Master Sheet" (
  "CIF Number"       TEXT,
  "Recovery Date"    TIMESTAMPTZ,
  "Recovery Amount"  NUMERIC,
  "Recovery Method"  TEXT,
  "Legal Stage"      TEXT,
  "Agent"            TEXT,
  "Status"           TEXT
);
```

---

## 4. Add indexes for query performance

```sql
CREATE INDEX IF NOT EXISTS idx_txn_date       ON "Transactions" ("Transaction Date");
CREATE INDEX IF NOT EXISTS idx_txn_cif        ON "Transactions" ("CIF Number");
CREATE INDEX IF NOT EXISTS idx_acc_created    ON "Accounts" ("Account Created Date");
CREATE INDEX IF NOT EXISTS idx_coll_date      ON "Collections Log" ("Date");
CREATE INDEX IF NOT EXISTS idx_recovery_date  ON "Recovery Master Sheet" ("Recovery Date");
CREATE INDEX IF NOT EXISTS idx_ma_month       ON "Monthly Activity" ("ActivityMonth");
CREATE INDEX IF NOT EXISTS idx_cif_cohort     ON "CIF Table" ("Cohort Date");
```

---

## 5. Disable Row Level Security (RLS) on reporting tables

The backend connects with the service role key, so RLS should be off for these tables:

```sql
ALTER TABLE "Accounts"              DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Products"              DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Transactions"          DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Monthly Activity"      DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Collections Log"       DISABLE ROW LEVEL SECURITY;
ALTER TABLE "CIF Table"             DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Recovery Master Sheet" DISABLE ROW LEVEL SECURITY;
ALTER TABLE o3c_users               DISABLE ROW LEVEL SECURITY;
```
