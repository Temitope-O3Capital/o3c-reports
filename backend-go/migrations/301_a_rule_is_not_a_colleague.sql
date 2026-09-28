-- 301 — The lead timeline says what happened, not which migration did it.
--
-- THE DEFECT. On 14 Sept a rule was agreed: a lead is only qualified once a call records
-- the customer actually saying they are interested (a callback request or "not ready yet"
-- does not count). Migrations 248 and 298 applied it retroactively, moving 1,855 leads
-- out of Qualified, and wrote an explanation onto each lead's timeline. That explanation
-- is what an agent reads, and every part of it was wrong for them:
--
--     Stage Regraded                                        14 Sept, 13:16
--     Re-graded: the last call recorded "Not Ready Yet". Only a call where the
--     customer says they are interested qualifies a lead (rule agreed 14 Sept 2026).
--     [Stage Change]  Staff · Sales
--
--   1. "Re-graded" is the migration's internal word. Nobody in the building says it.
--   2. It is attributed to "Staff · Sales". crm_lead_events.created_by is NULL for these
--      rows, so the mirror trigger wrote actor_team='sales' with no actor_name and the
--      timeline falls back to the word "Staff". A rule that swept 1,855 leads therefore
--      reads as an anonymous colleague having meddled with this one. That is the worst of
--      it: it invites the agent to go looking for a person who does not exist.
--   3. It cites "rule agreed 14 Sept 2026" — meaningless to anyone not in that meeting,
--      and a date is not an explanation.
--   4. It never says where the lead WENT or how to get it back. It states what was taken
--      away and stops.
--   5. The subject and the type say the same thing twice: "Stage Regraded" above,
--      "Stage Change" below.
--
-- Counted: 1,855 rows in crm_lead_events (1,809 carrying migration 248's wording,
-- 46 carrying 298's) and their 1,855 mirrors in app.activities. 1,152 leads went back to
-- 'contacted' and 703 were disqualified outright — a distinction the old text never made,
-- though it is the only thing that tells an agent whether the lead is still workable.
--
-- THE FIX.
--
--   * One copy of the wording, in app.regrade_note(), instead of the three that existed
--     (248, 298, and whatever the next author would have written). It branches on where
--     the lead actually went, so a still-workable lead is told how to re-qualify and a
--     disqualified one is not given false hope.
--   * The mirror trigger gives known events a human subject and stops attributing an
--     authorless system event to a team, so it can no longer read as a colleague.
--   * Both the 1,855 stored notes and their 1,855 mirrors are rewritten, because the old
--     text is what is on screen today.
--
-- Verified before writing: app.regrade_unqualified_leads() in the database still matches
-- migration 298 byte for byte, so replacing it reverts nobody's later fix. The event CODE
-- 'stage_regraded' is deliberately UNCHANGED — migrations/rollback/rollback_248.sql keys
-- on it, and renaming a key to improve a label is how a rollback script quietly stops
-- working.

BEGIN;

-- ── One copy of the explanation ────────────────────────────────────────────────
--
-- Takes where the lead went and, when it is known, the outcome of its last call. Returns
-- prose an agent can act on.
CREATE OR REPLACE FUNCTION app.regrade_note(to_stage text, last_disposition text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN to_stage = 'disqualified' THEN
            CASE WHEN COALESCE(NULLIF(TRIM(last_disposition), ''), '') <> '' THEN
                     'The last call recorded "' || TRIM(last_disposition) || '", which '
                     || 'closes a lead. It was sitting in Qualified, so it has been '
                     || 'disqualified instead. A lead only counts as qualified once a '
                     || 'call records the customer saying they are interested.'
                 ELSE
                     'No call on this lead ever recorded an interested customer, and its '
                     || 'last outcome closes a lead, so it has been disqualified rather '
                     || 'than left in Qualified.'
            END
        ELSE
            CASE WHEN COALESCE(NULLIF(TRIM(last_disposition), ''), '') <> '' THEN
                     'A lead is only qualified once a call records the customer saying '
                     || 'they are interested — the last call here recorded "'
                     || TRIM(last_disposition) || '". It has gone back to '
                     || initcap(COALESCE(NULLIF(to_stage, ''), 'Contacted'))
                     || '. Record an interested call and it qualifies again.'
                 ELSE
                     'A lead is only qualified once a call records the customer saying '
                     || 'they are interested, and no call on this one has. It has gone '
                     || 'back to ' || initcap(COALESCE(NULLIF(to_stage, ''), 'Contacted'))
                     || '. Record an interested call and it qualifies again.'
            END
    END;
$$;

COMMENT ON FUNCTION app.regrade_note(text, text) IS
  'The single copy of the wording shown on a lead timeline when the qualification rule '
  '(agreed 14 Sept 2026: only a call recording an interested customer qualifies a lead) '
  'moves a lead out of Qualified. Branches on the destination stage so a still-workable '
  'lead is told how to re-qualify and a disqualified one is not. Written for the agent '
  'reading it, not for the author of the rule — migration 301.';

-- A human name for each event that has one. Kept beside regrade_note because both exist
-- for the same reason: initcap() on a snake_case code produces a label that names the
-- mechanism instead of the outcome.
CREATE OR REPLACE FUNCTION app.lead_event_subject(event text, to_stage text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN event = 'stage_regraded' AND to_stage = 'disqualified' THEN 'Disqualified'
        WHEN event = 'stage_regraded'                               THEN 'Moved Out Of Qualified'
        ELSE initcap(replace(COALESCE(event, ''), '_', ' '))
    END;
$$;

-- ── The mirror trigger ─────────────────────────────────────────────────────────
--
-- Carried across unchanged except for three things: the subject comes from
-- lead_event_subject, actor_name is populated, and an event with no author is no longer
-- attributed to a team. Everything else — the contact/cif/phone resolution, the
-- forward/handoff branch, entity linking — is exactly as it was.
CREATE OR REPLACE FUNCTION app.activities_from_crm_lead_event()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_forward boolean := NEW.event ILIKE '%forward%';
BEGIN
  INSERT INTO app.activities
    (contact_id, cif, phone, actor_user_id, actor_name, actor_team, type, target_team,
     status, subject, body, occurred_at, source, entity_type, entity_id)
  VALUES (
    NEW.contact_id,
    (SELECT COALESCE(NULLIF(converted_cif,''), NULLIF(cif_number,'')) FROM app.crm_contacts WHERE id = NEW.contact_id),
    (SELECT NULLIF(app.norm_phone(phone),'') FROM app.crm_contacts WHERE id = NEW.contact_id),
    NEW.created_by,
    -- Nobody did this. Saying so is the whole point: with actor_name NULL the timeline
    -- prints the word "Staff", and a rule that moved 1,855 leads reads as a colleague
    -- who touched this one.
    CASE WHEN NEW.created_by IS NULL THEN 'System Rule' ELSE NULL END,
    -- And an authorless event belongs to no team either.
    CASE WHEN is_forward                THEN 'call_center'
         WHEN NEW.created_by IS NULL     THEN NULL
         ELSE 'sales' END,
    CASE WHEN is_forward THEN 'handoff' ELSE 'stage_change' END,
    CASE WHEN is_forward OR NEW.event ILIKE '%sales%' THEN 'sales' ELSE NULL END,
    CASE WHEN is_forward THEN 'open' ELSE NULL END,
    app.lead_event_subject(NEW.event, NEW.to_stage),
    NULLIF(NEW.note,''), NEW.created_at, 'crm_lead', 'crm_contact', NEW.contact_id::text);
  RETURN NULL;
END;
$$;

-- ── The worker's own copy of the note ──────────────────────────────────────────
--
-- app.regrade_unqualified_leads() runs continuously (handlers/lead_regrade_worker.go), so
-- leaving its text alone would keep producing the old wording forever. Only the INSERT's
-- note expression changes; the selection logic and the UPDATE are byte-identical to
-- migration 298, which the live definition was verified against before this was written.
-- Transcribed from pg_get_functiondef() of the LIVE function, not from migration 298, and
-- changed in exactly two places: `moved` also returns d.disposition, and `logged` calls
-- regrade_note instead of holding a literal. The candidate/decided logic, the UPDATE and
-- the return are byte-identical. Nothing about WHICH leads are re-graded changes here.
CREATE OR REPLACE FUNCTION app.regrade_unqualified_leads()
RETURNS TABLE(contact_id bigint, moved_to text)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    WITH candidate AS (
        SELECT c.id,
               l.status                              AS lead_status,
               NULLIF(btrim(l.last_disposition), '') AS disposition
          FROM app.crm_contacts c
          JOIN app.call_center_leads l ON l.contact_id = c.id
         WHERE c.lead_stage = 'qualified'
           AND app.lead_qualified_by_machine(c.id)
           -- The whole test: did anyone, on any call, ever say they were interested?
           AND NOT EXISTS (
               SELECT 1 FROM app.call_center_dispositions d
                WHERE d.lead_id = l.id AND d.outcome = 'answered_interested')
    ),
    decided AS (
        SELECT id, disposition, lead_status,
               CASE
                 WHEN lead_status IN ('dnc', 'closed', 'invalid')              THEN 'disqualified'
                 WHEN lower(COALESCE(disposition, '')) LIKE '%not interested%' THEN 'disqualified'
                 ELSE 'contacted'
               END AS target
          FROM candidate
    ),
    moved AS (
        UPDATE app.crm_contacts c
           SET lead_stage        = d.target,
               stage_changed_at  = NOW(),
               updated_at        = NOW(),
               disqualified_at   = CASE WHEN d.target = 'disqualified' THEN NOW() ELSE c.disqualified_at END,
               disqualify_reason = CASE WHEN d.target = 'disqualified'
                                        THEN 'Call centre: ' || COALESCE(d.disposition, d.lead_status)
                                        ELSE c.disqualify_reason END
          FROM decided d
         WHERE d.id = c.id
        -- d.disposition added so the note can name the call outcome that caused this,
        -- which is the one thing an agent cannot work out from the timeline above it.
        RETURNING c.id, d.target, d.disposition
    ),
    logged AS (
        INSERT INTO app.crm_lead_events (contact_id, event, from_stage, to_stage, note, created_by)
        SELECT m.id, 'stage_regraded', 'qualified', m.target,
               app.regrade_note(m.target, m.disposition),
               NULL
          FROM moved m
        RETURNING 1
    )
    SELECT m.id, m.target FROM moved m;
END;
$$;

COMMENT ON FUNCTION app.regrade_unqualified_leads() IS
  'Moves out of qualified any machine-qualified lead where no call ever recorded '
  'answered_interested, and records why on each lead timeline via app.regrade_note(). '
  'Safe to run repeatedly. Wording lives in regrade_note, not here — migration 301.';

-- ── Rewrite what is already on screen ──────────────────────────────────────────
--
-- The last call's outcome is recovered out of migration 248's own sentence, which is the
-- only place it was ever stored. 298's rows never carried one, and regrade_note handles
-- that case.
CREATE TEMP TABLE m301 ON COMMIT DROP AS
SELECT e.id            AS event_id,
       e.contact_id,
       e.to_stage,
       substring(e.note from 'the last call recorded "([^"]*)"') AS last_disposition,
       e.note                                                    AS old_note,
       e.created_at
  FROM app.crm_lead_events e
 WHERE e.event = 'stage_regraded';

UPDATE app.crm_lead_events e
   SET note = app.regrade_note(m.to_stage, m.last_disposition)
  FROM m301 m
 WHERE e.id = m.event_id;

-- The mirrors. Matched on the contact and the stored note rather than on a foreign key,
-- because app.activities keeps no reference back to the crm_lead_events row it came from.
UPDATE app.activities a
   SET subject    = app.lead_event_subject('stage_regraded', m.to_stage),
       body       = app.regrade_note(m.to_stage, m.last_disposition),
       actor_name = 'System Rule',
       actor_team = NULL
  FROM m301 m
 WHERE a.type = 'stage_change'
   AND a.contact_id = m.contact_id
   AND a.body = m.old_note
   AND a.actor_user_id IS NULL;

DO $m301$
DECLARE
    n_events int; n_stale_ev int; n_acts int; n_stale_act int; n_staff int;
BEGIN
    SELECT COUNT(*) INTO n_events FROM m301;

    -- No stored note may still carry either of the old wordings.
    SELECT COUNT(*) INTO n_stale_ev FROM app.crm_lead_events
     WHERE event = 'stage_regraded'
       AND (note LIKE '%Re-graded%' OR note LIKE '%rule agreed 14 Sept%');
    IF n_stale_ev > 0 THEN
        RAISE EXCEPTION '301: % lead event(s) still carry the old wording — refusing', n_stale_ev;
    END IF;

    SELECT COUNT(*) INTO n_acts FROM app.activities
     WHERE subject IN ('Moved Out Of Qualified', 'Disqualified') AND actor_name = 'System Rule';
    SELECT COUNT(*) INTO n_stale_act FROM app.activities
     WHERE body LIKE '%Re-graded%' OR body LIKE '%rule agreed 14 Sept%' OR subject = 'Stage Regraded';
    IF n_stale_act > 0 THEN
        RAISE EXCEPTION '301: % timeline row(s) still read "Stage Regraded" or carry the '
            'old wording — refusing', n_stale_act;
    END IF;

    -- The point of the change: none of these may still look like a person did it.
    SELECT COUNT(*) INTO n_staff FROM app.activities
     WHERE subject IN ('Moved Out Of Qualified', 'Disqualified')
       AND actor_user_id IS NULL
       AND (actor_name IS NULL OR actor_team IS NOT NULL);
    IF n_staff > 0 THEN
        RAISE EXCEPTION '301: % row(s) would still render as a colleague — refusing', n_staff;
    END IF;

    RAISE NOTICE '301: % lead event(s) and % timeline row(s) rewritten; the qualification '
        'rule no longer signs its work with a colleague''s name', n_events, n_acts;
END $m301$;

COMMIT;
