-- Customer feed ingestion, and account-officer ownership as a first-class concept.
--
-- Two problems solved together because they share a key (CIF):
--
-- 1. WHERE NEW CUSTOMERS COME FROM. Customers are not created in Udara — Udara holds
--    only the loan and FD books. They arrive in the 15-minute `cust_file` drops
--    (docs/DATA_FEED_INGESTION.md §3.1). Until now nothing read that feed, so
--    app.customers was a frozen mssql_baseline snapshot ending 2025-07-09 and the
--    workspace reported acquisition as having collapsed to ~65/year.
--
-- 2. WHO OWNS THE CUSTOMER. Account-officer ownership previously lived in Sage's
--    `dbo.Account.Account_Manager_txt`. That column is NOT carried by the feed (see
--    the acct_file column map, §3.2 — 20 fields, none of them an officer) and was
--    never backfilled: app."Products"."Account Manager" is NULL on all 20,474 rows.
--    The data no longer exists anywhere, and the system that held it is retired.
--
--    So ownership becomes workspace-owned, in its own table rather than a column on
--    app.customers. That is deliberate: app.customers is FEED-owned and gets upserted
--    on every ingest, whereas an assignment is a decision a human made and must
--    survive re-ingest, carry an audit trail, and never be silently overwritten by a
--    file drop.

-- ── 1. A unique key on CIF so the feed can upsert ────────────────────────────

-- One genuine duplicate blocks the index: CIF 00032142 appears twice (same person,
-- same phone), one row carrying 2 accounts and 1 transaction, the other carrying
-- nothing. Remove only the orphan, and only if it is still an orphan — guarded so
-- re-running the migration is a no-op and so it can never delete a row that has since
-- acquired references.
DELETE FROM app.customers c
WHERE c.cif = '00032142'
  AND NOT EXISTS (SELECT 1 FROM app.accounts     a WHERE a.contact_id = c.contact_id)
  AND NOT EXISTS (SELECT 1 FROM app.transactions t WHERE t.contact_id = c.contact_id)
  AND EXISTS (
      SELECT 1 FROM app.customers o
      WHERE o.cif = c.cif AND o.contact_id <> c.contact_id
        AND EXISTS (SELECT 1 FROM app.accounts a WHERE a.contact_id = o.contact_id)
  );

-- Partial: 36 legacy rows have a blank CIF (one of them with accounts). They predate
-- the feed and cannot be matched by CIF anyway, so they are excluded rather than
-- deleted.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_cif
    ON app.customers (cif)
    WHERE cif IS NOT NULL AND cif <> '';

-- ── 2. Feed provenance on the customer master ────────────────────────────────

-- source, source_file and last_seen already exist and were built for exactly this.
-- first_seen_at is new: cust_file carries no creation date (12 fields, none a date),
-- so for customers arriving after the baseline, the first time the feed showed us the
-- CIF is the best acquisition timestamp we have. It is never overwritten on update.
ALTER TABLE app.customers
    ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN app.customers.first_seen_at IS
    'When the cust_file feed first delivered this CIF. Acquisition proxy for post-baseline customers; account_created is authoritative where present.';

CREATE INDEX IF NOT EXISTS idx_customers_first_seen ON app.customers (first_seen_at);
CREATE INDEX IF NOT EXISTS idx_customers_account_created ON app.customers (account_created);

-- ── 3. Feed ingestion bookkeeping ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_feed_runs (
    id                 BIGSERIAL PRIMARY KEY,
    kind               TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'scheduled'
    status             TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'ok' | 'error'
    started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ,
    error              TEXT,

    files_seen         INTEGER NOT NULL DEFAULT 0,
    files_parsed       INTEGER NOT NULL DEFAULT 0,
    files_empty        INTEGER NOT NULL DEFAULT 0,   -- 0-byte = no change in that window, not an error
    files_failed       INTEGER NOT NULL DEFAULT 0,
    rows_read          INTEGER NOT NULL DEFAULT 0,
    rows_rejected      INTEGER NOT NULL DEFAULT 0,   -- unparseable / no CIF
    customers_inserted INTEGER NOT NULL DEFAULT 0,
    customers_updated  INTEGER NOT NULL DEFAULT 0,

    triggered_by       BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_feed_runs_started
    ON customer_feed_runs (started_at DESC);

-- filename is UNIQUE and is the whole idempotency story: the feed drops deltas, so
-- replaying a file would be harmless for content but would double-count the run
-- statistics and re-stamp last_seen. A processed file is never read again.
CREATE TABLE IF NOT EXISTS customer_feed_files (
    id            BIGSERIAL PRIMARY KEY,
    filename      TEXT NOT NULL UNIQUE,
    feed_date     DATE,
    seq           INTEGER,
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    rows_read     INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'empty' | 'failed'
    error         TEXT,
    processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_id        BIGINT REFERENCES customer_feed_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_feed_files_run  ON customer_feed_files (run_id);
CREATE INDEX IF NOT EXISTS idx_customer_feed_files_date ON customer_feed_files (feed_date DESC);

-- ── 4. Account-officer ownership ─────────────────────────────────────────────

-- One officer owns a customer at a time, so CIF is the primary key. Ownership is
-- keyed on CIF rather than app.customers.contact_id because CIF is the key every
-- other module already joins on (loans, cards, transactions, statements) and it
-- survives a re-ingest that rewrites contact rows.
CREATE TABLE IF NOT EXISTS customer_officers (
    cif          TEXT PRIMARY KEY,
    officer_id   BIGINT NOT NULL REFERENCES o3c_users(id) ON DELETE RESTRICT,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_by  BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    -- 'manual'   — assigned in the workspace by a head
    -- 'import'   — bulk CSV load
    -- 'converted'— set automatically when a lead this officer owned became a customer
    source       TEXT NOT NULL DEFAULT 'manual',
    note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_customer_officers_officer
    ON customer_officers (officer_id);

-- ON DELETE RESTRICT above stops an officer being deleted while they still hold a
-- book; reassignment must be explicit. History is kept separately so the audit trail
-- outlives both the assignment and the user record.
CREATE TABLE IF NOT EXISTS customer_officer_history (
    id              BIGSERIAL PRIMARY KEY,
    cif             TEXT NOT NULL,
    from_officer_id BIGINT,
    to_officer_id   BIGINT,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by      BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_customer_officer_history_cif
    ON customer_officer_history (cif, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_officer_history_to
    ON customer_officer_history (to_officer_id, changed_at DESC);
