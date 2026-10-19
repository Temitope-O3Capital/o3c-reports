-- A scheduled report can say what it is.
--
-- Every report email went out with a subject this code built itself --
-- "Report: <name> (2026-10-19)" -- and there was no way to change it. For a report that
-- lands in the same inbox every morning that is the one line the recipient reads, and a
-- sender could not write it. The body was slightly better off: an ad-hoc send could
-- carry a `message` already, but nothing stored it, so the instant the same report was
-- put on a schedule the note disappeared. reports_saved.go passed "" for the message on
-- every scheduled send because there was nowhere to read one from.
--
-- So this adds the two columns a schedule needs to send the same mail a person would
-- send by hand:
--
--   subject  -- overrides the generated subject when set; blank keeps today's default,
--              so every existing schedule and every caller that omits it is unchanged.
--   message  -- the note that already renders above the inline preview on ad-hoc sends.
--
-- BOTH ARE NULLABLE WITH NO DEFAULT, which is what makes this safe to deploy under a
-- running binary: the old code never names these columns, and an INSERT that omits them
-- leaves NULL, which the new code reads as "use the default subject, send no note".
--
-- Also adds `attach`, because the choice of whether to attach is not the same as the
-- choice of format. A daily summary of twelve rows is fully readable in the inline
-- preview the body already renders, and attaching a spreadsheet to it just gives
-- everyone a file to file. It defaults TRUE so nothing silently stops attaching.
--
-- Deliberately NOT added: a dashboard schedule. A dashboard cannot be rendered to a file
-- on the server at all today (its PDF is window.print() in the browser), so a column to
-- schedule one would be a promise the code cannot keep.

BEGIN;

ALTER TABLE app.pivot_report_schedules
    ADD COLUMN IF NOT EXISTS subject text,
    ADD COLUMN IF NOT EXISTS message text,
    ADD COLUMN IF NOT EXISTS attach  boolean NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN app.pivot_report_schedules.subject IS
    'Overrides the generated email subject when set; NULL or blank keeps the default.';
COMMENT ON COLUMN app.pivot_report_schedules.message IS
    'Optional note rendered above the inline preview in the email body.';
COMMENT ON COLUMN app.pivot_report_schedules.attach IS
    'FALSE sends the inline preview only, with no file attached.';

-- A subject long enough to be truncated by every mail client is not a subject. 200 is
-- generous against the ~78 characters most clients show, and it is a guard against a
-- paste of the whole report, not a style rule.
ALTER TABLE app.pivot_report_schedules
    DROP CONSTRAINT IF EXISTS pivot_report_schedules_subject_len;
ALTER TABLE app.pivot_report_schedules
    ADD CONSTRAINT pivot_report_schedules_subject_len
    CHECK (subject IS NULL OR length(subject) <= 200);

DO $$
BEGIN
    -- The columns exist and are nullable, because a NOT NULL here would break every
    -- INSERT the currently-running binary makes.
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'app' AND table_name = 'pivot_report_schedules'
                  AND column_name IN ('subject', 'message') AND is_nullable = 'NO') THEN
        RAISE EXCEPTION 'subject and message must stay nullable or the running binary cannot insert a schedule';
    END IF;

    IF (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'pivot_report_schedules'
           AND column_name IN ('subject', 'message', 'attach')) <> 3 THEN
        RAISE EXCEPTION 'expected all three columns to exist after this migration';
    END IF;

    -- attach must be TRUE everywhere it already existed, or a live schedule would
    -- quietly stop attaching its file.
    IF EXISTS (SELECT 1 FROM app.pivot_report_schedules WHERE attach IS NOT TRUE) THEN
        RAISE EXCEPTION 'an existing schedule came out of this migration not attaching';
    END IF;
END $$;

COMMIT;
