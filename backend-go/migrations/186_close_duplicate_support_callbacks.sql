-- 186: retire the duplicate "Support Call-back" queue contacts the old callback path
-- spawned (2026-08-26).
--
-- Before the fix, scheduling a call-back created it TWICE: once on the lead/contact it
-- belonged to, and once as a stray support-purpose "Support Call-back" queue contact —
-- so the same call-back showed up in two books and was mislabelled support. The code fix
-- stops new duplicates; this closes the ones already made.
--
-- SCOPE (deliberately narrow): only still-pending support "Support Call-back" contacts
-- that EXACTLY duplicate a lead's call-back — same phone (last 10 digits) and the same
-- call-back time (within 2 minutes). A genuine support call-back (no matching lead
-- call-back) has no such match and is left completely alone. Reversible: the rows are
-- closed, not deleted, and tagged in notes.
UPDATE call_center_contacts c
   SET status = 'closed',
       updated_at = NOW(),
       notes = CASE WHEN COALESCE(NULLIF(c.notes,''),'') = ''
                    THEN '[auto-closed: duplicate of a lead call-back]'
                    ELSE c.notes || ' · [auto-closed: duplicate of a lead call-back]' END
 WHERE c.product_name = 'Support Call-back'
   AND c.purpose = 'support'
   AND c.status = 'pending'
   AND c.callback_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM call_center_leads l
      WHERE right(regexp_replace(COALESCE(l.customer_phone,''),'\D','','g'),10)
          = right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10)
        AND right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10) <> ''
        AND l.callback_at IS NOT NULL
        AND abs(extract(epoch FROM (l.callback_at - c.callback_at))) < 120
   );
