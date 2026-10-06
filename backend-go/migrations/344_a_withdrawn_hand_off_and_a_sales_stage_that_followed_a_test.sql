-- Withdraw the Sales hand-off for the two test leads, and stop the Sales pipeline
-- claiming a conversion that migration 340 already removed from the call centre.
--
-- WHAT 340 MISSED, AND IT WAS MINE. Migration 340 corrected five leads from 'converted'
-- to 'interested' in app.call_center_leads. It did not touch app.crm_contacts.lead_stage,
-- which is what SALES reads. So two of those five went on telling the sales pipeline they
-- had converted:
--
--   45129 / lead 13080  Crowning Products  stage 'converted' set 2026-10-02 11:06:02 —
--                       the exact second of the mis-clicked call, which was then voided
--                       with the reason typed literally as "TEST"
--   37210 / lead 8009   Michael Sebiomo     stage 'converted' set 2026-09-09 11:55:31 —
--                       the second an agent filed disposition 'other' with a note reading
--                       "Converted". A claim in free text, which is why 340 re-derived it
--
-- Fixing one side of a two-sided fact and calling it done is the defect this codebase
-- keeps paying for. 340 was half a correction.
--
-- THE HAND-OFF. Leads 13080 and 13101 were auto-forwarded to Sales on 2026-09-28 when
-- they first qualified on a genuine "Interested" call — verified: both carry an
-- answered_interested disposition submitted by Emmanuella Alozieuwa against a live call
-- (656 and 338 seconds). The hand-off was therefore correct when it was made, which is
-- why 340 deliberately left it alone. It is withdrawn now because these two are test
-- records and Sales should not be chasing them, not because the forward was wrong.
--
-- Neither forward was ever accepted, assigned or given a sales owner — both still sit on
-- 'forwarded' with resolved_at NULL — so nothing Sales has acted on is being reached into.
-- The guard below refuses if that has changed since 2026-10-06.
--
-- WHY 'rejected' AND NOT A NEW STATUS. ccCloseForwardOnRefusal already ends a hand-off
-- from the call-centre side with status='rejected' and the reason in `outcome`, so that
-- is the established meaning here: the hand-off ended without a sale, for a reason on the
-- record. Adding a 'withdrawn' value would mean a vocabulary change across every reader
-- of this table for two rows.
--
-- WHY STAGE 'contacted' AND NOT 'qualified'. 'qualified' is what feeds the Sales pipeline.
-- Putting a withdrawn lead there would re-create the thing being withdrawn, and putting
-- 8009 there would push into Sales' queue a lead that has never been in it. 'contacted' is
-- the stage app.regrade_unqualified_leads() uses for exactly this — reached, worked, not
-- handed over — and it is a demotion out of the pipeline rather than a slur: these leads
-- are NOT marked 'disqualified', because the customers did nothing wrong.
--
-- NOT TOUCHED, and needing a decision rather than a patch: two more contacts sit at stage
-- 'converted' while their call-centre lead says otherwise — 38177 / lead 8880 (lead
-- 'called', stage set 2026-09-10) and 33 / lead 3087 (lead 'no_answer', 2026-08-03).
-- Neither is in this change's blast radius, and for those two the STAGE may well be the
-- true side: a real sale whose call-centre lead was simply never updated. Guessing which
-- half is stale is how a real conversion gets erased.

BEGIN;

DO $$
DECLARE
    v_open int;
    v_stage int;
BEGIN
    -- Both hand-offs must still be open and unowned. If Sales has since accepted,
    -- assigned or resolved either, this migration must not overwrite their work.
    SELECT count(*) INTO v_open
      FROM app.call_center_lead_forwards
     WHERE lead_id IN (13080, 13101)
       AND status = 'forwarded'
       AND resolved_at IS NULL
       AND sales_owner_id IS NULL;
    IF v_open <> 2 THEN
        RAISE EXCEPTION 'expected 2 open unowned hand-offs for leads 13080/13101, found % '
                        '— Sales may have acted on one; re-check before withdrawing', v_open;
    END IF;

    -- And the three stages must still be what was measured.
    SELECT count(*) INTO v_stage
      FROM app.crm_contacts
     WHERE id IN (45129, 37210) AND lead_stage = 'converted';
    IF v_stage <> 2 THEN
        RAISE EXCEPTION 'expected 45129 and 37210 still at stage converted, found % — '
                        'someone has changed these since 2026-10-06', v_stage;
    END IF;
END $$;

-- 1. End the hand-off, with the reason on the record.
UPDATE app.call_center_lead_forwards
   SET status      = 'rejected',
       outcome     = 'Withdrawn by the call centre on 2026-10-06: test lead. The lead was '
                  || 'genuinely dispositioned Interested on 2026-09-28, so the hand-off was '
                  || 'correct when made; it is withdrawn because the record is a test and '
                  || 'the conversion that followed it was logged in error (see migration 340).',
       updated_at  = NOW(),
       resolved_at = NOW()
 WHERE lead_id IN (13080, 13101)
   AND status = 'forwarded'
   AND resolved_at IS NULL;

-- 2. Keep the hand-off timestamp before clearing it. The ledger row above is the durable
--    history; forwarded_at is what the Leads screen reads to show "Forwarded to Sales",
--    and leaving it set would keep asserting a hand-off that no longer stands.
UPDATE app.call_center_leads
   SET notes = concat_ws(E'\n',
         nullif(btrim(coalesce(notes, '')), ''),
         '[2026-10-06] Sales hand-off withdrawn (test lead). Originally forwarded at '
         || coalesce(forwarded_at::text, '(unknown)') || '.'),
       forwarded_at = NULL,
       updated_at   = NOW()
 WHERE id IN (13080, 13101);

-- 3. Take all three out of the sales pipeline's converted/qualified stages.
UPDATE app.crm_contacts
   SET lead_stage       = 'contacted',
       stage_changed_at = NOW(),
       updated_at       = NOW()
 WHERE id IN (45129, 45186, 37210)
   AND lead_stage IN ('converted', 'qualified');

-- 4. Say so on each lead's own timeline, which is what the Leads page renders as history.
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
VALUES
  (45129, 'stage_regraded', 'converted', 'contacted',
   'Sales hand-off withdrawn and the converted stage removed: the call that converted this '
   || 'lead was voided on 2026-10-02 with the reason "TEST". Corrected by migration 344.', NULL),
  (45186, 'stage_regraded', 'qualified', 'contacted',
   'Sales hand-off withdrawn: test lead. The Interested call behind it was genuine, but '
   || 'nothing should be chasing this record. Corrected by migration 344.', NULL),
  (37210, 'stage_regraded', 'converted', 'contacted',
   'Converted stage removed to match migration 340: the conversion was a note typed into '
   || 'an "Other" disposition, not a recorded outcome. Corrected by migration 344.', NULL);

DO $$
DECLARE
    v_bad int;
BEGIN
    SELECT count(*) INTO v_bad
      FROM app.call_center_lead_forwards
     WHERE lead_id IN (13080, 13101) AND resolved_at IS NULL;
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% hand-offs for 13080/13101 are still open', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM app.call_center_leads WHERE id IN (13080, 13101) AND forwarded_at IS NOT NULL;
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% of the two leads still read as forwarded', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM app.crm_contacts WHERE id IN (45129, 45186, 37210) AND lead_stage <> 'contacted';
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% of the three contacts are not at stage contacted', v_bad;
    END IF;

    -- The property 340 should have asserted and did not: no contact may claim a converted
    -- stage while its call-centre lead says otherwise, EXCEPT the two left alone above.
    SELECT count(*) INTO v_bad
      FROM app.crm_contacts c
      JOIN app.call_center_leads l ON l.contact_id = c.id
     WHERE c.lead_stage = 'converted' AND l.status <> 'converted'
       AND c.id NOT IN (38177, 33);
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '% contacts still claim a conversion their lead does not', v_bad;
    END IF;

    RAISE NOTICE 'migration 344: two hand-offs withdrawn, three sales stages corrected';
END $$;

COMMIT;
