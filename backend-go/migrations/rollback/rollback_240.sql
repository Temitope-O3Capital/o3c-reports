-- Rollback 240_card_activity.sql
--
-- Run this BEFORE rollback_239: app.card_book_full selects the catalogue columns
-- that 239 adds (is_cooperative, fx_funded, currency, scheme…), so dropping those
-- columns while the view still exists would fail on the dependency.
--
-- Order within this file matters too — card_book_full reads card_activity.

DROP VIEW  IF EXISTS app.card_book_full;
DROP VIEW  IF EXISTS app.card_activity;
DROP INDEX IF EXISTS app.idx_transactions_account_no_date;
