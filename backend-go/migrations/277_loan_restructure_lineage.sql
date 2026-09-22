-- 277 — Loan restructure lineage: which "new" loans are an existing debt on new terms.
--
-- ── THE SIGNAL ───────────────────────────────────────────────────────────────
-- Udara numbers a restructured facility by INCREMENTING THE LAST DIGIT of the account
-- number. A restructure is therefore: same 18-digit stem, suffix n -> n+1, SAME customer,
-- prior facility now Closed.
--
-- Validated against a case that was already known to be true by other means: FOLTI
-- TECHNOLOGIES 1200045402000005530 (N250,000,000, Closed) -> ...5531 (N156,000,000). That
-- is exactly the pair recorded by hand in app.collection_assignments, where id 1782
-- (N250,000,000) carries superseded_by_id = 1755 (N156,000,000). The rule reproduces a
-- fact nobody derived it from.
--
-- ── THE GUARD THAT MATTERS: SAME CUSTOMER ────────────────────────────────────
-- Suffix-increment ALONE is wrong. Across the 52-loan book it yields 11 pairs, and 4 of
-- them are DIFFERENT PEOPLE:
--     2000450000100101 -> ...102, 2000450000100104 -> ...105,
--     2000450000100107 -> ...108, 2000450000100110 -> ...111
-- Those sit in an older '2000450000100...' series where the trailing digit is a GLOBAL
-- counter, not a per-facility sequence, so consecutive numbers belong to unrelated
-- borrowers. One of them would have chained a N4,000,000 facility to an unrelated
-- N53,000,000 one. Requiring cbs_customer_id to match removes all 4 and leaves exactly
-- the 7 genuine restructures, every one of which also has a Closed prior.
--
-- Two independent signals agree on the same 7: suffix-increment, and a successor starting
-- within days of the prior's maturity. That agreement is why this is stored as fact
-- rather than flagged as a guess.
--
-- ── WHAT IT SHOWS ────────────────────────────────────────────────────────────
-- The 7 successors total N231,000,000 of facility value, but only N10,000,000 of it is
-- genuinely NEW lending — the rest is existing debt re-papered:
--     ADELOYE BAYONLE   25,000,000 -> 25,000,000   (+0)
--     AJAYI JOSEPH      10,000,000 -> 10,000,000   (+0)
--     FOLTI TECHNOLOGIES 250,000,000 -> 156,000,000 (+0, it SHRANK)
--     BELLE REPUBLIK     5,000,000 ->  7,000,000   (+2,000,000)
--     CARE CREDIT        2,000,000 ->  5,000,000   (+3,000,000)
--     KEMDIO            18,000,000 -> 20,000,000   (+2,000,000)
--     TRADE PORT         5,000,000 ->  8,000,000   (+3,000,000)
--
-- Unlike fixed deposits, loan_amount_kobo SURVIVES closure here (a Closed loan still
-- reports its original amount), so the increment genuinely is derivable — the opposite of
-- the FD case in migration 276, where Udara zeroes principal on closure and no
-- principal/interest split can be recovered.
--
-- ── WHY A SIDE TABLE ─────────────────────────────────────────────────────────
-- cbssync.refreshLoans does `DELETE FROM cbs_loans` + full re-INSERT every 3 minutes, so
-- a column on that table is destroyed on the next tick — the same trap that silently
-- reverted migration 273. Lineage lives here, keyed on cbs_account_number, rebuilt by
-- app.compute_loan_restructure_links() which cbssync calls after the loan refresh commits.
--
-- Re-runnable: the function rebuilds its table from scratch every time.

BEGIN;

CREATE TABLE IF NOT EXISTS app.loan_restructure_links (
    successor_account text PRIMARY KEY,
    prior_account     text        NOT NULL,
    cbs_customer_id   text        NOT NULL,
    prior_amount_kobo bigint,
    successor_amount_kobo bigint,
    new_lending_kobo  bigint,
    prior_status      text,
    successor_status  text,
    prior_matured     date,
    successor_started date,
    basis             text        NOT NULL,
    computed_at       timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_restructure_prior ON app.loan_restructure_links (prior_account);

COMMENT ON TABLE app.loan_restructure_links IS
    'Derived loan restructure lineage: successor_account is prior_account on new terms. '
    'Rebuilt by app.compute_loan_restructure_links() after every cbssync loan refresh, '
    'because that refresh DELETEs and re-INSERTs cbs_loans and would destroy a column. '
    'Requires a MATCHING cbs_customer_id: suffix-increment alone chains unrelated '
    'borrowers in the legacy 2000450000100... series.';

CREATE OR REPLACE FUNCTION app.compute_loan_restructure_links() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer := 0;
BEGIN
    CREATE TEMP TABLE _ln ON COMMIT DROP AS
    SELECT cbs_account_number AS acct,
           left(cbs_account_number, length(cbs_account_number) - 1) AS stem,
           right(cbs_account_number, 1)::int AS seq,
           cbs_customer_id, loan_amount_kobo, status,
           start_date::date AS sd, maturity_date::date AS md
      FROM app.cbs_loans
     WHERE COALESCE(cbs_account_number,'') <> ''
       AND right(cbs_account_number, 1) ~ '^[0-9]$';

    DELETE FROM app.loan_restructure_links;
    INSERT INTO app.loan_restructure_links
        (successor_account, prior_account, cbs_customer_id, prior_amount_kobo,
         successor_amount_kobo, new_lending_kobo, prior_status, successor_status,
         prior_matured, successor_started, basis)
    SELECT b.acct, a.acct, a.cbs_customer_id,
           a.loan_amount_kobo, b.loan_amount_kobo,
           -- Only the increase is new lending. A restructure that SHRINKS the facility
           -- (FOLTI: 250m -> 156m) lends nothing new, so this floors at zero rather than
           -- going negative and quietly crediting someone with negative disbursement.
           GREATEST(COALESCE(b.loan_amount_kobo,0) - COALESCE(a.loan_amount_kobo,0), 0),
           a.status, b.status, a.md, b.sd,
           'account number suffix incremented for the same customer, prior facility Closed'
      FROM _ln a
      JOIN _ln b
        ON b.stem = a.stem
       AND b.seq  = a.seq + 1
       -- The guard without which this chains strangers together.
       AND b.cbs_customer_id = a.cbs_customer_id
     WHERE a.status = 'Closed';

    GET DIAGNOSTICS n = ROW_COUNT;
    DROP TABLE IF EXISTS _ln;
    RETURN n;
END
$fn$;

COMMENT ON FUNCTION app.compute_loan_restructure_links() IS
    'Rebuilds app.loan_restructure_links from cbs_loans. Called by cbssync after each loan '
    'refresh. Safe to run any time; it is a full rebuild.';

-- Read surface: every loan with its restructure depth and what it really lent.
CREATE OR REPLACE VIEW app.v_loan_lineage AS
WITH RECURSIVE chain AS (
    SELECT l.cbs_account_number AS acct, l.cbs_account_number AS root_account, 1 AS generation
      FROM app.cbs_loans l
     WHERE NOT EXISTS (SELECT 1 FROM app.loan_restructure_links r WHERE r.successor_account = l.cbs_account_number)
    UNION ALL
    SELECT r.successor_account, c.root_account, c.generation + 1
      FROM app.loan_restructure_links r
      JOIN chain c ON c.acct = r.prior_account
)
SELECT l.cbs_id, l.cbs_account_number, l.cbs_customer_id, l.product_name, l.status,
       l.loan_amount_kobo, l.outstanding_principal_kobo, l.interest_rate, l.officer_name,
       l.start_date, l.maturity_date,
       COALESCE(c.generation, 1) AS generation,
       COALESCE(c.root_account, l.cbs_account_number) AS root_account,
       (c.generation > 1)        AS is_restructure,
       r.prior_account,
       -- New lending: the whole facility if it is original, otherwise only the increase.
       -- Using loan_amount_kobo for a restructure counts debt the borrower already had.
       CASE WHEN COALESCE(c.generation,1) = 1 THEN l.loan_amount_kobo
            ELSE COALESCE(r.new_lending_kobo, 0) END AS new_lending_kobo
  FROM app.cbs_loans l
  LEFT JOIN chain c ON c.acct = l.cbs_account_number
  LEFT JOIN app.loan_restructure_links r ON r.successor_account = l.cbs_account_number;

COMMENT ON VIEW app.v_loan_lineage IS
    'Every Udara loan with its restructure generation (1 = original), the facility the debt '
    'started as, and new_lending_kobo — the genuinely new money. Use new_lending_kobo for '
    'disbursement, growth and officer credit; loan_amount_kobo counts restructured debt as '
    'fresh lending.';

SELECT app.compute_loan_restructure_links();

DO $$
DECLARE links int; newl bigint; face bigint;
BEGIN
    SELECT count(*) INTO links FROM app.loan_restructure_links;
    SELECT COALESCE(SUM(successor_amount_kobo),0), COALESCE(SUM(new_lending_kobo),0)
      INTO face, newl FROM app.loan_restructure_links;
    RAISE NOTICE '277: % restructures linked; % kobo of facility value, of which only % kobo is new lending', links, face, newl;
END $$;

COMMIT;
