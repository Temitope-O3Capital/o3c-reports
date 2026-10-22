-- rollback_392.sql
--
-- Drops the management desk spine.
--
-- READ THIS BEFORE RUNNING IT. app.management_notes is an append-only management record. By
-- the time anyone reaches for this rollback it may hold comments an MD left on a named
-- officer's week and that officer's replies, and dropping the table destroys both halves of
-- a conversation about a person. There is no soft version of that.
--
-- So the first statement is a guard, not a DROP: if any note survives that is not a probe
-- row, this refuses and tells you how many. Export them first, then set the guard aside
-- deliberately if you still mean it. A rollback that quietly deletes somebody's record of
-- being managed is worse than one that makes you stop and look.

BEGIN;

DO $guard$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM app.management_notes WHERE subject_key <> 'probe';
    IF n > 0 THEN
        RAISE EXCEPTION 'rollback 392: % real management notes would be destroyed. Export them '
            '(SELECT * FROM app.management_notes) and remove this guard block only if you '
            'genuinely intend to lose them.', n;
    END IF;

    SELECT count(*) INTO n FROM app.management_reviews WHERE subject_key <> 'probe';
    IF n > 0 THEN
        RAISE EXCEPTION 'rollback 392: % real review records would be destroyed. Export them '
            'before removing this guard.', n;
    END IF;
END
$guard$;

-- Order follows the foreign keys: notes and reviews both point at the registry, and notes
-- point at themselves for threading, which the table drop takes care of.
DROP TABLE IF EXISTS app.management_notes;
DROP TABLE IF EXISTS app.management_reviews;
DROP TABLE IF EXISTS app.management_subject_types;

-- The trigger went with its table; the function it called did not.
DROP FUNCTION IF EXISTS app.management_note_is_append_only();

DO $check$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n
      FROM information_schema.tables
     WHERE table_schema = 'app'
       AND table_name IN ('management_notes', 'management_reviews', 'management_subject_types');
    IF n <> 0 THEN
        RAISE EXCEPTION 'rollback 392: % of the three tables survive', n;
    END IF;

    SELECT count(*) INTO n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'app' AND p.proname = 'management_note_is_append_only';
    IF n <> 0 THEN
        RAISE EXCEPTION 'rollback 392: the append-only trigger function survives';
    END IF;
END
$check$;

DELETE FROM app.schema_migrations
 WHERE btrim(filename, chr(13)) = '392_a_figure_nobody_can_answer_is_not_a_report.sql';

COMMIT;
