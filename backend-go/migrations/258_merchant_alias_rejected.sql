-- Remember a rejected merchant merge, so the daily job stops re-proposing it.
--
-- Migration 244 generates tier-2 aliases with ON CONFLICT (clean_name) DO
-- NOTHING, which protects an alias that EXISTS. A rejected one does not exist —
-- it was deleted — so the next refresh re-proposed it, and the reviewer had to
-- reject the same merge again, for ever. The only durable fix available was to
-- write an opposing mapping by hand, which is not what "reject" should mean.
--
-- A tombstone is kept rather than a flag on merchant_alias because the alias row
-- must be gone for app.clean_merchant to stop applying the merge; the decision
-- has to outlive the row that carried it.
CREATE TABLE IF NOT EXISTS app.merchant_alias_rejected (
    clean_name   text PRIMARY KEY,
    canonical    text NOT NULL,       -- what it had been merged into, for the audit trail
    rejected_at  timestamptz NOT NULL DEFAULT now(),
    rejected_by  bigint
);

COMMENT ON TABLE app.merchant_alias_rejected IS
  'Merchant merges a person has explicitly rejected. app.refresh_merchant_aliases() skips these, so a rejection sticks. Delete a row here to let the job propose that merge again.';

-- Same as migration 244 but skipping anything previously rejected.
CREATE OR REPLACE FUNCTION app.refresh_merchant_aliases()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  added integer;
BEGIN
  WITH m AS (
    SELECT app.clean_merchant_basic(t.merchant_name) AS s, count(*) AS n
      FROM app.transactions t
      JOIN app.card_txn_codes c ON c.code = t.txn_code AND c.category = 'purchase'
     WHERE NULLIF(btrim(t.merchant_name), '') IS NOT NULL
     GROUP BY 1
  ),
  cands AS (
    SELECT DISTINCT ON (a.s) a.s AS short_name, b.s AS long_name
      FROM m a
      -- Bucket on the first 8 characters so this is not a 26k x 26k comparison.
      JOIN m b ON left(b.s, 8) = left(a.s, 8)
              AND b.s <> a.s
              -- An exact prefix test. Not LIKE: a merchant name containing % or _
              -- would turn into a wildcard.
              AND left(b.s, length(a.s)) = a.s
              AND b.n > a.n
     WHERE a.s IS NOT NULL
       AND length(a.s) >= 19          -- only spellings at the truncation width
       -- A rejected merge is not proposed again.
       AND NOT EXISTS (SELECT 1 FROM app.merchant_alias_rejected r WHERE r.clean_name = a.s)
     ORDER BY a.s, b.n DESC
  )
  INSERT INTO app.merchant_alias (clean_name, canonical, source, reviewed)
  SELECT short_name, long_name, 'auto_prefix', false FROM cands
  ON CONFLICT (clean_name) DO NOTHING;

  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

COMMENT ON FUNCTION app.refresh_merchant_aliases() IS
  'Adds auto_prefix aliases for truncated merchant spellings. Idempotent; never overwrites an existing alias and never re-proposes one recorded in app.merchant_alias_rejected. Run daily by the merchant_alias worker, not at migration time.';
