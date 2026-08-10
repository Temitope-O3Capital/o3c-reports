-- Interswitch settlement feed + honest naming for the CCS master.
--
-- TWO corrections and one new feed:
--
-- 1. `interswitch_txns` never held Interswitch data. It holds the CCS (O3 CMS)
--    EODTXN export — "Report 620: Daily Financial Card Account Transactions" —
--    which carries branch, product, CIF and account, none of which appear in any
--    Interswitch report. The table is renamed `ccs_transactions`; a view keeps the
--    old name working so existing handlers are unaffected.
--
-- 2. The real Interswitch settlement reports land in `interswitch_legs`. Interswitch
--    emits ONE ROW PER SETTLEMENT LEG, not per transaction: a single purchase appears
--    as Amount_Payable plus one or more Issuer_fee_payable / Issuer_fee_receivable
--    rows, with Tran_Amount_Req repeated on each. Summing the amount column
--    double- or triple-counts. Legs are stored as they arrive and collapsed by the
--    `interswitch_transactions` view.
--
-- Model: CCS is the master ledger; Interswitch and Paystack are payment providers.
--   CCS <-> Interswitch joins on STAN, which is the last 6 digits of the RRN
--   (CCS stores it unpadded, Interswitch zero-padded to 6).

-- ── 1. Rename the CCS master honestly ────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='app' AND table_name='interswitch_txns'
               AND table_type='BASE TABLE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='app' AND table_name='ccs_transactions') THEN
    ALTER TABLE interswitch_txns RENAME TO ccs_transactions;
    -- Back-compat: 10+ handlers still read the old name.
    CREATE VIEW interswitch_txns AS SELECT * FROM ccs_transactions;
  END IF;
END $$;

-- ── 2. Interswitch settlement legs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interswitch_legs (
    id                     BIGSERIAL PRIMARY KEY,
    -- Provenance
    report_family          TEXT NOT NULL,   -- POS | ATM_WITHDRAWAL | WEB | QT_TRANSFERS | ...
    session                TEXT,            -- DR | PR (the two daily settlement sessions)
    source_file            TEXT,
    -- Identity
    settlement_date        DATE,            -- report DateTime (the settlement day)
    local_datetime         TIMESTAMPTZ,     -- when the cardholder actually transacted
    stan                   TEXT,            -- 6-digit; joins to CCS trace (LPAD 6)
    rrn                    TEXT,            -- 12-digit retrieval reference; last 6 = STAN
    tran_id                TEXT,            -- Interswitch transaction id
    auth_id                TEXT,
    pan                    TEXT,            -- masked
    card_brand             TEXT,
    -- Counterparties
    terminal_id            TEXT,
    merchant_id            TEXT,
    merchant_name          TEXT,
    from_account           TEXT,
    to_account             TEXT,
    beneficiary_account    TEXT,
    -- Money (kobo). amount_req repeats across legs; settlement_impact is per-leg.
    amount_req_kobo        BIGINT NOT NULL DEFAULT 0,
    amount_rsp_kobo        BIGINT NOT NULL DEFAULT 0,
    surcharge_kobo         BIGINT NOT NULL DEFAULT 0,
    settlement_impact_kobo BIGINT NOT NULL DEFAULT 0,
    settlement_impact_desc TEXT,            -- Amount_Payable | Issuer_fee_payable | ...
    merchant_discount_kobo BIGINT NOT NULL DEFAULT 0,
    merchant_receivable_kobo BIGINT NOT NULL DEFAULT 0,
    -- Descriptive
    currency               TEXT,
    tran_type_desc         TEXT,
    response_desc          TEXT,
    txn_status             TEXT,
    trxn_category          TEXT,
    region                 TEXT,
    message_type           TEXT,
    -- Idempotent re-upload: same leg from the same file never lands twice.
    row_hash               TEXT NOT NULL,
    imported_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_isw_legs_hash   ON interswitch_legs (row_hash);
CREATE INDEX IF NOT EXISTS idx_isw_legs_rrn          ON interswitch_legs (rrn);
CREATE INDEX IF NOT EXISTS idx_isw_legs_stan         ON interswitch_legs (stan);
CREATE INDEX IF NOT EXISTS idx_isw_legs_settle_date  ON interswitch_legs (settlement_date DESC);
CREATE INDEX IF NOT EXISTS idx_isw_legs_family       ON interswitch_legs (report_family, settlement_date DESC);
CREATE INDEX IF NOT EXISTS idx_isw_legs_impact       ON interswitch_legs (settlement_impact_desc);

-- Import audit, so the Runs & Imports page can show what was loaded and when.
CREATE TABLE IF NOT EXISTS interswitch_imports (
    id            BIGSERIAL PRIMARY KEY,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'running',
    files_n       INTEGER NOT NULL DEFAULT 0,
    legs_n        INTEGER NOT NULL DEFAULT 0,
    inserted_n    INTEGER NOT NULL DEFAULT 0,
    skipped_n     INTEGER NOT NULL DEFAULT 0,   -- duplicates already present
    errors        TEXT,
    triggered_by  BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_isw_imports_started ON interswitch_imports (started_at DESC);

-- ── 3. Transaction-level view (legs collapsed) ───────────────────────────────
-- Gross value is the Amount_Payable leg; everything else is fee/commission. This
-- is the ONLY correct way to total an Interswitch report.
CREATE OR REPLACE VIEW interswitch_transactions AS
SELECT
    report_family,
    session,
    settlement_date,
    MIN(local_datetime)                                   AS local_datetime,
    rrn,
    MAX(stan)                                             AS stan,
    MAX(tran_id)                                          AS tran_id,
    MAX(pan)                                              AS pan,
    MAX(terminal_id)                                      AS terminal_id,
    MAX(merchant_name)                                    AS merchant_name,
    MAX(tran_type_desc)                                   AS tran_type_desc,
    MAX(txn_status)                                       AS txn_status,
    MAX(amount_req_kobo)                                  AS amount_kobo,
    -- Gross is the Amount_Payable leg when one exists. Two families never emit it:
    -- IPG has no Settlement_Impact column at all, and on the issuing side (WEB,
    -- Billpayment, Transfer_Service_Core) O3's only settlement impact is the fee —
    -- the principal moves to the acquirer. Both fall back to the requested amount,
    -- otherwise those channels silently total zero.
    CASE WHEN COUNT(*) FILTER (WHERE settlement_impact_desc = 'Amount_Payable') = 0
         THEN MAX(amount_req_kobo)
         ELSE SUM(settlement_impact_kobo)
              FILTER (WHERE settlement_impact_desc = 'Amount_Payable')
    END                                                   AS gross_kobo,
    COALESCE(SUM(settlement_impact_kobo)
             FILTER (WHERE settlement_impact_desc NOT IN ('Amount_Payable','')), 0) AS fees_kobo,
    COUNT(*)                                              AS legs_n
FROM interswitch_legs
WHERE rrn <> ''
GROUP BY report_family, session, settlement_date, rrn;
