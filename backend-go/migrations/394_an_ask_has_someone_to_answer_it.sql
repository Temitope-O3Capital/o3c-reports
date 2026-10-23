-- 394_an_ask_has_someone_to_answer_it.sql
--
-- The management desk shipped with an "Ask — and get an answer" button whose own helper
-- text said it "creates an owned question with an answer due". It did neither. Ask and
-- Comment both opened the same text box, and the note that came out had no recipient, no
-- due date and nobody notified beyond the officer the subject happened to be about. The
-- copy described behaviour that was never written.
--
-- Two columns make it real.
--
-- asked_user_id is WHO owes the answer, and it is not the same person as the subject. A
-- question about an officer's week is usually asked OF THEIR HEAD — "why has nobody picked
-- these up?" — so addressing it to the subject would send it to the one person who cannot
-- answer it. Nullable, because a plain comment addresses nobody and that is a different
-- kind of note, not a defective one.
--
-- due_at is when the answer is expected. Also nullable: an open question with no date is
-- still a question, and inventing a deadline nobody agreed to is worse than having none.
-- What the date buys is the ability to say "overdue", which is the only thing that makes an
-- unanswered question visible later.
--
-- NOT added: a separate 'ask' row type. The thread already distinguishes a root from a
-- reply, and status already carries open/answered — an ask IS a root note with a recipient.
-- A parallel type would mean two code paths that have to stay in step about what answering
-- means.

BEGIN;

ALTER TABLE app.management_notes
    ADD COLUMN IF NOT EXISTS asked_user_id bigint REFERENCES app.o3c_users(id),
    ADD COLUMN IF NOT EXISTS due_at        timestamptz;

COMMENT ON COLUMN app.management_notes.asked_user_id IS
    'Who owes the answer. NULL for a plain comment. Not the subject of the note: a question '
    'about an officer''s week is normally asked of their head.';
COMMENT ON COLUMN app.management_notes.due_at IS
    'When the answer is expected. NULL is legitimate — an open question with no date is '
    'still a question.';

-- Only a thread ROOT can be an ask. A reply answers; it does not ask on someone else's
-- behalf, and allowing a recipient on a reply would make "who owes this answer" ambiguous
-- the moment two replies named two different people.
ALTER TABLE app.management_notes
    DROP CONSTRAINT IF EXISTS management_notes_only_a_root_asks;
ALTER TABLE app.management_notes
    ADD CONSTRAINT management_notes_only_a_root_asks CHECK (
        thread_root_id IS NULL OR (asked_user_id IS NULL AND due_at IS NULL));

-- A due date without a recipient has nobody to be due from.
ALTER TABLE app.management_notes
    DROP CONSTRAINT IF EXISTS management_notes_due_needs_asked;
ALTER TABLE app.management_notes
    ADD CONSTRAINT management_notes_due_needs_asked CHECK (
        due_at IS NULL OR asked_user_id IS NOT NULL);

-- The question someone owes me, and the question I owe someone: both are lookups by
-- person over open roots, which is exactly what the desk and the officer's own page ask.
CREATE INDEX IF NOT EXISTS management_notes_open_asks
    ON app.management_notes (asked_user_id, due_at)
 WHERE thread_root_id IS NULL AND status = 'open' AND asked_user_id IS NOT NULL;

-- The append-only trigger must defend the new columns too, or the record of who was asked
-- and by when could be rewritten after the fact — which is precisely the kind of edit the
-- trigger exists to refuse.
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
       OR COALESCE(NEW.thread_root_id, -1) <> COALESCE(OLD.thread_root_id, -1)
       OR COALESCE(NEW.asked_user_id, -1)  <> COALESCE(OLD.asked_user_id, -1)
       OR COALESCE(NEW.due_at, 'epoch'::timestamptz) <> COALESCE(OLD.due_at, 'epoch'::timestamptz) THEN
        RAISE EXCEPTION 'app.management_notes is append-only: note % cannot be rewritten '
            '(only status may change)', OLD.id;
    END IF;
    RETURN NEW;
END;
$fn$;

DO $probe$
DECLARE
    v_user bigint;
    v_root bigint;
    v_ok   boolean;
BEGIN
    SELECT id INTO v_user FROM app.o3c_users WHERE deleted_at IS NULL ORDER BY id LIMIT 1;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'migration 394: no user to probe with';
    END IF;

    -- An ask: root, with a recipient and a date.
    INSERT INTO app.management_notes
        (subject_type, subject_key, author_user_id, body, asked_user_id, due_at)
    VALUES ('sales_officer_week', 'probe394', v_user, 'probe ask', v_user, now() + interval '2 days')
    RETURNING id INTO v_root;

    -- A due date with nobody to answer it must be refused.
    v_ok := false;
    BEGIN
        INSERT INTO app.management_notes
            (subject_type, subject_key, author_user_id, body, due_at)
        VALUES ('sales_officer_week', 'probe394', v_user, 'dateless', now());
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 394: a due date with no recipient was accepted';
    END IF;

    -- A REPLY may not carry a recipient.
    v_ok := false;
    BEGIN
        INSERT INTO app.management_notes
            (subject_type, subject_key, thread_root_id, author_user_id, body, asked_user_id)
        VALUES ('sales_officer_week', 'probe394', v_root, v_user, 'reply', v_user);
    EXCEPTION WHEN check_violation THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 394: a reply was allowed to ask somebody';
    END IF;

    -- The recipient cannot be rewritten afterwards.
    v_ok := false;
    BEGIN
        UPDATE app.management_notes SET asked_user_id = NULL WHERE id = v_root;
    EXCEPTION WHEN others THEN v_ok := true;
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'migration 394: the asked recipient was rewritten; append-only does not hold';
    END IF;

    -- Marking it answered still works, because that is the thread's state, not its content.
    UPDATE app.management_notes SET status = 'answered' WHERE id = v_root;
    IF (SELECT status FROM app.management_notes WHERE id = v_root) <> 'answered' THEN
        RAISE EXCEPTION 'migration 394: an ask could not be marked answered';
    END IF;

    DELETE FROM app.management_notes WHERE subject_key = 'probe394';
    IF EXISTS (SELECT 1 FROM app.management_notes WHERE subject_key = 'probe394') THEN
        RAISE EXCEPTION 'migration 394: probe rows survived cleanup';
    END IF;
END
$probe$;

INSERT INTO app.schema_migrations (filename)
VALUES ('394_an_ask_has_someone_to_answer_it.sql')
ON CONFLICT DO NOTHING;

COMMIT;
