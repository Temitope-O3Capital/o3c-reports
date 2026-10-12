-- Every lead an officer holds has a first action, a place, and a consistent ledger.
--
-- The three things left over from the audit in migration 364, now that the leads
-- themselves sit with the right people.
--
-- 1. THE FOLLOW-UP ALERT HAS NEVER ONCE FIRED. runFollowUpDueAlerts has run daily at
--    07:30 since it was built, selecting leads WHERE next_action_at <= CURRENT_DATE. Not
--    one of the 267 open leads has a next_action_at at all - the column is written only
--    when an officer sets a follow-up while logging an activity, and almost nothing has
--    been logged. So the alert is live code that can never match a row, and an officer
--    holding 42 leads is told about none of them.
--
--    A lead just handed to someone is owed a FIRST action, which is exactly what this
--    column means. Setting it both makes the alert work and is how the ten officers who
--    received 207 leads in migration 364 find out - in-app and by email, through the
--    app's own notification path rather than a one-off blast that honours nobody's
--    channel preferences.
--
--    SPREAD, NOT DUMPED. Eight per officer per working day, biggest first. Making all 42
--    due tomorrow would open Monday with "42 follow-ups due, 42 already late", which is a
--    number people learn to ignore. Weekends are skipped because a field visit on Sunday
--    is not a plan.
--
-- 2. THIRTY-ONE HAND-OFFS STILL READ AS NEVER DELIVERED. All 31 are already disqualified
--    and their ledger rows are closed, so nothing is pending - but sales_entered_at is
--    NULL, which means the audit question "was every forwarded lead delivered?" answers
--    no for ever and the real answer is hidden behind 31 rows of noise. Dated from the
--    forward, and safe precisely because they are disqualified: every queue, pool and
--    distribution excludes that stage, so this makes the history honest without putting a
--    dead lead in front of anybody.
--
-- 3. THE CITY, FOR THE FEW WHERE IT EXISTS. 264 open leads have no city and I said that
--    was unrecoverable. That was close but wrong: the core customer book carries city and
--    LGA, and a phone match recovers it for 6 of them. The other 258 were never captured
--    anywhere - only 4 of 20,587 rows in the lead book have ever had a city - and the
--    Interested guard added with migration 353 is what collects it from here on.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. A first action for every owned lead that has none.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE first_actions AS
WITH owed AS (
    SELECT c.id,
           c.sales_owner_id,
           ROW_NUMBER() OVER (PARTITION BY c.sales_owner_id
                              ORDER BY COALESCE(c.estimated_value_kobo, 0) DESC, c.id) - 1 AS rn
      FROM app.crm_contacts c
     WHERE c.sales_entered_at IS NOT NULL
       AND c.lead_stage NOT IN ('converted', 'disqualified')
       AND c.sales_owner_id IS NOT NULL
       AND c.next_action_at IS NULL
)
SELECT id,
       sales_owner_id,
       -- Eight a day, starting tomorrow. The weekend skip walks the date forward rather
       -- than doing calendar arithmetic, so it stays right however many weekends a long
       -- backlog spans.
       (SELECT d FROM (
           SELECT d FROM generate_series(CURRENT_DATE + 1, CURRENT_DATE + 400, INTERVAL '1 day') AS d
            WHERE EXTRACT(ISODOW FROM d) < 6
            ORDER BY d
            OFFSET (owed.rn / 8) LIMIT 1
        ) pick) AS due_on
  FROM owed;

UPDATE app.crm_contacts c
   SET next_action_at = f.due_on,
       updated_at     = NOW()
  FROM first_actions f
 WHERE c.id = f.id
   AND c.next_action_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Make the delivery history honest for the closed hand-offs.
-- ---------------------------------------------------------------------------
UPDATE app.crm_contacts c
   SET sales_entered_at = COALESCE(c.sales_entered_at, f.forwarded_at),
       sales_source     = COALESCE(c.sales_source, 'call_centre'),
       updated_at       = NOW()
  FROM call_center_lead_forwards f
 WHERE f.contact_id = c.id
   AND c.sales_entered_at IS NULL
   AND c.lead_stage IN ('converted', 'disqualified');

-- ---------------------------------------------------------------------------
-- 3. Recover the city where the customer book knows it.
-- ---------------------------------------------------------------------------
-- City first, then LGA: an LGA is not a city but it is a place a visit can be planned
-- around, which is the whole purpose of the field. Only ever fills a blank.
UPDATE app.crm_contacts c
   SET city       = src.found,
       updated_at = NOW()
  FROM (
    SELECT g.id,
           COALESCE(NULLIF(btrim(cu.city), ''), NULLIF(btrim(cu.lga), '')) AS found
      FROM app.crm_contacts g
      JOIN app.customers cu
        ON (length(app.norm_phone(cu.phone))   = 10 AND app.norm_phone(cu.phone)   = app.norm_phone(g.phone))
        OR (length(app.norm_phone(cu.phone_2)) = 10 AND app.norm_phone(cu.phone_2) = app.norm_phone(g.phone))
     WHERE g.sales_entered_at IS NOT NULL
       AND g.lead_stage NOT IN ('converted', 'disqualified')
       AND COALESCE(btrim(g.city), '') = ''
       AND COALESCE(NULLIF(btrim(cu.city), ''), NULLIF(btrim(cu.lga), '')) IS NOT NULL
  ) src
 WHERE c.id = src.id
   AND COALESCE(btrim(c.city), '') = '';

-- ---------------------------------------------------------------------------
-- What happened.
-- ---------------------------------------------------------------------------
DO $m365$
DECLARE
    v_actions   bigint;
    v_no_action bigint;
    v_undeliv   bigint;
    v_cities    bigint;
    r           record;
BEGIN
    SELECT COUNT(*) INTO v_actions FROM first_actions;

    SELECT COUNT(*) INTO v_no_action
      FROM app.crm_contacts
     WHERE sales_entered_at IS NOT NULL AND lead_stage NOT IN ('converted','disqualified')
       AND sales_owner_id IS NOT NULL AND next_action_at IS NULL;

    SELECT COUNT(*) INTO v_undeliv
      FROM call_center_lead_forwards f JOIN app.crm_contacts c ON c.id = f.contact_id
     WHERE c.sales_entered_at IS NULL;

    SELECT COUNT(*) INTO v_cities
      FROM app.crm_contacts
     WHERE sales_entered_at IS NOT NULL AND lead_stage NOT IN ('converted','disqualified')
       AND COALESCE(btrim(city), '') <> '';

    RAISE NOTICE 'first action set on % leads; % owned leads still have none', v_actions, v_no_action;
    RAISE NOTICE '% forwarded leads still read as never delivered', v_undeliv;
    RAISE NOTICE '% open leads now carry a city', v_cities;

    FOR r IN
        SELECT u.full_name AS who, COUNT(*) AS leads, MIN(f.due_on) AS starts, MAX(f.due_on) AS ends
          FROM first_actions f JOIN app.o3c_users u ON u.id = f.sales_owner_id
         GROUP BY 1 ORDER BY 2 DESC
    LOOP
        RAISE NOTICE '  % | % leads | first due % | last due %', r.who, r.leads, r.starts, r.ends;
    END LOOP;

    IF v_no_action > 0 THEN
        RAISE EXCEPTION '% owned leads have no first action, so their officer will never be alerted', v_no_action;
    END IF;
    IF v_undeliv > 0 THEN
        RAISE EXCEPTION '% forwarded leads still have no sales_entered_at', v_undeliv;
    END IF;
END $m365$;

COMMIT;
