-- FLEET — the vehicle register, and the link that makes spend free.
--
-- O3 runs company vehicles and wants fuel, distance, maintenance and total cost
-- per vehicle. The spend half of that is ALREADY CAPTURED and nobody was reading
-- it: the fuel cards are O3-issued, so every purchase lands in app.ccs_transactions
-- dated, priced and merchant-verified. 22 such cards exist, named explicitly
-- (O3C FUEL CARD 2..11, ABUJA FUEL CARD 1..2, O3 CARD FUEL 5, CAR MAINTENANCE 1,
-- ZONE PETROLEUM); four are live and carried ₦13.5m through 2025.
--
-- So this migration adds no spend capture at all. It adds the REGISTER — what
-- vehicles exist, which card belongs to which — plus the two things the card feed
-- cannot know: how far the vehicle went, and what was done to it.
--
-- WHY THE CARD LINK KEYS ON CIF. ccs_transactions identifies a card by cif, and the
-- PAN it carries is masked. CIF is a cards-system identity and nothing else — it is
-- NOT a customer party_id and must never be joined to one. Here that is exactly
-- what we want: the CIF names the card, the card names the vehicle.
--
-- WHY SCOPE IS DEFINED BY CARD AND NOT BY MERCHANT. Classifying fuel from
-- merchant_name does not work in this market. The string is frequently the payment
-- processor, not the filling station — the largest merchants on these very cards are
-- OPAY DIGITAL SERVICES, PAYCOM NIGERIA, PALMPAY and ZEST PAYMENTS, any of which is
-- what a petrol station's POS terminal reports. A dedicated card's whole spend is
-- fleet spend whatever the merchant text says, so the register defines scope and the
-- merchant mix is reported rather than trusted.

/* ── The register ───────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_vehicles (
  id                    bigserial PRIMARY KEY,
  -- The registration number is the business key: it is what people say out loud,
  -- what appears on a mechanic's invoice, and what a fine quotes.
  reg_no                text        NOT NULL,
  make                  text,
  model                 text,
  model_year            int,
  vin                   text,
  engine_no             text,
  colour                text,
  acquired_on           date,
  acquisition_cost_kobo bigint      NOT NULL DEFAULT 0,
  disposed_on           date,
  disposal_proceeds_kobo bigint     NOT NULL DEFAULT 0,
  status                text        NOT NULL DEFAULT 'active',
  department_id         int         REFERENCES app.departments(id) ON DELETE SET NULL,
  -- The custodian. A staff driver links to a user so the vehicle appears on their
  -- record; a contract driver is a name only, because inventing a user account for
  -- somebody who cannot sign in makes the staff list a lie.
  assigned_to           bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  assigned_driver_name  text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_vehicles_status_check
    CHECK (status IN ('active','workshop','disposed','stolen','reserve'))
);

-- Registration numbers are unique among vehicles still on the books. A disposed
-- vehicle keeps its row for history, and a plate legitimately reissued years later
-- must not collide with it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_vehicles_reg_active
  ON app.fleet_vehicles (upper(btrim(reg_no)))
  WHERE status <> 'disposed';

CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_status ON app.fleet_vehicles (status);
CREATE INDEX IF NOT EXISTS idx_fleet_vehicles_assigned ON app.fleet_vehicles (assigned_to)
  WHERE assigned_to IS NOT NULL;

/* ── The card link ──────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_cards (
  id          bigserial PRIMARY KEY,
  vehicle_id  bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  -- The CCS cards identity. This is the join to spend.
  cif         text        NOT NULL,
  -- name_on_card as it reads in the card book, so a human can recognise the row
  -- without looking the CIF up.
  card_label  text,
  -- Validity window. A card reassigned from one vehicle to another must not rewrite
  -- the first vehicle's history, so spend is attributed by the window the
  -- transaction falls in rather than by the card's current owner.
  valid_from  date        NOT NULL DEFAULT CURRENT_DATE,
  valid_to    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_cards_window_check CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- One live mapping per CIF. Without this a card assigned to two vehicles at once
-- double-counts its spend into both, and the fleet total silently exceeds what was
-- actually spent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fleet_cards_cif_open
  ON app.fleet_cards (cif) WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_fleet_cards_vehicle ON app.fleet_cards (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_fleet_cards_cif ON app.fleet_cards (cif);

/* ── Distance ───────────────────────────────────────────────────────────────── */

-- The only new human capture in the whole module, and deliberately one number.
--
-- There are no trackers and none are being bought, so distance comes from the
-- odometer. A reading taken at each refuel costs one field on a form that is
-- already being filled, and yields true kilometres between fills — which is what
-- makes ₦/km a measured figure rather than an estimate.
--
-- litres is captured here too because CCS records naira and not volume. Without it
-- a price rise and a developing fault look identical, which is most of the value.
--
-- CONSUMPTION ASSUMES A FULL TANK, and the figure is void without it. The tank-to-
-- tank method works because the litres added at one fill are exactly what the
-- vehicle burned getting there from the last fill — so litres at reading N over the
-- distance from N-1 to N is true consumption ONLY if the tank was filled to full
-- both times. A part-fill makes that arithmetic meaningless rather than merely
-- imprecise, so the capture form must ask whether the tank was filled, and any
-- consumption figure derived from a part-fill has to be withheld instead of shown.
CREATE TABLE IF NOT EXISTS app.fleet_odometer (
  id          bigserial PRIMARY KEY,
  vehicle_id  bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  reading_km  bigint      NOT NULL CHECK (reading_km >= 0),
  read_on     date        NOT NULL,
  litres      numeric(10,2) CHECK (litres IS NULL OR litres > 0),
  -- Whether the tank was filled to full. Load-bearing, not administrative: the
  -- tank-to-tank consumption figure is only valid between two full fills, so this
  -- is what decides whether a consumption number may be shown at all.
  filled_to_full boolean  NOT NULL DEFAULT true,
  source      text        NOT NULL DEFAULT 'refuel',
  -- The fuel transaction this reading was taken against, when it is known. Lets a
  -- fill be priced and measured in the same breath.
  ccs_txn_id  bigint,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_odometer_source_check
    CHECK (source IN ('refuel','service','manual','audit','handover'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_odo_vehicle_date
  ON app.fleet_odometer (vehicle_id, read_on DESC, reading_km DESC);

/* ── Maintenance ────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_maintenance (
  id           bigserial PRIMARY KEY,
  vehicle_id   bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  kind         text        NOT NULL,
  performed_on date        NOT NULL,
  vendor       text,
  cost_kobo    bigint      NOT NULL DEFAULT 0,
  odometer_km  bigint,
  -- Due either by date (insurance, licence) or by distance (service interval).
  -- Both are kept because a vehicle that sits idle is due by date and one in heavy
  -- use is due by kilometres, and a single field gets one of those wrong.
  next_due_on  date,
  next_due_km  bigint,
  description  text,
  invoice_ref  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_maintenance_kind_check
    CHECK (kind IN ('service','repair','tyres','battery','insurance','licence',
                    'roadworthiness','papers','towing','other'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_maint_vehicle ON app.fleet_maintenance (vehicle_id, performed_on DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_maint_due_on ON app.fleet_maintenance (next_due_on)
  WHERE next_due_on IS NOT NULL;

/* ── Incidents ──────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS app.fleet_incidents (
  id           bigserial PRIMARY KEY,
  vehicle_id   bigint      NOT NULL REFERENCES app.fleet_vehicles(id) ON DELETE CASCADE,
  occurred_on  date        NOT NULL,
  kind         text        NOT NULL,
  description  text,
  cost_kobo    bigint      NOT NULL DEFAULT 0,
  reported_by  bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
  resolved_on  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fleet_incidents_kind_check
    CHECK (kind IN ('accident','fine','theft','breakdown','vandalism','other'))
);

CREATE INDEX IF NOT EXISTS idx_fleet_incidents_vehicle
  ON app.fleet_incidents (vehicle_id, occurred_on DESC);

/* ── Spend, derived ─────────────────────────────────────────────────────────── */

-- Every card transaction attributed to the vehicle that held the card on that date.
--
-- This is the whole point of the module: no form, no claim, no receipt. The row
-- already existed in ccs_transactions; the register tells us whose it is. Debits
-- only — a credit on a fuel card is a top-up or a reversal, not consumption.
CREATE OR REPLACE VIEW app.fleet_spend AS
SELECT v.id            AS vehicle_id,
       v.reg_no,
       c.id            AS fleet_card_id,
       c.cif,
       c.card_label,
       t.id            AS ccs_txn_id,
       t.txn_date,
       t.amount_kobo,
       t.txn_code,
       t.merchant_name,
       t.description
FROM app.fleet_vehicles v
JOIN app.fleet_cards   c ON c.vehicle_id = v.id
JOIN app.ccs_transactions t
       ON t.cif = c.cif
      AND t.txn_date >= c.valid_from
      AND (c.valid_to IS NULL OR t.txn_date <= c.valid_to)
WHERE t.sign = 'DR';

-- Distance between consecutive readings, per vehicle.
--
-- Computed over the span between two KNOWN readings rather than assuming every
-- refuel carries one: a missed reading then widens the span instead of destroying
-- the figure. km_since is NULL on a vehicle's first reading, which is correct —
-- there is no prior point to measure from.
CREATE OR REPLACE VIEW app.fleet_distance AS
SELECT o.id,
       o.vehicle_id,
       o.read_on,
       o.reading_km,
       o.litres,
       o.source,
       o.filled_to_full,
       LAG(o.read_on)    OVER w AS prev_read_on,
       LAG(o.reading_km) OVER w AS prev_reading_km,
       o.reading_km - LAG(o.reading_km) OVER w AS km_since,
       (o.read_on - LAG(o.read_on) OVER w)     AS days_since,
       -- Consumption, or NULL when it cannot honestly be stated. Valid only
       -- between two full fills (see the note on fleet_odometer): a part-fill at
       -- either end makes the arithmetic meaningless, so it is withheld rather
       -- than shown with a caveat nobody reads.
       CASE
         WHEN o.filled_to_full
          AND LAG(o.filled_to_full) OVER w
          AND o.litres > 0
          AND o.reading_km - LAG(o.reading_km) OVER w > 0
         THEN ROUND(o.litres * 100.0 / (o.reading_km - LAG(o.reading_km) OVER w), 2)
       END AS litres_per_100km
FROM app.fleet_odometer o
WINDOW w AS (PARTITION BY o.vehicle_id ORDER BY o.read_on, o.reading_km);

COMMENT ON TABLE app.fleet_vehicles IS
  'Company vehicle register. reg_no is the business key; disposed rows are kept for history.';
COMMENT ON TABLE app.fleet_cards IS
  'Maps a CCS cards CIF to a vehicle for a validity window. This link is what turns existing card transactions into attributed fleet spend.';
COMMENT ON TABLE app.fleet_odometer IS
  'Odometer readings, normally taken at refuel. The only new capture in the module; litres is recorded here because CCS holds naira and not volume.';
COMMENT ON VIEW app.fleet_spend IS
  'Card debits attributed to the vehicle holding that card on the transaction date. Scope is defined by card, never by merchant_name, which is often the payment processor rather than the filling station.';
