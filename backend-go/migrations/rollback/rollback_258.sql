-- Rollback 258: forget rejected merges and restore migration 244's refresh.
--
-- Dropping the table loses every rejection decision, and the daily job will then
-- re-propose those merges as pending. The aliases themselves are untouched.
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
      JOIN m b ON left(b.s, 8) = left(a.s, 8)
              AND b.s <> a.s
              AND left(b.s, length(a.s)) = a.s
              AND b.n > a.n
     WHERE a.s IS NOT NULL
       AND length(a.s) >= 19
     ORDER BY a.s, b.n DESC
  )
  INSERT INTO app.merchant_alias (clean_name, canonical, source, reviewed)
  SELECT short_name, long_name, 'auto_prefix', false FROM cands
  ON CONFLICT (clean_name) DO NOTHING;

  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

DROP TABLE IF EXISTS app.merchant_alias_rejected;
