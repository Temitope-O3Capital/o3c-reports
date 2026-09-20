-- Rollback 244_merchant_canonical.sql
--
-- Note: handlers/growth.go and handlers/customer360.go call app.clean_merchant.
-- After this rollback their top_merchants queries fail and those keys are
-- silently omitted from the response, so roll the handlers back too.

DROP FUNCTION IF EXISTS app.refresh_merchant_aliases();
DROP FUNCTION IF EXISTS app.clean_merchant(text);
DROP TABLE IF EXISTS app.merchant_alias;
DROP FUNCTION IF EXISTS app.clean_merchant_basic(text);
