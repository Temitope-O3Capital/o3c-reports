-- 392_a_figure_nobody_can_answer_is_not_a_report.sql
--
-- The spine of the management desk: things that need a judgement, the judgement itself, and
-- the conversation about it. Three objects, built generic on purpose, because Sales is the
-- first module through here and Collections, Recovery and Cards are meant to cost a day each
-- rather than a sprint each.
--
-- THE ONE RULE THAT MATTERS. A note's visibility is NOT stored. It derives from the subject
-- it hangs on, through management_subject_types.page_keys, which is the same shape as
-- reportDatasetPages in handlers/report_access.go -- entitlement computed from the pages a
-- viewer holds rather than from a parallel list. A second access list beside the first always
-- drifts from it, and the drift is invisible until someone reads something they should not.
-- So there is deliberately no visibility column here to get wrong.
--
-- WHY THE REGISTRY IS A TABLE AND NOT A GO MAP. is_active is the switch that lets management
-- turn a subject type off. An inbox that never empties is a backlog wearing an inbox's
-- clothes and it stops being opened, so being able to silence a type without a deploy is
-- part of the design rather than an afterthought.

BEGIN;

-- ---------------------------------------------------------------------------------------
-- The registry. One row per kind of thing management can be asked to look at.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.management_subject_types (
    subject_type   text PRIMARY KEY,
    module         text        NOT NULL,
    label          text        NOT NULL,
    -- Any one of these page keys is enough to see a subject of this type, and therefore its
    -- notes and its review state. Empty would mean "visible to nobody", which is never what
    -- anyone means, so it is refused.
    page_keys      text[]      NOT NULL CHECK (cardinality(page_keys) > 0),
    -- What may be done to a subject of this type. 'approve' is listed only where the viewer
    -- genuinely is the approver; the Go layer still checks that, this records the intent.
    verbs          text[]      NOT NULL CHECK (cardinality(verbs) > 0),
    -- Plain English, for the admin screen: what puts a subject of this type on the desk.
    raised_when    text        NOT NULL,
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT management_subject_types_verbs_known CHECK (
        verbs <@ ARRAY['comment', 'acknowledge', 'ask', 'escalate', 'approve']::text[])
);

COMMENT ON TABLE app.management_subject_types IS
    'Registry of things management can review. page_keys is the ONLY input to who may see a '
    'subject of this type, its notes and its review state -- never a per-note access list.';

-- ---------------------------------------------------------------------------------------
-- The review state. One row per subject per period.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.management_reviews (
    id            bigserial PRIMARY KEY,
    subject_type  text        NOT NULL REFERENCES app.management_subject_types(subject_type),
    -- Opaque by design: an officer id, a case id, a team id, a composite. The registry says
    -- how to read it; this table does not care.
    subject_key   text        NOT NULL,
    -- A period is optional because not every subject has one. A week of an officer's work
    -- does; a recovery case does not.
    period_start  date,
    period_end    date,
    state         text        NOT NULL DEFAULT 'needs_review',
    reviewer_user_id bigint   REFERENCES app.o3c_users(id),
    reviewed_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT management_reviews_state_known CHECK (
        state IN ('needs_review', 'reviewed', 'acknowledged', 'escalated', 'closed')),
    -- A state past needs_review was reached by somebody, at some time. Without this a row
    -- can claim it was reviewed with nobody's name on it, which is the one thing a review
    -- record must never be able to say.
    CONSTRAINT management_reviews_reviewed_has_reviewer CHECK (
        state = 'needs_review'
        OR (reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
    CONSTRAINT management_reviews_period_ordered CHECK (
        period_start IS NULL OR period_end IS NULL OR period_end >= period_start)
);

-- One review per subject per period. COALESCE on the date because NULL never equals NULL and
-- a plain unique index would happily allow a thousand review rows for a periodless subject.
CREATE UNIQUE INDEX IF NOT EXISTS management_reviews_one_per_subject_period
    ON app.management_reviews (subject_type, subject_key, COALESCE(period_start, '0001-01-01'::date));

CREATE INDEX IF NOT EXISTS management_reviews_open
    ON app.management_reviews (subject_type, state) WHERE state <> 'closed';

-- ---------------------------------------------------------------------------------------
-- The conversation. Append-only.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.management_notes (
    id             bigserial PRIMARY KEY,
    subject_type   text        NOT NULL REFERENCES app.management_subject_types(subject_type),
    subject_key    text        NOT NULL,
    period_start   date,
    period_end     date,
    -- NULL on the first note of a thread, that note's id on every reply. Self-referencing so
    -- a reply can never be orphaned from the thread it answers.
    thread_root_id bigint      REFERENCES app.management_notes(id) ON DELETE CASCADE,
    author_user_id bigint      NOT NULL REFERENCES app.o3c_users(id),
    body           text        NOT NULL CHECK (btrim(body) <> ''),
    -- Only meaningful on a thread root. An 'open' thread asked something and has not been
    -- answered; without this a head answers in person and the MD never learns they did.
    status         text        NOT NULL DEFAULT 'open',
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT management_notes_status_known CHECK (status IN ('open', 'answered', 'closed')),
    CONSTRAINT management_notes_reply_has_no_status CHECK (
        thread_root_id IS NULL OR status = 'open')
);

CREATE INDEX IF NOT EXISTS management_notes_by_subject
    ON app.management_notes (subject_type, subject_key, created_at DESC);

CREATE INDEX IF NOT EXISTS management_notes_thread
    ON app.management_notes (thread_root_id) WHERE thread_root_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS management_notes_open_threads
    ON app.management_notes (subject_type, status) WHERE thread_root_id IS NULL AND status = 'open';

-- Append-only, enforced rather than documented. This becomes a performance-management record
-- the moment the first comment lands on an officer's week, and a record whose text can be
-- quietly rewritten afterwards is worth nothing to the person it is about. status may move
-- (open -> answered) because that is the thread's state, not its content.
CREATE OR REPLACE FUNCTION app.management_note_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF NEW.body <> OLD.body
       OR NEW.author_user_id <> OLD.author_user_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.subject_type <> OLD.subject_type
       OR NEW.subject_key <> OLD.subject_key
       OR COALESCE(NEW.thread_root_id, -1) <> COALESCE(OLD.thread_root_id, -1) THEN
        RAISE EXCEPTION 'app.management_notes is append-only: note % cannot be rewritten '
            '(only status may change)', OLD.id;
    END IF;
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_management_note_append_only ON app.management_notes;
CREATE TRIGGER trg_management_note_append_only
    BEFORE UPDATE ON app.management_notes
    FOR EACH ROW EXECUTE FUNCTION app.management_note_is_append_only();

-- ---------------------------------------------------------------------------------------
-- The first subject type. One, deliberately: the model is proved end to end on this before
-- a second is added. page_keys mirrors what opens the Sales module today, so a sales head
-- sees their own team's weeks and management sees all of them, with no new gate invented.
-- ---------------------------------------------------------------------------------------
INSERT INTO app.management_subject_types
    (subject_type, module, label, page_keys, verbs, raised_when)
VALUES
    ('sales_officer_week', 'sales', 'An officer''s week',
     ARRAY['sales', 'sales_team']::text[],
     ARRAY['comment', 'acknowledge', 'ask', 'escalate']::text[],
     'An officer logged no activity across a full working week, counted from '
     || 'app.v_sales_officer_days and excluding leave, declared holidays and weekends '
     || 'through app.available_working_days.')
ON CONFLICT (subject_type) DO NOTHING;

-- ---------------------------------------------------------------------------------------
-- Assertions. Existence proves nothing; each of these probes a behaviour.
-- ---------------------------------------------------------------------------------------
DO $probe$
DECLARE
    v_root bigint;
    v_reply bigint;
    v_user bigint;
    v_ok boolean;
BEGIN
    SELECT id INTO v_user FROM app.o3c_users WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'migration 392: no user to author a probe note with';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app.management_subject_types WHERE subject_type = 'sales_officer_week') THEN
        RAISE EXCEPTION 'migration 392: the first subject type was not registered';
    END IF;

    -- An unknown subject_type must be refused, because that FK is what keeps a note
    -- attached to a registry entry that says who may read it.
    v_ok := false;
    BEGIN
        INSERT INTO app.management_notes (subject_type, subject_key, author_user_id, body)
        VALUES ('a_type_that_does_not_exist', '1', v_user, 'probe');
    EXCEPTION WHEN foreign_key_violation THEN
        v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 392: a note on an unregistered subject type was accepted';
    END IF;

    -- A real thread, and a reply to it.
    INSERT INTO app.management_notes (subject_type, subject_key, period_start, period_end,
                                      author_user_id, body)
    VALUES ('sales_officer_week', 'probe', date '2026-10-19', date '2026-10-25',
            v_user, 'probe root')
    RETURNING id INTO v_root;

    INSERT INTO app.management_notes (subject_type, subject_key, thread_root_id,
                                      author_user_id, body)
    VALUES ('sales_officer_week', 'probe', v_root, v_user, 'probe reply')
    RETURNING id INTO v_reply;

    -- The body cannot be rewritten.
    v_ok := false;
    BEGIN
        UPDATE app.management_notes SET body = 'rewritten' WHERE id = v_root;
    EXCEPTION WHEN others THEN
        v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 392: a note body was rewritten; the append-only trigger does not hold';
    END IF;

    -- The status still can.
    UPDATE app.management_notes SET status = 'answered' WHERE id = v_root;
    IF (SELECT status FROM app.management_notes WHERE id = v_root) <> 'answered' THEN
        RAISE EXCEPTION 'migration 392: a thread root could not be marked answered';
    END IF;

    -- A review that claims it was reviewed by nobody must be refused.
    v_ok := false;
    BEGIN
        INSERT INTO app.management_reviews (subject_type, subject_key, state)
        VALUES ('sales_officer_week', 'probe', 'reviewed');
    EXCEPTION WHEN check_violation THEN
        v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 392: a review was accepted with no reviewer and no time';
    END IF;

    -- A properly attributed one is accepted, and only one per subject per period.
    INSERT INTO app.management_reviews (subject_type, subject_key, period_start, period_end,
                                        state, reviewer_user_id, reviewed_at)
    VALUES ('sales_officer_week', 'probe', date '2026-10-19', date '2026-10-25',
            'reviewed', v_user, now());

    v_ok := false;
    BEGIN
        INSERT INTO app.management_reviews (subject_type, subject_key, period_start, period_end,
                                            state, reviewer_user_id, reviewed_at)
        VALUES ('sales_officer_week', 'probe', date '2026-10-19', date '2026-10-25',
                'acknowledged', v_user, now());
    EXCEPTION WHEN unique_violation THEN
        v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 392: a second review was accepted for the same subject and period';
    END IF;

    -- Clean up after the probe. The cascade takes the reply with the root.
    DELETE FROM app.management_reviews WHERE subject_key = 'probe';
    DELETE FROM app.management_notes   WHERE subject_key = 'probe';

    IF EXISTS (SELECT 1 FROM app.management_notes WHERE subject_key = 'probe')
       OR EXISTS (SELECT 1 FROM app.management_reviews WHERE subject_key = 'probe') THEN
        RAISE EXCEPTION 'migration 392: probe rows survived their own cleanup';
    END IF;
END
$probe$;

INSERT INTO app.schema_migrations (filename)
VALUES ('392_a_figure_nobody_can_answer_is_not_a_report.sql')
ON CONFLICT DO NOTHING;

COMMIT;
