-- Sales & CRM: a trustworthy acquisition date, a seeded pipeline, and a lead
-- lifecycle that reaches from Business Dev through to an owned customer.

-- ── 1. Acquisition date ──────────────────────────────────────────────────────
--
-- The workspace reported customer acquisition as having collapsed — 167 in 2023, 65
-- in 2024, 161 in 2025, against 6,236 in 2021. That was an artefact.
--
-- 3,717 of 21,012 customers (18%) have a NULL account_created, and they are the most
-- recent ones: every CIF above 00037038 is undated. Any query that buckets by
-- account_created silently drops them. The accounts book tells the true story for the
-- same period — 389 accounts opened in 2023, 723 in 2024, 751 in 2025, 355 so far in
-- 2026.
--
-- cust_file cannot fix this: its 12 fields carry no date at all. So acquisition date
-- is DERIVED, with an explicit precedence, and the derivation is exposed as a view
-- rather than written back over account_created — that column belongs to the source
-- data and should not be overwritten with an inference.
--
--   1. account_created        — authoritative where the baseline supplied it
--   2. first account opened   — a customer is acquired when their first account opens
--   3. first_seen_at          — the feed's first sighting; the best we have for a
--                               customer with no dated account
--
-- acquired_on_source travels with the value so a report can state how many customers
-- rest on an inference, instead of presenting all three as equally solid.

CREATE OR REPLACE VIEW app.customer_acquisition AS
SELECT
    c.contact_id,
    c.cif,
    c.full_name,
    c.first_name,
    c.last_name,
    c.email,
    c.phone,
    c.state,
    c.city,
    c.account_status,
    c.source,
    c.first_seen_at,
    c.last_seen,
    c.account_created,
    a.first_account_opened,
    a.account_count,
    COALESCE(c.account_created, a.first_account_opened, c.first_seen_at) AS acquired_on,
    CASE
        WHEN c.account_created      IS NOT NULL THEN 'account_created'
        WHEN a.first_account_opened IS NOT NULL THEN 'first_account'
        WHEN c.first_seen_at        IS NOT NULL THEN 'first_seen'
        ELSE 'unknown'
    END AS acquired_on_source,
    o.officer_id,
    o.assigned_at AS officer_assigned_at
FROM app.customers c
LEFT JOIN (
    SELECT cif,
           MIN(opened_date) AS first_account_opened,
           COUNT(*)         AS account_count
    FROM app.accounts
    WHERE opened_date IS NOT NULL
      AND cif IS NOT NULL AND cif <> ''
      -- One row is dated in the future; a customer cannot be acquired tomorrow.
      AND opened_date <= CURRENT_DATE
    GROUP BY cif
) a ON a.cif = c.cif
LEFT JOIN customer_officers o ON o.cif = c.cif
WHERE c.cif IS NOT NULL AND c.cif <> '';

COMMENT ON VIEW app.customer_acquisition IS
    'Customer master with a derived acquisition date. Use acquired_on for all acquisition reporting, and acquired_on_source to disclose how firm each date is.';

-- ── 2. Seed the pipeline (only if genuinely unseeded) ────────────────────────
--
-- This installation already carries six stages (Lead, Qualified, Proposal,
-- Negotiation, Won, Lost), so the insert below is a no-op here. It exists for a fresh
-- deployment, where an unseeded crm_pipeline_stages makes the Pipeline page
-- unrenderable and blocks deal creation outright — crm_deals.stage_id references this
-- table. The NOT EXISTS guard means a team that has customised its stages keeps them.

INSERT INTO crm_pipeline_stages (name, color, is_won, is_lost, order_index)
SELECT * FROM (VALUES
    ('New',         '#6B7280', FALSE, FALSE, 1),
    ('Contacted',   '#2563EB', FALSE, FALSE, 2),
    ('Qualified',   '#7C3AED', FALSE, FALSE, 3),
    ('Proposal',    '#D97706', FALSE, FALSE, 4),
    ('Application', '#0E2841', FALSE, FALSE, 5),
    ('Won',         '#16A34A', TRUE,  FALSE, 6),
    ('Lost',        '#C00000', FALSE, TRUE,  7)
) AS s(name, color, is_won, is_lost, order_index)
WHERE NOT EXISTS (SELECT 1 FROM crm_pipeline_stages);

-- ── 3. Lead lifecycle ────────────────────────────────────────────────────────
--
-- Leads reach Sales from Business Dev, from campaigns, from the call centre, and from
-- officers profiling a walk-in or referral themselves. crm_contacts.status only
-- distinguished 'lead' from 'customer', with nothing recording progress in between —
-- so a lead could be worked for weeks with no way to see where it had got to.

ALTER TABLE crm_contacts
    ADD COLUMN IF NOT EXISTS lead_stage        TEXT NOT NULL DEFAULT 'new',
    ADD COLUMN IF NOT EXISTS lead_owner_id     BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS qualified_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS converted_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS converted_cif     TEXT,
    ADD COLUMN IF NOT EXISTS disqualified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disqualify_reason TEXT,
    ADD COLUMN IF NOT EXISTS last_activity_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_action_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS estimated_value_kobo BIGINT;

-- new → contacted → qualified → converted, or out via disqualified at any point.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'crm_contacts_lead_stage_chk'
    ) THEN
        ALTER TABLE crm_contacts ADD CONSTRAINT crm_contacts_lead_stage_chk
            CHECK (lead_stage IN ('new','contacted','qualified','converted','disqualified'));
    END IF;
END $$;

-- The 29,663 rows already flagged 'customer' are converted by definition; leaving them
-- at the 'new' default would put every existing customer at the top of the lead queue.
UPDATE crm_contacts
   SET lead_stage   = 'converted',
       converted_cif = COALESCE(NULLIF(converted_cif, ''), cif_number)
 WHERE status = 'customer' AND lead_stage = 'new';

CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead_stage  ON crm_contacts (lead_stage);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_lead_owner  ON crm_contacts (lead_owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_next_action ON crm_contacts (next_action_at)
    WHERE next_action_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_cif         ON crm_contacts (cif_number);

-- Where a lead came from, so origination can be credited. 'business_dev' and
-- 'sales_officer' are the two the team asked for; the rest already occur in the data.
CREATE TABLE IF NOT EXISTS crm_lead_sources (
    code       TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    order_index INTEGER NOT NULL DEFAULT 0
);

INSERT INTO crm_lead_sources (code, label, order_index) VALUES
    ('business_dev',  'Business Development', 1),
    ('sales_officer', 'Sales Officer',        2),
    ('walk_in',       'Walk-in',              3),
    ('referral',      'Referral',             4),
    ('campaign',      'Campaign',             5),
    ('call_center',   'Call Centre',          6),
    ('employer',      'Employer Scheme',      7),
    ('website',       'Website',              8),
    ('other',         'Other',                9)
ON CONFLICT (code) DO NOTHING;

-- ── 4. Lead activity trail ───────────────────────────────────────────────────
--
-- crm_activities exists but is keyed to contacts generally. Stage changes need their
-- own record so "how long did this sit in Qualified?" is answerable, and so a lead
-- reassigned between officers keeps its history.
CREATE TABLE IF NOT EXISTS crm_lead_events (
    id          BIGSERIAL PRIMARY KEY,
    contact_id  BIGINT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,        -- 'created' | 'stage_change' | 'assigned' | 'note' | 'converted'
    from_stage  TEXT,
    to_stage    TEXT,
    from_owner  BIGINT,
    to_owner    BIGINT,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_lead_events_contact
    ON crm_lead_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_lead_events_created
    ON crm_lead_events (created_at DESC);
