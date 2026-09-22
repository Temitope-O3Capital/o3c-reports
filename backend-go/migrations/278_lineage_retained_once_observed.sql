-- 278 — Stop the rollover and restructure lineage eroding as Udara ages records out.
--
-- ── THE DEFECT IN 276/277 (mine, found immediately after deploying them) ─────
-- Both compute_fd_rollover_links() and compute_loan_restructure_links() begin with
-- DELETE FROM <links table> and re-derive everything from the CURRENT book.
--
-- That is only safe if the current book always contains the whole history. It does not.
-- The oldest Closed fixed deposit Udara returns is 2026-07-01 — the same floor as the GL
-- call-over ledger. Udara ages closed records out of its feed.
--
-- So the moment a PRIOR deposit falls off the back of that window, the rebuild can no
-- longer see the pair, and the link is deleted. The rollover is silently un-recorded, the
-- successor reverts to looking like a brand-new deposit, and its principal is counted as
-- fresh inflow again. The lineage would quietly erode month by month, and the erosion
-- would look exactly like genuine new business — the worst possible failure shape for a
-- number feeding sales and growth.
--
-- Nothing has been lost yet: all 76 FD links and all 7 loan links still have both
-- accounts present. This is a fix applied before the first record ages out, not a repair.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- A link is an OBSERVATION. Once seen it is kept, even after the source rows age away.
-- The rebuild becomes an upsert, and only removes a link when it can actually prove the
-- pair is wrong — which requires BOTH accounts to still be visible. If a prior has aged
-- out the link is left alone, because absence of the record is not evidence of absence of
-- the rollover.
--
-- `observed_at` records when the link was first seen and stops being overwritten on every
-- rebuild, so "when did we learn this" survives.
--
-- Same change to both functions, for the same reason.

BEGIN;

ALTER TABLE app.fd_rollover_links
    ADD COLUMN IF NOT EXISTS first_observed_at timestamptz NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS prior_aged_out    boolean     NOT NULL DEFAULT false;

ALTER TABLE app.loan_restructure_links
    ADD COLUMN IF NOT EXISTS first_observed_at timestamptz NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS prior_aged_out    boolean     NOT NULL DEFAULT false;

COMMENT ON COLUMN app.fd_rollover_links.prior_aged_out IS
    'True once the prior deposit is no longer returned by Udara. The link is RETAINED: a '
    'record ageing out of the feed is not evidence the rollover did not happen.';
COMMENT ON COLUMN app.loan_restructure_links.prior_aged_out IS
    'True once the prior facility is no longer returned by Udara. The link is RETAINED.';

-- ── Fixed deposits ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.compute_fd_rollover_links() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE n integer := 0;
BEGIN
    CREATE TEMP TABLE _fd ON COMMIT DROP AS
    SELECT cbs_account_number AS acct, cbs_customer_id, principal_kobo, status,
           commencement_date::date AS comm, maturity_date::date AS mat
      FROM app.cbs_fixed_deposits
     WHERE commencement_date IS NOT NULL AND maturity_date IS NOT NULL
       AND COALESCE(cbs_account_number,'') <> '';

    -- A successor commences as the prior matures, same customer, prior now Closed. No
    -- principal comparison: Udara zeroes principal_kobo on closure, so such a test is
    -- vacuous. prior_kobo is still stored (it reads 0) so the absence is visible.
    CREATE TEMP TABLE _pair ON COMMIT DROP AS
    SELECT a.acct AS prior_account, b.acct AS successor_account, a.cbs_customer_id,
           a.mat AS prior_matures, b.comm AS successor_starts, (b.comm - a.mat) AS gap_days,
           a.principal_kobo AS prior_kobo, b.principal_kobo AS successor_kobo
      FROM _fd a
      JOIN _fd b ON b.cbs_customer_id = a.cbs_customer_id AND b.acct <> a.acct
     WHERE b.comm BETWEEN a.mat AND a.mat + 1
       AND a.status = 'Closed';

    DELETE FROM app.fd_rollover_ambiguous;
    INSERT INTO app.fd_rollover_ambiguous (cbs_customer_id, prior_account, successor_account, reason)
    SELECT p.cbs_customer_id, p.prior_account, p.successor_account,
           CASE WHEN p.prior_account IN (SELECT prior_account FROM _pair GROUP BY 1 HAVING count(*) > 1)
                 AND p.successor_account IN (SELECT successor_account FROM _pair GROUP BY 1 HAVING count(*) > 1)
                THEN 'prior split across several successors AND successor consolidated from several priors'
                WHEN p.prior_account IN (SELECT prior_account FROM _pair GROUP BY 1 HAVING count(*) > 1)
                THEN 'one deposit split across several successors'
                ELSE 'several deposits consolidated into one successor' END
      FROM _pair p
     WHERE p.prior_account     IN (SELECT prior_account     FROM _pair GROUP BY 1 HAVING count(*) > 1)
        OR p.successor_account IN (SELECT successor_account FROM _pair GROUP BY 1 HAVING count(*) > 1);

    CREATE TEMP TABLE _clean ON COMMIT DROP AS
    SELECT p.* FROM _pair p
     WHERE p.prior_account     IN (SELECT prior_account     FROM _pair GROUP BY 1 HAVING count(*) = 1)
       AND p.successor_account IN (SELECT successor_account FROM _pair GROUP BY 1 HAVING count(*) = 1);

    -- Upsert, never wholesale delete: a link already observed survives its source rows.
    INSERT INTO app.fd_rollover_links
        (successor_account, prior_account, cbs_customer_id, prior_matures, successor_starts,
         gap_days, prior_kobo, successor_kobo, basis, computed_at)
    SELECT successor_account, prior_account, cbs_customer_id, prior_matures, successor_starts,
           gap_days, prior_kobo, successor_kobo,
           'prior deposit Closed and matured as this one commenced', NOW()
      FROM _clean
    ON CONFLICT (successor_account) DO UPDATE
       SET prior_account   = EXCLUDED.prior_account,
           cbs_customer_id = EXCLUDED.cbs_customer_id,
           prior_matures   = EXCLUDED.prior_matures,
           successor_starts= EXCLUDED.successor_starts,
           gap_days        = EXCLUDED.gap_days,
           prior_kobo      = EXCLUDED.prior_kobo,
           successor_kobo  = EXCLUDED.successor_kobo,
           computed_at     = NOW(),
           prior_aged_out  = false;   -- first_observed_at deliberately NOT touched

    GET DIAGNOSTICS n = ROW_COUNT;

    -- Retire a link ONLY when both accounts are still visible and the pair no longer
    -- qualifies — i.e. we can actually see that it is wrong. A link whose prior has aged
    -- out of the feed is flagged, never deleted.
    DELETE FROM app.fd_rollover_links l
     WHERE EXISTS (SELECT 1 FROM _fd f WHERE f.acct = l.successor_account)
       AND EXISTS (SELECT 1 FROM _fd f WHERE f.acct = l.prior_account)
       AND NOT EXISTS (SELECT 1 FROM _clean c WHERE c.successor_account = l.successor_account);

    UPDATE app.fd_rollover_links l
       SET prior_aged_out = NOT EXISTS (SELECT 1 FROM _fd f WHERE f.acct = l.prior_account)
     WHERE l.prior_aged_out IS DISTINCT FROM NOT EXISTS (SELECT 1 FROM _fd f WHERE f.acct = l.prior_account);

    DROP TABLE IF EXISTS _fd;
    DROP TABLE IF EXISTS _pair;
    DROP TABLE IF EXISTS _clean;
    RETURN n;
END
$fn$;

-- ── Loans ────────────────────────────────────────────────────────────────────
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

    CREATE TEMP TABLE _lpair ON COMMIT DROP AS
    SELECT b.acct AS successor_account, a.acct AS prior_account, a.cbs_customer_id,
           a.loan_amount_kobo AS prior_amount_kobo, b.loan_amount_kobo AS successor_amount_kobo,
           GREATEST(COALESCE(b.loan_amount_kobo,0) - COALESCE(a.loan_amount_kobo,0), 0) AS new_lending_kobo,
           a.status AS prior_status, b.status AS successor_status,
           a.md AS prior_matured, b.sd AS successor_started
      FROM _ln a
      JOIN _ln b ON b.stem = a.stem AND b.seq = a.seq + 1
       -- Without this, the legacy 2000450000100... series chains unrelated borrowers.
       AND b.cbs_customer_id = a.cbs_customer_id
     WHERE a.status = 'Closed';

    INSERT INTO app.loan_restructure_links
        (successor_account, prior_account, cbs_customer_id, prior_amount_kobo,
         successor_amount_kobo, new_lending_kobo, prior_status, successor_status,
         prior_matured, successor_started, basis, computed_at)
    SELECT successor_account, prior_account, cbs_customer_id, prior_amount_kobo,
           successor_amount_kobo, new_lending_kobo, prior_status, successor_status,
           prior_matured, successor_started,
           'account number suffix incremented for the same customer, prior facility Closed', NOW()
      FROM _lpair
    ON CONFLICT (successor_account) DO UPDATE
       SET prior_account         = EXCLUDED.prior_account,
           cbs_customer_id       = EXCLUDED.cbs_customer_id,
           prior_amount_kobo     = EXCLUDED.prior_amount_kobo,
           successor_amount_kobo = EXCLUDED.successor_amount_kobo,
           new_lending_kobo      = EXCLUDED.new_lending_kobo,
           prior_status          = EXCLUDED.prior_status,
           successor_status      = EXCLUDED.successor_status,
           computed_at           = NOW(),
           prior_aged_out        = false;

    GET DIAGNOSTICS n = ROW_COUNT;

    DELETE FROM app.loan_restructure_links l
     WHERE EXISTS (SELECT 1 FROM _ln x WHERE x.acct = l.successor_account)
       AND EXISTS (SELECT 1 FROM _ln x WHERE x.acct = l.prior_account)
       AND NOT EXISTS (SELECT 1 FROM _lpair p WHERE p.successor_account = l.successor_account);

    UPDATE app.loan_restructure_links l
       SET prior_aged_out = NOT EXISTS (SELECT 1 FROM _ln x WHERE x.acct = l.prior_account)
     WHERE l.prior_aged_out IS DISTINCT FROM NOT EXISTS (SELECT 1 FROM _ln x WHERE x.acct = l.prior_account);

    DROP TABLE IF EXISTS _ln;
    DROP TABLE IF EXISTS _lpair;
    RETURN n;
END
$fn$;

SELECT app.compute_fd_rollover_links();
SELECT app.compute_loan_restructure_links();

DO $$
DECLARE fd int; ln int; aged int;
BEGIN
    SELECT count(*) INTO fd FROM app.fd_rollover_links;
    SELECT count(*) INTO ln FROM app.loan_restructure_links;
    SELECT count(*) INTO aged FROM app.fd_rollover_links WHERE prior_aged_out;
    IF fd < 76 OR ln < 7 THEN
        RAISE EXCEPTION '278: lineage shrank (fd=%, loans=%) — the upsert lost links it should have kept', fd, ln;
    END IF;
    RAISE NOTICE '278: % FD rollover links and % loan restructure links, now retained once observed; % have a prior that has aged out of Udara', fd, ln, aged;
END $$;

COMMIT;
