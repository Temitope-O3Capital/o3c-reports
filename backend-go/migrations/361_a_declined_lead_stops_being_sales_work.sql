-- A lead the call centre has declined stops being Sales' work.
--
-- THE CASE. Lead 14648, "Sicostar". One call on 2 October 2026, disposition Interested,
-- which correctly qualified the contact and forwarded it to Sales. On 6 October somebody
-- moved it to the terminal journey step Declined - Not Eligible, with the note "BAD
-- CREDIT RECORD WITH OPAY AND NEWEDGE". The call-centre board closed the lead, exactly
-- as designed. Nothing told Sales. So on 12 October a bulk distribution handed a lead the
-- business had already refused to a sales officer, to go and visit.
--
-- Asked three ways, the app gave three answers about that one lead:
--
--   call_center_leads.status          closed
--   crm_contacts.lead_stage           qualified      (shown to Sales as "Interested")
--   call_center_lead_forwards         still open     (shown as "With Sales")
--
-- applyStepToLead deliberately never touched crm_contacts, and the reason given was
-- sound for CONVERTING: that path needs a product line and a CIF a free-text step cannot
-- carry, and marking a lead a customer without a CIF corrupts every join that assumes
-- one. It is not sound for DECLINING - disqualifying needs only a reason, and the step
-- carries one in its own note. customer_steps.go now propagates declines (and only
-- declines) through declineReachesSales / disqualifyForwardedLeadSQL.
--
-- This migration repairs the leads already in that state. Sixteen of them when measured,
-- fifteen already sitting with an officer.
--
-- WHAT IT WILL NOT DO. It never touches a contact Sales has converted or already
-- disqualified: a booked conversion outranks a call-centre note, and reversing one would
-- drop a real customer out of the numbers. It reaches only contacts linked through the
-- hand-off ledger, never by phone - a phone match would disqualify whoever else shares
-- the number. And it leaves the lead board alone: that side is already correct, and it is
-- the side the decline came from.

BEGIN;

-- 1. End the lead on the Sales side.
--
-- The reason comes off the lead's own last_disposition, which is where applyStepToLead
-- wrote the step label and the agent's note. Prefixed so that six months from now the
-- lead page says where the decision came from, rather than presenting a call-centre note
-- as a sales officer's own conclusion.
CREATE TEMP TABLE repaired AS
WITH declined AS (
    SELECT DISTINCT ON (f.contact_id)
           f.contact_id,
           l.id     AS lead_id,
           COALESCE(NULLIF(btrim(l.last_disposition), ''), 'Closed by the call centre')
                    AS reason
      FROM call_center_lead_forwards f
      JOIN call_center_leads l ON l.id = f.lead_id
      JOIN crm_contacts c      ON c.id = f.contact_id
     WHERE l.status IN ('closed', 'dnc', 'invalid')
       AND c.lead_stage NOT IN ('converted', 'disqualified')
       AND f.contact_id IS NOT NULL
     ORDER BY f.contact_id, f.forwarded_at DESC
),
-- The write has to be a CTE: CREATE TABLE AS cannot wrap a bare UPDATE.
ended AS (
    UPDATE crm_contacts c
       SET lead_stage        = 'disqualified',
           disqualify_reason = 'Declined by the call centre after the hand-off: ' || d.reason,
           updated_at        = NOW()
      FROM declined d
     WHERE c.id = d.contact_id
 RETURNING c.id AS contact_id, c.sales_owner_id, d.lead_id, d.reason
)
SELECT * FROM ended;

-- 2. Put it in the stage history. Without this the lead page shows a disqualified lead
-- and nothing saying who did it or why, which is the same invisibility that produced the
-- problem in the first place.
INSERT INTO crm_lead_events (contact_id, event, to_stage, note, created_by)
SELECT contact_id, 'disqualified', 'disqualified',
       'Declined by the call centre after the hand-off: ' || reason, NULL
  FROM repaired;

-- 3. Close the hand-off in the tracker. These were open hand-offs that will never be
-- worked, ageing in the call centre's own tracker and counting against pickup time.
UPDATE call_center_lead_forwards f
   SET status         = 'rejected',
       outcome        = COALESCE(NULLIF(btrim(f.outcome), ''), r.reason),
       sales_owner_id = COALESCE(f.sales_owner_id, r.sales_owner_id),
       resolved_at    = COALESCE(f.resolved_at, NOW())
  FROM repaired r
 WHERE f.contact_id = r.contact_id
   AND f.resolved_at IS NULL;

-- 4. Say what happened, and refuse to claim a fix it did not make.
DO $$
DECLARE
    n_repaired INT;
    n_owned    INT;
    n_left     INT;
BEGIN
    SELECT COUNT(*), COUNT(*) FILTER (WHERE sales_owner_id IS NOT NULL)
      INTO n_repaired, n_owned FROM repaired;

    SELECT COUNT(*) INTO n_left
      FROM call_center_lead_forwards f
      JOIN call_center_leads l ON l.id = f.lead_id
      JOIN crm_contacts c      ON c.id = f.contact_id
     WHERE l.status IN ('closed', 'dnc', 'invalid')
       AND c.lead_stage NOT IN ('converted', 'disqualified');

    RAISE NOTICE 'declined hand-offs ended on the sales side: % (% already with an officer)',
        n_repaired, n_owned;

    IF n_left > 0 THEN
        RAISE EXCEPTION 'still % forwarded leads the call centre has closed but Sales reads as open', n_left;
    END IF;
END $$;

-- The officers holding those leads are NOT alerted from here. A migration runs once, at
-- deploy, and would fire a batch of "stop work" alerts about decisions up to three weeks
-- old - the oldest of these was declined on 6 October. The leads leave their queues
-- quietly; the alert exists for declines from now on, where it is timely and actionable,
-- and that is disqualifyForwardedLead in customer_steps.go.

COMMIT;
