-- 141: Stop dropping non-customer calls.
--
-- helpdesk_calls.customer_cif was created NOT NULL DEFAULT '' (migration 025/026).
-- The Zoho Desk call importer (migration 128 handler) resolves CIF-by-phone with
--   COALESCE(NULLIF($5,''), (SELECT cif ... LIMIT 1))
-- which evaluates to NULL when the caller isn't a known customer — i.e. for the
-- ~96% of telesales/lead calls. Every one of those inserts then failed with
-- "null value in column customer_cif violates not-null constraint" (SQLSTATE 23502)
-- and the call was silently dropped, so per-agent call counts collapsed (an agent
-- who made 149 calls showed 2). Allowing NULL lets those calls land.
--
-- The companion code fix makes the importer insert '' (the column's own "no CIF"
-- sentinel) instead of NULL going forward; this migration removes the constraint so
-- the currently-running binary — and any historical backfill — can insert them too.

ALTER TABLE helpdesk_calls ALTER COLUMN customer_cif DROP NOT NULL;
