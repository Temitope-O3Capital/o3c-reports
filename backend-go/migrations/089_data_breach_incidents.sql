-- R4: Data breach incident tracking with 72-hour NDPC notification countdown.

CREATE TABLE IF NOT EXISTS data_breach_incidents (
  id                  BIGSERIAL PRIMARY KEY,
  ref_no              TEXT NOT NULL UNIQUE DEFAULT 'BREACH-' || TO_CHAR(NOW(), 'YYYYMM') || '-' || LPAD(nextval('finding_ref_seq')::text, 4, '0'),
  title               TEXT NOT NULL,
  description         TEXT,
  discovered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- notify_deadline_at = discovered_at + 72h. Not a GENERATED column: (timestamptz
  -- + interval) is STABLE, not IMMUTABLE, so Postgres rejects it in a generation
  -- expression ("generation expression is not immutable"). Set via trigger below.
  notify_deadline_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  affected_records    INT,
  data_categories     TEXT[],          -- e.g. {'BVN','email','phone'}
  breach_type         TEXT NOT NULL DEFAULT 'unauthorized_access'
                        CHECK (breach_type IN ('unauthorized_access','data_loss','ransomware','insider_threat','phishing','other')),
  severity            TEXT NOT NULL DEFAULT 'medium'
                        CHECK (severity IN ('low','medium','high','critical')),
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','investigating','notified','remediated','closed')),
  ndpc_notified       BOOLEAN NOT NULL DEFAULT FALSE,
  ndpc_notified_at    TIMESTAMPTZ,
  ndpc_ref_number     TEXT,
  containment_steps   TEXT,
  remediation_steps   TEXT,
  reported_by         BIGINT REFERENCES o3c_users(id),
  assigned_to         BIGINT REFERENCES o3c_users(id),
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep notify_deadline_at = discovered_at + 72h (replaces the generated column).
CREATE OR REPLACE FUNCTION set_breach_notify_deadline() RETURNS trigger AS $$
BEGIN
  NEW.notify_deadline_at := NEW.discovered_at + INTERVAL '72 hours';
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_breach_notify_deadline ON data_breach_incidents;
CREATE TRIGGER trg_breach_notify_deadline
  BEFORE INSERT OR UPDATE OF discovered_at ON data_breach_incidents
  FOR EACH ROW EXECUTE FUNCTION set_breach_notify_deadline();

CREATE INDEX IF NOT EXISTS idx_breach_status ON data_breach_incidents(status);
CREATE INDEX IF NOT EXISTS idx_breach_discovered ON data_breach_incidents(discovered_at DESC);
