-- 378: staff unavailability becomes one fact that every queue can ask.
--
-- THE PROBLEM, MEASURED. A sales head in Lagos was unavailable and kept receiving
-- forwarded leads: 21 sat accepted-but-unworked on his name, averaging 3.4 days against
-- a four-hour pickup promise, and one arrived the same afternoon this was written.
-- Nothing was malfunctioning. There is simply no way to say a person is away, so there
-- is nothing for a queue to respect.
--
-- WHAT ALREADY EXISTS, AND WHY IT IS NOT ENOUGH.
--
--   app.on_leave(user, date)   migration 374. Correct, and consulted by nothing outside
--                              the leave module and the KPI denominators. 374's own
--                              header anticipated this exact use — "the answer to whose
--                              queue should this person's accounts sit in while they are
--                              out" — and nothing consumed it.
--                              It only knows APPROVED leave, so it cannot answer the
--                              common case: an emergency this morning, a day in the
--                              field, somebody seconded to another task. Nobody files a
--                              leave request for those, and they should not have to.
--
--   o3c_users.helpdesk_status  migration 157, 'available|on_call|break|offline'. This is
--                              SOFT-PHONE PRESENCE: it is flipped by logging into the
--                              call-centre console and back on logout, so a manager
--                              cannot set it meaningfully and the agent's next login
--                              overwrites whatever was set. It is also only ever written
--                              by the call-centre and helpdesk screens, so every sales,
--                              recon, LOS and compliance user sits at the 'offline'
--                              default for ever. Presence is not availability.
--
--   o3c_users.is_active        Account state. Setting it false ALSO kills every session
--                              (handlers/admin_suspend.go), so reusing it for "away
--                              today" would log the person out of the product. Not this.
--
-- So: a dated, reasoned, cancellable absence record, plus ONE predicate that folds it
-- together with approved leave and account state. One fact, asked one way, by every
-- queue — rather than each module inventing its own test, which is how the same fact
-- ends up living in two places and drifting.

BEGIN;

-- ── The ad-hoc absence record ───────────────────────────────────────────────
-- Deliberately NOT a column on o3c_users. An absence has a start, an end, a reason, a
-- person who recorded it and possibly a cover; a column holds one of those and loses
-- the history. It is also deliberately separate from app.leave_requests: leave is an
-- entitlement that is requested and approved, this is a statement of fact about today
-- that needs no approval. Conflating them would mean either approving an emergency or
-- letting anyone grant themselves leave.
CREATE TABLE IF NOT EXISTS app.staff_unavailability (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES app.o3c_users(id) ON DELETE CASCADE,
  from_date     DATE   NOT NULL,
  to_date       DATE   NOT NULL,

  -- Why they are away. Not free text alone: the kind is what lets a report say "three
  -- people are in the field" rather than reading twelve different sentences.
  kind          TEXT   NOT NULL,

  -- Shown to whoever is about to assign them work, so the warning is specific
  -- ("at the Ikeja branch all day") rather than a bare "unavailable".
  reason        TEXT,

  -- Who picks up time-critical work meanwhile. Optional, and never defaulted to a
  -- guess: an absent cover is better than a wrong one.
  cover_user_id BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,

  set_by        BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cancelled rather than deleted: "he was marked away on Tuesday and it was lifted at
  -- 10am" is a different fact from "he was never marked away", and the first one
  -- explains why a lead sat unclaimed for two hours.
  cancelled_at  TIMESTAMPTZ,
  cancelled_by  BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,

  CONSTRAINT staff_unavailability_dates_make_sense CHECK (to_date >= from_date),
  CONSTRAINT staff_unavailability_not_own_cover    CHECK (cover_user_id IS DISTINCT FROM user_id),
  CONSTRAINT staff_unavailability_kind_known       CHECK (kind IN
      ('emergency','sick','field_work','reassigned','training','personal','other'))
);

-- The hot path is "is this one person available today", asked once per candidate in a
-- dropdown and once per row in a round-robin, so it has to be an index hit.
CREATE INDEX IF NOT EXISTS idx_staff_unavail_user_window
  ON app.staff_unavailability (user_id, from_date, to_date)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_unavail_window
  ON app.staff_unavailability (from_date, to_date)
  WHERE cancelled_at IS NULL;

COMMENT ON TABLE app.staff_unavailability IS
  'Ad-hoc, dated absence that needs no approval: emergency, sick without a leave request, a day in the field, seconded elsewhere. Separate from app.leave_requests (an entitlement that is requested and approved) and from o3c_users.helpdesk_status (soft-phone presence). Ask app.is_unavailable() rather than reading this table directly - approved leave and account state belong in the same answer.';

-- ── The one predicate every queue asks ──────────────────────────────────────
-- Folds four separate reasons into one boolean so that a candidate query needs one
-- call and cannot accidentally check three of the four. Account state is included on
-- purpose even though most paths already filter is_active: one call should be
-- sufficient, and a path that only calls this is still correct.
--
-- APPROVED leave only, never pending. A pending request is a request; if a pending one
-- excluded somebody from work, anybody could take themselves out of the rota by filing
-- a request nobody has looked at. The ad-hoc table above is the honest route for
-- "I am genuinely away right now".
CREATE OR REPLACE FUNCTION app.is_unavailable(p_user_id BIGINT, p_date DATE DEFAULT CURRENT_DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT TRUE
      FROM app.o3c_users u
     WHERE u.id = p_user_id
       AND (u.deleted_at IS NOT NULL OR NOT u.is_active)
  ), FALSE)
  OR app.on_leave(p_user_id, p_date)
  OR EXISTS (
    SELECT 1 FROM app.staff_unavailability s
     WHERE s.user_id = p_user_id
       AND s.cancelled_at IS NULL
       AND p_date BETWEEN s.from_date AND s.to_date
  );
$$;

COMMENT ON FUNCTION app.is_unavailable(BIGINT, DATE) IS
  'TRUE when this person should not be given new work on this date: left or deactivated, on APPROVED leave (app.on_leave), or covered by an app.staff_unavailability row. Pending leave is deliberately NOT included. Use this in automatic distribution pools; use app.v_staff_availability where the screen needs to SAY why.';

-- ── The same answer, with its reason, for screens ───────────────────────────
-- A dropdown must not silently drop people: the decision taken on 2026-10-19 is that a
-- human may still assign to somebody who is away, deliberately and with the reason in
-- front of them, while AUTOMATIC distribution excludes them outright. Hiding them would
-- also mean a whole team being away leaves work with nowhere to go.
--
-- So this view exists to be JOINED, not filtered on: it returns every active person
-- with the reason they are unavailable, when they are back, and who covers.
CREATE OR REPLACE VIEW app.v_staff_availability AS
SELECT u.id                                           AS user_id,
       u.full_name,
       u.role,
       u.department,
       NOT app.is_unavailable(u.id, CURRENT_DATE)      AS available,
       -- Most severe reason first. A person on leave who is ALSO marked away in the
       -- field is reported as on leave: it is the longer and more formal absence.
       CASE
         WHEN u.deleted_at IS NOT NULL OR NOT u.is_active THEN 'no longer active'
         WHEN app.on_leave(u.id, CURRENT_DATE)            THEN 'on leave'
         WHEN ua.id IS NOT NULL                           THEN ua.kind
       END                                             AS unavailable_kind,
       CASE
         WHEN u.deleted_at IS NOT NULL OR NOT u.is_active THEN NULL
         WHEN app.on_leave(u.id, CURRENT_DATE)            THEN lv.end_date
         WHEN ua.id IS NOT NULL                           THEN ua.to_date
       END                                             AS unavailable_until,
       CASE
         WHEN app.on_leave(u.id, CURRENT_DATE) THEN lv.reason
         WHEN ua.id IS NOT NULL                THEN ua.reason
       END                                             AS unavailable_reason,
       -- Whoever is covering, from either source. This is what "route the clocked work
       -- to the cover" reads, and it is why leave_requests.cover_user_id was captured.
       COALESCE(
         CASE WHEN app.on_leave(u.id, CURRENT_DATE) THEN lv.cover_user_id END,
         ua.cover_user_id
       )                                               AS cover_user_id,
       cv.full_name                                    AS cover_name
  FROM app.o3c_users u
  -- The leave row in force today, if any.
  LEFT JOIN LATERAL (
      SELECT r.end_date, r.reason, r.cover_user_id
        FROM app.leave_requests r
       WHERE r.user_id = u.id
         AND r.status  = 'approved'
         AND CURRENT_DATE BETWEEN r.start_date AND r.end_date
       ORDER BY r.end_date DESC
       LIMIT 1
  ) lv ON TRUE
  -- The ad-hoc row in force today. Latest-ending wins, so two overlapping records
  -- (one set by the person, one by their head) report the longer absence rather than
  -- whichever happened to be inserted last.
  LEFT JOIN LATERAL (
      SELECT s.id, s.kind, s.to_date, s.reason, s.cover_user_id
        FROM app.staff_unavailability s
       WHERE s.user_id = u.id
         AND s.cancelled_at IS NULL
         AND CURRENT_DATE BETWEEN s.from_date AND s.to_date
       ORDER BY s.to_date DESC, s.id DESC
       LIMIT 1
  ) ua ON TRUE
  LEFT JOIN app.o3c_users cv
         ON cv.id = COALESCE(
              CASE WHEN app.on_leave(u.id, CURRENT_DATE) THEN lv.cover_user_id END,
              ua.cover_user_id)
 WHERE u.deleted_at IS NULL;

COMMENT ON VIEW app.v_staff_availability IS
  'One row per live member of staff: whether they can take new work today, the reason if not, when they are back, and who covers. Built to be JOINED by assignee dropdowns so a human sees the absence and can still override it deliberately; automatic distribution should use app.is_unavailable() and exclude instead.';

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $assert$
DECLARE
  n_rows   INT;
  n_avail  INT;
  n_users  INT;
  ok       BOOLEAN;
BEGIN
  -- The function must answer for somebody who is plainly fine, and for somebody who
  -- does not exist at all. The second case matters: app.available_working_days returns
  -- a full working-day count for an unknown id because it only subtracts that id's
  -- leave, and a predicate that said "available" for a non-existent user would let a
  -- bad id through every gate.
  SELECT app.is_unavailable(id, CURRENT_DATE) INTO ok
    FROM app.o3c_users WHERE is_active AND deleted_at IS NULL ORDER BY id LIMIT 1;
  IF ok IS NOT FALSE THEN
    RAISE EXCEPTION '378: an active member of staff with no leave reads as unavailable';
  END IF;

  IF app.is_unavailable(999999999, CURRENT_DATE) IS NULL THEN
    RAISE EXCEPTION '378: is_unavailable returned NULL for an unknown user id';
  END IF;

  -- The view must cover every live user, or a dropdown joining it would silently drop
  -- whoever it misses.
  SELECT COUNT(*) INTO n_rows  FROM app.v_staff_availability;
  SELECT COUNT(*) INTO n_users FROM app.o3c_users WHERE deleted_at IS NULL;
  IF n_rows <> n_users THEN
    RAISE EXCEPTION '378: view returns % rows for % live users', n_rows, n_users;
  END IF;

  -- With no leave and no unavailability recorded yet, every active person must read as
  -- available. If this fails the predicate is inverted, and inverting it would empty
  -- every queue in the platform at once.
  SELECT COUNT(*) INTO n_avail FROM app.v_staff_availability WHERE available;
  IF n_avail <> (SELECT COUNT(*) FROM app.o3c_users WHERE is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION '378: % of % active staff read as available before any absence exists',
      n_avail, (SELECT COUNT(*) FROM app.o3c_users WHERE is_active AND deleted_at IS NULL);
  END IF;

  -- A row must not be able to name the person as their own cover.
  BEGIN
    INSERT INTO app.staff_unavailability (user_id, from_date, to_date, kind, cover_user_id)
    SELECT id, CURRENT_DATE, CURRENT_DATE, 'other', id
      FROM app.o3c_users WHERE is_active ORDER BY id LIMIT 1;
    RAISE EXCEPTION '378: a person was accepted as their own cover';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;

  RAISE NOTICE '378 OK: % live staff, all available, predicate and view agree', n_users;
END $assert$;

COMMIT;
