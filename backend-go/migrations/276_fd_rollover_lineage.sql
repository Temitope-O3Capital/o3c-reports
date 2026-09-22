-- 276 — Fixed-deposit rollover lineage: which deposits are the same money rolling.
--
-- ── WHY THIS WAS NOT OBVIOUS ─────────────────────────────────────────────────
-- Udara publishes rolloverCount, rolloverOption and applyRollover on every FD. They are
-- USELESS here: measured 2026-09-22 across all 380 deposits, rolloverCount is EMPTY on
-- 380/380, applyRollover is false on 380/380, and exactly one record carries a
-- rolloverOption. The fields exist and are not populated, so cbs_fixed_deposits.
-- rollover_count has been NULL on every row since it was added.
--
-- The GL call-over ledger does not rescue it either. The full ledger (5,684 entries,
-- financialDate 2026-07-01..2026-09-16) holds 155 FD bookings (FDPP) and 42
-- pre-liquidations (FDPL), but only **7 customers** have both a liquidation AND a booking
-- inside that window — and the ledger does not reach back before July, while most of the
-- book was booked earlier. A liquidation-to-booking chain would therefore describe a
-- handful of deposits and silently call the other 370 "new money".
--
-- ── THE SIGNAL THAT DOES WORK ────────────────────────────────────────────────
-- A rollover is a deposit that COMMENCES AS ANOTHER MATURES, for the same customer, where
-- the prior deposit is now Closed. That is visible on all 380 deposits regardless of when
-- they were booked, and needs neither the ledger nor a field Udara does not fill.
--
-- Measured on the live book:
--   same customer, successor commences within [prior maturity, +1 day]  -> 97 chains
--   of those, the prior is Closed                                       -> 97 (all of them)
--   of those, strictly one prior and one successor                      -> 76 unambiguous
--   the remaining 21 are genuine fan-out: 9 deposits split across several successors, 4
--   consolidated from several priors. Real banking, but NOT a 1:1 lineage, so they are
--   recorded and flagged rather than chained.
--
-- 93 of 380 deposits (24%) are a successor. THIS CORRECTS AN EARLIER CLAIM OF "~67% of
-- new deposits are rollovers" — that figure was never measured and is wrong.
--
-- ── WHAT CANNOT BE DERIVED, AND IS THEREFORE NOT CLAIMED ─────────────────────
-- How much of a rollover is rolled principal versus newly added money. Udara ZEROES
-- principal_kobo when a deposit closes: 166 of 380 rows read 0, including all 150 Closed
-- ones. So the prior's principal is gone by the time we can see the chain, and across all
-- 97 chains there is NOT ONE where the prior still carries a principal.
--
-- An earlier draft of this migration tested `successor.principal >= prior.principal` and
-- computed interest_rolled as the difference. Both were nonsense: a zeroed prior makes the
-- test vacuous (it matches every successor) and makes the "interest rolled" equal to the
-- successor's entire principal. The test is gone and no interest figure is stored.
-- new_money_kobo is therefore 0 for any rollover — conservative and honest: the money was
-- already on the book, and the split cannot be recovered from what Udara exposes.
--
-- ── WHY A SIDE TABLE AND NOT A COLUMN ────────────────────────────────────────
-- cbssync.refreshFDs runs every 3 minutes and does `DELETE FROM cbs_fixed_deposits`
-- followed by a full re-INSERT. Anything written into a column on that table is destroyed
-- on the next tick — which is exactly how migration 273 was silently reverted by
-- assign_parties. So lineage lives HERE, keyed on cbs_account_number (stable across the
-- refresh; cbs_id is not guaranteed to be), and is recomputed by
-- app.compute_fd_rollover_links(), which cbssync calls after each FD refresh.
--
-- Re-runnable: the function rebuilds its own table from scratch every time.

BEGIN;

CREATE TABLE IF NOT EXISTS app.fd_rollover_links (
    successor_account text PRIMARY KEY,
    prior_account     text        NOT NULL,
    cbs_customer_id   text        NOT NULL,
    prior_matures     date,
    successor_starts  date,
    gap_days          int,
    prior_kobo        bigint,
    successor_kobo    bigint,
    basis             text        NOT NULL,
    computed_at       timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fd_rollover_prior ON app.fd_rollover_links (prior_account);

COMMENT ON TABLE app.fd_rollover_links IS
    'Derived FD rollover lineage: successor_account continued prior_account. Rebuilt by '
    'app.compute_fd_rollover_links() after every cbssync FD refresh, because that refresh '
    'DELETEs and re-INSERTs cbs_fixed_deposits and would destroy a column. Only '
    'unambiguous 1:1 chains are stored; splits and consolidations are deliberately '
    'excluded — see app.fd_rollover_ambiguous.';

-- Fan-out cases kept visible rather than dropped: a human may want to resolve them.
CREATE TABLE IF NOT EXISTS app.fd_rollover_ambiguous (
    id               bigserial PRIMARY KEY,
    cbs_customer_id  text NOT NULL,
    prior_account    text NOT NULL,
    successor_account text NOT NULL,
    reason           text NOT NULL,
    computed_at      timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.fd_rollover_ambiguous IS
    'FD chains that are real but not 1:1 — one deposit split across several successors, '
    'or several consolidated into one. Recorded, never chained, so a rollover count can '
    'never silently double-count a split deposit.';

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

    -- A successor commences as the prior matures, for the same customer, and the prior is
    -- now Closed. No principal comparison: Udara zeroes principal_kobo on closure, so any
    -- such test is vacuous — it matches every successor and proves nothing. prior_kobo is
    -- still STORED (it will read 0) so the absence is visible rather than implied.
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

    DELETE FROM app.fd_rollover_links;
    INSERT INTO app.fd_rollover_links
        (successor_account, prior_account, cbs_customer_id, prior_matures, successor_starts,
         gap_days, prior_kobo, successor_kobo, basis)
    SELECT p.successor_account, p.prior_account, p.cbs_customer_id, p.prior_matures,
           p.successor_starts, p.gap_days, p.prior_kobo, p.successor_kobo,
           'prior deposit Closed and matured as this one commenced'
      FROM _pair p
     WHERE p.prior_account     IN (SELECT prior_account     FROM _pair GROUP BY 1 HAVING count(*) = 1)
       AND p.successor_account IN (SELECT successor_account FROM _pair GROUP BY 1 HAVING count(*) = 1);

    GET DIAGNOSTICS n = ROW_COUNT;
    DROP TABLE IF EXISTS _fd;
    DROP TABLE IF EXISTS _pair;
    RETURN n;
END
$fn$;

COMMENT ON FUNCTION app.compute_fd_rollover_links() IS
    'Rebuilds app.fd_rollover_links and app.fd_rollover_ambiguous from cbs_fixed_deposits. '
    'Called by cbssync after each FD refresh. Safe to run at any time; it is a full rebuild.';

-- Read surface: every deposit with its chain depth and the money that is genuinely new.
-- generation 1 = original deposit, 2 = first rollover, and so on.
CREATE OR REPLACE VIEW app.v_fd_lineage AS
WITH RECURSIVE chain AS (
    SELECT f.cbs_account_number AS acct, f.cbs_account_number AS root_account, 1 AS generation
      FROM app.cbs_fixed_deposits f
     WHERE NOT EXISTS (SELECT 1 FROM app.fd_rollover_links l WHERE l.successor_account = f.cbs_account_number)
    UNION ALL
    SELECT l.successor_account, c.root_account, c.generation + 1
      FROM app.fd_rollover_links l
      JOIN chain c ON c.acct = l.prior_account
)
SELECT f.cbs_id, f.cbs_account_number, f.cbs_customer_id, f.product_name, f.status,
       f.principal_kobo, f.interest_rate, f.officer_name,
       f.commencement_date, f.maturity_date,
       COALESCE(c.generation, 1)        AS generation,
       COALESCE(c.root_account, f.cbs_account_number) AS root_account,
       (c.generation > 1)               AS is_rollover,
       l.prior_account,
       -- New money is the ORIGINAL principal only; a rollover's principal was already on
       -- the book and must never be counted as fresh inflow a second time.
       CASE WHEN COALESCE(c.generation,1) = 1 THEN f.principal_kobo ELSE 0::bigint END AS new_money_kobo
  FROM app.cbs_fixed_deposits f
  LEFT JOIN chain c ON c.acct = f.cbs_account_number
  LEFT JOIN app.fd_rollover_links l ON l.successor_account = f.cbs_account_number;

COMMENT ON VIEW app.v_fd_lineage IS
    'Every fixed deposit with its rollover generation (1 = original), the root deposit the '
    'money started in, and new_money_kobo — the part that is genuinely fresh inflow rather '
    'than principal already on the book. Use new_money_kobo for sales and growth figures; '
    'principal_kobo double-counts rolled money.';

SELECT app.compute_fd_rollover_links();

DO $$
DECLARE links int; amb int; rolled bigint; gens int;
BEGIN
    SELECT count(*) INTO links FROM app.fd_rollover_links;
    SELECT count(*) INTO amb   FROM app.fd_rollover_ambiguous;
    SELECT COALESCE(SUM(principal_kobo),0) INTO rolled FROM app.v_fd_lineage WHERE is_rollover;
    SELECT COALESCE(max(generation),1) INTO gens FROM app.v_fd_lineage;
    RAISE NOTICE '276: % unambiguous rollover links, % ambiguous chains recorded; % kobo sits in rollovers; deepest chain is % generations', links, amb, rolled, gens;
END $$;

COMMIT;
