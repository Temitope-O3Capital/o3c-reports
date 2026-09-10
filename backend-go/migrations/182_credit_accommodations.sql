-- Concessions & restructuring for credit accounts.
--
-- A concession waives or reduces what's owed (interest/penalty waiver, partial
-- settlement, payment holiday, rate cut); a restructure gives the facility new terms
-- (tenor, rate, installment, maturity). Both are proposed by whoever is working the
-- account (collections / recovery / risk) and require a head-level approval before
-- they take effect, so they live in one table with a request -> decide workflow.

CREATE TABLE IF NOT EXISTS app.credit_accommodations (
  id                   BIGSERIAL PRIMARY KEY,
  cif                  TEXT NOT NULL,
  account_ref          TEXT,                 -- optional loan/card reference the accommodation applies to
  kind                 TEXT NOT NULL CHECK (kind IN ('concession','restructure')),
  -- concession fields
  concession_type      TEXT,                 -- interest_waiver | penalty_waiver | partial_settlement | payment_holiday | rate_reduction | other
  amount_kobo          BIGINT,               -- waiver / settlement amount
  -- restructure fields
  new_tenor_months     INT,
  new_rate_bps         INT,
  new_installment_kobo BIGINT,
  new_maturity_date    DATE,
  -- workflow
  reason               TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by         BIGINT,
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by           BIGINT,
  decided_at           TIMESTAMPTZ,
  decision_note        TEXT,
  recovery_case_id     BIGINT,               -- optional link to the recovery case it was raised from
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_accommodations_cif    ON app.credit_accommodations(cif);
CREATE INDEX IF NOT EXISTS idx_credit_accommodations_status ON app.credit_accommodations(status);
CREATE INDEX IF NOT EXISTS idx_credit_accommodations_case   ON app.credit_accommodations(recovery_case_id);
