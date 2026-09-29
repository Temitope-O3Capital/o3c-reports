-- Rollback 317: return the pool, the lead states and the office locations.
--
-- Order matters: the ownership is undone FIRST, while the states that decided it are still
-- on the rows to identify what 317 assigned.
--
-- Only ownership 317 itself created is released — a lead owned by a team head who covers
-- that lead's state. Anything an officer has claimed or been given since, or any lead a head
-- has passed to one of their team, is left exactly where it is. That is the important
-- property: this must never take work off whoever is holding it now.

UPDATE app.crm_contacts c
   SET sales_owner_id = NULL,
       updated_at     = NOW()
  FROM app.sales_teams t
 WHERE t.head_user_id = c.sales_owner_id
   AND t.is_active
   AND c.sales_entered_at IS NOT NULL
   AND (
        (btrim(COALESCE(c.state, '')) = 'Lagos' AND t.name IN ('Team Jennifer', 'Team IK'))
     OR (btrim(COALESCE(c.state, '')) = 'FCT'   AND t.name IN ('Team Ozioma', 'Team Ikechukwu Okoro'))
   );

-- The states 317 derived from the campaign name. Cleared only where they still match what
-- the campaign says, so a state corrected by hand afterwards survives.
UPDATE app.crm_contacts c
   SET state      = NULL,
       updated_at = NOW()
  FROM (
      SELECT c2.id,
             CASE WHEN COALESCE(mc.name, ccc.name) ILIKE '%lagos%' THEN 'Lagos'
                  WHEN COALESCE(mc.name, ccc.name) ILIKE '%FCT%'   THEN 'FCT'
             END AS derived
        FROM app.crm_contacts c2
        LEFT JOIN app.campaigns mc ON mc.id = c2.source_campaign_id
        LEFT JOIN LATERAL (
            SELECT cc.name
              FROM app.call_center_lead_forwards f
              JOIN app.call_center_campaigns cc ON cc.id = f.cc_campaign_id
             WHERE f.contact_id = c2.id
             ORDER BY f.forwarded_at DESC
             LIMIT 1
        ) ccc ON TRUE
       WHERE c2.sales_entered_at IS NOT NULL
  ) d
 WHERE d.id = c.id
   AND d.derived IS NOT NULL
   AND btrim(COALESCE(c.state, '')) = d.derived;

-- Office locations. Cleared only for the people 317 set them on: the two that were already
-- correct before it ran — Jennifer Igwilo (Lagos HQ) and Maminetu Isah (Abuja) — are named
-- here so they are NOT cleared, because 317 did not set them.
UPDATE app.o3c_users u
   SET office_location = NULL,
       updated_at      = NOW()
 WHERE u.email NOT IN ('jigwilo@o3cards.com', 'maisah@o3cards.com')
   AND u.office_location IN ('Lagos (Head Quarter)', 'Abuja')
   AND (EXISTS (SELECT 1 FROM app.sales_team_members m WHERE m.user_id = u.id)
     OR EXISTS (SELECT 1 FROM app.sales_teams t WHERE t.head_user_id = u.id AND t.is_active));
