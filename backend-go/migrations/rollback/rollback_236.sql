DROP VIEW IF EXISTS app.income_daily_by_currency;

-- Restore the view comments to absent (migration 236 only added warnings; the
-- view definitions themselves were never altered).
COMMENT ON VIEW app.income_daily IS NULL;
COMMENT ON VIEW app.interest_components_daily IS NULL;
