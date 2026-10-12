-- 358: release the leads that were qualified but never delivered.
--
-- The Leads queue is gated on crm_contacts.sales_entered_at (migration 302). Only the
-- explicit "Forward to Sales" button ever stamped it; recordCallHandoff — the path a
-- lead actually takes when an agent dispositions a call "Interested" — wrote the ledger
-- row, the timeline event and the alerts, and never that column. So qualification
-- recorded a hand-off without performing one.
--
-- Measured 2026-10-12, before this migration:
--   • 140 of 325 automatic hand-offs had never reached the queue
--   • including ALL 80 raised in October — every lead qualified that month
--   • while the hand-off alert had been telling a head about each of them
--
-- The code half is fixed alongside this (handlers/call_center_outbound.go). This is the
-- backlog: 2026-09-07 to 2026-10-12.
--
-- WHAT IS RELEASED, AND WHAT IS NOT. Only the 107 still sitting at 'qualified'. The 31
-- that were later disqualified and the 2 demoted back to 'contacted' are left alone:
-- they are closed or were withdrawn, Sales never worked them, and putting 33 dead rows
-- into a queue is how a queue stops being read. Leaving their sales_entered_at NULL is
-- also the truthful record — they genuinely never reached Sales.
--
-- None of the 140 carries a conversion or a sales owner, so nothing here re-credits a
-- conversion to a team that never touched the customer.

-- ---------------------------------------------------------------------------
-- PART 1 — give them the state they were worked under
-- ---------------------------------------------------------------------------
--
-- Released leads are useless to Sales if they cannot be routed: app.sales_hub_for_state
-- returns NULL without one, so by_office distribution skips them and they sit in the
-- pool for ever. Before this, only 2 of the 140 had a usable state.
--
-- Derived from the CAMPAIGN NAME, which is the rule migration 317 established and
-- justified: the campaign a lead was worked under is unambiguous where a phone match is
-- not, and 'Lagos'/'FCT' is the upstream vocabulary the contact lists carry. 106 of the
-- 107 name one. The single "IK August List" lead names no location and keeps a blank
-- state deliberately — the same treatment 317 gave the five it could not place.

WITH lead_state AS (
    SELECT c.id,
           CASE WHEN COALESCE(mc.name, ccc.name) ILIKE '%lagos%' THEN 'Lagos'
                WHEN COALESCE(mc.name, ccc.name) ILIKE '%FCT%'
                  OR COALESCE(mc.name, ccc.name) ILIKE '%abuja%' THEN 'FCT'
           END AS state
      FROM app.crm_contacts c
      JOIN app.call_center_lead_forwards f ON f.contact_id = c.id
      LEFT JOIN app.campaigns mc ON mc.id = c.source_campaign_id
      LEFT JOIN LATERAL (
          SELECT cc.name
            FROM app.call_center_lead_forwards f2
            JOIN app.call_center_campaigns cc ON cc.id = f2.cc_campaign_id
           WHERE f2.contact_id = c.id
           ORDER BY f2.forwarded_at DESC
           LIMIT 1
      ) ccc ON TRUE
     WHERE c.sales_entered_at IS NULL
       AND c.lead_stage = 'qualified'
)
UPDATE app.crm_contacts c
   SET state      = ls.state,
       updated_at = NOW()
  FROM lead_state ls
 WHERE c.id = ls.id
   AND ls.state IS NOT NULL
   AND COALESCE(NULLIF(btrim(c.state), ''), '') = '';

-- ---------------------------------------------------------------------------
-- PART 2 — deliver them
-- ---------------------------------------------------------------------------
--
-- sales_entered_at takes the date of the HAND-OFF, not of this migration. A lead
-- qualified on 7 September is five weeks old and must read that way: stamping NOW()
-- would reset the clock on every one of them and hide a five-week-old backlog behind a
-- queue that looked like this morning's work. Migration 298 took the same care with the
-- hand-off backlog it released.
--
-- Left unowned on purpose. Who works them is a distribution decision — by_office will
-- now route them, since Part 1 gave them a state — and not something a migration should
-- make on a head's behalf.

WITH earliest AS (
    SELECT contact_id, MIN(forwarded_at) AS at
      FROM app.call_center_lead_forwards
     GROUP BY contact_id
)
UPDATE app.crm_contacts c
   SET sales_entered_at = COALESCE(e.at, c.stage_changed_at, NOW()),
       sales_source     = COALESCE(c.sales_source, 'call_centre'),
       lead_source      = COALESCE(NULLIF(c.lead_source, ''), 'call_centre'),
       source           = COALESCE(NULLIF(c.source, ''), 'call_centre'),
       updated_at       = NOW()
  FROM earliest e
 WHERE c.id = e.contact_id
   AND c.sales_entered_at IS NULL
   AND c.lead_stage = 'qualified';

-- ---------------------------------------------------------------------------
-- PART 3 — prove it, and refuse to ship a half-done release
-- ---------------------------------------------------------------------------
--
-- A silent partial backfill is the failure mode here: leads appear, a head distributes
-- what they can see, and the rest stay invisible with nothing to say so.

DO $$
DECLARE
    still_hidden int;
    unroutable   int;
BEGIN
    SELECT COUNT(*) INTO still_hidden
      FROM app.crm_contacts c
      JOIN app.call_center_lead_forwards f ON f.contact_id = c.id
     WHERE c.sales_entered_at IS NULL AND c.lead_stage = 'qualified';

    IF still_hidden > 0 THEN
        RAISE EXCEPTION 'release incomplete: % qualified leads still invisible to Sales', still_hidden;
    END IF;

    SELECT COUNT(*) INTO unroutable
      FROM app.crm_contacts c
     WHERE c.sales_entered_at IS NOT NULL
       AND c.sales_owner_id IS NULL
       AND c.lead_stage NOT IN ('converted', 'disqualified')
       AND app.sales_hub_for_state(c.state) IS NULL;

    RAISE NOTICE 'every qualified hand-off now reaches Sales; % unowned lead(s) still have no routable state', unroutable;
END $$;
