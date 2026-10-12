-- Fleet: who held the vehicle, and whether it was insured at the time.
--
-- Migration 352 stored the CURRENT driver on the vehicle row (assigned_to /
-- assigned_driver_name) and nothing else. That answers "who has it now" and loses
-- the only question that matters after the fact: when an accident or a fine is
-- reviewed six months later, who was driving? The answer had already been
-- overwritten by the next assignment.
--
-- Fuel cards solved exactly this with a date window, and this reuses that shape.
-- The difference is that the vehicle row stays the editing surface — a trigger keeps
-- the history, so there is no second form to remember and no way to reassign a
-- vehicle without the history recording it.
--
-- Insurance also gets a real record. It was being carried as a maintenance row of
-- kind 'insurance' with a next_due_on, which tracks a renewal date but cannot hold
-- an insurer, a policy number or a sum insured — so a claim could not be made from
-- what the register knew.

/* ── Driver assignments ─────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_assignments (
  id           bigserial PRIMARY KEY,
  vehicle_id   bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  -- A staff driver links to a user; a contract driver is a name only, for the same
  -- reason as on the vehicle row: inventing an account for somebody who cannot sign
  -- in makes the staff list a lie.
  assigned_to  bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  driver_name  text,
  valid_from   date        NOT NULL DEFAULT CURRENT_DATE,
  valid_to     date,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  -- A window with nobody in it is not a record of anything.
  CONSTRAINT fleet_assignments_someone CHECK (
    assigned_to IS NOT NULL
    OR NULLIF(btrim(COALESCE(driver_name, '')), '') IS NOT NULL),
  CONSTRAINT fleet_assignments_window CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_fleet_assign_vehicle
  ON app.fleet_assignments (vehicle_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_assign_person
  ON app.fleet_assignments (assigned_to) WHERE assigned_to IS NOT NULL;

-- At most one open window per vehicle: two people cannot both currently hold it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_assign_open
  ON app.fleet_assignments (vehicle_id) WHERE valid_to IS NULL;

-- Keeps the history in step with the vehicle row, so reassignment through the
-- ordinary edit form cannot bypass it.
--
-- Closing uses GREATEST(valid_from, CURRENT_DATE - 1) so a window never ends before
-- it began. The consequence is that reassigning twice in one day leaves two windows
-- overlapping on that day; "who held it on date D" therefore takes the LATEST window
-- containing D (see app.fleet_driver_on), which is deterministic rather than
-- arbitrary.
CREATE OR REPLACE FUNCTION app.fleet_sync_assignment() RETURNS trigger AS $$
DECLARE
  has_driver boolean;
BEGIN
  has_driver := NEW.assigned_to IS NOT NULL
             OR NULLIF(btrim(COALESCE(NEW.assigned_driver_name, '')), '') IS NOT NULL;

  -- An update that did not touch the assignment changes no history.
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to
     AND NEW.assigned_driver_name IS NOT DISTINCT FROM OLD.assigned_driver_name THEN
    RETURN NEW;
  END IF;

  UPDATE app.fleet_assignments
     SET valid_to = GREATEST(valid_from, CURRENT_DATE - 1)
   WHERE vehicle_id = NEW.id AND valid_to IS NULL;

  IF has_driver THEN
    INSERT INTO app.fleet_assignments
      (vehicle_id, assigned_to, driver_name, valid_from, created_by)
    VALUES (NEW.id, NEW.assigned_to,
            NULLIF(btrim(COALESCE(NEW.assigned_driver_name, '')), ''),
            CURRENT_DATE, NEW.created_by);
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fleet_sync_assignment_ins ON app.fleet_vehicles;
CREATE TRIGGER trg_fleet_sync_assignment_ins
  AFTER INSERT ON app.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION app.fleet_sync_assignment();

DROP TRIGGER IF EXISTS trg_fleet_sync_assignment_upd ON app.fleet_vehicles;
CREATE TRIGGER trg_fleet_sync_assignment_upd
  AFTER UPDATE OF assigned_to, assigned_driver_name ON app.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION app.fleet_sync_assignment();

-- Backfill: any vehicle already carrying a driver gets an open window from the day
-- it was acquired, or the day it was registered if that is unknown. The register is
-- expected to be empty when this runs, so this is for safety rather than effect.
INSERT INTO app.fleet_assignments (vehicle_id, assigned_to, driver_name, valid_from, note)
SELECT v.id, v.assigned_to,
       NULLIF(btrim(COALESCE(v.assigned_driver_name, '')), ''),
       COALESCE(v.acquired_on, v.created_at::date),
       'Backfilled from the vehicle row when assignment history was introduced'
  FROM app.fleet_vehicles v
 WHERE (v.assigned_to IS NOT NULL
        OR NULLIF(btrim(COALESCE(v.assigned_driver_name, '')), '') IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM app.fleet_assignments a
                    WHERE a.vehicle_id = v.id AND a.valid_to IS NULL);

-- Who held a given vehicle on a given date. Returns the latest window containing
-- the date, so a same-day handover resolves to the person who took it over.
CREATE OR REPLACE FUNCTION app.fleet_driver_on(p_vehicle_id bigint, p_on date)
RETURNS text AS $$
  SELECT COALESCE(u.full_name, a.driver_name)
    FROM app.fleet_assignments a
    LEFT JOIN app.o3c_users u ON u.id = a.assigned_to
   WHERE a.vehicle_id = p_vehicle_id
     AND a.valid_from <= p_on
     AND (a.valid_to IS NULL OR a.valid_to >= p_on)
   ORDER BY a.valid_from DESC, a.id DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE;

/* ── Insurance ──────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_insurance (
  id               bigserial PRIMARY KEY,
  vehicle_id       bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  insurer          text        NOT NULL,
  policy_no        text,
  cover_type       text        NOT NULL DEFAULT 'comprehensive',
  -- What the insurer would pay, and what the cover cost. Both in kobo, like every
  -- other money column in this module.
  sum_insured_kobo bigint      NOT NULL DEFAULT 0,
  premium_kobo     bigint      NOT NULL DEFAULT 0,
  cover_from       date        NOT NULL,
  cover_to         date        NOT NULL,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_insurance_window CHECK (cover_to >= cover_from),
  CONSTRAINT fleet_insurance_cover_type_check
    CHECK (cover_type IN ('comprehensive', 'third_party', 'third_party_fire_theft'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_ins_vehicle
  ON app.fleet_insurance (vehicle_id, cover_to DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_ins_expiry
  ON app.fleet_insurance (cover_to);

-- Cover status per vehicle, for the whole register in one read.
--
-- A vehicle with no policy row is reported as 'unknown', NOT as 'uninsured'. The
-- register not knowing about a policy is not evidence that none exists, and telling
-- a COO a car is uninsured when the certificate is simply in a drawer would be a
-- confident wrong answer.
CREATE OR REPLACE VIEW app.fleet_cover_status AS
SELECT v.id AS vehicle_id,
       v.reg_no,
       v.status AS vehicle_status,
       p.id AS policy_id,
       p.insurer,
       p.policy_no,
       p.cover_type,
       p.sum_insured_kobo,
       p.premium_kobo,
       p.cover_from,
       p.cover_to,
       CASE
         WHEN p.id IS NULL                     THEN 'unknown'
         WHEN p.cover_to < CURRENT_DATE        THEN 'expired'
         WHEN p.cover_to <= CURRENT_DATE + 30  THEN 'expiring'
         ELSE 'covered'
       END AS cover_state,
       CASE WHEN p.id IS NULL THEN NULL ELSE (p.cover_to - CURRENT_DATE) END AS days_to_expiry
  FROM app.fleet_vehicles v
  LEFT JOIN LATERAL (
       -- The policy that matters is the one covering today; failing that, the most
       -- recent one, so an expired certificate still reports who the insurer was.
       SELECT i.*
         FROM app.fleet_insurance i
        WHERE i.vehicle_id = v.id
        ORDER BY (i.cover_from <= CURRENT_DATE AND i.cover_to >= CURRENT_DATE) DESC,
                 i.cover_to DESC
        LIMIT 1
  ) p ON true;

COMMENT ON TABLE app.fleet_assignments IS
  'Driver custody as date windows, kept in step with fleet_vehicles by trigger so an accident can be traced to whoever held the vehicle that day.';
COMMENT ON TABLE app.fleet_insurance IS
  'Motor policies: insurer, policy number, sum insured and cover window. The maintenance kind ''insurance'' remains the record of the PAYMENT; this is the record of the COVER.';
COMMENT ON VIEW app.fleet_cover_status IS
  'One row per vehicle with its current cover state. A vehicle with no policy row is ''unknown'', never ''uninsured''.';
COMMENT ON FUNCTION app.fleet_driver_on(bigint, date) IS
  'Who held the vehicle on a date. Latest window wins, so a same-day handover resolves to the person who took over.';
