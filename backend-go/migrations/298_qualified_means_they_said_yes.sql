-- 298 — The qualified book should hold only leads who said yes, and Sales should see
-- every one of them.
--
-- WHY. Migration 248 established the rule on 14 Sept 2026: a call qualifies a lead only
-- when the customer says they are interested. It re-graded 1,809 leads that afternoon and
-- shipped crmStageForCall alongside, which has applied the rule to every call since.
--
-- Two gaps survived it, and this migration closes both.
--
-- GAP ONE: 48 LEADS THE CLEANUP COULD NOT SEE. Migration 248 re-graded leads whose latest
-- qualifying event read exactly 'Advanced by a call-centre call'. The backfill that joined
-- the two lead books wrote a different note, so the leads it had qualified were never
-- tested against the rule. 48 of them sit at 'qualified' today without a single call where
-- anyone said they were interested; one last recorded "Not Interested". They inflate the
-- qualified book and they are not leads.
--
-- The re-grade here is deliberately keyed on WHETHER A LEAD EVER SAID INTERESTED, not on
-- its most recent call. Keying on the last call would be wrong and destructive: 10 leads
-- said they were interested in August, were called again on 23 September and did not pick
-- up, and are still interested customers waiting on Sales. A last-call rule would demote
-- exactly those.
--
-- GAP TWO: 128 INTERESTED LEADS SALES HAS NEVER SEEN. recordCallHandoff, which writes the
-- forwards ledger automatically, shipped on 15 Sept 2026. Before it, the hand-off existed
-- only as a button nobody pressed, so call_center_lead_forwards begins on 15 September and
-- holds nothing earlier. 128 leads said they were interested before that date. Every one
-- has an answered_interested call on record. Nothing will ever surface them on its own,
-- because a hand-off only fires on a NEW call, and a fresh call from an already-qualified
-- lead used to hit the rank gate this release also removes (see call_center_outbound.go).
--
-- They are forwarded here with a note that says where they came from, so Sales can tell a
-- months-old backlog from this morning's live hand-off rather than finding 128 fresh-
-- looking rows in the queue.
--
-- REVERSIBLE. Both halves record what they did: the re-grade writes a stage_regraded event
-- carrying the stage each lead left, and the backlog forwards are the only rows in the
-- ledger whose notes begin 'Backlog:'. rollback/rollback_298.sql restores from those.

-- ---------------------------------------------------------------------------
-- Part one: the rule, as something that can be re-run rather than a memory of
-- one afternoon.
-- ---------------------------------------------------------------------------

-- Machine-written qualifications. A lead a PERSON judged interested in the CRM is not
-- touched by this function, which is why the note is matched rather than the author:
-- every call-centre path stamps the agent as created_by, so "was it a person?" cannot be
-- answered from created_by alone.
CREATE OR REPLACE FUNCTION app.lead_qualified_by_machine(p_contact_id bigint)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((
        SELECT e.note = 'Advanced by a call-centre call'
            OR e.note LIKE 'Moved by a call-centre call:%'
            OR e.note LIKE 'Auto hand-off: qualified by a call-centre call%'
            OR e.note = 'Derived from call-centre activity when the two lead books were connected'
          FROM app.crm_lead_events e
         WHERE e.contact_id = p_contact_id AND e.to_stage = 'qualified'
         ORDER BY e.created_at DESC
         LIMIT 1), FALSE);
$$;

COMMENT ON FUNCTION app.lead_qualified_by_machine(bigint) IS
  'TRUE when the latest event that put this contact at qualified was written by the '
  'call-centre sync, the automatic hand-off or the lead-book backfill. Used to leave '
  'leads a person qualified alone.';

CREATE OR REPLACE FUNCTION app.regrade_unqualified_leads()
RETURNS TABLE (contact_id bigint, moved_to text)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH candidate AS (
        SELECT c.id,
               l.status                              AS lead_status,
               NULLIF(btrim(l.last_disposition), '') AS disposition
          FROM app.crm_contacts c
          JOIN app.call_center_leads l ON l.contact_id = c.id
         WHERE c.lead_stage = 'qualified'
           AND app.lead_qualified_by_machine(c.id)
           -- The whole test: did anyone, on any call, ever say they were interested?
           AND NOT EXISTS (
               SELECT 1 FROM app.call_center_dispositions d
                WHERE d.lead_id = l.id AND d.outcome = 'answered_interested')
    ),
    decided AS (
        SELECT id, disposition, lead_status,
               CASE
                 WHEN lead_status IN ('dnc', 'closed', 'invalid')              THEN 'disqualified'
                 WHEN lower(COALESCE(disposition, '')) LIKE '%not interested%' THEN 'disqualified'
                 ELSE 'contacted'
               END AS target
          FROM candidate
    ),
    moved AS (
        UPDATE app.crm_contacts c
           SET lead_stage        = d.target,
               stage_changed_at  = NOW(),
               updated_at        = NOW(),
               disqualified_at   = CASE WHEN d.target = 'disqualified' THEN NOW() ELSE c.disqualified_at END,
               disqualify_reason = CASE WHEN d.target = 'disqualified'
                                        THEN 'Call centre: ' || COALESCE(d.disposition, d.lead_status)
                                        ELSE c.disqualify_reason END
          FROM decided d
         WHERE d.id = c.id
        RETURNING c.id, d.target
    ),
    logged AS (
        INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
        SELECT m.id, 'stage_regraded', 'qualified', m.target,
               'Re-graded: no call on this lead ever recorded that the customer was '
                 || 'interested. Only an interested call qualifies a lead (rule agreed '
                 || '14 Sept 2026).',
               NULL
          FROM moved m
        RETURNING 1
    )
    SELECT m.id, m.target FROM moved m;
END;
$$;

COMMENT ON FUNCTION app.regrade_unqualified_leads() IS
  'Moves out of qualified any machine-qualified lead where no call ever recorded '
  'answered_interested, and records why on each lead timeline. Safe to run repeatedly: '
  'it tests whether a lead EVER said interested, never its most recent call, so a lead '
  'who said yes in August and missed a call in September is left qualified.';

-- Close gap one now.
SELECT count(*) AS regraded FROM app.regrade_unqualified_leads();

-- ---------------------------------------------------------------------------
-- Part two: hand the pre-15-September backlog to Sales.
-- ---------------------------------------------------------------------------

-- A qualified lead earns a durable party, the same as the live hand-off path does.
SELECT app.ensure_lead_party(l.contact_id)
  FROM app.call_center_leads l
 WHERE l.status = 'interested' AND l.forwarded_at IS NULL AND l.contact_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.call_center_dispositions d
                WHERE d.lead_id = l.id AND d.outcome = 'answered_interested');

WITH backlog AS (
    SELECT l.id
      FROM app.call_center_leads l
     WHERE l.status = 'interested'
       AND l.forwarded_at IS NULL
       -- Same idempotency guard the live path uses: one open forward per lead.
       AND NOT EXISTS (SELECT 1 FROM app.call_center_lead_forwards f
                        WHERE f.lead_id = l.id AND f.resolved_at IS NULL)
       AND EXISTS (SELECT 1 FROM app.call_center_dispositions d
                    WHERE d.lead_id = l.id AND d.outcome = 'answered_interested')
),
inserted AS (
    INSERT INTO app.call_center_lead_forwards
      (lead_id, contact_id, forwarded_by, customer_name, customer_phone, customer_cif,
       cc_campaign_id, marketing_campaign_id, product_interest, status, notes, forwarded_at)
    SELECT l.id, l.contact_id, NULL, l.customer_name, l.customer_phone,
           NULLIF(l.customer_cif, ''), l.campaign_id, l.marketing_campaign_id,
           c.product_interest, 'forwarded',
           'Backlog: this customer said they were interested on '
             || to_char(
                  (SELECT max(d.created_at) FROM app.call_center_dispositions d
                    WHERE d.lead_id = l.id AND d.outcome = 'answered_interested'),
                  'FMDD FMMonth YYYY')
             || ', before the automatic hand-off existed. Forwarded on 24 Sept 2026.',
           -- Stamped with the call that qualified them, not today, so its age in the
           -- queue reads truthfully rather than looking like this morning's work.
           (SELECT max(d.created_at) FROM app.call_center_dispositions d
             WHERE d.lead_id = l.id AND d.outcome = 'answered_interested')
      FROM app.call_center_leads l
      JOIN backlog b ON b.id = l.id
      LEFT JOIN app.crm_contacts c ON c.id = l.contact_id
    RETURNING lead_id, contact_id
),
stamped AS (
    UPDATE app.call_center_leads l
       SET forwarded_at = COALESCE(l.forwarded_at, NOW())
      FROM inserted i WHERE i.lead_id = l.id
    RETURNING l.id
)
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
SELECT i.contact_id, 'forwarded_to_sales', 'qualified', 'qualified',
       'Backlog hand-off: qualified by a call-centre call before the automatic hand-off '
         || 'existed (15 Sept 2026), and forwarded when that gap was found.',
       NULL
  FROM inserted i
 WHERE i.contact_id IS NOT NULL;
