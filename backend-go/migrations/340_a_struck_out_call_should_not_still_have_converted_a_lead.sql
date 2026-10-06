-- Five leads read 'converted' with no live call that says so.
--
-- 'converted' is rank 5 in ccLeadStatusRank — terminal, and the forward-only guard in
-- syncLeadFromCall means nothing a later call records can move a lead out of it. So a
-- wrong conversion is not self-correcting: it sits in the converted count, it keeps the
-- lead out of every working list, and until today there was no control in the UI to
-- change a lead's status at all. An agent who mis-clicks cannot undo it.
--
-- WHAT HAPPENED, lead by lead. Evidence is app.helpdesk_calls (excluding voided rows)
-- and app.call_center_dispositions, measured 2026-10-06:
--
--   13080  Crowning Products Business Ent
--          THE LIVE BUG. The agent logged "Converted" at 2026-10-02 11:06:02, realised
--          and re-logged "Interested" at 11:07:31 and again at 11:11:26 — then VOIDED all
--          three calls. Voiding strikes out the call and nothing re-derives the lead, so
--          the struck-out "Converted" still owned the lead four days later. Its one live
--          call says "Interested". Fixed in code in the same change set: hdVoidCall now
--          re-derives from what survives.
--
--   13101  Pumas Africa Logistics Limited
--          No evidence anywhere. Two live calls, "Interested" then "Information Sent —
--          Awaiting Reply", and the dispositions ledger agrees: answered_interested then
--          info_sent. NOTHING records a conversion, yet status and last_disposition both
--          read 'Converted'. Written by the backfill of 2026-10-05 11:57:57.278169, which
--          touched a batch of leads in one statement; no live code path can produce it.
--
--   6655   Adebayo Peter Olorunfemi    live calls: Interested, Call Dropped, Call Dropped
--   8009   Michael Sunday Sebiomo      live calls: Interested
--   11306  Ganiu Timson                live calls: Interested, Not Ready Yet
--          Same backfill, same absence of a converting call. 6655 and 8009 carry human
--          notes claiming a real outcome ("2,000,000 CREDIT CARD WAS DONE", and an
--          audited re-attribution by a named agent). Those notes are NOT discarded —
--          see the append below — but a claim in a disposition string is not a recorded
--          conversion, and the decision taken was to re-derive all five.
--
-- WHY ALL FIVE BECOME 'interested' AND NOT THEIR LATEST CALL. Lead status is forward-only
-- by design: a lead keeps the highest rank it has ever earned, which is why a later
-- "Not Ready Yet" or "Information Sent" cannot walk an earned 'interested' back. Every
-- one of these five has a live "Interested" call, so 'interested' (rank 4) is precisely
-- what each lead would hold today if the bad write had never happened. Picking the latest
-- call instead would invent a downgrade the system's own rules forbid.
--
-- NOT re-implemented here: leadStatusFromCall. A SQL twin of that mapping is the exact
-- defect this codebase keeps paying for, and this is a one-off correction of five rows —
-- so the five values are written out, with the evidence above, rather than derived by a
-- second copy of the rule.
--
-- The hand-off to Sales is deliberately LEFT ALONE. 13080 and 13101 were auto-forwarded
-- on 2026-09-28 when they first qualified on a genuine "Interested" call; that hand-off
-- was correct then and is correct now, because 'interested' is the status that earns it.

BEGIN;

-- Guard: refuse if the shape is not what was measured. If another session has already
-- corrected these, or a real conversion has since been recorded against one of them,
-- this migration must not quietly overwrite it.
DO $$
DECLARE
    v_bad int;
    v_live_conv int;
BEGIN
    SELECT count(*) INTO v_bad
      FROM app.call_center_leads
     WHERE id IN (6655, 8009, 11306, 13080, 13101) AND status = 'converted';
    IF v_bad <> 5 THEN
        RAISE EXCEPTION 'expected 5 leads still reading converted, found % — someone has '
                        'changed these since 2026-10-06; re-measure before applying', v_bad;
    END IF;

    -- And none of them may have gained a live converting call in the meantime.
    SELECT count(*) INTO v_live_conv
      FROM app.helpdesk_calls h
     WHERE h.lead_id IN (6655, 8009, 11306, 13080, 13101)
       AND h.voided_at IS NULL
       AND lower(coalesce(h.disposition, '')) LIKE '%convert%';
    IF v_live_conv <> 0 THEN
        RAISE EXCEPTION 'one of these leads now has a live converting call (% found) — '
                        'that is a real conversion and must not be reverted', v_live_conv;
    END IF;
END $$;

-- Keep what is being overwritten. 6655's "2,000,000 CREDIT CARD WAS DONE" is somebody's
-- record of a real event and the only place it exists; losing it to a status correction
-- would be a worse error than the status was. Appended to notes, dated, with the reason.
UPDATE app.call_center_leads
   SET notes = concat_ws(E'\n',
         nullif(btrim(coalesce(notes, '')), ''),
         '[2026-10-06] Status corrected from ''converted'' to ''interested'': no live call '
         || 'recorded a conversion. Previous last_disposition was: '
         || coalesce(nullif(btrim(last_disposition), ''), '(blank)'))
 WHERE id IN (6655, 8009, 11306, 13080, 13101)
   AND status = 'converted';

-- The correction itself. last_disposition is reset alongside status, because leaving it
-- reading 'Converted' is what made 13080 confusing to look at: the lead showed one thing
-- and its disposition another, and neither pointed at the voided call that caused it.
UPDATE app.call_center_leads
   SET status           = 'interested',
       last_disposition = 'Interested',
       updated_at       = NOW()
 WHERE id IN (6655, 8009, 11306, 13080, 13101)
   AND status = 'converted';

-- Leave a trace on the pipeline side too, so the change is visible from the lead's own
-- timeline rather than only in this file. crm_lead_events is what the Leads page renders
-- as history; created_by is NULL because this is a migration, not a person.
INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
SELECT l.contact_id, 'stage_regraded', 'converted', 'qualified',
       'Converted in error and corrected by migration 340: no live call recorded a '
       || 'conversion. The lead keeps the ''interested'' it earned on a real call.',
       NULL
  FROM app.call_center_leads l
 WHERE l.id IN (6655, 8009, 11306, 13080, 13101)
   AND l.contact_id IS NOT NULL;

-- Verify before committing.
DO $$
DECLARE
    v_left int;
    v_now  int;
BEGIN
    SELECT count(*) INTO v_left
      FROM app.call_center_leads
     WHERE id IN (6655, 8009, 11306, 13080, 13101) AND status <> 'interested';
    IF v_left <> 0 THEN
        RAISE EXCEPTION '% of the five did not move to interested', v_left;
    END IF;

    -- Every remaining converted lead must have a live call that says so. That is the
    -- property this migration is really asserting, and it is cheap to check.
    SELECT count(*) INTO v_now
      FROM app.call_center_leads l
     WHERE l.status = 'converted'
       AND NOT EXISTS (
           SELECT 1 FROM app.helpdesk_calls h
            WHERE h.lead_id = l.id AND h.voided_at IS NULL
              AND lower(coalesce(h.disposition, '')) LIKE '%convert%');
    IF v_now <> 0 THEN
        RAISE EXCEPTION '% converted leads still have no live converting call', v_now;
    END IF;

    RAISE NOTICE 'migration 340: five leads corrected; every converted lead now has a '
                 'live call that records it';
END $$;

COMMIT;
