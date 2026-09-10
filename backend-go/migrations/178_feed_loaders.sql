-- Migration 178: groundwork for the account / transaction / card-family feed loaders.
--
-- The 15-minute drops (docs/DATA_FEED_INGESTION.md) have four streams; until now only
-- cust_file → app.customers had a loader. This adds what the acct_file / txn_file /
-- cardfam_file loaders need:
--   1. A UNIQUE key on app.accounts(account_no) so the loader can upsert on it (the
--      feed's account key), after collapsing the 3 duplicate account_no rows.
--   2. Generic feed_runs / feed_files tracking tables (stream-tagged) mirroring the
--      customer_feed_* pattern, so each stream records what it processed and never
--      re-reads a file.
-- Idempotent.

-- ── 1. Collapse duplicate account_no, then enforce uniqueness ─────────────────
-- Only 3 account_no values carry a second row. Keep the richest survivor (feed >
-- o3c > baseline, then most-recent last_seen), repoint its transactions, drop losers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='app' AND indexname='uq_accounts_account_no'
  ) THEN
    CREATE TEMP TABLE acct_dedup ON COMMIT DROP AS
    SELECT account_id, account_no,
           ROW_NUMBER() OVER (
             PARTITION BY account_no
             ORDER BY (source='feed') DESC, (source LIKE 'o3c%') DESC,
                      last_seen DESC NULLS LAST, account_id
           ) AS rn
      FROM app.accounts
     WHERE account_no IN (
       SELECT account_no FROM app.accounts
        WHERE account_no IS NOT NULL AND account_no <> ''
        GROUP BY account_no HAVING COUNT(*) > 1);

    UPDATE app.transactions t SET account_id = win.account_id
      FROM acct_dedup loser
      JOIN acct_dedup win ON win.account_no = loser.account_no AND win.rn = 1
     WHERE loser.rn > 1 AND t.account_id = loser.account_id;

    DELETE FROM app.accounts a USING acct_dedup d
     WHERE a.account_id = d.account_id AND d.rn > 1;

    CREATE UNIQUE INDEX uq_accounts_account_no
        ON app.accounts (account_no) WHERE account_no IS NOT NULL AND account_no <> '';
  END IF;
END $$;

-- ── 2. Generic feed tracking (stream-tagged) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS feed_runs (
  id            BIGSERIAL PRIMARY KEY,
  stream        TEXT NOT NULL,                 -- accounts | transactions | cardfam
  kind          TEXT NOT NULL,                 -- scheduled | manual | backfill
  status        TEXT NOT NULL DEFAULT 'running',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  files_seen    INT DEFAULT 0,
  files_parsed  INT DEFAULT 0,
  files_empty   INT DEFAULT 0,
  files_failed  INT DEFAULT 0,
  rows_read     INT DEFAULT 0,
  rows_rejected INT DEFAULT 0,
  rows_inserted INT DEFAULT 0,
  rows_updated  INT DEFAULT 0,
  triggered_by  BIGINT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_feed_runs_stream ON feed_runs (stream, id DESC);

CREATE TABLE IF NOT EXISTS feed_files (
  stream        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  feed_date     DATE,
  seq           INT,
  size_bytes    BIGINT,
  rows_read     INT,
  rows_rejected INT,
  status        TEXT NOT NULL,                 -- ok | empty | failed
  error         TEXT,
  run_id        BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream, filename)
);
