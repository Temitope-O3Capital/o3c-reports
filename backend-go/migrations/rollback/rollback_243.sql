-- Rollback 243_income_naira_only.sql
--
-- Restore the pre-243 view definitions exactly (as captured from the 2026-09-12
-- dump), then drop the resolver. Views first: they depend on the function.
--
-- (This migration was briefly numbered 239 and was renumbered because another
-- session had already claimed 239 for card_product_definition. rollback_239.sql
-- belongs to THAT migration — do not run it to undo this one.)

CREATE OR REPLACE VIEW app.income_daily AS
 SELECT t.txn_date AS income_date,
    c.category,
    COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text) AS product_name,
    count(*) AS txn_count,
    sum(t.amount) AS amount_ngn
   FROM (app.transactions t
     JOIN app.card_txn_codes c ON ((c.code = t.txn_code)))
  WHERE ((c.category = ANY (ARRAY['fee'::text, 'interest'::text, 'penalty'::text])) AND c.counts_in_total)
  GROUP BY t.txn_date, c.category, COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text);

CREATE OR REPLACE VIEW app.interest_components_daily AS
 SELECT t.txn_date AS income_date,
    c.description AS component,
    count(*) AS txn_count,
    sum(t.amount) AS amount_ngn
   FROM (app.transactions t
     JOIN app.card_txn_codes c ON ((c.code = t.txn_code)))
  WHERE ((c.category = 'interest'::text) AND (NOT c.counts_in_total))
  GROUP BY t.txn_date, c.description;

-- Migration 236's definition.
CREATE OR REPLACE VIEW app.income_daily_by_currency AS
 SELECT t.txn_date                                                   AS income_date,
        c.category,
        COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text) AS product_name,
        COALESCE(NULLIF(btrim(t.currency_code), ''), 'unknown')      AS currency_code,
        count(*)                                                     AS txn_count,
        sum(t.amount)                                                AS amount
   FROM app.transactions t
   JOIN app.card_txn_codes c ON c.code = t.txn_code
  WHERE c.category = ANY (ARRAY['fee'::text, 'interest'::text, 'penalty'::text])
    AND c.counts_in_total
  GROUP BY t.txn_date, c.category,
           COALESCE(NULLIF(t.product_name, ''::text), 'Unspecified'::text),
           COALESCE(NULLIF(btrim(t.currency_code), ''), 'unknown');

DROP FUNCTION IF EXISTS app.resolve_currency(text, text, text);
