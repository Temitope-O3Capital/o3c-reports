-- 261_canonical_npl.sql
--
-- One definition of "non-performing", for the whole workspace.
--
-- NPL was computed four different ways, and the screens disagreed with each other in
-- ways nobody could reconcile:
--
--   * Risk (dashboard, supervisor, portfolio filter, vintage grid)  dpd > 90
--   * Overview / KPI / Executive / nightly CBS snapshot             status IN ('Defaulting','Expired')
--   * The Portfolio "NPL (90+)" tile                                counted dpd > 90 but summed money for dpd > 0
--   * The nightly portfolio_daily_snapshot                          days since BOOKING > 90, as if that were arrears
--
-- The last two are outright bugs. The first two are a genuine disagreement: CBS's own
-- classification and the repayment schedule do not always agree — migration 151 found
-- loans marked 'Defaulting' that were not past due at all, and five that had not even
-- matured. Rather than pick one and lose the other's signal, the agreed rule is the
-- union: a loan is non-performing if the schedule says it is more than 90 days past due
-- OR the core banking system has classified it Defaulting/Expired. It can never
-- understate, and it matches the rule migration 134 already encoded in the scorecard —
-- a Defaulting/Expired loan cannot score as healthy whatever its DPD.
--
-- Ratios built on this are value over value (outstanding of non-performing loans over
-- total outstanding), never a count of loans, which is what a regulator means by the
-- NPL ratio and what the naira figures beside them already implied.
--
-- IMMUTABLE: a pure function of its two arguments, so it can be used in indexes and
-- inlined by the planner. DPD itself stays STABLE (app.cbs_loan_dpd reads CURRENT_DATE);
-- callers pass the computed value in.

CREATE OR REPLACE FUNCTION app.is_npl(p_status text, p_dpd int)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_dpd, 0) > 90
      OR COALESCE(p_status, '') IN ('Defaulting', 'Expired');
$$;

COMMENT ON FUNCTION app.is_npl(text, int) IS
  'Canonical NPL test: schedule DPD > 90 OR CBS status Defaulting/Expired. Use everywhere; do not inline the rule.';
