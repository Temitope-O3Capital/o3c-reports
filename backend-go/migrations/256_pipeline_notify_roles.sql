-- Per-source alert recipients.
--
-- Migration 238 gave every source an `owner`: free text, for a human to read
-- afterwards. The monitor itself notified a fixed list — it_admin and admin — so
-- who actually got told had nothing to do with who could fix it.
--
-- Measured 2026-09-20, six days after the monitor went live: there are NO
-- it_admin users and two admins. Meanwhile CCS EODTXN was 46 days stale,
-- Interswitch settlement 45 days, card cycle 47 days. The people who upload those
-- files — Cards ops (cards_head) and Settlement ops (settlement_head) — were
-- never told, because the alert had no way to reach them.
--
-- Roles are stored, not user ids: people change teams, and the workspace already
-- routes every other alert by role. handlers/notify.go's NotifyRoles ALWAYS
-- copies admins, so an empty list still reaches someone rather than nobody.
ALTER TABLE app.pipeline_source
  ADD COLUMN IF NOT EXISTS notify_roles text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN app.pipeline_source.notify_roles IS
  'Roles notified when this source is stale, tapering or its job is dead — the team that can actually fix it, derived from owner. Admins are always copied by NotifyRoles, so an empty array means "admins only", never "nobody". Editable without a deploy.';

-- Seeded from the owner column each source already carried.
--
-- Checked against who actually holds each role on 2026-09-20, because a role with
-- no users is the same silence this migration exists to end. Empty today:
-- it_admin (0), finance_head (0), cmo (0), bi_head (0). Those are kept where they
-- are the correct destination — someone will hold them eventually, and the
-- workspace's own role list defines them — but each source that would otherwise
-- reach nobody is paired with a role that has a person in it today:
-- cards_head (1), settlement_head (1), cfo (2), call_center_head (1),
-- care_head (1), risk_head (1), head_ops (1), bi_analyst (1), admin (2).
--
-- The Data Freshness page shows the recipient count per source, so a source that
-- can only reach admins is visible rather than assumed.
UPDATE app.pipeline_source AS p
   SET notify_roles = v.roles, updated_at = now()
  FROM (VALUES
    -- CCS export: the card system's own feeds. IT chases the export; Cards ops
    -- own the data and notice first when the book stops moving.
    ('feed_accounts',          ARRAY['it_admin','cards_head']),
    ('feed_transactions',      ARRAY['it_admin','cards_head']),
    ('customer_feed',          ARRAY['it_admin','cards_head']),
    ('feed_cardfam',           ARRAY['it_admin','cards_head']),
    -- Manual uploads: the team that does the uploading. These are the three that
    -- sat 45-47 days stale while only admins were told.
    ('card_cycle',             ARRAY['cards_head','it_admin']),
    ('ccs_eodtxn',             ARRAY['cards_head','it_admin']),
    ('interswitch_settlement', ARRAY['settlement_head','it_admin']),
    -- Money in and out. cfo is included because finance_head has no holder.
    ('paystack',               ARRAY['settlement_head','finance_head','cfo']),
    ('fx_rates',               ARRAY['finance_head','cfo']),
    -- Acquisition numbers: cmo has no holder, so BI is copied.
    ('appsflyer',              ARRAY['cmo','bi_analyst']),
    ('zoho_calls',             ARRAY['call_center_head','it_admin']),
    ('zoho_desk',              ARRAY['care_head','it_admin']),
    -- Core banking and mail are IT's, and it_admin has no holder — head_ops is
    -- the operational fallback so these do not degrade to admins alone.
    ('cbs',                    ARRAY['it_admin','head_ops']),
    ('mail_outbound',          ARRAY['it_admin','head_ops']),
    ('inbound_mail',           ARRAY['it_admin','head_ops']),
    ('phoenix_inbound',        ARRAY['risk_head','it_admin'])
  ) AS v(source_key, roles)
 WHERE p.source_key = v.source_key;
