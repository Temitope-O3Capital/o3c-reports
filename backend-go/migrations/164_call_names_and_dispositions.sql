-- 164_call_names_and_dispositions.sql
--
-- Two things agents asked for.
--
-- 1. NAMES. Zoho only sends a customer name when the number is one of ITS
--    contacts. For an outbound dial to a lead, or an inbound call from a customer
--    Zoho has never seen, it sends nothing — so 8,614 of the last 9,181 calls
--    arrived anonymous and an agent saw a bare phone number for a customer we are
--    already doing business with. We can name 711 of them from records we already
--    hold. Going forward resolveCallCustomerName() does this at import; this is
--    the backfill for what is already in the book.
--
--    Resolution order is by strength of claim: the customer master (a real,
--    booked customer), then the lead the number was dialled from, then the wider
--    CRM contact book. Only ever fills a blank — a name a human typed is never
--    overwritten.
--
-- 2. DISPOSITIONS. "Not Eligible" and "Not Ready" had nowhere to go, so agents
--    were forcing them into "Not Interested" — which closes the contact. Those
--    are different outcomes with different follow-ups: not eligible is a decline
--    on our side, not ready is a timing objection worth calling back.
--
-- Idempotent: safe to re-run.

-- ── Names ────────────────────────────────────────────────────────────────────

UPDATE app.helpdesk_calls h
   SET customer_name = v.name
  FROM (
    SELECT c.id,
           COALESCE(
             (SELECT NULLIF(TRIM(m.full_name), '') FROM app.customers m
               WHERE right(regexp_replace(COALESCE(m.phone,''),'\D','','g'),10) = c.ph LIMIT 1),
             (SELECT NULLIF(TRIM(d.customer_name), '') FROM app.call_center_leads d
               WHERE right(regexp_replace(COALESCE(d.customer_phone,''),'\D','','g'),10) = c.ph LIMIT 1),
             (SELECT NULLIF(TRIM(k.first_name || ' ' || COALESCE(k.last_name,'')), '')
                FROM app.crm_contacts k
               WHERE right(regexp_replace(COALESCE(k.phone,''),'\D','','g'),10) = c.ph LIMIT 1)
           ) AS name
      FROM (SELECT id, right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS ph
              FROM app.helpdesk_calls
             WHERE NULLIF(TRIM(customer_name), '') IS NULL) c
     WHERE c.ph <> ''
  ) v
 WHERE h.id = v.id AND v.name IS NOT NULL;

-- The CIF too, where the number belongs to a booked customer: it is what links a
-- call to Customer 360.
UPDATE app.helpdesk_calls h
   SET customer_cif = v.cif
  FROM (
    SELECT c.id,
           (SELECT NULLIF(TRIM(m.cif), '') FROM app.customers m
             WHERE right(regexp_replace(COALESCE(m.phone,''),'\D','','g'),10) = c.ph LIMIT 1) AS cif
      FROM (SELECT id, right(regexp_replace(COALESCE(customer_phone,''),'\D','','g'),10) AS ph
              FROM app.helpdesk_calls
             WHERE NULLIF(TRIM(customer_cif), '') IS NULL) c
     WHERE c.ph <> ''
  ) v
 WHERE h.id = v.id AND v.cif IS NOT NULL;

-- Phone lookups above scan three tables by normalised number; index them so the
-- backfill and the per-call resolution at import are both cheap.
CREATE INDEX IF NOT EXISTS idx_customers_phone10
  ON app.customers (right(regexp_replace(COALESCE(phone,''),'\D','','g'),10));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone10
  ON app.crm_contacts (right(regexp_replace(COALESCE(phone,''),'\D','','g'),10));

-- ── Dispositions ─────────────────────────────────────────────────────────────
--
-- The outbound queue validates against a canonical list in Go
-- (handlers/call_center_dispositions.go). These two are added there; recorded
-- here so the vocabulary has one written home.
--
--   not_eligible — the customer does not qualify (age, employer, exposure).
--                  Closes the contact: calling back will not change it.
--   not_ready    — interested but not now ("after salary", "next quarter").
--                  Stays in the queue for a later cycle.
--
-- Existing rows are untouched: an agent who filed "Not Interested" because there
-- was nothing better meant what they picked at the time, and rewriting their
-- dispositions after the fact would falsify the record.
