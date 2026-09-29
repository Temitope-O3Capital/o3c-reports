-- 314: real tags for leads, and every lead knows which campaign it came from.
--
-- Two separate ideas that were both half-present, and keeping them separate is the point.
--
-- ---------------------------------------------------------------------------
-- WHY NOT THE EXISTING crm_contacts.tags COLUMN
-- ---------------------------------------------------------------------------
--
-- There is already a `tags` column. It is text, not an array, so it holds ONE blob rather
-- than a set: "which leads are tagged corporate" becomes a LIKE scan, and 'hot' matches
-- 'not-hot'. It is populated on 0 of 32,579 rows, it is accepted by two different update
-- whitelists that nothing calls, and it renders as a permanently blank row on the contact
-- page. A field that looks like a feature in the schema and in the UI while being
-- impossible to query is worse than no field, so tags move to their own table with set
-- semantics and the old column is left untouched for whoever still writes to it.
--
-- The CHECK is the part that decides whether a tag system survives a year. Without a
-- canonical form, 'Corporate', 'corporate ' and 'CORPORATE' become three different tags
-- that each match a third of the leads, and no filter is ever right again. So the stored
-- form IS the canonical form: lowercase, trimmed, no leading punctuation. Callers
-- normalise before writing and the database refuses anything else.

CREATE TABLE IF NOT EXISTS app.crm_lead_tags (
    contact_id  bigint      NOT NULL REFERENCES app.crm_contacts(id) ON DELETE CASCADE,
    tag         text        NOT NULL,
    added_by    bigint      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, tag),
    CONSTRAINT crm_lead_tags_tag_is_canonical CHECK (
        tag = lower(btrim(tag))
        AND char_length(tag) BETWEEN 2 AND 32
        AND tag ~ '^[a-z0-9][a-z0-9 _-]*$'
    )
);

-- Filtering by tag across the queue is the whole reason this is a table, so index the
-- direction the PRIMARY KEY does not already serve.
CREATE INDEX IF NOT EXISTS idx_crm_lead_tags_tag ON app.crm_lead_tags (tag);

COMMENT ON TABLE app.crm_lead_tags IS
  'Free-form labels a rep or head puts on a lead (corporate, price-objection, '
  'callback-dec). Deliberately NOT where campaign provenance lives: a campaign is a fact '
  'the system already knows and must not be editable, so it stays on '
  'crm_contacts.source_campaign_id. Tags are opinion; the campaign is record.';

-- ---------------------------------------------------------------------------
-- CAMPAIGN PROVENANCE — derived, not typed
-- ---------------------------------------------------------------------------
--
-- All 185 leads that have reached Sales came from one campaign family, the CRC July
-- Campaign, split across six lists plus an "IK August List". That is already recorded on
-- the forward, so nobody should be hand-tagging it: asking a rep to type the campaign a
-- lead came from invites a typo into a fact the database can prove.
--
-- THE TRAP. There are TWO campaign namespaces with overlapping ids and different names:
--
--     app.campaigns              (marketing)  <- crm_contacts.source_campaign_id
--                                             <- call_center_lead_forwards.marketing_campaign_id
--     app.call_center_campaigns  (dialler)    <- call_center_lead_forwards.cc_campaign_id
--
-- Id 5 is "IK August List" in call_center_campaigns and "CRC July Campaign (Lagos
-- Individuals) 4" in campaigns. Joining source_campaign_id to the dialler table therefore
-- returns a REAL campaign name that belongs to a different campaign — the same class of
-- silent wrong answer as joining a card CIF to a Udara customer id. Measured:
-- source_campaign_id resolves 8,309/8,309 against app.campaigns and only 6,445 against
-- app.call_center_campaigns, which is how the two were told apart.
--
-- The backfill therefore takes marketing_campaign_id, NOT cc_campaign_id — same namespace
-- as the column it is filling. Verified before running: of the 185, 86 already carry a
-- source_campaign_id and 140 forwards carry a marketing_campaign_id, and where BOTH exist
-- they never disagree (0 conflicts). That agreement is the evidence the namespaces line up;
-- without it this backfill would be a guess.

UPDATE app.crm_contacts c
   SET source_campaign_id = f.marketing_campaign_id
  FROM app.call_center_lead_forwards f
 WHERE f.contact_id = c.id
   AND c.source_campaign_id IS NULL
   AND f.marketing_campaign_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m314$
DECLARE
    v_unresolved bigint;
    v_conflict   bigint;
    v_with_camp  bigint;
    v_gated      bigint;
    v_ok         boolean;
BEGIN
    -- Every source_campaign_id must name a MARKETING campaign. If this ever fails, some
    -- writer has put a dialler campaign id in this column and the names on screen are
    -- someone else's campaign.
    SELECT count(*) INTO v_unresolved
      FROM app.crm_contacts c
     WHERE c.source_campaign_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM app.campaigns mc WHERE mc.id = c.source_campaign_id);
    IF v_unresolved > 0 THEN
        RAISE EXCEPTION '314: % contacts have a source_campaign_id that is not a marketing '
                        'campaign — check nobody wrote a call_center_campaigns id here.', v_unresolved;
    END IF;

    -- The backfill must not have contradicted a value that was already there.
    SELECT count(*) INTO v_conflict
      FROM app.crm_contacts c
      JOIN app.call_center_lead_forwards f ON f.contact_id = c.id
     WHERE c.source_campaign_id IS NOT NULL
       AND f.marketing_campaign_id IS NOT NULL
       AND c.source_campaign_id <> f.marketing_campaign_id;
    IF v_conflict > 0 THEN
        RAISE EXCEPTION '314: % leads disagree with their forward about the campaign.', v_conflict;
    END IF;

    -- The canonical-form CHECK has to actually bite, or the tag list rots into
    -- near-duplicates. Prove both directions rather than trusting the regex by eye.
    BEGIN
        INSERT INTO app.crm_lead_tags (contact_id, tag)
        SELECT id, 'Corporate' FROM app.crm_contacts LIMIT 1;
        RAISE EXCEPTION '314: the tag CHECK accepted "Corporate" — casing is not canonical.';
    EXCEPTION WHEN check_violation THEN
        NULL; -- expected
    END;

    INSERT INTO app.crm_lead_tags (contact_id, tag)
    SELECT id, 'corporate' FROM app.crm_contacts LIMIT 1;

    SELECT EXISTS (SELECT 1 FROM app.crm_lead_tags WHERE tag = 'corporate') INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION '314: the tag table rejected a canonical tag.';
    END IF;
    DELETE FROM app.crm_lead_tags WHERE tag = 'corporate';

    SELECT count(*) FILTER (WHERE source_campaign_id IS NOT NULL), count(*)
      INTO v_with_camp, v_gated
      FROM app.crm_contacts WHERE sales_entered_at IS NOT NULL;

    RAISE NOTICE '314: crm_lead_tags ready; % of % leads in Sales now name their marketing '
                 'campaign (the rest reached Sales through a dialler-only list and are '
                 'shown from the forward instead).', v_with_camp, v_gated;
END
$m314$;
