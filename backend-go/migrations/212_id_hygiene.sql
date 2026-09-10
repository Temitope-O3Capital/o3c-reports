-- 212: id hygiene.
--
-- Remove orphan parties: parties referenced by NO customer, NO CBS link, and NOT present
-- in customer_acquisition — pure dead weight left behind by earlier party-layer rebuilds
-- (party_key 'cid:<hex>'), invisible in the app because nothing points at them. Verified
-- 2026-09-08: 123 such rows, none referenced anywhere. Idempotent (re-run deletes 0).
--
-- NOTE on test/dummy records: they are intentionally NOT deleted here. They live in the
-- feed-owned card book (app."Accounts"), so a delete is re-inserted on the next sync (a
-- prior attempt left app.customers_testdel_20260810 / accounts_testdel_20260810 backups).
-- They are hidden at the query layer instead (customer directory + search filter on a
-- name pattern), which is durable and needs no destructive change.
DELETE FROM app.parties p
 WHERE NOT EXISTS (SELECT 1 FROM app.customers c        WHERE c.party_id = p.party_id)
   AND NOT EXISTS (SELECT 1 FROM app.cbs_links k         WHERE k.entity_type='party' AND k.entity_id = p.party_id)
   AND NOT EXISTS (SELECT 1 FROM app.customer_acquisition ca WHERE ca.party_id = p.party_id);
