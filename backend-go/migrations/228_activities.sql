-- 228_activities.sql
--
-- One activity stream for the workspace. Until now every interaction had to be anchored
-- to a *thing* — a call (helpdesk_calls), a ticket, a campaign send, a payment. There was
-- no home for a standalone activity/milestone: "collected the customer's documents",
-- "forwarded this lead to Risk", "Risk found them ineligible", a plain note, a task.
--
-- This table is that home. It is deliberately NOT a replacement for the systems of record
-- (calls stay in helpdesk_calls, payments in the ledger, etc.) — the Customer 360 timeline
-- keeps sourcing those from their own tables, and this becomes one more branch of that
-- union carrying only the event types that had nowhere to live before. That avoids showing
-- anything twice while giving notes / documents / handoffs / decisions a real home.
--
-- Identity is by ANCHOR, matching how the rest of the app already ties records to a person:
-- a row carries whichever of lead_id / contact_id / cif / application_id / ticket_id /
-- call_id / phone apply, and readers match on those (a person's CIFs + normalised phones),
-- exactly like c360Activity and ccLeadCalls do today. A lead with no CIF yet and the loan
-- application it later becomes therefore land on the same stream.

CREATE TABLE IF NOT EXISTS app.activities (
    id                  BIGSERIAL PRIMARY KEY,

    -- Anchors — any that apply. Readers match a person by the set of these.
    lead_id             BIGINT,        -- app.call_center_leads.id
    contact_id          BIGINT,        -- app.crm_contacts.id
    cif                 TEXT,          -- customer identity (a card/CIF)
    application_id      BIGINT,        -- app.loan_applications.id
    ticket_id           BIGINT,        -- app.helpdesk_tickets.id
    call_id             BIGINT,        -- app.helpdesk_calls.id (link back to the call, never a duplicate of it)
    phone               TEXT,          -- normalised last-10 digits, for pre-identity matching

    -- Who did it.
    actor_user_id       BIGINT,        -- o3c_users.id (NULL for system/external)
    actor_name          TEXT,          -- denormalised for display / external actors
    actor_team          TEXT,          -- call_center | sales | risk | finance | ops | collections | care | ...

    -- What happened.
    type                TEXT NOT NULL,  -- note | document | handoff | stage_change | decision | task | email | sms | meeting | ...
    direction           TEXT,           -- in | out | internal
    subject             TEXT,
    body                TEXT,
    outcome             TEXT,           -- free but conventional: eligible | ineligible | interested | converted | ...

    -- Handoff / task fields (NULL for other types).
    target_team         TEXT,           -- who it was handed to
    target_user_id      BIGINT,
    status              TEXT,           -- open | accepted | in_progress | resolved | returned | cancelled
    related_activity_id BIGINT REFERENCES app.activities(id) ON DELETE SET NULL,  -- a reflect-back points at its originating handoff

    -- Extras + provenance.
    metadata            JSONB,          -- structured extras (eligibility reason, doc refs, amounts, campaign id, ...)
    source              TEXT NOT NULL DEFAULT 'manual',  -- manual | los | cc_forward | backfill:<table> | ...

    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when it happened (may predate created_at on a backfill)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Readers fan out by anchor + time; keep each anchor and the timeline order indexed.
CREATE INDEX IF NOT EXISTS idx_activities_lead        ON app.activities (lead_id)        WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_contact     ON app.activities (contact_id)     WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_cif         ON app.activities (cif)            WHERE cif IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_application ON app.activities (application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_phone       ON app.activities (phone)          WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_type        ON app.activities (type);
CREATE INDEX IF NOT EXISTS idx_activities_handoff     ON app.activities (target_team, status) WHERE type = 'handoff';
CREATE INDEX IF NOT EXISTS idx_activities_occurred    ON app.activities (occurred_at DESC);
