-- 328 — Backfill call_center_leads.status/last_disposition from terminal steps
-- already logged before applyStepToLead existed. @nonblocking: data only, safe to retry.
--
-- The gap: a terminal step (Converted / Declined-Not-Eligible / Dropped Off) has always
-- been written correctly to app.activities with a real lead_id -- confirmed by tracing
-- Ramat Sadiq's "Converted" step for Adebayo Peter Olorunfemi (activities.id=50063,
-- lead_id=6655, logged 2026-09-30) against call_center_leads.id=6655, which still read
-- status='interested' two days later. The step was never wrong; nothing before this
-- migration ever read it back onto the board. applyStepToLead (customer_steps.go) fixes
-- this going forward; this is the one-time catch-up for every step logged before that
-- shipped.
--
-- Same rank guard as the live code (ccLeadStatusRankSQL / ccLeadStatusRank), so this
-- cannot knock a lead backward that a LATER call has already carried past where the step
-- would put it, and the same vocabulary (converted->converted, declined_not_eligible and
-- dropped_off->closed) so a lead moved by this migration reads exactly as if
-- applyStepToLead had run at the time. Idempotent: every step is applied again on a
-- retry, and the rank guard means re-applying an already-applied step is a no-op.
--
-- Picks the LATEST terminal step per lead (DISTINCT ON ... ORDER BY occurred_at DESC) --
-- a lead worked twice (e.g. dropped off, then later re-engaged and converted) must land
-- on what most recently happened, not an earlier one a naive one-step-wins-arbitrarily
-- join would pick.
\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS scrap.bk_328_lead_status;
CREATE TABLE scrap.bk_328_lead_status AS
  SELECT id, status, last_disposition, updated_at, NOW() AS snapped_at
    FROM call_center_leads
   WHERE id IN (
     SELECT DISTINCT lead_id FROM activities
      WHERE type = 'step' AND lead_id IS NOT NULL
        AND outcome IN ('converted', 'declined_not_eligible', 'dropped_off')
   );

WITH latest_terminal_step AS (
  SELECT DISTINCT ON (lead_id)
         lead_id,
         outcome,
         CASE outcome
           WHEN 'converted' THEN 'converted'
           ELSE 'closed' -- declined_not_eligible, dropped_off
         END AS step_status,
         CASE
           WHEN outcome = 'converted' THEN 'Converted'
           WHEN outcome = 'declined_not_eligible' THEN 'Declined — Not Eligible'
           ELSE 'Dropped Off'
         END || CASE WHEN COALESCE(TRIM(body), '') <> '' THEN ' — ' || TRIM(body) ELSE '' END AS step_label
    FROM activities
   WHERE type = 'step' AND lead_id IS NOT NULL
     AND outcome IN ('converted', 'declined_not_eligible', 'dropped_off')
   ORDER BY lead_id, occurred_at DESC, created_at DESC
)
UPDATE call_center_leads l
   SET status = CASE
                   WHEN (CASE t.step_status WHEN 'converted' THEN 5 WHEN 'closed' THEN 5 ELSE 0 END)
                        >= (CASE l.status
                              WHEN 'pending'    THEN 0
                              WHEN 'no_answer'  THEN 1
                              WHEN 'called'     THEN 1
                              WHEN 'not_ready'  THEN 2
                              WHEN 'callback'   THEN 3
                              WHEN 'interested' THEN 4
                              ELSE 5
                            END)
                   THEN t.step_status ELSE l.status END,
       last_disposition = t.step_label,
       updated_at = NOW()
  FROM latest_terminal_step t
 WHERE l.id = t.lead_id;

\echo '=== leads moved ==='
SELECT l.id, b.status AS was, l.status AS now_status, l.last_disposition
  FROM call_center_leads l
  JOIN scrap.bk_328_lead_status b ON b.id = l.id
 WHERE b.status IS DISTINCT FROM l.status OR b.last_disposition IS DISTINCT FROM l.last_disposition
 ORDER BY l.id;

COMMIT;
