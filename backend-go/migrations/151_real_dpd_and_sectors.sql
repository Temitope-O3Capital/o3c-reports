-- 151_real_dpd_and_sectors.sql
--
-- Replaces the "days past maturity" DPD proxy with a schedule-derived DPD, and
-- gives the CBN economic-sector codes a name lookup.
--
-- WHY THIS EXISTS
-- ---------------
-- Every PAR/NPL/vintage number in the Risk module was computed as
--     GREATEST(0, CURRENT_DATE - maturity_date)
-- i.e. days past FINAL maturity. A loan that has missed four monthly instalments
-- but has not yet reached maturity scored DPD = 0 and was reported as "Current".
--
-- Measured on the live book on 2026-08-17: 6 loans carried CBS status
-- 'Defaulting' and NOT ONE of them counted toward PAR30 — 5 had not matured yet.
-- The dashboard reported NPL 4.00% / PAR30 12.00% while the core banking system
-- flagged 24% of the book as defaulting.
--
-- HOW THE REAL DPD IS DERIVED
-- ---------------------------
-- cbs_loans carries no instalment ledger, but it does carry enough to rebuild the
-- amortisation schedule, populated on 100% of rows:
--   start_date, maturity_date, first_installment_date, loan_amount_kobo,
--   outstanding_principal_kobo
--
-- NOTE ON installment_amount_kobo: it is NOT usable as the periodic instalment.
-- On 'Monthly' loans Udara stores the FULL principal there (a 6-month ₦10m loan
-- has installment_amount_kobo = ₦10m). The actual amortisation is equal monthly
-- principal, which is why outstanding lands on exact fractions of the principal
-- (₦2m/3-month loan sits at ₦666,666). So the periodic amount is derived as
-- loan_amount / tenor_months rather than read from that column.
--
--   tenor_months  = ROUND((maturity - start) / 30.44), floored at 1
--   monthly       = loan_amount / tenor_months
--   n_due         = instalments whose due date has passed, capped at tenor_months
--   expected_out  = loan_amount - n_due * monthly
--   arrears       = outstanding - expected_out          (0 if ahead/on track)
--   behind        = CEIL(arrears / monthly)             (instalments in arrears)
--   dpd           = days since the due date of the oldest unpaid instalment
--
-- Then floored by two independent signals so the number can only ever be too
-- kind, never too harsh:
--   * days past final maturity while principal is still outstanding
--   * CBS status 'Defaulting' implies at minimum 30 days (PAR30). Udara does not
--     publish the delinquency date, so 30 is the floor of the band it asserts —
--     not a guess at the true figure.
--
-- Validated against the live book: this reproduces CBS 'Defaulting' on 5 of the 6
-- flagged loans from the schedule alone (39, 45, 93, 45, 32 days); the 6th lands
-- at 23 days and is raised to the 30-day floor by its status.

BEGIN;

-- ── Schedule-derived arrears ─────────────────────────────────────────────────
-- Returns the kobo amount by which a loan's outstanding principal exceeds what
-- the amortisation schedule says should still be owed today. 0 = on track.
CREATE OR REPLACE FUNCTION app.cbs_loan_arrears_kobo(
  p_start        timestamptz,
  p_maturity     timestamptz,
  p_first_due    timestamptz,
  p_loan_kobo    bigint,
  p_outstanding  bigint
) RETURNS bigint
-- STABLE, not IMMUTABLE: reads CURRENT_DATE. Marking it immutable would let the
-- planner constant-fold a value that changes at midnight.
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenor_m  int;
  v_monthly  numeric;
  v_first    date;
  v_n_due    int;
  v_expected numeric;
BEGIN
  IF p_loan_kobo IS NULL OR p_loan_kobo <= 0
     OR COALESCE(p_outstanding, 0) <= 0
     OR p_start IS NULL OR p_maturity IS NULL THEN
    RETURN 0;
  END IF;

  v_tenor_m := GREATEST(1, ROUND((p_maturity::date - p_start::date) / 30.44)::int);
  v_monthly := p_loan_kobo::numeric / v_tenor_m;
  v_first   := COALESCE(p_first_due::date, (p_start + INTERVAL '1 month')::date);

  IF CURRENT_DATE < v_first THEN
    v_n_due := 0;
  ELSE
    -- +1 because the instalment falling exactly on v_first is already due
    v_n_due := LEAST(
      v_tenor_m,
      (EXTRACT(YEAR  FROM AGE(CURRENT_DATE, v_first))::int * 12
       + EXTRACT(MONTH FROM AGE(CURRENT_DATE, v_first))::int) + 1
    );
  END IF;

  v_expected := GREATEST(0::numeric, p_loan_kobo::numeric - (v_n_due * v_monthly));
  RETURN GREATEST(0, (p_outstanding::numeric - v_expected))::bigint;
END $$;

-- ── Schedule-derived DPD ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.cbs_loan_dpd(
  p_status       text,
  p_start        timestamptz,
  p_maturity     timestamptz,
  p_first_due    timestamptz,
  p_loan_kobo    bigint,
  p_outstanding  bigint
) RETURNS int
-- STABLE, not IMMUTABLE: reads CURRENT_DATE (see cbs_loan_arrears_kobo).
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenor_m   int;
  v_monthly   numeric;
  v_first     date;
  v_n_due     int;
  v_expected  numeric;
  v_arrears   numeric;
  v_behind    int;
  v_oldest    date;
  v_sched_dpd int := 0;
  v_mat_dpd   int := 0;
  v_dpd       int;
BEGIN
  -- A loan with nothing outstanding is not past due, whatever its status says.
  IF COALESCE(p_outstanding, 0) <= 0 THEN
    RETURN 0;
  END IF;

  IF p_maturity IS NOT NULL THEN
    v_mat_dpd := GREATEST(0, CURRENT_DATE - p_maturity::date);
  END IF;

  IF p_loan_kobo IS NOT NULL AND p_loan_kobo > 0
     AND p_start IS NOT NULL AND p_maturity IS NOT NULL THEN
    v_tenor_m := GREATEST(1, ROUND((p_maturity::date - p_start::date) / 30.44)::int);
    v_monthly := p_loan_kobo::numeric / v_tenor_m;
    v_first   := COALESCE(p_first_due::date, (p_start + INTERVAL '1 month')::date);

    IF CURRENT_DATE >= v_first THEN
      v_n_due := LEAST(
        v_tenor_m,
        (EXTRACT(YEAR  FROM AGE(CURRENT_DATE, v_first))::int * 12
         + EXTRACT(MONTH FROM AGE(CURRENT_DATE, v_first))::int) + 1
      );

      v_expected := GREATEST(0::numeric, p_loan_kobo::numeric - (v_n_due * v_monthly));
      v_arrears  := GREATEST(0::numeric, p_outstanding::numeric - v_expected);

      IF v_arrears > 0 AND v_monthly > 0 THEN
        -- Instalments in arrears, capped at the number actually due so far.
        v_behind := LEAST(v_n_due, CEIL(v_arrears / v_monthly)::int);
        IF v_behind > 0 THEN
          -- Oldest unpaid instalment = the (n_due - behind)th offset from first due.
          v_oldest    := (v_first + ((v_n_due - v_behind) || ' months')::interval)::date;
          v_sched_dpd := GREATEST(0, CURRENT_DATE - v_oldest);
        END IF;
      END IF;
    END IF;
  END IF;

  v_dpd := GREATEST(v_sched_dpd, v_mat_dpd);

  -- Status floor: CBS asserts the loan is in default but publishes no delinquency
  -- date, so take the bottom of the band it asserts rather than inventing a date.
  IF p_status = 'Defaulting' THEN
    v_dpd := GREATEST(v_dpd, 30);
  END IF;

  RETURN v_dpd;
END $$;

-- ── Risk score / band, now driven by the real DPD ────────────────────────────
-- Scale is 0-100 (NOT a 300-850 bureau scale — the UI colours on 80/65/50/35 to
-- match the band cut-offs below).
CREATE OR REPLACE FUNCTION app.cbs_risk_score_dpd(p_status text, p_dpd int)
RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(100, GREATEST(0,
    CASE
      WHEN COALESCE(p_dpd, 0) = 0   THEN 95
      WHEN p_dpd <= 30              THEN 75
      WHEN p_dpd <= 60              THEN 60
      WHEN p_dpd <= 90              THEN 45
      WHEN p_dpd <= 180             THEN 30
      ELSE 15
    END
    - CASE p_status WHEN 'Defaulting' THEN 25 WHEN 'Expired' THEN 45 ELSE 0 END
  ))::int
$$;

CREATE OR REPLACE FUNCTION app.cbs_risk_band_dpd(p_status text, p_dpd int)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN app.cbs_risk_score_dpd(p_status, p_dpd) >= 80 THEN 'A'
    WHEN app.cbs_risk_score_dpd(p_status, p_dpd) >= 65 THEN 'B'
    WHEN app.cbs_risk_score_dpd(p_status, p_dpd) >= 50 THEN 'C'
    WHEN app.cbs_risk_score_dpd(p_status, p_dpd) >= 35 THEN 'D'
    ELSE 'E'
  END
$$;

-- The maturity-proxy versions are retired. Every caller now passes a real DPD.
-- Dropping rather than leaving them in place so they cannot be picked up again:
-- verified no view, matview, constraint or generated column depends on them.
DROP FUNCTION IF EXISTS app.cbs_risk_band(text, date);
DROP FUNCTION IF EXISTS app.cbs_risk_score(text, date);

-- ── CBN economic sector code → name ──────────────────────────────────────────
-- cbs_loans.economic_sector holds the raw CBN numeric code ('41000', '40800'),
-- and the Udara payload carries no name alongside it, so the Risk module was
-- rendering "41000 — 39.6% of book" as a sector label.
--
-- This table is the join target. It is deliberately seeded EMPTY of names: the
-- authoritative code list has to come from Udara/CBN, and inventing labels here
-- would put fabricated sector names in front of the risk committee. Until it is
-- populated, callers fall back to 'Sector <code>' — which is at least honestly
-- an unresolved code rather than a wrong name.
--
-- To populate:
--   INSERT INTO app.cbn_sector_codes (code, name) VALUES ('41000','<name>'), …
--   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
CREATE TABLE IF NOT EXISTS app.cbn_sector_codes (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Register every code currently on the book so the gap is visible in one query
-- (SELECT * FROM app.cbn_sector_codes WHERE name LIKE 'Sector %').
INSERT INTO app.cbn_sector_codes (code, name)
SELECT DISTINCT economic_sector, 'Sector ' || economic_sector
FROM cbs_loans
WHERE NULLIF(economic_sector, '') IS NOT NULL
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION app.cbn_sector_name(p_code text)
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT name FROM app.cbn_sector_codes WHERE code = NULLIF(p_code, '')),
    CASE WHEN NULLIF(p_code, '') IS NULL THEN 'Unclassified'
         ELSE 'Sector ' || p_code END
  )
$$;

COMMIT;
