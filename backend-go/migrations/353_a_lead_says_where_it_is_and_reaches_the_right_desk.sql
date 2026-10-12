-- 353: a lead says where it is, and reaches the right desk.
--
-- Migration 317 gave the 185 leads already in Sales a state, derived from the campaign
-- they were worked under, and handed the pool to the heads who cover Lagos and FCT. It
-- was a one-off backfill of a book that had already arrived. This migration is the
-- standing machinery underneath it: a lead captures its own location at the moment it
-- becomes interesting, every Nigerian state knows which of the two offices covers it,
-- and an officer can plan the visit rather than only log it afterwards.
--
-- The numbers that make this worth doing, measured 2026-10-12:
--   • city  is blank on 36,499 of 36,499 crm_contacts — every lead in the system.
--   • state is blank on 36,319 of them; the 180 that carry one are almost exactly the
--     leads 317 touched, so outside Sales' own book the field has never been filled.
-- An officer in Abuja cannot plan a day around a lead whose city nobody wrote down,
-- which is the whole reason Sales asked for this.
--
-- VOCABULARY, and it is not interchangeable. A lead's state is 'FCT'; the officer who
-- covers it has office_location 'Abuja'. FCT is the state, Abuja is the city inside it
-- (317's PART 2 explains why the two books say different words). Everything here routes
-- through the two helper functions below rather than comparing the strings directly,
-- because every place that compared them by hand has had to be fixed at least once.

-- ---------------------------------------------------------------------------
-- PART 1 — the call centre can write down a city
-- ---------------------------------------------------------------------------
--
-- crm_contacts has carried state and city since 017b. call_center_leads — the book the
-- agents actually work — has state and address but no city, so an agent had nowhere to
-- put "Ikeja" even when the customer said it. That is the capture gap, not the display.

ALTER TABLE app.call_center_leads
    ADD COLUMN IF NOT EXISTS city TEXT;

COMMENT ON COLUMN app.call_center_leads.city IS
    'Lead city, captured by the agent. Required before a lead can be marked Interested '
    '(see the qualification guard in call_center_outbound.go): Sales plans visits off it.';

-- ---------------------------------------------------------------------------
-- PART 2 — which office covers which state
-- ---------------------------------------------------------------------------
--
-- The firm has exactly two offices, so every state resolves to one of them. The split is
-- the conventional north/south one: the nineteen northern states and the FCT are Abuja's,
-- the seventeen southern and western states are Lagos'.
--
-- A TABLE rather than a CASE expression in code, for two reasons. The business can move a
-- state between offices without a deploy, which they will want the first time an officer
-- relocates; and a state that is NOT in this table resolves to NULL rather than to a
-- default, which is what keeps a typo ('Lgos') out of somebody's book. A lead whose state
-- does not resolve stays in the unclaimed pool for a head to place deliberately — the same
-- treatment 317 gave the five leads whose campaign named no location.

CREATE TABLE IF NOT EXISTS app.lead_state_hub (
    state      TEXT PRIMARY KEY,
    hub        TEXT NOT NULL CHECK (hub IN ('Lagos', 'Abuja')),
    region     TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.lead_state_hub IS
    'State -> covering office (Lagos | Abuja). Editable by the business; a state that is '
    'absent deliberately resolves to NULL so the lead waits for a head rather than being '
    'routed to a default office.';

INSERT INTO app.lead_state_hub (state, hub, region) VALUES
    -- North-Central, and the FCT itself
    ('FCT',         'Abuja', 'North-Central'),
    ('Benue',       'Abuja', 'North-Central'),
    ('Kogi',        'Abuja', 'North-Central'),
    ('Kwara',       'Abuja', 'North-Central'),
    ('Nasarawa',    'Abuja', 'North-Central'),
    ('Niger',       'Abuja', 'North-Central'),
    ('Plateau',     'Abuja', 'North-Central'),
    -- North-East
    ('Adamawa',     'Abuja', 'North-East'),
    ('Bauchi',      'Abuja', 'North-East'),
    ('Borno',       'Abuja', 'North-East'),
    ('Gombe',       'Abuja', 'North-East'),
    ('Taraba',      'Abuja', 'North-East'),
    ('Yobe',        'Abuja', 'North-East'),
    -- North-West
    ('Jigawa',      'Abuja', 'North-West'),
    ('Kaduna',      'Abuja', 'North-West'),
    ('Kano',        'Abuja', 'North-West'),
    ('Katsina',     'Abuja', 'North-West'),
    ('Kebbi',       'Abuja', 'North-West'),
    ('Sokoto',      'Abuja', 'North-West'),
    ('Zamfara',     'Abuja', 'North-West'),
    -- South-East
    ('Abia',        'Lagos', 'South-East'),
    ('Anambra',     'Lagos', 'South-East'),
    ('Ebonyi',      'Lagos', 'South-East'),
    ('Enugu',       'Lagos', 'South-East'),
    ('Imo',         'Lagos', 'South-East'),
    -- South-South
    ('Akwa Ibom',   'Lagos', 'South-South'),
    ('Bayelsa',     'Lagos', 'South-South'),
    ('Cross River', 'Lagos', 'South-South'),
    ('Delta',       'Lagos', 'South-South'),
    ('Edo',         'Lagos', 'South-South'),
    ('Rivers',      'Lagos', 'South-South'),
    -- South-West
    ('Ekiti',       'Lagos', 'South-West'),
    ('Lagos',       'Lagos', 'South-West'),
    ('Ogun',        'Lagos', 'South-West'),
    ('Ondo',        'Lagos', 'South-West'),
    ('Osun',        'Lagos', 'South-West'),
    ('Oyo',         'Lagos', 'South-West')
ON CONFLICT (state) DO NOTHING;

-- sales_hub_for_state: the lead's state -> the covering office, or NULL.
--
-- Tolerates the spellings people actually type, because the field is free text in the
-- agent's hands: case and surrounding space are ignored, a trailing ' State' is dropped,
-- and 'Abuja' typed into a state box resolves to FCT (it is the city, but it is the
-- answer an agent gives when asked for the state, and refusing it would just send a
-- correct lead to the unclaimed pool).
CREATE OR REPLACE FUNCTION app.sales_hub_for_state(p_state TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    WITH norm AS (
        SELECT NULLIF(btrim(regexp_replace(COALESCE(p_state, ''), '\s+state$', '', 'i')), '') AS s
    ),
    canon AS (
        SELECT CASE
                   WHEN lower(s) IN ('abuja', 'fct', 'f.c.t.', 'f.c.t', 'federal capital territory')
                       THEN 'FCT'
                   ELSE s
               END AS s
          FROM norm
    )
    SELECT h.hub
      FROM canon c
      JOIN app.lead_state_hub h ON lower(h.state) = lower(c.s)
$$;

COMMENT ON FUNCTION app.sales_hub_for_state(TEXT) IS
    'Lead state -> covering office (Lagos | Abuja), NULL when the state is blank or '
    'unrecognised. Never guess a default: an unresolved lead belongs in the pool.';

-- sales_hub_for_office: the officer's office_location -> the same two-value vocabulary.
--
-- Migration 215 standardised office_location to two values, but one of them is
-- 'Lagos (Head Quarter)' — so a direct comparison against a lead's hub fails on the
-- parenthetical. Matching on the prefix keeps working if the suffix is ever reworded.
CREATE OR REPLACE FUNCTION app.sales_hub_for_office(p_office TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
               WHEN COALESCE(p_office, '') ILIKE 'lagos%' THEN 'Lagos'
               WHEN COALESCE(p_office, '') ILIKE 'abuja%' THEN 'Abuja'
               ELSE NULL
           END
$$;

COMMENT ON FUNCTION app.sales_hub_for_office(TEXT) IS
    'o3c_users.office_location -> hub (Lagos | Abuja), NULL when unset. An officer with '
    'no office takes part in no automatic distribution — deliberate, so a missing office '
    'is visible as an empty book rather than silently handing them another hub''s leads.';

-- Routing and the Leads filter both read state on leads that have reached Sales.
CREATE INDEX IF NOT EXISTS idx_crm_contacts_sales_state
    ON app.crm_contacts (btrim(state))
    WHERE sales_entered_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PART 3 — an officer can plan the week, not just report on it
-- ---------------------------------------------------------------------------
--
-- sales_activities does not exist; the officer's logged day lives in app.activities, which
-- is a record of what HAPPENED (migration 307 and the team calendar read it that way).
-- A plan is a different thing with a different clock, and writing intentions into that
-- table would make "what did Tuesday look like" unanswerable — a planned visit would be
-- indistinguishable from a made one.
--
-- So plans get their own table, and completing a plan writes an activity through the
-- normal logging path. The retrospective calendar keeps reading activities and stays
-- truthful; the new planning calendar reads plans. Nothing has to choose.
--
-- A plan points at a crm_contact (the lead and its sales pipeline are the same row — see
-- the architecture note in sales_leads.go), and optionally at the call_center_leads row it
-- was forwarded from, so "leads forwarded to them and the ones they inputed" are both
-- plannable without two tables.

CREATE TABLE IF NOT EXISTS app.sales_visit_plans (
    id           BIGSERIAL PRIMARY KEY,
    officer_id   BIGINT      NOT NULL REFERENCES app.o3c_users (id) ON DELETE CASCADE,
    contact_id   BIGINT      REFERENCES app.crm_contacts (id) ON DELETE CASCADE,
    lead_id      BIGINT,
    kind         TEXT        NOT NULL DEFAULT 'visit'
                             CHECK (kind IN ('visit', 'call', 'meeting', 'follow_up')),
    planned_for  DATE        NOT NULL,
    planned_at   TIMESTAMPTZ,
    address      TEXT,
    city         TEXT,
    state        TEXT,
    title        TEXT,
    notes        TEXT,
    status       TEXT        NOT NULL DEFAULT 'planned'
                             CHECK (status IN ('planned', 'done', 'missed', 'cancelled')),
    outcome      TEXT,
    activity_id  BIGINT,
    created_by   BIGINT      REFERENCES app.o3c_users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

COMMENT ON TABLE app.sales_visit_plans IS
    'Forward-looking sales plan: the visits, calls and follow-ups an officer intends. '
    'Separate from app.activities on purpose — that table records what happened, and a '
    'plan written into it would read as work done. Completing a plan writes an activity '
    'and stores its id in activity_id.';
COMMENT ON COLUMN app.sales_visit_plans.planned_at IS
    'Optional time of day. NULL means the officer planned the day but not the hour, which '
    'is how most field work is actually scheduled.';
COMMENT ON COLUMN app.sales_visit_plans.lead_id IS
    'The call_center_leads row this came from, when it was forwarded rather than entered '
    'by the officer. No FK: a lead row can be re-derived, and losing it must not delete a '
    'plan the officer still intends to keep.';

CREATE INDEX IF NOT EXISTS idx_sales_visit_plans_officer_day
    ON app.sales_visit_plans (officer_id, planned_for);
CREATE INDEX IF NOT EXISTS idx_sales_visit_plans_day
    ON app.sales_visit_plans (planned_for)
    WHERE status = 'planned';
CREATE INDEX IF NOT EXISTS idx_sales_visit_plans_contact
    ON app.sales_visit_plans (contact_id);

-- One officer cannot hold two live plans for the same contact on the same day. Re-planning
-- is an update, not a second row, and without this a double-click leaves two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_visit_plans_live
    ON app.sales_visit_plans (officer_id, contact_id, planned_for)
    WHERE contact_id IS NOT NULL AND status = 'planned';
