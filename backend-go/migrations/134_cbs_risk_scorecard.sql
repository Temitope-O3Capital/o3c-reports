-- 134: Internal risk scorecard for the live CBS book. Udara is a core-banking system;
-- it does NOT hold O3's own credit rating, so we DERIVE a transparent behavioural score
-- from the signals the book gives us — repayment status and days past maturity (DPD).
-- Score is 0-100 (higher = healthier); band A(best)-E(worst). STABLE (uses CURRENT_DATE).

CREATE OR REPLACE FUNCTION app.cbs_risk_score(p_status text, p_maturity date)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT LEAST(100, GREATEST(0,
    CASE  -- base from DPD (days past maturity)
      WHEN GREATEST(0, CURRENT_DATE - p_maturity) = 0        THEN 95
      WHEN GREATEST(0, CURRENT_DATE - p_maturity) <= 30      THEN 75
      WHEN GREATEST(0, CURRENT_DATE - p_maturity) <= 60      THEN 60
      WHEN GREATEST(0, CURRENT_DATE - p_maturity) <= 90      THEN 45
      WHEN GREATEST(0, CURRENT_DATE - p_maturity) <= 180     THEN 30
      ELSE 15
    END
    -- status caps: a Defaulting/Expired loan can't score as healthy regardless of DPD
    - CASE p_status WHEN 'Defaulting' THEN 25 WHEN 'Expired' THEN 45 ELSE 0 END
  ))::int
$$;

CREATE OR REPLACE FUNCTION app.cbs_risk_band(p_status text, p_maturity date)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN app.cbs_risk_score(p_status, p_maturity) >= 80 THEN 'A'
    WHEN app.cbs_risk_score(p_status, p_maturity) >= 65 THEN 'B'
    WHEN app.cbs_risk_score(p_status, p_maturity) >= 50 THEN 'C'
    WHEN app.cbs_risk_score(p_status, p_maturity) >= 35 THEN 'D'
    ELSE 'E'
  END
$$;
