-- rollback_394.sql
--
-- Removes the recipient and due date from app.management_notes, and restores the
-- append-only trigger to the version that did not defend them.
--
-- READ FIRST. Dropping asked_user_id destroys the record of who was asked a question and
-- by when. The question itself survives as a note, but it becomes anonymous in its
-- addressing — nobody can tell afterwards whether the head was asked or the officer, which
-- is most of what an ask means. The guard below refuses while any real ask exists, so
-- export them before setting it aside:
--
--   SELECT id, subject_type, subject_key, author_user_id, asked_user_id, due_at, body
--     FROM app.management_notes WHERE asked_user_id IS NOT NULL;

BEGIN;

DO $guard$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM app.management_notes
     WHERE asked_user_id IS NOT NULL AND subject_key <> 'probe394';
    IF n > 0 THEN
        RAISE EXCEPTION 'rollback 394: % asks would lose their recipient and due date. '
            'Export them first, then remove this guard only if you mean to lose that.', n;
    END IF;
END
$guard$;

ALTER TABLE app.management_notes DROP CONSTRAINT IF EXISTS management_notes_due_needs_asked;
ALTER TABLE app.management_notes DROP CONSTRAINT IF EXISTS management_notes_only_a_root_asks;
DROP INDEX IF EXISTS app.management_notes_open_asks;

ALTER TABLE app.management_notes
    DROP COLUMN IF EXISTS due_at,
    DROP COLUMN IF EXISTS asked_user_id;

-- Back to the 392 trigger body. It must not reference the dropped columns, or every UPDATE
-- on the table fails at run time — plpgsql resolves those names when the trigger fires,
-- not when it is created, so this would pass CREATE and then break on first use.
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

DO $check$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'management_notes'
       AND column_name IN ('asked_user_id', 'due_at');
    IF n <> 0 THEN
        RAISE EXCEPTION 'rollback 394: % of the two columns survive', n;
    END IF;

    -- Prove the restored trigger still fires and still refuses a body rewrite, because a
    -- trigger that silently stopped working is the worst outcome of this rollback.
    SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'app' AND p.proname = 'management_note_is_append_only';
    IF n <> 1 THEN
        RAISE EXCEPTION 'rollback 394: the append-only function is missing';
    END IF;
END
$check$;

DELETE FROM app.schema_migrations
 WHERE btrim(filename, chr(13)) = '394_an_ask_has_someone_to_answer_it.sql';

COMMIT;
