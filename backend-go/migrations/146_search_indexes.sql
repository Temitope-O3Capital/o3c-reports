-- Search acceleration indexes.
--
-- Every customer/contact search is a case-insensitive substring (ILIKE '%q%') plus a
-- normalized last-10-digits phone match. Those are sequential scans without trigram
-- support, and the only existing pg_trgm indexes (migration 010) sit on the LEGACY
-- public."Accounts" table, which no live search touches. These build the trigram GIN
-- indexes on the tables searches actually hit — app.customers (identity, ~21k),
-- app.crm_contacts (CRM/leads, ~30k) and app.customer_acquisition (sales book) — so
-- ILIKE and phone lookups use an index instead of scanning.
--
-- gin_trgm_ops supports both ILIKE '%q%' and LIKE with a leading wildcard, so the
-- normalized-phone suffix match ("... LIKE '%'||digits") is index-accelerated too.
-- The phone index expression MUST match normalizedPhoneExpr() in handlers/searchcore.go.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── app.customers (identity source of truth) ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_fullname_trgm ON app.customers USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_cif_trgm      ON app.customers USING gin (cif gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_email_trgm    ON app.customers USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone_norm_trgm
  ON app.customers USING gin ((right(regexp_replace(coalesce(phone,''),'\D','','g'),10)) gin_trgm_ops);

-- ── app.crm_contacts (CRM / leads) ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_crm_contacts_name_trgm
  ON app.crm_contacts USING gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email_trgm ON app.crm_contacts USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_cif_trgm   ON app.crm_contacts USING gin (cif_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone_norm_trgm
  ON app.crm_contacts USING gin ((right(regexp_replace(coalesce(phone,''),'\D','','g'),10)) gin_trgm_ops);

-- app.customer_acquisition (the sales book source) is a VIEW, not a table, so it
-- can't carry its own indexes — its reads ride the base tables' indexes instead.
