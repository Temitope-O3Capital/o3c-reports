-- Every open lead sits with an officer who can actually visit it.
--
-- A full audit of the hand-off pipeline on 2026-10-12 found four things wrong at once.
-- Three of them are repaired here; the fourth (a missing city on 262 of 265 open leads)
-- cannot be - the field was never captured, only 4 of 20,587 leads in the book carry one,
-- so there is nothing to recover. The Interested guard added with migration 353 collects
-- it going forward.
--
-- 1. THE LEDGER DISAGREED WITH THE STAGE. 14 contacts read lead_stage 'disqualified'
--    while their hand-off still read 'forwarded' with resolved_at NULL. Every one was
--    moved by a call-centre call logging "Not Eligible". syncLeadFromCall closes a
--    hand-off only when leadDeclinedOnCall says so, and that predicate answers a
--    different question - "may this overturn an earned 'interested'?" - where excluding
--    our own decline is the correct answer. Borrowing it to decide whether SALES is
--    finished was not. Fixed in code by leadEndsHandoffOnCall; the backlog closes below.
--
--    It was invisible on screen, which is why it lasted: forwardStatusExpr reads the
--    stage, so the tracker showed these as Rejected while resolved_at stayed NULL and
--    they aged as open hand-offs for ever.
--
-- 2. TWO LIVE HAND-OFFS NEVER ARRIVED. Of 33 forwards with no sales_entered_at, 31 are
--    already disqualified - finished business, and delivering them now would resurrect
--    dead leads into the pool. Two are not: forwarded 2026-09-28 at stage 'contacted'
--    and 'interested', never delivered, a fortnight stuck. Those two are delivered.
--
-- 3. 162 LEADS WERE PARKED ON FOUR HEADS AND 45 WERE IN THE WRONG CITY. Migration 317
--    dealt the unowned backlog to the hub heads so that "a head takes the state their
--    team covers and allocates within their own team". Nothing was ever built for a head
--    to make that allocation, so it never happened. Meanwhile 45 Abuja-state leads sat
--    with Lagos staff who cannot visit them, and all five Abuja officers held nothing at
--    all. Reallocated below.
--
--    Checked before moving any of it: of the 162 on heads, exactly 2 had been worked by
--    a named person. The 182 activity rows against them are source='call_center' dialler
--    imports - the calls that qualified the leads - not sales work. Nothing in progress
--    is being taken off anybody.
--
-- WHAT THIS WILL NOT DO. It never moves a converted or disqualified lead, never moves a
-- lead whose state does not resolve to an office (5 of them - they stay where they are
-- and are reported, rather than being dealt to whichever hub sorted first), and never
-- gives a lead to anyone who is not an active member of an active sales team.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Close the ledger where the stage already says the business is over.
-- ---------------------------------------------------------------------------
UPDATE call_center_lead_forwards f
   SET status      = CASE WHEN c.lead_stage = 'converted' THEN 'converted' ELSE 'rejected' END,
       outcome     = COALESCE(NULLIF(btrim(f.outcome), ''),
                              NULLIF(btrim(c.disqualify_reason), ''),
                              'Closed by the call centre'),
       resolved_at = COALESCE(f.resolved_at, NOW()),
       updated_at  = NOW()
  FROM crm_contacts c
 WHERE c.id = f.contact_id
   AND c.lead_stage IN ('converted', 'disqualified')
   AND f.resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Deliver the live hand-offs that never arrived.
-- ---------------------------------------------------------------------------
-- Dated from the forward rather than from now, so the ageing figures keep telling the
-- truth about how long Sales actually had them instead of resetting the clock at deploy.
UPDATE crm_contacts c
   SET sales_entered_at = COALESCE(c.sales_entered_at, f.forwarded_at),
       sales_source     = COALESCE(c.sales_source, 'call_centre'),
       updated_at       = NOW()
  FROM call_center_lead_forwards f
 WHERE f.contact_id = c.id
   AND c.sales_entered_at IS NULL
   AND c.lead_stage NOT IN ('converted', 'disqualified');

-- ---------------------------------------------------------------------------
-- 3. Put every routable open lead with an officer in the right hub, evenly.
-- ---------------------------------------------------------------------------
--
-- Eligible recipients are active users on an active team whose office resolves to a hub.
-- Heads are NOT recipients: they supervise, and a head holding 72 leads is the state this
-- migration exists to end. A head can still claim a lead deliberately afterwards, and can
-- deal their own book out with the include_mine option added alongside this.
CREATE TEMP TABLE officer_slots AS
SELECT u.id                                        AS officer_id,
       app.sales_hub_for_office(u.office_location)  AS hub,
       (SELECT COUNT(*) FROM app.crm_contacts c
         WHERE c.sales_owner_id = u.id
           AND c.lead_stage NOT IN ('converted', 'disqualified')
           AND app.sales_hub_for_state(c.state)
               = app.sales_hub_for_office(u.office_location)) AS keeps
  FROM app.o3c_users u
 WHERE u.is_active
   AND u.deleted_at IS NULL
   AND app.sales_hub_for_office(u.office_location) IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.sales_team_members m
                 JOIN app.sales_teams t ON t.id = m.team_id AND t.is_active
                WHERE m.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM app.sales_teams t
                    WHERE t.head_user_id = u.id AND t.is_active);

-- The leads that need a new owner: parked on a head, or in a hub their owner cannot
-- reach, or unowned. A lead already sitting with a correctly placed officer is left alone,
-- because churning somebody's book to make a number look tidier is not an improvement.
CREATE TEMP TABLE to_place AS
SELECT c.id,
       app.sales_hub_for_state(c.state)      AS hub,
       COALESCE(c.estimated_value_kobo, 0)   AS value_kobo
  FROM app.crm_contacts c
  LEFT JOIN app.o3c_users u ON u.id = c.sales_owner_id
 WHERE c.sales_entered_at IS NOT NULL
   AND c.lead_stage NOT IN ('converted', 'disqualified')
   AND app.sales_hub_for_state(c.state) IS NOT NULL
   AND (
     c.sales_owner_id IS NULL
     OR EXISTS (SELECT 1 FROM app.sales_teams t
                 WHERE t.head_user_id = c.sales_owner_id AND t.is_active)
     OR app.sales_hub_for_state(c.state)
        IS DISTINCT FROM app.sales_hub_for_office(u.office_location)
   );

-- Deal by levelling, not by round-robin.
--
-- Round-robin adds the same number to everybody and therefore PRESERVES whatever
-- imbalance it started from. Tried first, it produced Lagos on 47/46/46/32/31, because
-- three officers were already holding ~17 correctly-placed leads and two were holding 2
-- and 3. Adding 29 each to that is not an even distribution, it is the old gap with a
-- bigger number on top - and the same mechanic is what left an earlier run on 36/35/34
-- against two colleagues with 9.
--
-- So: build a ladder of SLOTS. Each officer contributes slots numbered from what they
-- already keep upwards - keeps, keeps+1, keeps+2 - and every slot in the hub is then
-- ordered by that fill level. The lightest officer owns the lowest slot, so the next lead
-- always goes to whoever is currently carrying least, which is water-filling and lands
-- everyone within one lead of each other. Biggest lead first, so value spreads as well as
-- volume. Deterministic on (fill level, officer id), so a replay deals the same way.
CREATE TEMP TABLE placed AS
WITH hub_demand AS (
    SELECT hub, COUNT(*) AS to_deal FROM to_place GROUP BY hub
),
slots AS (
    SELECT o.officer_id, o.hub, o.keeps + g AS fill_level
      FROM officer_slots o
      JOIN hub_demand d ON d.hub = o.hub
      CROSS JOIN LATERAL generate_series(0, d.to_deal) AS g
),
ranked_slots AS (
    SELECT officer_id, hub,
           ROW_NUMBER() OVER (PARTITION BY hub ORDER BY fill_level, officer_id) - 1 AS pos
      FROM slots
),
ranked_leads AS (
    SELECT id, hub,
           ROW_NUMBER() OVER (PARTITION BY hub ORDER BY value_kobo DESC, id) - 1 AS seq
      FROM to_place
)
SELECT l.id AS contact_id, s.officer_id
  FROM ranked_leads l
  JOIN ranked_slots s ON s.hub = l.hub AND s.pos = l.seq;

UPDATE app.crm_contacts c
   SET sales_owner_id = p.officer_id,
       updated_at     = NOW()
  FROM placed p
 WHERE c.id = p.contact_id
   AND c.sales_owner_id IS DISTINCT FROM p.officer_id;

INSERT INTO crm_lead_events (contact_id, event, to_owner, note, created_by)
SELECT p.contact_id, 'assigned', p.officer_id,
       'Reallocated to the officer whose office covers this lead', NULL
  FROM placed p;

-- ---------------------------------------------------------------------------
-- Guards. Every one of these is something this migration claims to have fixed,
-- re-measured rather than assumed.
-- ---------------------------------------------------------------------------
DO $m364$
DECLARE
    v_ledger     bigint;
    v_undeliv    bigint;
    v_on_heads   bigint;
    v_misrouted  bigint;
    v_idle       bigint;
    v_unroutable bigint;
    v_placed     bigint;
    r            record;
BEGIN
    SELECT COUNT(*) INTO v_placed FROM placed;

    SELECT COUNT(*) INTO v_ledger
      FROM call_center_lead_forwards f JOIN crm_contacts c ON c.id = f.contact_id
     WHERE c.lead_stage IN ('converted','disqualified') AND f.resolved_at IS NULL;

    SELECT COUNT(*) INTO v_undeliv
      FROM call_center_lead_forwards f JOIN crm_contacts c ON c.id = f.contact_id
     WHERE c.sales_entered_at IS NULL AND c.lead_stage NOT IN ('converted','disqualified');

    SELECT COUNT(*) INTO v_on_heads
      FROM crm_contacts c
     WHERE c.sales_entered_at IS NOT NULL AND c.lead_stage NOT IN ('converted','disqualified')
       AND EXISTS (SELECT 1 FROM app.sales_teams t
                    WHERE t.head_user_id = c.sales_owner_id AND t.is_active);

    SELECT COUNT(*) INTO v_misrouted
      FROM crm_contacts c JOIN app.o3c_users u ON u.id = c.sales_owner_id
     WHERE c.sales_entered_at IS NOT NULL AND c.lead_stage NOT IN ('converted','disqualified')
       AND app.sales_hub_for_state(c.state) IS NOT NULL
       AND app.sales_hub_for_state(c.state)
           IS DISTINCT FROM app.sales_hub_for_office(u.office_location);

    SELECT COUNT(*) INTO v_idle FROM officer_slots o
     WHERE NOT EXISTS (SELECT 1 FROM crm_contacts c
                        WHERE c.sales_owner_id = o.officer_id
                          AND c.lead_stage NOT IN ('converted','disqualified'));

    SELECT COUNT(*) INTO v_unroutable
      FROM crm_contacts c
     WHERE c.sales_entered_at IS NOT NULL AND c.lead_stage NOT IN ('converted','disqualified')
       AND app.sales_hub_for_state(c.state) IS NULL;

    RAISE NOTICE 'reallocated % leads', v_placed;
    FOR r IN
        SELECT o.hub AS hub, u.full_name AS who,
               (SELECT COUNT(*) FROM crm_contacts c
                 WHERE c.sales_owner_id = o.officer_id
                   AND c.lead_stage NOT IN ('converted','disqualified')) AS holds
          FROM officer_slots o JOIN app.o3c_users u ON u.id = o.officer_id
         ORDER BY o.hub, 3 DESC
    LOOP
        RAISE NOTICE '  % | % | %', r.hub, r.who, r.holds;
    END LOOP;
    RAISE NOTICE '% open leads have no routable state and were left where they are',
        v_unroutable;

    IF v_ledger > 0 THEN
        RAISE EXCEPTION 'still % finished leads whose hand-off reads open', v_ledger;
    END IF;
    IF v_undeliv > 0 THEN
        RAISE EXCEPTION 'still % live hand-offs that never reached Sales', v_undeliv;
    END IF;
    IF v_on_heads > 0 THEN
        RAISE EXCEPTION 'still % open leads parked on a team head', v_on_heads;
    END IF;
    IF v_misrouted > 0 THEN
        RAISE EXCEPTION 'still % leads owned by someone whose office cannot reach them',
            v_misrouted;
    END IF;
    IF v_idle > 0 THEN
        RAISE EXCEPTION '% officers on an active team still hold no leads at all', v_idle;
    END IF;
END $m364$;

COMMIT;
