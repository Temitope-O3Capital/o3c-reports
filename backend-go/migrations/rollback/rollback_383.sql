-- Undo 383.
--
-- THIS PUTS THE SLOW VERSION BACK. 383 was a performance fix with no change in
-- behaviour, so rolling it back restores migration 376's body: the same answers, 13x
-- slower on a filter (16,238 ms against 37,916 contact list members, versus 1,212 ms
-- after). Nothing reads differently; the Report Builder's state filters just become
-- slow enough to time out again. Roll back only if the rewrite is suspected of
-- answering differently, and if so please record what differed, because the assertions
-- in 383 cover every branch.
--
-- NO BINARY ROLLBACK IS NEEDED. Both versions take the same argument and return the
-- same type, and nothing in Go calls app.fold_state directly — the handlers only ever
-- name app.canon_state, in the dataset column and filter expressions.
--
-- app.fold_state IS LEFT IN PLACE on purpose. Dropping it would fail while any other
-- session's migration or view references it, and an unused IMMUTABLE function costs
-- nothing. The index is dropped because 383 created it; it is equally harmless, so
-- leave that line out if anything else has come to depend on it.

CREATE OR REPLACE FUNCTION app.canon_state(p_state text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    WITH trimmed AS (
        -- Strip a trailing " State", exactly as app.sales_hub_for_state does.
        SELECT NULLIF(btrim(regexp_replace(COALESCE(p_state, ''), '\s+state$', '', 'i')), '') AS s
    ),
    folded AS (
        SELECT s,
               CASE
                   WHEN lower(s) IN ('abuja', 'fct', 'f.c.t.', 'f.c.t',
                                     'federal capital territory', 'fct, abuja',
                                     'abuja, fct')
                       THEN 'FCT'
                   ELSE s
               END AS f
          FROM trimmed
    )
    SELECT CASE
               WHEN f IS NULL THEN NULL
               WHEN EXISTS (SELECT 1 FROM app.lead_state_hub h WHERE lower(h.state) = lower(f))
                   THEN (SELECT h.state FROM app.lead_state_hub h
                          WHERE lower(h.state) = lower(f) LIMIT 1)
               WHEN f = 'FCT' THEN 'FCT'
               ELSE COALESCE(
                   (SELECT h.state FROM app.lead_state_hub h
                     WHERE lower(h.state) = lower(btrim(split_part(f, ',', 1))) LIMIT 1),
                   s)
           END
      FROM folded
$$;

DROP INDEX IF EXISTS app.lead_state_hub_lower_state_idx;
