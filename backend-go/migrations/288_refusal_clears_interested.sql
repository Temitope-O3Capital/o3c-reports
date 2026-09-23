-- 288: a lead that was reached again and REFUSED should not still read "Interested".
--
-- RENUMBERED. This shipped as 283_refusal_clears_interested.sql and ran in production
-- at 10:39 on 2026-09-23, before another migration claimed 283 the same day;
-- TestMigrationNumbersDoNotCollide then required the newer file to move, and that was
-- this one. Renaming re-runs it under the new name, which is safe and was verified
-- against the already-migrated database BEFORE the rename: both statements report
-- UPDATE 0. Each is self-limiting — the first reads only leads still on 'interested',
-- the second only hand-offs still open — so replaying it changes nothing.
--
-- Third in the family that began with 275 and 278. All three are the same shape: the
-- forward-only rank guard in syncLeadFromCall let a lead advance but never step back,
-- so a later call that established something WORSE was recorded and then ignored.
--   275 — the promised callback was made and answered "Not Interested" (25 leads)
--   278 — the promised callback was made and nobody picked up      (48 leads)
--   283 — an INTERESTED lead was called again and said no          (this one)
--
-- 'interested' ranks 4 and "Not Interested" maps to 'called' (rank 1), so the refusal
-- lost the comparison and the lead stayed Interested — on the Leads screen, in the
-- qualified count, and to Sales.
--
-- Measured on 2026-09-23 immediately before running — the 204 leads then on
-- 'interested', by what their LATEST disposition actually says:
--     answered_interested   190  -> left alone (they did say yes, most recently)
--     no_answer               8  -> LEFT ALONE. Nobody picked up; that says nothing
--                                   about whether they still want the product, and
--                                   the last thing they actually told us was "yes".
--     not_ready               3  -> LEFT ALONE. A timing objection, not a refusal
--                                   ("Interested but not now" is its own hint).
--     answered_not_interested 3  -> MOVED to 'called'  (this migration)
--
-- So this touches exactly three leads. It is deliberately the narrowest repair that
-- matches the code change shipped alongside it: only an explicit refusal moves a
-- lead off an earned 'interested'. Nothing terminal is touched — the 7 'converted'
-- leads are out of scope by construction, because this only reads rows that are
-- currently 'interested'.
--
-- last_disposition is realigned at the same time. Lead 12615 still read "Interested"
-- there while its latest disposition row was answered_not_interested, because the
-- call that refused came in through a path that passed no label and
-- COALESCE(NULLIF($4,''), last_disposition) kept the stale one.
WITH latest AS (
  SELECT DISTINCT ON (d.lead_id) d.lead_id, d.outcome
    FROM call_center_dispositions d
   ORDER BY d.lead_id, d.created_at DESC
),
refused AS (
  SELECT cl.id,
         CASE latest.outcome WHEN 'do_not_call' THEN 'dnc'          ELSE 'called'         END AS new_status,
         CASE latest.outcome WHEN 'do_not_call' THEN 'Do Not Call'  ELSE 'Not Interested' END AS new_label
    FROM call_center_leads cl
    JOIN latest ON latest.lead_id = cl.id
   WHERE cl.status = 'interested'
     AND latest.outcome IN ('answered_not_interested', 'do_not_call')
)
UPDATE call_center_leads cl
   SET status           = refused.new_status,
       last_disposition = refused.new_label,
       -- A refusal resolves the matter, so no promise survives it. This mirrors
       -- syncLeadFromCall, where every status other than callback/not_ready/
       -- no_answer/pending clears callback_at. All three rows are already NULL here;
       -- it is written anyway so the repair and the code cannot diverge.
       callback_at      = NULL,
       updated_at       = NOW()
  FROM refused
 WHERE cl.id = refused.id;

-- The hand-off to Sales has to end with it.
--
-- The ledger has carried a 'rejected' state and a reason field from the start, but
-- only the Sales handlers ever wrote them — the call centre could learn that a
-- forwarded customer had changed their mind and had no way to say so. On 2026-09-23
-- all 73 forwards sat on 'forwarded' with a NULL outcome. The companion code change
-- closes these automatically from now on; this clears the ones already standing.
--
-- The rule is simply: the hand-off is still open, and the customer refused AFTER it
-- was made. Deliberately not keyed to the three leads repaired above, because a
-- stale hand-off is worth closing whether or not the lead status also froze — and
-- one of the three matches is exactly that case (lead 12172, whose status had
-- already moved to 'called' while Sales went on chasing him).
--
-- Measured immediately before running — 3 open hand-offs match, out of 73:
--     f.24  lead 12172  Aloaye Nicolas Oyati    forwarded 09-16, refused 09-17
--     f.38  lead 12615  Obinna Geoffrey Ijeoma  forwarded 09-18, refused 09-18
--     f.49  lead 17388  Jeffrey Wandara         forwarded 09-21, refused 09-23
--
-- Restricted to the open states so a hand-off Sales has already resolved is neither
-- reopened nor overwritten.
UPDATE call_center_lead_forwards f
   SET status      = 'rejected',
       outcome     = 'Customer declined on a later call — Not Interested',
       updated_at  = NOW(),
       resolved_at = NOW()
 WHERE f.status IN ('forwarded', 'accepted', 'assigned')
   AND EXISTS (
         SELECT 1 FROM call_center_dispositions d
          WHERE d.lead_id = f.lead_id
            AND d.outcome IN ('answered_not_interested', 'do_not_call')
            AND d.created_at > f.forwarded_at);
