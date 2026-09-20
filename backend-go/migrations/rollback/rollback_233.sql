DROP INDEX IF EXISTS app.idx_transactions_currency_foreign;
DROP INDEX IF EXISTS app.idx_accounts_currency_foreign;

ALTER TABLE app.transactions
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS pcc,
  DROP COLUMN IF EXISTS code_class;

ALTER TABLE app.customers
  DROP COLUMN IF EXISTS address_3,
  DROP COLUMN IF EXISTS phone_2;

ALTER TABLE app.accounts
  DROP COLUMN IF EXISTS currency_code,
  DROP COLUMN IF EXISTS status_code,
  DROP COLUMN IF EXISTS interest_rate,
  DROP COLUMN IF EXISTS card_issue_date;
