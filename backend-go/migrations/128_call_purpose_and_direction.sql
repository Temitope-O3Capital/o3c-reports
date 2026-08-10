-- 128: Call/lead PURPOSE taxonomy + consistent DIRECTION model.
-- Adds a shared purpose dimension (collections | marketing | support | retention | other)
-- across the call systems, a shared phone normalizer, cleans up helpdesk_calls.direction,
-- and backfills purpose for the ~100k historical calls + the outbound queue.
-- Fully idempotent (safe to re-run / apply out-of-band then record as applied).

-- ── Shared phone normalizer (last-10 digits) ───────────────────────────────
CREATE OR REPLACE FUNCTION app.norm_phone(p text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT right(regexp_replace(coalesce(p,''), '\D', '', 'g'), 10) $$;

-- ── purpose columns ────────────────────────────────────────────────────────
ALTER TABLE app.call_center_campaigns ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE app.call_center_contacts  ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE app.helpdesk_calls        ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE app.dialer_campaigns      ADD COLUMN IF NOT EXISTS purpose text;

-- ── purpose CHECK constraints (NULL allowed so existing insert paths keep
--    working until their handlers set purpose; values otherwise constrained) ─
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY['call_center_campaigns','call_center_contacts','helpdesk_calls','dialer_campaigns'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t||'_purpose_chk') THEN
      EXECUTE format(
        'ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (purpose IS NULL OR purpose IN
           (''collections'',''marketing'',''support'',''retention'',''other''))',
        t, t||'_purpose_chk');
    END IF;
  END LOOP;
END $$;

-- ── direction: normalize helpdesk_calls values, then constrain ─────────────
UPDATE app.helpdesk_calls
SET direction = CASE
  WHEN lower(trim(coalesce(direction,''))) IN ('inbound','incoming','in')  THEN 'inbound'
  WHEN lower(trim(coalesce(direction,''))) IN ('outbound','outgoing','out') THEN 'outbound'
  ELSE 'unknown'
END
WHERE direction IS DISTINCT FROM CASE
  WHEN lower(trim(coalesce(direction,''))) IN ('inbound','incoming','in')  THEN 'inbound'
  WHEN lower(trim(coalesce(direction,''))) IN ('outbound','outgoing','out') THEN 'outbound'
  ELSE 'unknown'
END;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'helpdesk_calls_direction_chk') THEN
    ALTER TABLE app.helpdesk_calls ADD CONSTRAINT helpdesk_calls_direction_chk
      CHECK (direction IS NULL OR direction IN ('inbound','outbound','unknown'));
  END IF;
END $$;

-- ── Backfill purpose for historical helpdesk_calls (heuristic) ──────────────
-- inbound            -> support        (customer reaching in)
-- outbound + is a customer (cif or phone) -> collections
-- outbound + matches a lead (phone)   -> marketing
-- otherwise                           -> marketing (outbound telesales)
-- (retention isn't derivable historically; it's a going-forward explicit tag.)
WITH cust_phone AS (
  SELECT DISTINCT app.norm_phone(phone) AS p FROM app.customers WHERE app.norm_phone(phone) <> ''
),
lead_phone AS (
  SELECT DISTINCT app.norm_phone(phone) AS p FROM app.crm_contacts WHERE app.norm_phone(phone) <> ''
)
UPDATE app.helpdesk_calls h
SET purpose = CASE
  WHEN lower(coalesce(h.direction,'')) = 'inbound' THEN 'support'
  WHEN (h.customer_cif IS NOT NULL AND h.customer_cif <> ''
        AND h.customer_cif IN (SELECT cif FROM app.customers))
    OR app.norm_phone(h.customer_phone) IN (SELECT p FROM cust_phone) THEN 'collections'
  WHEN app.norm_phone(h.customer_phone) IN (SELECT p FROM lead_phone) THEN 'marketing'
  ELSE 'marketing'
END
WHERE h.purpose IS NULL;

-- Outbound queue rows are Zoho marketing leads today.
UPDATE app.call_center_contacts SET purpose = 'marketing' WHERE purpose IS NULL;

-- ── Indexes (reporting + the phone crosswalk that comes next) ──────────────
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_purpose   ON app.helpdesk_calls (purpose);
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_direction ON app.helpdesk_calls (direction);
CREATE INDEX IF NOT EXISTS idx_customers_normphone      ON app.customers   (app.norm_phone(phone));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_normphone   ON app.crm_contacts (app.norm_phone(phone));
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_normphone ON app.helpdesk_calls (app.norm_phone(customer_phone));
