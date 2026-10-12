-- What an ad actually produced.
--
-- THE QUESTION THIS ANSWERS, AND WHY META CANNOT. Ads Manager knows impressions, clicks
-- and cost. It does not know which of those clicks became a customer who borrowed money,
-- because that happens in here. The join between the two is a single identifier —
-- ctwa_clid — which Meta attaches to the referral object of the FIRST inbound WhatsApp
-- message after an ad click and never sends again. app.whatsapp_messages already captures
-- it (migration 364); this is where it becomes an outcome.
--
-- TWO TABLES, BECAUSE THEY ARE FILLED BY DIFFERENT HANDS. ad_campaigns is what the
-- marketing team records about an ad — including what it cost, which until the Marketing
-- API is wired is typed in from Ads Manager. ad_attribution is what the platform observes
-- a conversation become. Mixing them would mean a human editing a row the system also
-- writes, and the first disagreement would be silent.
--
-- THE STAGE ONLY EVER MOVES FORWARD, and only on evidence. A conversation that never
-- becomes a lead stays 'conversation' for ever, which is the honest record: a campaign
-- that produced 400 chats and 3 loans should read that way, not be quietly rounded up by
-- a stage that defaults optimistically.

BEGIN;

CREATE TABLE IF NOT EXISTS app.ad_campaigns (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,

    -- WhatsApp Status is a PLACEMENT in Meta's Updates tab, bought in Ads Manager like
    -- any Feed or Reels ad — it is not something this platform creates. It is named here
    -- so performance can be compared across placements, which is the whole reason to
    -- record the ad at all.
    placement   TEXT NOT NULL DEFAULT 'other'
                CHECK (placement IN ('whatsapp_status', 'facebook_feed', 'instagram_feed',
                                     'instagram_stories', 'reels', 'messenger', 'marketplace',
                                     'audience_network', 'other')),
    objective   TEXT,

    -- Meta's own campaign or ad id, so spend can be reconciled against Ads Manager later
    -- without re-keying, and so a future Marketing API sync has something to match on.
    external_ref TEXT,

    budget_kobo BIGINT,
    -- Spend is entered by hand until the Marketing API is wired, and spend_source says
    -- so. A figure typed from a dashboard and a figure pulled from an API are different
    -- kinds of fact, and a report that cannot tell them apart invites a decision made on
    -- a stale number.
    spend_kobo  BIGINT NOT NULL DEFAULT 0 CHECK (spend_kobo >= 0),
    spend_source TEXT NOT NULL DEFAULT 'manual' CHECK (spend_source IN ('manual', 'meta_api')),
    spend_as_of  DATE,

    started_on  DATE,
    ended_on    DATE,
    created_by  BIGINT REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ad_campaigns_dates_make_sense CHECK (ended_on IS NULL OR started_on IS NULL OR ended_on >= started_on)
);

CREATE TABLE IF NOT EXISTS app.ad_attribution (
    -- The click id is the natural key: Meta issues one per ad click, and a second inbound
    -- message from the same person carries no referral at all. PRIMARY KEY, so a replayed
    -- webhook cannot create a second conversation out of one click.
    ctwa_clid   TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,

    -- Nullable because the click arrives before anyone has told us which ad it was. Meta
    -- sends a headline and source URL on the referral, not a campaign id, so matching to
    -- app.ad_campaigns is a human or a later API sync — and an unmatched conversation is
    -- still worth counting.
    ad_campaign_id    BIGINT REFERENCES app.ad_campaigns(id) ON DELETE SET NULL,
    referral_headline TEXT,
    referral_source   TEXT,
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    party_id    BIGINT REFERENCES app.parties(party_id)  ON DELETE SET NULL,
    lead_id     BIGINT REFERENCES app.crm_contacts(id)   ON DELETE SET NULL,

    -- conversation: they wrote to us. lead: a CRM contact exists. qualified: the lead
    -- reached Interested. converted: it became business.
    stage       TEXT NOT NULL DEFAULT 'conversation'
                CHECK (stage IN ('conversation', 'lead', 'qualified', 'converted')),
    stage_at    TIMESTAMPTZ,
    -- Only meaningful at 'converted', and left NULL rather than 0 everywhere else: zero
    -- is a value and absent is not, and a cost-per-naira built on zeros reads as free.
    value_kobo  BIGINT,

    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ad_attribution_campaign_idx ON app.ad_attribution (ad_campaign_id);
CREATE INDEX IF NOT EXISTS ad_attribution_phone_idx    ON app.ad_attribution (phone);
CREATE INDEX IF NOT EXISTS ad_attribution_stage_idx    ON app.ad_attribution (stage, first_seen_at DESC);

-- ── Performance ──────────────────────────────────────────────────────────────
--
-- One row per campaign, with the funnel and what each step cost.
--
-- EVERY COST IS NULL WHEN ITS DENOMINATOR IS ZERO, never 0. A campaign with spend and no
-- conversions has an UNKNOWN cost per conversion, not a free one, and NULLIF is the
-- difference between a report that says "we do not know yet" and one that says "nothing".
-- The same discipline as collectionRateToDate.
CREATE OR REPLACE VIEW app.v_ad_performance AS
SELECT c.id                        AS ad_campaign_id,
       c.name,
       c.placement,
       c.objective,
       c.started_on,
       c.ended_on,
       c.spend_kobo,
       c.spend_source,
       COUNT(a.ctwa_clid)                                            AS conversations,
       COUNT(*) FILTER (WHERE a.stage IN ('lead','qualified','converted')) AS leads,
       COUNT(*) FILTER (WHERE a.stage IN ('qualified','converted'))        AS qualified,
       COUNT(*) FILTER (WHERE a.stage = 'converted')                       AS converted,
       COALESCE(SUM(a.value_kobo) FILTER (WHERE a.stage = 'converted'), 0) AS value_kobo,
       (c.spend_kobo / NULLIF(COUNT(a.ctwa_clid), 0))                      AS cost_per_conversation_kobo,
       (c.spend_kobo / NULLIF(COUNT(*) FILTER (WHERE a.stage IN ('lead','qualified','converted')), 0))
                                                                           AS cost_per_lead_kobo,
       (c.spend_kobo / NULLIF(COUNT(*) FILTER (WHERE a.stage = 'converted'), 0))
                                                                           AS cost_per_conversion_kobo
  FROM app.ad_campaigns c
  LEFT JOIN app.ad_attribution a ON a.ad_campaign_id = c.id
 GROUP BY c.id, c.name, c.placement, c.objective, c.started_on, c.ended_on,
          c.spend_kobo, c.spend_source;

COMMENT ON VIEW app.v_ad_performance IS
    'Per ad campaign: conversations started, how far they got, and what each step cost. '
    'Cost columns are NULL when nothing reached that stage — an unknown cost, not a free one.';

COMMIT;
