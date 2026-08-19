-- 157_income_model_and_collections_kpi.sql
--
-- Gives the reporting layer a real revenue model and a way to populate the
-- collections KPI rollup.
--
-- Background: the workspace's revenue figures all read app.fee_income, which has
-- never had a row in it, so "Revenue" reported ₦0 while 1.1m card transactions
-- sat in app.transactions carrying every fee, interest and penalty posting the
-- business has ever made.
--
-- Nothing here is invented. Every category below is derived from the transaction
-- descriptions Card & Cash Solutions already writes into the book — "Membership
-- Fee", "Cash Advance Fee", "Overdue Interest", "Penalty Charge" and so on. The
-- registry is seeded from the codes actually present in the data, and any code
-- that appears later registers itself as 'unclassified' rather than being
-- silently counted or silently dropped.
--
-- Idempotent: safe to re-run.

-- ── Transaction code registry ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app.card_txn_codes (
  code             text PRIMARY KEY,
  description      text,
  category         text NOT NULL DEFAULT 'unclassified',
  -- counts_in_total exists because of a real double-count trap: code 604
  -- "Total Interest" is a ROLLUP of 600 "Purchase Txn Interest", 601 "Advance
  -- Txn Interest" and 603 "Overdue Interest". Measured on this book, 604 equals
  -- the sum of those three on 85,618 of the 95,553 account-days where both are
  -- present. Summing all four would nearly double reported interest income.
  -- 604 is the authoritative posted total; the components are the breakdown and
  -- are flagged FALSE so they can be shown without being added.
  counts_in_total  boolean NOT NULL DEFAULT TRUE,
  first_seen_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.card_txn_codes IS
  'CCS transaction code taxonomy. Categories drive every income report. Codes '
  'auto-register from app.transactions as unclassified; classify them here.';

-- Seed from the descriptions in the book itself. ON CONFLICT DO NOTHING so a
-- re-run never overwrites a classification the business has since corrected.
INSERT INTO app.card_txn_codes (code, description, category, counts_in_total) VALUES
  -- Fees
  ('100', 'Membership Fee',            'fee',       TRUE),
  ('104', 'Re-Issue Fee',              'fee',       TRUE),
  ('105', 'Joining Fee',               'fee',       TRUE),
  ('108', 'Account Maintenance Fee',   'fee',       TRUE),
  ('111', 'Cash Advance Fee',          'fee',       TRUE),
  ('112', 'Foreign Purchase Fee',      'fee',       TRUE),
  ('129', 'Misc Fees/Charges Debit',   'fee',       TRUE),
  ('161', 'Cash Advance Fee Reversal', 'fee',       TRUE),
  ('821', 'Fee Adjustment Debit',      'fee',       TRUE),
  ('871', 'Fee Adjustment Credit',     'fee',       TRUE),
  -- Interest. 604 is the total; 600/601/603 are its components.
  ('604', 'Total Interest',            'interest',  TRUE),
  ('600', 'Purchase Txn Interest',     'interest',  FALSE),
  ('601', 'Advance Txn Interest',      'interest',  FALSE),
  ('603', 'Overdue Interest',          'interest',  FALSE),
  ('820', 'Interest Adjustment Debit', 'interest',  TRUE),
  ('870', 'Interest Adjustment Credit','interest',  TRUE),
  -- Penalties
  ('602', 'Penalty Charge',            'penalty',   TRUE),
  ('416', 'Payment To Penalty',        'payment',   TRUE),
  ('872', 'Penalty Adjustment Credit', 'penalty',   TRUE),
  -- Spend / utilisation (not income — this is what the customer did)
  ('200', 'Purchase',                  'purchase',      TRUE),
  ('202', 'Foreign Purchase',          'purchase',      TRUE),
  ('250', 'Purchase Reversal',         'purchase',      TRUE),
  ('252', 'Foreign Purchase Reversal', 'purchase',      TRUE),
  ('823', 'Purchase Adjustment Debit', 'purchase',      TRUE),
  ('873', 'Purchase Adjustment Credit','purchase',      TRUE),
  ('300', 'Cash Advance',              'cash_advance',  TRUE),
  ('302', 'Foreign Cash Advance',      'cash_advance',  TRUE),
  ('350', 'Cash Advance Reversal',     'cash_advance',  TRUE),
  ('352', 'Foreign Cash Advance Reversal', 'cash_advance', TRUE),
  ('824', 'Cash Advance Adjustment Debit', 'cash_advance', TRUE),
  ('874', 'Cash Advance Adjustment Credit','cash_advance', TRUE),
  ('303', 'Utility Payment',           'utility',       TRUE),
  ('353', 'Utility Payment Reversal',  'utility',       TRUE),
  -- Repayments (credits — money coming back in)
  ('402', 'Cash Payment Bank',         'payment',   TRUE),
  ('452', 'Cash Payment Bank Reversal','payment',   TRUE),
  ('411', 'Payment To Purchase',       'payment',   TRUE),
  ('412', 'Payment To Cash Advance',   'payment',   TRUE),
  ('413', 'Payment To Fees',           'payment',   TRUE),
  ('414', 'Payment To Interest',       'payment',   TRUE),
  -- Transfers
  ('422', 'Web Transfer In',           'transfer',  TRUE),
  ('423', 'Web Transfer Out',          'transfer',  TRUE),
  ('473', 'Web Transfer Out Reversal', 'transfer',  TRUE),
  -- Non-financial
  ('903', 'Balance Inquiry',           'non_financial', TRUE),
  ('811', 'Change in Line of Credit',  'non_financial', TRUE),
  ('000', '',                          'non_financial', TRUE)
ON CONFLICT (code) DO NOTHING;

-- Auto-register any code that turns up later, so a new CCS code surfaces as a
-- visible gap ('unclassified') instead of quietly falling out of the numbers.
CREATE OR REPLACE FUNCTION app.sync_card_txn_codes() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  INSERT INTO app.card_txn_codes (code, description, category)
  SELECT t.txn_code,
         mode() WITHIN GROUP (ORDER BY t.description),
         'unclassified'
  FROM app.transactions t
  WHERE NULLIF(t.txn_code,'') IS NOT NULL
  GROUP BY t.txn_code
  ON CONFLICT (code) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

SELECT app.sync_card_txn_codes();

-- ── Income model ─────────────────────────────────────────────────────────────
--
-- One place the business's revenue is defined. Amounts on this book are numeric
-- NAIRA (major units), not kobo — unlike the rest of the workspace. Income
-- postings are debits to the customer (positive); reversals and credits carry
-- negative amounts already, so a plain SUM nets correctly.

CREATE OR REPLACE VIEW app.income_daily AS
SELECT t.txn_date                                   AS income_date,
       c.category,
       COALESCE(NULLIF(t.product_name,''), 'Unspecified') AS product_name,
       COUNT(*)                                     AS txn_count,
       SUM(t.amount)                                AS amount_ngn
FROM app.transactions t
JOIN app.card_txn_codes c ON c.code = t.txn_code
WHERE c.category IN ('fee','interest','penalty')
  AND c.counts_in_total          -- excludes the 600/601/603 interest components
GROUP BY 1, 2, 3;

COMMENT ON VIEW app.income_daily IS
  'Daily card revenue by category (fee / interest / penalty) in NAIRA. Excludes '
  'the interest component codes 600/601/603, which 604 already totals.';

-- The breakdown view, for reports that want to show what interest is made of.
-- Deliberately separate so it can never be added to income_daily by accident.
CREATE OR REPLACE VIEW app.interest_components_daily AS
SELECT t.txn_date AS income_date, c.description AS component,
       COUNT(*) AS txn_count, SUM(t.amount) AS amount_ngn
FROM app.transactions t
JOIN app.card_txn_codes c ON c.code = t.txn_code
WHERE c.category = 'interest' AND NOT c.counts_in_total
GROUP BY 1, 2;

-- ── Collections KPI rollup ───────────────────────────────────────────────────
--
-- collections_daily_kpi is the source for Collections Performance and Agent
-- Performance, and has never had a row. So do its own sources: as of this
-- migration collection_contacts, collection_promises and collection_payments are
-- all empty — no agent has logged a contact, a promise or a payment yet. Only
-- collection_assignments has data (1,228 rows, seeded by the go-live job).
--
-- So this is not a backfill; there is nothing to back-fill. It is the rollup
-- those reports need, ready for the day the team starts working the queue. It is
-- written to be re-runnable over any window so a correction to the underlying
-- activity can simply be re-rolled.

CREATE OR REPLACE FUNCTION app.rebuild_collections_daily_kpi(
  p_from date DEFAULT CURRENT_DATE - 30,
  p_to   date DEFAULT CURRENT_DATE
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  DELETE FROM app.collections_daily_kpi WHERE kpi_date BETWEEN p_from AND p_to;

  WITH contacts AS (
    SELECT cc.created_at::date AS d, cc.agent_user_id, COUNT(*) AS contacts_made
    FROM app.collection_contacts cc
    WHERE cc.created_at::date BETWEEN p_from AND p_to
      AND cc.agent_user_id IS NOT NULL
    GROUP BY 1, 2
  ),
  promises AS (
    -- collection_promises has no status column: kept/broken is the is_kept
    -- boolean, and it is NULL while the promise is still open. So "broken" is
    -- explicitly is_kept = FALSE — counting NOT is_kept would score every
    -- promise that has not fallen due yet as already broken.
    SELECT cp.created_at::date AS d, cp.agent_user_id,
           COUNT(*)                                     AS promises_obtained,
           COUNT(*) FILTER (WHERE cp.is_kept IS FALSE)  AS promises_broken
    FROM app.collection_promises cp
    WHERE cp.created_at::date BETWEEN p_from AND p_to
      AND cp.agent_user_id IS NOT NULL
    GROUP BY 1, 2
  ),
  payments AS (
    -- Payments are credited to the agent who owns the assignment, not to whoever
    -- keyed the receipt: a payment banked by Finance still belongs to the agent
    -- who worked the account. LEFT JOIN, because collection_payments is keyed by
    -- account_cif as well as assignment_id and a payment with no assignment must
    -- not vanish from the totals.
    SELECT pm.payment_date AS d,
           COALESCE(ca.agent_user_id, ca2.agent_user_id) AS agent_user_id,
           COALESCE(SUM(pm.amount_kobo), 0)              AS amount_collected_kobo
    FROM app.collection_payments pm
    LEFT JOIN app.collection_assignments ca  ON ca.id = pm.assignment_id
    LEFT JOIN app.collection_assignments ca2 ON ca2.cif_number = pm.account_cif
                                            AND pm.assignment_id IS NULL
    WHERE pm.payment_date BETWEEN p_from AND p_to
      AND COALESCE(ca.agent_user_id, ca2.agent_user_id) IS NOT NULL
    GROUP BY 1, 2
  ),
  targets AS (
    SELECT ca.agent_user_id, COALESCE(SUM(ca.target_amount_kobo), 0) AS target_amount_kobo
    FROM app.collection_assignments ca
    WHERE ca.agent_user_id IS NOT NULL
    GROUP BY 1
  ),
  days AS (
    SELECT d, agent_user_id FROM contacts
    UNION SELECT d, agent_user_id FROM promises
    UNION SELECT d, agent_user_id FROM payments
  )
  INSERT INTO app.collections_daily_kpi
    (kpi_date, agent_user_id, contacts_made, promises_obtained,
     promises_broken, amount_collected_kobo, target_amount_kobo)
  SELECT dy.d, dy.agent_user_id,
         COALESCE(c.contacts_made, 0),
         COALESCE(p.promises_obtained, 0),
         COALESCE(p.promises_broken, 0),
         COALESCE(pm.amount_collected_kobo, 0),
         COALESCE(tg.target_amount_kobo, 0)
  FROM days dy
  LEFT JOIN contacts c  ON c.d  = dy.d AND c.agent_user_id  = dy.agent_user_id
  LEFT JOIN promises p  ON p.d  = dy.d AND p.agent_user_id  = dy.agent_user_id
  LEFT JOIN payments pm ON pm.d = dy.d AND pm.agent_user_id = dy.agent_user_id
  LEFT JOIN targets  tg ON tg.agent_user_id = dy.agent_user_id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE INDEX IF NOT EXISTS idx_collections_daily_kpi_date
  ON app.collections_daily_kpi (kpi_date DESC);

-- ── KPI targets ──────────────────────────────────────────────────────────────
--
-- kpi_targets is empty, so every RAG indicator on the KPI Tracker compares
-- against a target of zero. The targets themselves are a business decision and
-- are deliberately NOT seeded here — inventing them would put fabricated goals
-- in front of the exec team. What is added is the metadata the editor needs so
-- Finance can enter them, and a uniqueness guarantee so an upsert cannot create
-- two competing targets for the same metric and period.

ALTER TABLE app.kpi_targets
  ADD COLUMN IF NOT EXISTS updated_by  bigint,
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS notes       text;

-- No extra unique index here. The table already has
-- kpi_targets_role_metric_name_period_key UNIQUE (role, metric_name, period),
-- which is the correct grain: targets are per role, so Collections and Finance
-- can each hold their own target for the same metric. An earlier draft of this
-- migration added a UNIQUE (metric_name, period) index, which would have made a
-- metric's target global and silently blocked the second role's upsert.
DROP INDEX IF EXISTS app.idx_kpi_targets_metric_period;

-- kpi_targets.period stores a cadence ('monthly'), while the KPI Tracker asks for
-- a window ('this_month', 'last_quarter'). Those are different vocabularies, and
-- reportKPIsHandler compared them directly — so no target ever matched, and every
-- RAG indicator would have read zero even once the table was populated. The
-- handler now maps window → cadence; this comment records why the two differ.
