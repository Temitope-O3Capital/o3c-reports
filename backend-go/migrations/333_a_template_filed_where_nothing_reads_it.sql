-- 333: A template filed under a category nothing reads simply stops being sent.
--
-- app.message_templates.category had a Go whitelist (templateCategories) that DOES match both
-- screens -- general / collections / marketing / onboarding / repayment_reminder. I had recorded
-- this as "three conflicting category lists"; that was wrong, and checking it was the fix for
-- that claim rather than for the code.
--
-- The real gap was that the rule was enforced on ONE of the two write paths. createTemplate
-- checks the category (quietly coercing an unknown one to 'general'); updateTemplate built its
-- SET clause straight from templateUpdateCols, which includes 'category', and validated
-- NOTHING. So a PATCH could file a template under any string at all.
--
-- Why that is not cosmetic: collections_dunning.go selects
--     FROM app.message_templates WHERE category = 'collections'
-- and reports "no collections template configured" when it finds none. A collections template
-- re-categorised by an edit -- to a typo, or to 'general' -- stops being sent to delinquent
-- customers, and the only symptom is a worker heartbeat saying idle. Nothing errors.
--
-- updateTemplate now returns 422 instead of silently accepting, and this CHECK means neither
-- path can drift from the other again. 7 rows today (6 collections, 1 marketing), both already
-- valid, so there is nothing to convert.
--
-- NOT fixed here, and worth a thought: 'repayment_reminder' is in the vocabulary but the dunning
-- worker only reads 'collections'. A reminder template filed under the obvious category would
-- never be picked up. That is a question about what the worker should read, not about the
-- vocabulary, so it is left alone rather than guessed at.

BEGIN;

ALTER TABLE app.message_templates
  ADD CONSTRAINT message_templates_category_chk CHECK (
    category IS NULL OR category = ANY (ARRAY[
      'general', 'collections', 'marketing', 'onboarding', 'repayment_reminder'
    ])
  );

DO $g$
DECLARE
    v_bad   int;
    v_rows  bigint;
    v_valid boolean;
BEGIN
    SELECT count(*) INTO v_bad FROM app.message_templates
     WHERE category IS NOT NULL
       AND category NOT IN ('general','collections','marketing','onboarding','repayment_reminder');
    IF v_bad <> 0 THEN
        RAISE EXCEPTION '333: % templates hold a category outside the vocabulary', v_bad;
    END IF;

    -- The dunning worker needs at least one collections template to have anything to send.
    -- Not an error if it is missing, but worth saying out loud during a migration.
    SELECT count(*) INTO v_rows FROM app.message_templates WHERE category = 'collections';
    IF v_rows = 0 THEN
        RAISE WARNING '333: no template is categorised collections -- the dunning worker will idle';
    END IF;

    SELECT convalidated INTO v_valid FROM pg_constraint
     WHERE conrelid = 'app.message_templates'::regclass
       AND conname  = 'message_templates_category_chk';
    IF v_valid IS DISTINCT FROM true THEN
        RAISE EXCEPTION '333: category CHECK did not validate';
    END IF;

    RAISE NOTICE '333: category CHECK validated; % collections templates', v_rows;
END
$g$;

COMMIT;
