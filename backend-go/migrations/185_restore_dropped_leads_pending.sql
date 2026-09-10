-- 185: restore call-centre leads that were knocked off 'pending' by the pre-fix
-- auto-advance worker (2026-08-26).
--
-- A "Call Dropped" means the line connected then died within seconds — nothing was
-- discussed, so the lead has NOT been worked and must stay 'pending' to be retried.
-- syncLeadFromCall already set it pending, but the phone-match lead-advance worker
-- then re-derived the status from a later raw dial and downgraded it (e.g. to
-- 'no_answer'). The worker now skips leads whose latest agent disposition is a drop;
-- this repairs the ones it already moved.
--
-- Only leads whose MOST RECENT agent disposition is a drop are touched, and only from
-- the "touched, not closed" states — deliberate closes (converted/closed/dnc/invalid)
-- and callbacks are left exactly as they are. Idempotent: once restored, no rows match.
UPDATE call_center_leads l
   SET status = 'pending', updated_at = NOW()
 WHERE l.status IN ('no_answer', 'called')
   AND EXISTS (
     SELECT 1
       FROM call_center_dispositions d
      WHERE d.lead_id = l.id
        AND d.created_at = (SELECT MAX(created_at) FROM call_center_dispositions d2 WHERE d2.lead_id = l.id)
        AND d.outcome ILIKE '%drop%'
   );

-- Same repair for outbound-queue contacts, keyed off their stored disposition.
UPDATE call_center_contacts
   SET status = 'pending', updated_at = NOW()
 WHERE status IN ('no_answer', 'called')
   AND (last_disposition ILIKE '%drop%' OR disposition_code = 'call_dropped');
