-- 290: consent, and a record of every 1:1 message we send a customer.
--
-- The platform has never had either. Today it can message customers ONLY in bulk,
-- through Campaigns, and even that has never fired — all 6 campaigns sit in draft and
-- all 23,188 campaign_contacts rows are 'pending'. The handful of genuinely triggered
-- 1:1 sends that exist (CSAT after a ticket, survey dispatch, a Care reply, a
-- statement) are each bespoke code at their own call site, with no shared consent
-- check, no shared rate limit, and no shared audit trail. Notify() cannot reach a
-- customer at all: it resolves recipients with SELECT ... FROM o3c_users.
--
-- Retention needs to message one customer at one moment — a deposit maturing, a loan
-- repaid — so it needs the two things that were missing underneath all of it.
--
--
-- WHY CONSENT IS A TABLE AND NOT A COLUMN
--
-- NDPR lawful basis differs by WHO and by CHANNEL, and it changes over time; a
-- boolean on the customer row could express none of that. Today the only permission
-- state anywhere is dnc_list (47 phone numbers, honoured by the dialler and, since
-- today, by campaigns) and mail_suppressions (1 address, honoured by every email).
-- Both are opt-OUT registers. Neither records that anyone ever opted IN.
--
-- The distinction matters for exactly the population retention exists to reach. An
-- ACTIVE customer can be messaged about their own product on legitimate interest —
-- their deposit is maturing, they asked us to hold their money. A customer who
-- stopped using us over a year ago has no live relationship to draw that basis from,
-- so a win-back approach needs a recorded permission. That was decision 1 of the five
-- agreed on 2026-09-15, and it is enforced in code by consentAllows(), not by
-- convention.
--
-- 'pending' is a real state and the default: we have neither permission nor a
-- refusal. It is NOT permission.

CREATE TABLE IF NOT EXISTS app.party_contact_consent (
    id          BIGSERIAL PRIMARY KEY,
    party_id    BIGINT      NOT NULL REFERENCES app.parties(party_id) ON DELETE CASCADE,
    -- 'sms' | 'email' | 'whatsapp' | 'voice'
    channel     TEXT        NOT NULL,
    -- 'servicing'  — about a product they hold. Legitimate interest.
    -- 'marketing'  — offers and win-back. Needs opt-in.
    purpose     TEXT        NOT NULL,
    state       TEXT        NOT NULL DEFAULT 'pending',
    -- How we came to believe this: 'customer_reply', 'agent_recorded', 'web_form',
    -- 'import', 'inferred_active_product'. An inferred basis is never an opt-in.
    basis       TEXT,
    evidence    TEXT,
    recorded_by BIGINT      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,

    CONSTRAINT party_contact_consent_channel_check CHECK (channel IN ('sms','email','whatsapp','voice')),
    CONSTRAINT party_contact_consent_purpose_check CHECK (purpose IN ('servicing','marketing')),
    CONSTRAINT party_contact_consent_state_check   CHECK (state   IN ('pending','granted','withdrawn')),
    CONSTRAINT party_contact_consent_unique UNIQUE (party_id, channel, purpose)
);

CREATE INDEX IF NOT EXISTS idx_party_consent_lookup
    ON app.party_contact_consent (party_id, purpose, channel, state);

COMMENT ON TABLE app.party_contact_consent IS
  'NDPR marketing/servicing consent per party per channel. state=''pending'' is the default and is NOT permission. Servicing messages about a product the customer holds run on legitimate interest and do not require a ''granted'' row; marketing and win-back do. Enforced in consentAllows() in customer_dispatch.go, never by convention.';


-- ── The send log ─────────────────────────────────────────────────────────────
--
-- One row per 1:1 message, written BEFORE the provider is called, so a send that
-- crashes mid-flight still leaves a trace. mail_messages exists but is staff-directed
-- and email-only; this covers every channel and is keyed to the customer.
--
-- It is also the rate limiter's memory and the preview surface: in staff_preview mode
-- rows are written with state='preview' and nothing is dispatched, so the whole
-- journey can be inspected against real customers before a single message goes out.
CREATE TABLE IF NOT EXISTS app.customer_messages (
    id            BIGSERIAL PRIMARY KEY,
    party_id      BIGINT      REFERENCES app.parties(party_id) ON DELETE SET NULL,
    cif           TEXT,
    channel       TEXT        NOT NULL,
    purpose       TEXT        NOT NULL,
    -- What triggered it: 'fd_maturity_t14', 'loan_repaid', 'winback', ...
    journey       TEXT,
    to_address    TEXT        NOT NULL,
    subject       TEXT,
    body          TEXT        NOT NULL,
    -- preview   — computed but deliberately not sent (staff_preview mode)
    -- queued/sent/failed — real dispatch outcomes
    -- suppressed — refused by consent, DNC, suppression, quiet hours or a cap.
    --              Recorded rather than dropped: a message we chose NOT to send is
    --              the most important thing in this table for an NDPR audit.
    state         TEXT        NOT NULL DEFAULT 'queued',
    suppressed_by TEXT,
    provider_id   TEXT,
    error_text    TEXT,
    segments      INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at       TIMESTAMPTZ,

    CONSTRAINT customer_messages_channel_check CHECK (channel IN ('sms','email','whatsapp')),
    CONSTRAINT customer_messages_state_check   CHECK (state IN
        ('preview','queued','sent','failed','suppressed'))
);

CREATE INDEX IF NOT EXISTS idx_customer_messages_party  ON app.customer_messages (party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_messages_state  ON app.customer_messages (state, created_at DESC);
-- The rate limiter asks "how many have we sent this person lately", so it needs the
-- party and the clock together.
CREATE INDEX IF NOT EXISTS idx_customer_messages_recent ON app.customer_messages (party_id, created_at)
    WHERE state IN ('queued','sent');
-- One send per customer per journey per day, enforced in the DATABASE rather than
-- trusted from the worker: a restart mid-run must not re-message anyone.
--
-- The day is pinned to UTC because a bare created_at::date depends on the session
-- TimeZone and is therefore only STABLE, which Postgres refuses to index. UTC rather
-- than Africa/Lagos is harmless here: the journey worker runs once at 09:00 Lagos
-- (08:00 UTC), nowhere near a date boundary in either zone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_messages_journey_day
    ON app.customer_messages (party_id, journey, ((created_at AT TIME ZONE 'UTC')::date))
    WHERE journey IS NOT NULL AND state IN ('preview','queued','sent');

COMMENT ON TABLE app.customer_messages IS
  'Every 1:1 message to a customer, written before dispatch. state=''suppressed'' rows are the NDPR trail of what we chose NOT to send and why (suppressed_by). state=''preview'' means staff_preview mode computed it and sent nothing. The unique index on (party_id, journey, date) makes a journey idempotent across a worker restart.';

-- Seed servicing consent for customers who hold a live product. This is the
-- legitimate-interest basis agreed on 2026-09-15 written down explicitly rather than
-- assumed at send time, so an auditor can see the reasoning and a withdrawal can
-- overwrite it. Marketing consent is deliberately NOT seeded for anybody: nobody has
-- opted in to marketing, and inventing that would be the one thing this table exists
-- to prevent.
INSERT INTO app.party_contact_consent (party_id, channel, purpose, state, basis, evidence)
SELECT DISTINCT cl.party_id, ch.channel, 'servicing', 'granted', 'inferred_active_product',
       'Holds a live product; messaged only about that product (NDPR legitimate interest, agreed 2026-09-15)'
  FROM app.customer_lifecycle cl
  CROSS JOIN (VALUES ('sms'), ('email')) AS ch(channel)
 WHERE cl.open_products > 0
ON CONFLICT (party_id, channel, purpose) DO NOTHING;
