-- ─────────────────────────────────────────────────────────────────────────────
-- Campaign → Call Centre → Sales pipeline: durable disposition, campaign lineage,
-- and a TRACKED hand-off so both agents and supervisors can follow a lead they
-- forwarded to Sales all the way to its outcome.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Durable disposition + campaign lineage on the call-centre lead.
--    last_disposition was previously derived from the latest call at read time, so
--    voiding/merging a call rewrote a lead's history. Store it. marketing_campaign_id
--    carries the ORIGIN marketing campaign (campaign_id points at call_center_campaigns,
--    a different table) so a lead is attributable back to the blast that produced it.
ALTER TABLE app.call_center_leads
  ADD COLUMN IF NOT EXISTS last_disposition      text,
  ADD COLUMN IF NOT EXISTS marketing_campaign_id bigint,
  ADD COLUMN IF NOT EXISTS source                text,
  ADD COLUMN IF NOT EXISTS forwarded_at          timestamptz;

-- Stop the "push twice → duplicate leads" bug: one lead per (calling campaign, phone).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_leads_campaign_phone
  ON app.call_center_leads (campaign_id, customer_phone)
  WHERE customer_phone IS NOT NULL AND customer_phone <> '';

-- 2. Attribution on the CRM contact — trace a WON customer back to campaign/lead.
ALTER TABLE app.crm_contacts
  ADD COLUMN IF NOT EXISTS source_campaign_id bigint,
  ADD COLUMN IF NOT EXISTS source_cc_lead_id  bigint;

-- 3. The tracked hand-off record. This is the durable "who forwarded what, when,
--    with what pitch" event; the live outcome is read from crm_contacts at query
--    time so the tracker is always accurate without coupling every sales action.
CREATE TABLE IF NOT EXISTS app.call_center_lead_forwards (
  id                    bigserial PRIMARY KEY,
  lead_id               bigint REFERENCES call_center_leads(id) ON DELETE SET NULL,
  contact_id            bigint REFERENCES crm_contacts(id) ON DELETE SET NULL,
  forwarded_by          bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  forwarded_by_name     text,
  customer_name         text,
  customer_phone        text,
  customer_cif          text,
  cc_campaign_id        bigint,
  marketing_campaign_id bigint,
  product_interest      text,
  notes                 text,
  status                text NOT NULL DEFAULT 'forwarded'
                        CHECK (status IN ('forwarded','accepted','assigned','converted','rejected','closed')),
  sales_owner_id        bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  sales_owner_name      text,
  outcome               text,
  forwarded_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cc_forwards_by      ON app.call_center_lead_forwards (forwarded_by, forwarded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cc_forwards_status  ON app.call_center_lead_forwards (status);
CREATE INDEX IF NOT EXISTS idx_cc_forwards_contact ON app.call_center_lead_forwards (contact_id);

-- One OPEN hand-off per lead (a lead can be re-forwarded once a prior one closes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_forward_open
  ON app.call_center_lead_forwards (lead_id)
  WHERE status IN ('forwarded','accepted','assigned');

-- Make sure 'call_centre' is a recognised CRM lead source (idempotent).
INSERT INTO app.crm_lead_sources (code, label, is_active, order_index)
VALUES ('call_centre', 'Call Centre', true, 55)
ON CONFLICT (code) DO NOTHING;
