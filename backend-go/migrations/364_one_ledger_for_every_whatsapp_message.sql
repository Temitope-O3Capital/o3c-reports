-- One ledger for every WhatsApp message, in both directions.
--
-- THE GAP THIS CLOSES, measured 2026-10-12. sendWhatsApp returns the WhatsApp message id
-- (the "wamid") that Meta assigns, and exactly one caller keeps it:
-- campaign_contacts.whatsapp_provider_id. The other routes throw it away —
-- handlers/notify.go discards it with `ok, _ :=` and handlers/helpdesk_care.go ignores the
-- return entirely. Since processWADeliveryStatus correlates status webhooks against
-- campaign_contacts and nothing else, the consequence is precise:
--
--   * a care agent's reply to a customer has NO delivered/read/failed state at all;
--   * a WhatsApp notification has none either;
--   * and 'read' is handled as a synonym for 'delivered', so a read receipt — the one
--     signal that tells a support team the customer actually saw the answer — is
--     discarded on every route including campaigns.
--
-- So there is no answer today to "did that reach them?", which is the first question a
-- care agent asks, and no basis for the per-message cost reporting that Meta's
-- October 2026 pricing makes necessary.
--
-- WHY A LEDGER AND NOT MORE COLUMNS ON helpdesk_messages. Inbound ticket messages are
-- already stored there and that stays: it is the conversation as the agent reads it.
-- This table is the TRANSPORT record — one row per message Meta accepted or rejected,
-- keyed on the wamid, carrying the delivery lifecycle and the cost category. The two
-- answer different questions and a message can exist in one without the other: a
-- campaign send has no ticket, and a ticket note has no wamid.
--
-- IT IS WRITTEN INSIDE THE SENDER, not at the call sites. That is the whole point of
-- putting it here: the two sites that lose the wamid today lost it by forgetting, and a
-- ledger that depends on every future caller remembering would be back in the same
-- position within a release.

BEGIN;

CREATE TABLE IF NOT EXISTS app.whatsapp_messages (
    id          BIGSERIAL PRIMARY KEY,

    -- Meta's message id. UNIQUE because status webhooks arrive repeatedly for one
    -- message (sent -> delivered -> read) and must update a row rather than add one.
    -- NULLABLE on purpose: a send Meta rejected never gets an id, and that failure is
    -- exactly what this table should record rather than drop.
    wamid       TEXT UNIQUE,

    direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),

    -- E.164. Kept on the row rather than only via party_id because most WhatsApp
    -- traffic is to a number we have not linked to a party yet — an ad click arrives as
    -- a phone number and nothing else.
    phone       TEXT NOT NULL,
    party_id    BIGINT REFERENCES app.parties(party_id)          ON DELETE SET NULL,
    ticket_id   BIGINT REFERENCES app.helpdesk_tickets(id)       ON DELETE SET NULL,
    campaign_id BIGINT REFERENCES app.campaigns(id)              ON DELETE SET NULL,

    -- WHO SENT IT, which is the cost and policy dimension. 'dunning' is deliberately
    -- NOT a value here: Meta's Business Policy prohibits debt collection, WhatsApp was
    -- removed from the arrears sweep for that reason, and a vocabulary that admits the
    -- value invites the behaviour back.
    kind        TEXT NOT NULL DEFAULT 'other'
                CHECK (kind IN ('care', 'campaign', 'notification', 'ad_reply', 'other')),

    -- The lawful basis the send was made under, mirroring app.party_contact_consent
    -- .purpose so the two can be reconciled. NULL for inbound: a customer writing to us
    -- needs no basis.
    purpose     TEXT CHECK (purpose IN ('servicing', 'marketing')),

    msg_type      TEXT NOT NULL DEFAULT 'text',
    template_name TEXT,
    body          TEXT,

    -- 'accepted' is Meta taking the request; the webhook then moves it to sent ->
    -- delivered -> read. 'received' is the only state an inbound message has.
    status      TEXT NOT NULL DEFAULT 'accepted'
                CHECK (status IN ('accepted', 'sent', 'delivered', 'read', 'failed', 'received')),
    status_at   TIMESTAMPTZ,
    error_code  TEXT,
    error_text  TEXT,

    -- CLICK-TO-WHATSAPP ATTRIBUTION. Meta attaches ctwa_clid to the referral object of
    -- the FIRST inbound message after an ad click and never again, and it travels in no
    -- URL — so if it is not captured here, the ad that produced a customer is
    -- unknowable afterwards. This is the column that makes Status/Feed ad reporting
    -- possible at all.
    ctwa_clid        TEXT,
    referral_headline TEXT,
    referral_source   TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What is this customer's thread, newest first" and the 24-hour service window both
-- read by phone and time.
CREATE INDEX IF NOT EXISTS whatsapp_messages_phone_idx
    ON app.whatsapp_messages (phone, created_at DESC);

-- The service window is the newest INBOUND message per number, so that half is indexed
-- on its own.
CREATE INDEX IF NOT EXISTS whatsapp_messages_inbound_idx
    ON app.whatsapp_messages (phone, created_at DESC) WHERE direction = 'in';

CREATE INDEX IF NOT EXISTS whatsapp_messages_ticket_idx
    ON app.whatsapp_messages (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_messages_campaign_idx
    ON app.whatsapp_messages (campaign_id) WHERE campaign_id IS NOT NULL;

-- Ad attribution is queried the other way round: "which conversations came from ads".
CREATE INDEX IF NOT EXISTS whatsapp_messages_ctwa_idx
    ON app.whatsapp_messages (ctwa_clid) WHERE ctwa_clid IS NOT NULL;

-- ── The 24-hour customer service window ──────────────────────────────────────
--
-- A free-form (non-template) message may only be sent within 24 hours of the customer's
-- last inbound message; outside it, Meta requires an approved template. Getting this
-- wrong is not a validation error, it is a send that fails after the agent has pressed
-- Send and believes the customer was answered.
--
-- A view rather than a stored column, because the answer changes with the clock and a
-- stored one would be stale the moment it was written. Reading it is one index probe.
CREATE OR REPLACE VIEW app.v_whatsapp_window AS
SELECT phone,
       MAX(created_at)                                  AS last_inbound_at,
       MAX(created_at) + INTERVAL '24 hours'            AS window_expires_at,
       (MAX(created_at) + INTERVAL '24 hours') > NOW()  AS window_open
  FROM app.whatsapp_messages
 WHERE direction = 'in'
 GROUP BY phone;

COMMENT ON VIEW app.v_whatsapp_window IS
    'Per number: when the customer last wrote in, and whether a free-form reply is still '
    'permitted. Outside the window Meta requires an approved template.';

COMMIT;
