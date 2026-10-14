-- Leave, and the days someone was actually available.
--
-- WHY THIS EXISTS. The KPI framework measures adherence daily — was the activity log
-- submitted, was the forwarded lead picked up within four hours, was the contact recorded
-- the same day. Outcome measures are monthly and absorb a week's absence; adherence does
-- not. Without a leave record, somebody on two weeks' holiday fails every adherence
-- measure in a row and their scorecard reads as neglect. So leave is not a side feature
-- here: it is the DENOMINATOR. app.available_working_days() is the function the whole
-- framework hangs on, and everything else in this migration exists to make it true.
--
-- WHY THIS IS NOT THE OLD HR MODULE. A 19-table HR and payroll module existed and was
-- deliberately removed on 2026-08-05 (migration 121), after which a narrow HR role was
-- re-created on 2026-10-12 reading only the staff register. This follows that trajectory:
-- leave, plus the two employment facts leave needs, and nothing else. Specifically it
-- does NOT reintroduce an `employees` table — app.o3c_users is the staff register, and a
-- second one would be the same fact in two places, drifting.
--
-- THREE THINGS THE OLD DESIGN GOT WRONG, FIXED HERE.
--
--   1. It stored days_used on a balance row. A stored counter beside the requests that
--      produce it is two places holding one fact, and the first disagreement is silent.
--      Here ENTITLEMENT IS STORED (it is a decision somebody made) and CONSUMPTION IS
--      DERIVED from approved requests. There is no days_used column anywhere.
--
--   2. It counted leave in plain integer days, because the working-hours clock did not
--      exist yet. A week off consumed five days whether or not a public holiday fell
--      inside it. Here leave is consumed in WORKING days from app.business_calendar,
--      which already carries every Nigerian federal and Islamic holiday 2015-2040.
--      Nobody loses annual leave for a day the office was shut.
--
--   3. It had no notion of a person whose entitlement was never set, so a missing row
--      read as zero days remaining — indistinguishable from somebody who has used
--      everything. Here an absent entitlement yields no row at all, and
--      app.v_leave_entitlement_gaps names exactly who is missing one.
--
-- RETROACTIVE HOLIDAYS ARE SURFACED, NOT SILENTLY APPLIED. working_days is stamped when
-- the dates are set — the figure the person and their manager agreed. If a holiday is
-- declared later inside an already-approved period, app.v_leave_daycount_drift reports
-- the difference and HR decides whether to credit it back. Recomputing balances silently
-- would restate history, the same reason migration 355 left the SLA trigger alone.

BEGIN;

-- Everything in this file depends on app.business_calendar being populated. A missing or
-- thin calendar would not error — it would quietly make every leave day count zero, which
-- is the worst possible failure for a table that governs entitlement. So assert it loudly.
DO $$
DECLARE working_days INT;
BEGIN
  IF to_regclass('app.business_calendar') IS NULL THEN
    RAISE EXCEPTION '374 requires app.business_calendar (migration 357) and it is absent';
  END IF;
  SELECT COUNT(*) INTO working_days
    FROM app.business_calendar
   WHERE d >= date_trunc('year', CURRENT_DATE)::date
     AND d <  (date_trunc('year', CURRENT_DATE) + INTERVAL '1 year')::date
     AND open_minutes > 0;
  IF working_days < 200 THEN
    RAISE EXCEPTION '374: business calendar holds only % working days in the current year; leave counts would be wrong', working_days;
  END IF;
END $$;

-- ── Employment basics ────────────────────────────────────────────────────────
--
-- Two columns, both nullable, both earning their place:
--   hire_date       pro-rata entitlement for joiners, and the only honest basis for any
--                   tenure, ramp or attrition figure. created_at is ACCOUNT creation —
--                   every account was made within 92 days of the workspace launch, so a
--                   tenure computed from it is flatly false.
--   manager_user_id routes a leave request to the person who should approve it, and
--                   closes the gap that leaves nine departments with no supervisor
--                   relationship the database can answer.

ALTER TABLE app.o3c_users
  ADD COLUMN IF NOT EXISTS hire_date       DATE,
  ADD COLUMN IF NOT EXISTS manager_user_id BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN app.o3c_users.hire_date IS
  'Employment start date. NULL means unknown — never substitute created_at, which is account creation.';
COMMENT ON COLUMN app.o3c_users.manager_user_id IS
  'Line manager, for leave approval and supervisor reporting. NULL means unassigned.';

-- Both columns are new, so no existing row can violate this and it validates immediately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'o3c_users_manager_not_self') THEN
    ALTER TABLE app.o3c_users
      ADD CONSTRAINT o3c_users_manager_not_self
      CHECK (manager_user_id IS NULL OR manager_user_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS o3c_users_manager_idx ON app.o3c_users (manager_user_id);

-- A reporting cycle makes every recursive query over the org chart hang, and it is always
-- a data-entry error rather than an intent. Checked only when the manager actually changes.
CREATE OR REPLACE FUNCTION app.o3c_users_no_manager_cycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  walker BIGINT := NEW.manager_user_id;
  hops   INT    := 0;
BEGIN
  WHILE walker IS NOT NULL AND hops < 32 LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'manager chain for user % would form a cycle', NEW.id;
    END IF;
    SELECT manager_user_id INTO walker FROM app.o3c_users WHERE id = walker;
    hops := hops + 1;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS o3c_users_manager_cycle_guard ON app.o3c_users;
CREATE TRIGGER o3c_users_manager_cycle_guard
  BEFORE UPDATE OF manager_user_id ON app.o3c_users
  FOR EACH ROW WHEN (NEW.manager_user_id IS NOT NULL)
  EXECUTE FUNCTION app.o3c_users_no_manager_cycle();

-- ── Leave types ──────────────────────────────────────────────────────────────
--
-- Seeded with the set the business already agreed once, before the old module was
-- removed. days_per_year is the standard full-year entitlement; what a particular person
-- actually has lives in app.leave_entitlements, because a standard is not a promise to an
-- individual.

CREATE TABLE IF NOT EXISTS app.leave_types (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    days_per_year  NUMERIC(5,1) NOT NULL CHECK (days_per_year >= 0),
    is_paid        BOOLEAN NOT NULL DEFAULT TRUE,
    requires_docs  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Minimum notice, so a late request is visible as such rather than silently accepted.
    -- Zero means it can be raised on the day, which is correct for sick and compassionate.
    min_notice_days INT NOT NULL DEFAULT 0 CHECK (min_notice_days >= 0),

    -- How many unused days may follow the person into next year. Carry-over is a policy
    -- choice, so it is a column rather than a rule buried in code.
    carry_over_max  NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (carry_over_max >= 0),

    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INT NOT NULL DEFAULT 100,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app.leave_types
    (name, days_per_year, is_paid, requires_docs, min_notice_days, carry_over_max, sort_order) VALUES
    ('Annual Leave',        20, TRUE,  FALSE,  7, 5, 10),
    ('Sick Leave',          14, TRUE,  TRUE,   0, 0, 20),
    ('Maternity Leave',     84, TRUE,  TRUE,  30, 0, 30),
    ('Paternity Leave',     14, TRUE,  FALSE, 14, 0, 40),
    ('Compassionate Leave',  5, TRUE,  FALSE,  0, 0, 50),
    ('Study Leave',         14, FALSE, TRUE,  30, 0, 60),
    ('Unpaid Leave',        30, FALSE, FALSE, 14, 0, 70)
ON CONFLICT (name) DO NOTHING;

-- ── Entitlement ──────────────────────────────────────────────────────────────
--
-- One row per person per type per year. Stored, because it is a decision somebody made,
-- including any individual variation from the standard. Consumption never lives here.

CREATE TABLE IF NOT EXISTS app.leave_entitlements (
    id                SERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES app.o3c_users(id) ON DELETE CASCADE,
    leave_type_id     INT    NOT NULL REFERENCES app.leave_types(id),
    year              INT    NOT NULL CHECK (year BETWEEN 2020 AND 2100),
    days_entitled     NUMERIC(5,1) NOT NULL CHECK (days_entitled >= 0),
    days_carried_over NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (days_carried_over >= 0),
    notes             TEXT,
    set_by            BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, leave_type_id, year)
);

CREATE INDEX IF NOT EXISTS leave_entitlements_user_year_idx
  ON app.leave_entitlements (user_id, year);

-- ── Requests ─────────────────────────────────────────────────────────────────
--
-- Two-step approval: the line manager decides, then HR confirms. Both decisions record
-- who and when, because an approval nobody can trace afterwards is how a dispute becomes
-- unresolvable.

CREATE TABLE IF NOT EXISTS app.leave_requests (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES app.o3c_users(id) ON DELETE CASCADE,
    leave_type_id INT    NOT NULL REFERENCES app.leave_types(id),

    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,

    -- Working days consumed, stamped from app.business_calendar when the dates are set.
    -- See the note on retroactive holidays at the top of this file.
    working_days  NUMERIC(4,1) NOT NULL DEFAULT 0,

    reason        TEXT,
    document_ref  TEXT,

    -- Who covers the work. Not required, but an operational fact worth having: it is also
    -- the answer to "whose queue should this person's accounts sit in while they are out".
    cover_user_id BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,

    status        TEXT NOT NULL DEFAULT 'pending_manager'
                  CHECK (status IN ('draft','pending_manager','pending_hr','approved','rejected','cancelled')),

    -- The manager this was routed to, captured at submission. Stored rather than looked up
    -- later, because a person's manager changes and the approval trail must not.
    routed_to_manager  BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,

    manager_decided_by BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    manager_decided_at TIMESTAMPTZ,
    manager_note       TEXT,

    hr_decided_by      BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    hr_decided_at      TIMESTAMPTZ,
    hr_note            TEXT,

    cancelled_by       BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    cancelled_at       TIMESTAMPTZ,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT leave_requests_dates_make_sense CHECK (end_date >= start_date),
    CONSTRAINT leave_requests_no_self_cover    CHECK (cover_user_id IS NULL OR cover_user_id <> user_id)
);

CREATE INDEX IF NOT EXISTS leave_requests_user_idx    ON app.leave_requests (user_id, start_date DESC);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx  ON app.leave_requests (status, start_date);
CREATE INDEX IF NOT EXISTS leave_requests_manager_idx ON app.leave_requests (routed_to_manager, status);
CREATE INDEX IF NOT EXISTS leave_requests_period_idx  ON app.leave_requests (start_date, end_date);

-- ── The working-day count ────────────────────────────────────────────────────
--
-- Returns 0 rather than NULL on nonsense input, matching app.business_minutes. A day is a
-- working day when the business calendar has it open, which already accounts for weekends,
-- federal holidays and the Islamic dates seeded by migration 367.

CREATE OR REPLACE FUNCTION app.leave_working_days(p_from DATE, p_to DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN 0
    ELSE COALESCE((SELECT COUNT(*)::numeric
                     FROM app.business_calendar bc
                    WHERE bc.d BETWEEN p_from AND p_to
                      AND bc.open_minutes > 0), 0)
  END;
$$;

COMMENT ON FUNCTION app.leave_working_days(DATE, DATE) IS
  'Working days between two dates inclusive, per app.business_calendar. Weekends and public holidays excluded.';

CREATE OR REPLACE FUNCTION app.leave_set_working_days() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.working_days := app.leave_working_days(NEW.start_date, NEW.end_date);
  IF NEW.working_days = 0 THEN
    RAISE EXCEPTION 'leave period % to % contains no working days', NEW.start_date, NEW.end_date;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leave_requests_working_days ON app.leave_requests;
CREATE TRIGGER leave_requests_working_days
  BEFORE INSERT OR UPDATE OF start_date, end_date ON app.leave_requests
  FOR EACH ROW EXECUTE FUNCTION app.leave_set_working_days();

-- One person cannot be on two leaves at once. Enforced by trigger rather than an EXCLUDE
-- constraint because that needs btree_gist, and CREATE EXTENSION inside a migration applied
-- at boot fails the entire startup if the database user lacks the privilege.
CREATE OR REPLACE FUNCTION app.leave_no_overlap() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('pending_manager','pending_hr','approved') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM app.leave_requests r
              WHERE r.user_id = NEW.user_id
                AND r.id IS DISTINCT FROM NEW.id
                AND r.status IN ('pending_manager','pending_hr','approved')
                AND r.start_date <= NEW.end_date
                AND r.end_date   >= NEW.start_date) THEN
    RAISE EXCEPTION 'leave for user % overlaps an existing active request (% to %)',
      NEW.user_id, NEW.start_date, NEW.end_date;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leave_requests_no_overlap ON app.leave_requests;
CREATE TRIGGER leave_requests_no_overlap
  BEFORE INSERT OR UPDATE ON app.leave_requests
  FOR EACH ROW EXECUTE FUNCTION app.leave_no_overlap();

-- ── What the KPI framework actually calls ────────────────────────────────────

CREATE OR REPLACE FUNCTION app.on_leave(p_user_id BIGINT, p_date DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app.leave_requests r
                  WHERE r.user_id = p_user_id
                    AND r.status  = 'approved'
                    AND p_date BETWEEN r.start_date AND r.end_date);
$$;

-- Approved leave working-days falling inside a window, CLIPPED to that window — a request
-- spanning a month end must only count the part inside the month, which is why this
-- recomputes from the dates rather than summing the stored working_days.
CREATE OR REPLACE FUNCTION app.leave_days_taken(p_user_id BIGINT, p_from DATE, p_to DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(app.leave_working_days(GREATEST(r.start_date, p_from),
                                             LEAST(r.end_date,   p_to))), 0)
    FROM app.leave_requests r
   WHERE r.user_id = p_user_id
     AND r.status  = 'approved'
     AND r.start_date <= p_to
     AND r.end_date   >= p_from;
$$;

-- THE DENOMINATOR. Every adherence measure divides by this, never by the raw working days
-- in the period. A person available four days out of twenty is judged on four.
CREATE OR REPLACE FUNCTION app.available_working_days(p_user_id BIGINT, p_from DATE, p_to DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT GREATEST(app.leave_working_days(p_from, p_to)
                  - app.leave_days_taken(p_user_id, p_from, p_to), 0);
$$;

COMMENT ON FUNCTION app.available_working_days(BIGINT, DATE, DATE) IS
  'Working days in the period minus approved leave. The denominator for every adherence KPI — never divide by raw working days.';

-- Pro-rata entitlement for a joiner. NULL when the hire date is unknown, deliberately: an
-- entitlement is a decision, and guessing one is worse than leaving it unset where
-- app.v_leave_entitlement_gaps will report it.
CREATE OR REPLACE FUNCTION app.leave_prorata_days(p_hire_date DATE, p_year INT, p_days_per_year NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_hire_date IS NULL THEN NULL
    WHEN EXTRACT(YEAR FROM p_hire_date)::int <  p_year THEN p_days_per_year
    WHEN EXTRACT(YEAR FROM p_hire_date)::int >  p_year THEN 0
    ELSE ROUND(p_days_per_year * (13 - EXTRACT(MONTH FROM p_hire_date)::numeric) / 12.0, 1)
  END;
$$;

-- ── Reporting ────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW app.v_leave_balance AS
SELECT e.user_id,
       u.full_name,
       u.role,
       e.year,
       t.id   AS leave_type_id,
       t.name AS leave_type,
       e.days_entitled,
       e.days_carried_over,
       COALESCE(tk.days, 0) AS days_taken,
       COALESCE(pd.days, 0) AS days_pending,
       e.days_entitled + e.days_carried_over - COALESCE(tk.days, 0) - COALESCE(pd.days, 0)
         AS days_remaining
  FROM app.leave_entitlements e
  JOIN app.o3c_users  u ON u.id = e.user_id
  JOIN app.leave_types t ON t.id = e.leave_type_id
  LEFT JOIN LATERAL (
        SELECT SUM(r.working_days) AS days
          FROM app.leave_requests r
         WHERE r.user_id = e.user_id
           AND r.leave_type_id = e.leave_type_id
           AND r.status = 'approved'
           AND EXTRACT(YEAR FROM r.start_date)::int = e.year
  ) tk ON TRUE
  LEFT JOIN LATERAL (
        SELECT SUM(r.working_days) AS days
          FROM app.leave_requests r
         WHERE r.user_id = e.user_id
           AND r.leave_type_id = e.leave_type_id
           AND r.status IN ('pending_manager','pending_hr')
           AND EXTRACT(YEAR FROM r.start_date)::int = e.year
  ) pd ON TRUE;

COMMENT ON VIEW app.v_leave_balance IS
  'Entitlement minus approved and pending leave, per person per type per year. Somebody with no entitlement row does not appear — see app.v_leave_entitlement_gaps.';

-- Who has no entitlement set. The same coverage discipline the KPI framework uses: an
-- absent row must be named, not rendered as zero.
CREATE OR REPLACE VIEW app.v_leave_entitlement_gaps AS
SELECT u.id AS user_id, u.full_name, u.role, u.department, u.hire_date,
       EXTRACT(YEAR FROM CURRENT_DATE)::int AS year,
       t.id AS leave_type_id, t.name AS leave_type,
       app.leave_prorata_days(u.hire_date, EXTRACT(YEAR FROM CURRENT_DATE)::int, t.days_per_year)
         AS suggested_days
  FROM app.o3c_users u
 CROSS JOIN app.leave_types t
 WHERE u.is_active AND u.deleted_at IS NULL
   AND t.is_active
   AND NOT EXISTS (SELECT 1 FROM app.leave_entitlements e
                    WHERE e.user_id = u.id
                      AND e.leave_type_id = t.id
                      AND e.year = EXTRACT(YEAR FROM CURRENT_DATE)::int);

-- Approved periods whose agreed day count no longer matches the calendar, because a holiday
-- was declared afterwards. Reported rather than applied — crediting a day back restates a
-- balance, and that is HR's call.
CREATE OR REPLACE VIEW app.v_leave_daycount_drift AS
SELECT r.id AS leave_request_id, r.user_id, u.full_name,
       r.start_date, r.end_date,
       r.working_days AS days_agreed,
       app.leave_working_days(r.start_date, r.end_date) AS days_by_calendar_now,
       app.leave_working_days(r.start_date, r.end_date) - r.working_days AS difference
  FROM app.leave_requests r
  JOIN app.o3c_users u ON u.id = r.user_id
 WHERE r.status = 'approved'
   AND app.leave_working_days(r.start_date, r.end_date) <> r.working_days;

-- Who is off, and who is covering.
CREATE OR REPLACE VIEW app.v_leave_calendar AS
SELECT r.id AS leave_request_id,
       r.user_id, u.full_name, u.role, u.department,
       t.name AS leave_type,
       r.start_date, r.end_date, r.working_days, r.status,
       r.cover_user_id, c.full_name AS cover_name,
       r.routed_to_manager, m.full_name AS manager_name
  FROM app.leave_requests r
  JOIN app.o3c_users u ON u.id = r.user_id
  JOIN app.leave_types t ON t.id = r.leave_type_id
  LEFT JOIN app.o3c_users c ON c.id = r.cover_user_id
  LEFT JOIN app.o3c_users m ON m.id = r.routed_to_manager
 WHERE r.status IN ('pending_manager','pending_hr','approved');

COMMIT;
