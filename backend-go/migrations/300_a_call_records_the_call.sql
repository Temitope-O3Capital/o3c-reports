-- 300 — A call log records the call, and what happened afterwards gets its own entry.
--
-- THE DEFECT. helpdesk_calls.disposition is the outcome of one conversation at one
-- moment. Agents were overwriting it days later to record what the customer did NEXT,
-- because editing was the only writable surface in front of them: logging a new call
-- means claiming a call that never happened, and an activity note was invisible from the
-- Call Log. So the record of Monday's conversation was being replaced by Friday's news.
--
-- Measured on 2026-09-28 across 280 edits on helpdesk_call_edits:
--
--   * 188 (67%) filled in a disposition the agent had left blank. Completing a log, not
--     rewriting one. UNTOUCHED by this migration.
--   * 31 edits across 28 calls overwrote an outcome that had already been recorded, six
--     or more hours after the call. Interested → Not Interested averaged 104 HOURS
--     later; Interested → Not Eligible 132 hours; one Interested → Converted. Nobody
--     learns four days later what was said on Monday's call.
--   * Of those, 7 were a conversation replaced by "Unreachable / No Answer" — the agent
--     made the promised call-back, got no answer, and overwrote the original. The
--     conversation was deleted and the new attempt was never recorded at all.
--   * 278 of the 280 edits recorded no reason. The column existed and was dead.
--
-- Nothing was lost irrecoverably: helpdesk_call_edits keeps every before-value, which is
-- what makes this repair possible. But every report reads helpdesk_calls.disposition as
-- current truth, so the timeline was wrong, conversion lag was unmeasurable, and call
-- volumes undercounted by exactly the attempts that got overwritten.
--
-- THE REPAIR, in three parts.
--
--   1. The call goes back to what it recorded — the `from` value of the EARLIEST
--      qualifying edit on that call, so a chain of two rewrites unwinds to the original
--      rather than to the middle. Three of the 28 calls have two qualifying edits.
--   2. The later development becomes its OWN entry on the customer's timeline, dated
--      when the agent recorded it, attributed to the agent who recorded it, and linked
--      to the call it followed from. Where it maps onto a customer step it is stored as
--      one (type='step'); where it does not, it is kept as a note that states plainly
--      what happened and where it came from.
--   3. The repair itself is written to helpdesk_call_edits, so the audit trail shows a
--      migration moved it and not a person.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
--   * It does not fabricate the missing call. Seven attempts really were made and never
--     logged, but inventing a helpdesk_calls row means inventing a start time, a
--     duration and a telephony outcome. Those are facts from the exchange, not ours to
--     write. The attempt is recorded as a note that says it was never logged as a call.
--   * It does not touch call_center_contacts, crm_contacts.lead_stage or any lead
--     status. Those hold the customer's CURRENT state, which the later development made
--     correct. Unwinding them would re-open contacts that have legitimately closed.
--   * It skips any call whose disposition no longer equals the last edit's `to` value —
--     something else has happened since, and a blind restore would discard it.
--
-- SAFE TO RE-RUN. Every clause keys on "the call still reads as the edit left it", which
-- stops being true the moment the restore lands, so a second run selects nothing.
--
-- Verified before writing: helpdesk_calls carries NO triggers, so restoring a
-- disposition fires nothing. app.activities has a BEFORE INSERT trigger
-- (activity_resolve_party) which resolves party_id for the rows inserted here.

BEGIN;

-- ── 1. The qualifying edits ────────────────────────────────────────────────────
--
-- The same rules the Go classifier applies in handlers/call_log_correction_guard.go,
-- mirrored here. The two vocabularies are kept in step by
-- TestDispositionVocabularyAgrees and the sqlNoContactDispositions constants; if you
-- change one, change both.
CREATE TEMP TABLE m300_edits ON COMMIT DROP AS
WITH raw AS (
    SELECT e.id                                        AS edit_id,
           e.call_id,
           e.created_at                                AS edited_at,
           e.edited_by,
           NULLIF(TRIM(e.edited_name), '')             AS edited_name,
           NULLIF(TRIM(e.reason), '')                  AS reason,
           e.changes->'disposition'->>'from'           AS was,
           e.changes->'disposition'->>'to'             AS became,
           c.disposition                               AS now_disp,
           c.started_at,
           c.lead_id,
           NULLIF(TRIM(c.customer_cif), '')            AS cif,
           NULLIF(TRIM(c.customer_phone), '')          AS phone,
           NULLIF(TRIM(c.customer_name), '')           AS customer_name,
           EXTRACT(epoch FROM (e.created_at - c.started_at)) / 3600.0 AS age_hours
      FROM app.helpdesk_call_edits e
      JOIN app.helpdesk_calls      c ON c.id = e.call_id
     WHERE e.action = 'edit'
       AND e.changes ? 'disposition'
       -- Filling in a blank is completing a log. Two thirds of all edits, and none of
       -- this migration's business.
       AND COALESCE(e.changes->'disposition'->>'from', '') <> ''
       AND e.changes->'disposition'->>'from' <> COALESCE(e.changes->'disposition'->>'to', '')
       AND c.voided_at IS NULL
       AND c.merged_into_call_id IS NULL
), kinded AS (
    SELECT r.*,
           CASE WHEN lower(was) IN ('unreachable / no answer','no answer','no_answer',
                                    'voicemail','unreachable')                  THEN 'silent'
                WHEN lower(was) IN ('wrong number','wrong_number',
                                    'pending / follow-up','call dropped','call_dropped')
                                                                                 THEN 'ambiguous'
                ELSE 'talked' END AS was_kind,
           CASE WHEN lower(became) IN ('unreachable / no answer','no answer','no_answer',
                                       'voicemail','unreachable')               THEN 'silent'
                WHEN lower(became) IN ('wrong number','wrong_number',
                                       'pending / follow-up','call dropped','call_dropped')
                                                                                 THEN 'ambiguous'
                ELSE 'talked' END AS became_kind
      FROM raw r
     -- Six hours is where the two populations separate: real corrections landed within
     -- minutes (0.1–0.6h), developments at 17h and up. Inside the window an agent is
     -- still in the same shift as the call and a mis-pick is entirely plausible.
     WHERE r.age_hours >= 6
)
SELECT edit_id, call_id, edited_at, edited_by, edited_name, reason, was, became,
       now_disp, started_at, lead_id, cif, phone, customer_name, age_hours,
       CASE
           -- Two different conclusions about the same conversation, days apart. The
           -- first was not wrong; the customer moved.
           WHEN was_kind = 'talked' AND became_kind = 'talked'  THEN 'later_development'
           -- A conversation replaced by "nobody answered" — that is the NEXT dial.
           WHEN was_kind = 'talked' AND became_kind = 'silent'  THEN 'new_attempt'
           ELSE 'leave_alone'
       END AS kind
  FROM kinded;

DELETE FROM m300_edits WHERE kind = 'leave_alone';

-- ── 2. Which calls can safely be restored ──────────────────────────────────────
--
-- Only where the call still reads exactly as the LAST disposition edit left it. If
-- anything has touched it since, the later change is somebody's deliberate work and a
-- blind restore would throw it away.
CREATE TEMP TABLE m300_calls ON COMMIT DROP AS
WITH last_edit AS (
    SELECT DISTINCT ON (e.call_id)
           e.call_id, e.changes->'disposition'->>'to' AS last_to
      FROM app.helpdesk_call_edits e
     WHERE e.action = 'edit' AND e.changes ? 'disposition'
     ORDER BY e.call_id, e.created_at DESC
), first_qualifying AS (
    SELECT DISTINCT ON (call_id) call_id, was AS restore_to, edited_at AS first_edited_at
      FROM m300_edits
     ORDER BY call_id, edited_at
)
SELECT f.call_id, f.restore_to, f.first_edited_at, c.disposition AS current_disp
  FROM first_qualifying f
  JOIN last_edit        l ON l.call_id = f.call_id
  JOIN app.helpdesk_calls c ON c.id = f.call_id
 WHERE c.disposition = l.last_to
   AND c.disposition <> f.restore_to;

-- Drop the edits belonging to calls we are not restoring: recording a step for a
-- development while leaving the call claiming to BE that development would state the
-- same thing twice.
DELETE FROM m300_edits e
 WHERE NOT EXISTS (SELECT 1 FROM m300_calls c WHERE c.call_id = e.call_id);

-- ── 3. The later development becomes its own timeline entry ────────────────────
--
-- Mapped onto the customer-step vocabulary (handlers/customer_steps.go) where the
-- meaning matches exactly, and kept as a note where it does not. A note is the honest
-- answer for an outcome that is a CALL result rather than a journey step — "Callback
-- Scheduled" and "Unreachable" describe a phone, not a customer's progress.
INSERT INTO app.activities
    (lead_id, cif, call_id, phone, actor_user_id, actor_name, actor_team,
     type, direction, subject, body, outcome, status, source, occurred_at, metadata)
SELECT e.lead_id,
       e.cif,
       e.call_id,
       e.phone,
       e.edited_by,
       COALESCE(e.edited_name, 'A call centre agent'),
       'call_center',
       CASE WHEN m.step_code IS NOT NULL THEN 'step' ELSE 'note' END,
       'internal',
       COALESCE(m.step_label, 'Update Recorded After the Call'),
       -- Reads as a timeline entry first and provenance second, because an agent opening
       -- this customer wants to know what happened, not to read about a migration.
       CASE WHEN e.kind = 'new_attempt' THEN
              'A further attempt was made on ' || to_char(e.edited_at, 'DD Mon YYYY')
              || ' and got no answer.'
              -- The agent's own words, ended with a full stop if they did not end it
              -- themselves, so it does not run into the sentence after it.
              || COALESCE(' ' || e.reason
                   || CASE WHEN e.reason ~ '[.!?]\s*$' THEN '' ELSE '.' END, '')
              || ' It was recorded by overwriting the call of '
              || to_char(e.started_at, 'DD Mon YYYY') || ', which had recorded "'
              || e.was || '" — that call has been restored. The attempt was never logged '
              || 'as a call of its own, so this note is the only record of it.'
            ELSE
              'Recorded on ' || to_char(e.edited_at, 'DD Mon YYYY') || ' by '
              || COALESCE(e.edited_name, 'a call centre agent') || '.'
              -- The agent's own words, ended with a full stop if they did not end it
              -- themselves, so it does not run into the sentence after it.
              || COALESCE(' ' || e.reason
                   || CASE WHEN e.reason ~ '[.!?]\s*$' THEN '' ELSE '.' END, '')
              || ' Previously written onto the call of '
              || to_char(e.started_at, 'DD Mon YYYY') || ', which recorded "' || e.was
              || '"; that call now reads as it did at the time.'
       END,
       COALESCE(m.step_code, 'outcome_updated_after_call'),
       -- A step is a fact, not an outstanding item. Anything with a status shows up in
       -- the open-handoff rails.
       '',
       'call_log_repair',
       -- When the agent recorded it. The best available proxy for when they learned it,
       -- and never earlier than the call itself.
       e.edited_at,
       jsonb_build_object(
           'repaired_by_migration', 300,
           'source_edit_id',        e.edit_id,
           'call_disposition_was',  e.was,
           'recorded_as',           e.became,
           'edit_kind',             e.kind,
           'hours_after_call',      round(e.age_hours::numeric, 1))
  FROM m300_edits e
  LEFT JOIN (VALUES
        -- The customer withdrew after having shown interest. That is a drop-off, and the
        -- reason is the only thing of value in it.
        ('Not Interested',  'dropped_off',           'Dropped Off'),
        -- WE declined them, after checking. Not the customer leaving, and not a call
        -- outcome either — which is why this step had to be added to the vocabulary.
        ('Not Eligible',    'declined_not_eligible', 'Declined — Not Eligible'),
        -- Still considering, not now.
        ('Not Ready Yet',   'customer_reviewing',    'Customer Reviewing'),
        ('Converted',       'converted',             'Converted')
     ) AS m(became, step_code, step_label) ON m.became = e.became;

-- ── 4. The call goes back to what it recorded ──────────────────────────────────
UPDATE app.helpdesk_calls c
   SET disposition = t.restore_to
  FROM m300_calls t
 WHERE c.id = t.call_id;

-- ── 5. The repair is itself auditable ──────────────────────────────────────────
--
-- action='edit' because the CHECK constraint admits only edit/void/restore/
-- review_cleared, and 'restore' already means un-voiding a log. edited_by is NULL: no
-- person did this.
INSERT INTO app.helpdesk_call_edits (call_id, action, edited_by, edited_name, changes, reason)
SELECT t.call_id, 'edit', NULL, 'Migration 300',
       jsonb_build_object('disposition',
           jsonb_build_object('from', t.current_disp, 'to', t.restore_to)),
       'Restored what the call recorded. The outcome had been overwritten '
       || to_char(t.first_edited_at, 'DD Mon YYYY')
       || ' to record a later development, which is now a separate entry on the '
       || 'customer timeline.'
  FROM m300_calls t;

-- ── Guards ─────────────────────────────────────────────────────────────────────
DO $m300$
DECLARE
    n_edits int; n_calls int; n_steps int; n_notes int; n_left int; n_orphan int;
BEGIN
    SELECT COUNT(*) INTO n_edits FROM m300_edits;
    SELECT COUNT(*) INTO n_calls FROM m300_calls;
    SELECT COUNT(*) INTO n_steps FROM app.activities
     WHERE source = 'call_log_repair' AND type = 'step';
    SELECT COUNT(*) INTO n_notes FROM app.activities
     WHERE source = 'call_log_repair' AND type = 'note';

    -- One timeline entry per qualifying edit. Fewer means a development was silently
    -- dropped; more means one was recorded twice.
    IF n_steps + n_notes <> n_edits THEN
        RAISE EXCEPTION '300: % qualifying edits produced % timeline entries — refusing',
            n_edits, n_steps + n_notes;
    END IF;

    -- Every restored call must now differ from what the edit left, or the restore did
    -- not take.
    SELECT COUNT(*) INTO n_left
      FROM m300_calls t JOIN app.helpdesk_calls c ON c.id = t.call_id
     WHERE c.disposition <> t.restore_to;
    IF n_left > 0 THEN
        RAISE EXCEPTION '300: % call(s) did not take the restore — refusing', n_left;
    END IF;

    -- Every entry must be findable from the customer, or it is invisible and the
    -- information is lost anyway.
    SELECT COUNT(*) INTO n_orphan FROM app.activities
     WHERE source = 'call_log_repair'
       AND lead_id IS NULL AND COALESCE(cif,'') = '' AND COALESCE(phone,'') = '';
    IF n_orphan > 0 THEN
        RAISE EXCEPTION '300: % repaired entr(ies) have no anchor and would never be '
            'seen — refusing', n_orphan;
    END IF;

    RAISE NOTICE '300: % call(s) restored to what they recorded; % development(s) moved '
        'to the customer timeline (% as steps, % as notes)',
        n_calls, n_edits, n_steps, n_notes;
END $m300$;

COMMIT;
