-- 317: give every lead its state, every sales officer an office, and hand the pool to the
-- team heads who cover that state.
--
-- Three steps that only work in this order: a lead cannot be routed by state until it has
-- one, and a state cannot be routed to a team until the teams have locations.
--
-- ---------------------------------------------------------------------------
-- PART 1 — where the officers are
-- ---------------------------------------------------------------------------
--
-- 12 of the 14 people on a sales team had no office_location at all, which is why no
-- geographic routing was possible regardless of what the leads carried. Confirmed by the
-- business 29 Sept 2026: Team Jennifer and Team IK (Ojiako) are Lagos; Team Ozioma and Team
-- Ikechukwu Okoro are Abuja.
--
-- The two locations that WERE already set corroborate that rather than contradict it, which
-- is the only reason this is a backfill and not a guess: Jennifer Igwilo is already
-- 'Lagos (Head Quarter)', and Maminetu Isah — on Team Ozioma — is already 'Abuja'.
--
-- Vocabulary follows migration 215, which standardised offices to exactly two values.
-- Keyed on team NAME rather than the user ids observed today, so a replay elsewhere is
-- still correct. Heads are included: a head works and owns leads like anyone else.

WITH team_office(team_name, office) AS (
    VALUES ('Team Jennifer',        'Lagos (Head Quarter)'),
           ('Team IK',              'Lagos (Head Quarter)'),
           ('Team Ozioma',          'Abuja'),
           ('Team Ikechukwu Okoro', 'Abuja')
),
roster AS (
    SELECT m.user_id, tf.office
      FROM app.sales_teams t
      JOIN team_office tf ON tf.team_name = t.name
      JOIN app.sales_team_members m ON m.team_id = t.id
     WHERE t.is_active
    UNION
    SELECT t.head_user_id, tf.office
      FROM app.sales_teams t
      JOIN team_office tf ON tf.team_name = t.name
     WHERE t.is_active AND t.head_user_id IS NOT NULL
)
UPDATE app.o3c_users u
   SET office_location = r.office,
       updated_at      = NOW()
  FROM roster r
 WHERE u.id = r.user_id
   AND COALESCE(u.office_location, '') <> r.office;

-- ---------------------------------------------------------------------------
-- PART 2 — where the leads are
-- ---------------------------------------------------------------------------
--
-- city, state and address are blank on all 185 leads in Sales. The state was never missing
-- from the business, only from the lead: the CRC contact lists carry it on 100% of their
-- members, and nothing copied it across when a contact was forwarded to Sales.
--
-- Derived from the CAMPAIGN NAME rather than by matching phone numbers back into the lists,
-- on the business's instruction and because the campaign is the more reliable of the two.
-- The phone route agreed on 178 of 180 and disagreed on 2, where the same number sits in
-- both a Lagos and an FCT list — the campaign a lead was actually worked under is not
-- ambiguous in that way. It also reaches leads the phone match cannot.
--
-- 'Lagos' and 'FCT' are the upstream vocabulary (contact_list_members.state holds exactly
-- these two), so the lead now agrees with the list it came from. FCT is the state; Abuja is
-- the city within it, which is why the officers say 'Abuja' and the leads say 'FCT'.
--
-- A campaign naming neither is left NULL. "IK August List" (5 leads) names no location and
-- nothing in the data says which of the two Ikechukwus it belongs to — it was created by
-- Hadiza Imoniye with no forwarder recorded and nobody pre-assigned — so those 5 keep a
-- blank state and stay in the unclaimed pool for a head to take deliberately.

WITH lead_state AS (
    SELECT c.id,
           CASE WHEN COALESCE(mc.name, ccc.name) ILIKE '%lagos%' THEN 'Lagos'
                WHEN COALESCE(mc.name, ccc.name) ILIKE '%FCT%'   THEN 'FCT'
           END AS state
      FROM app.crm_contacts c
      LEFT JOIN app.campaigns mc ON mc.id = c.source_campaign_id
      LEFT JOIN LATERAL (
          SELECT cc.name
            FROM app.call_center_lead_forwards f
            JOIN app.call_center_campaigns cc ON cc.id = f.cc_campaign_id
           WHERE f.contact_id = c.id
           ORDER BY f.forwarded_at DESC
           LIMIT 1
      ) ccc ON TRUE
     WHERE c.sales_entered_at IS NOT NULL
)
UPDATE app.crm_contacts c
   SET state      = ls.state,
       updated_at = NOW()
  FROM lead_state ls
 WHERE c.id = ls.id
   AND ls.state IS NOT NULL
   AND COALESCE(NULLIF(btrim(c.state), ''), '') = '';

-- ---------------------------------------------------------------------------
-- PART 3 — who works the pool
-- ---------------------------------------------------------------------------
--
-- Every one of the 185 leads has sat unowned since they were forwarded, so the queue has
-- been correct and empty for every officer. Handed to the HEADS, per the business: a head
-- takes the state their team covers and allocates within their own team, which is a
-- decision about people that belongs to them and not to this migration.
--
-- Lagos -> Jennifer Igwilo and Ikechukwu Ojiako. FCT -> Ozioma Okpara and Ikechukwu Okoro.
-- Split evenly, alternating on lead id so the result is deterministic and a replay produces
-- the same allocation rather than reshuffling somebody's book.
--
-- ONLY UNOWNED LEADS ARE TOUCHED. Once an officer has claimed or been given a lead, this
-- must never move it: re-running would silently take work off whoever holds it.

WITH heads(state, head_name, slot) AS (
    VALUES ('Lagos', 'Team Jennifer',        0),
           ('Lagos', 'Team IK',              1),
           ('FCT',   'Team Ozioma',          0),
           ('FCT',   'Team Ikechukwu Okoro', 1)
),
head_ids AS (
    SELECT h.state, h.slot, t.head_user_id
      FROM heads h
      JOIN app.sales_teams t ON t.name = h.head_name AND t.is_active
     WHERE t.head_user_id IS NOT NULL
),
ranked AS (
    SELECT c.id,
           btrim(c.state) AS state,
           (ROW_NUMBER() OVER (PARTITION BY btrim(c.state) ORDER BY c.id) - 1) % 2 AS slot
      FROM app.crm_contacts c
     WHERE c.sales_entered_at IS NOT NULL
       AND c.sales_owner_id IS NULL
       AND btrim(COALESCE(c.state, '')) IN ('Lagos', 'FCT')
       AND c.lead_stage NOT IN ('converted', 'disqualified')
)
UPDATE app.crm_contacts c
   SET sales_owner_id = hi.head_user_id,
       updated_at     = NOW()
  FROM ranked r
  JOIN head_ids hi ON hi.state = r.state AND hi.slot = r.slot
 WHERE c.id = r.id;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m317$
DECLARE
    v_no_office   bigint;
    v_no_state    bigint;
    v_unowned     bigint;
    v_wrong_state bigint;
    r             record;
BEGIN
    -- Everyone on a team must now have an office, or routing is still impossible.
    SELECT count(*) INTO v_no_office
      FROM app.o3c_users u
     WHERE u.deleted_at IS NULL
       AND COALESCE(NULLIF(btrim(u.office_location), ''), '') = ''
       AND (EXISTS (SELECT 1 FROM app.sales_team_members m WHERE m.user_id = u.id)
         OR EXISTS (SELECT 1 FROM app.sales_teams t WHERE t.head_user_id = u.id AND t.is_active));
    IF v_no_office > 0 THEN
        RAISE EXCEPTION '317: % people on a sales team still have no office_location.', v_no_office;
    END IF;

    -- A lead must never be owned by a head whose team covers a different state. This is the
    -- check that would catch a mis-keyed team name in the VALUES lists above.
    SELECT count(*) INTO v_wrong_state
      FROM app.crm_contacts c
      JOIN app.sales_teams t ON t.head_user_id = c.sales_owner_id AND t.is_active
     WHERE c.sales_entered_at IS NOT NULL
       AND btrim(COALESCE(c.state, '')) IN ('Lagos', 'FCT')
       AND (
            (btrim(c.state) = 'Lagos' AND t.name NOT IN ('Team Jennifer', 'Team IK'))
         OR (btrim(c.state) = 'FCT'   AND t.name NOT IN ('Team Ozioma', 'Team Ikechukwu Okoro'))
       );
    IF v_wrong_state > 0 THEN
        RAISE EXCEPTION '317: % leads are owned by a head who does not cover their state.', v_wrong_state;
    END IF;

    -- Every OPEN lead that has a state must now have an owner. Restricted to open leads
    -- deliberately: 13 of the 185 are disqualified and DO carry a state — the state is a
    -- fact about the person, not about whether the lead is alive — but distribution skips
    -- them, because handing a head thirteen dead leads as work is not a hand-over. An
    -- earlier version of this guard compared every unowned lead against every state-less
    -- one and would have aborted the migration on that difference alone.
    SELECT count(*) INTO v_unowned
      FROM app.crm_contacts
     WHERE sales_entered_at IS NOT NULL
       AND sales_owner_id IS NULL
       AND lead_stage NOT IN ('converted', 'disqualified')
       AND btrim(COALESCE(state, '')) IN ('Lagos', 'FCT');
    IF v_unowned > 0 THEN
        RAISE EXCEPTION '317: % open leads have a state but no owner — every one should have '
                        'gone to a head.', v_unowned;
    END IF;

    SELECT count(*) INTO v_no_state
      FROM app.crm_contacts
     WHERE sales_entered_at IS NOT NULL AND COALESCE(NULLIF(btrim(state), ''), '') = '';

    RAISE NOTICE '317: leads now carry a state; % remain without one and stay in the pool.', v_no_state;
    FOR r IN
        SELECT u.full_name, btrim(c.state) AS state, count(*) AS leads
          FROM app.crm_contacts c
          JOIN app.o3c_users u ON u.id = c.sales_owner_id
         WHERE c.sales_entered_at IS NOT NULL
         GROUP BY 1, 2 ORDER BY 2, 1
    LOOP
        RAISE NOTICE '317:   % (%) -> % leads', r.full_name, r.state, r.leads;
    END LOOP;
END
$m317$;
