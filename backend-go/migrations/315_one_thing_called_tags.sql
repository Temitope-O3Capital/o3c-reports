-- 315: drop crm_contacts.tags, so there is one thing called tags.
--
-- Migration 314 gave leads real labels in app.crm_lead_tags and deliberately left the old
-- crm_contacts.tags text column alone. That was the wrong call, and the consequence became
-- visible as soon as the label UI shipped: the contact page renders a "Tags" row from this
-- column that is blank on all 32,579 rows, one click away from a working Labels section on
-- the lead drawer. Two fields with the same name, one of which can never have a value, is
-- worse than one — a reader cannot tell which is authoritative, and the blank one reads as
-- missing data rather than as a field nobody uses.
--
-- It is also a second place a label could start being written. It sat in two update
-- whitelists (crm.go contactUpdateCols and the sales PATCH list) and in createContact's
-- INSERT, so any caller could have begun populating it, at which point the platform would
-- have had two disagreeing answers to "what is this lead tagged".
--
-- WHY DROPPING LOSES NOTHING. The column is text, not an array, so it never had set
-- semantics: filtering it meant a LIKE scan in which 'hot' matches 'not-hot'. It has been
-- NULL or empty on every row since it was created — 0 of 32,579 — so there is no data to
-- migrate into crm_lead_tags. Verified immediately below rather than asserted, because a
-- DROP COLUMN on a populated column is not recoverable from the rollback script.
--
-- The six code references go in the same commit: contactUpdateCols, createContact's body
-- struct and INSERT, the customer360 SELECT, the sales PATCH whitelist, and the contact
-- page's interface and InfoRow.

DO $m315$
DECLARE
    v_populated bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'crm_contacts' AND column_name = 'tags'
    ) THEN
        RAISE NOTICE '315: crm_contacts.tags is already gone.';
        RETURN;
    END IF;

    -- The guard that makes this safe. If anyone has started writing to the column since
    -- this migration was written, STOP: that content has to be moved into crm_lead_tags
    -- first, and a DROP here would destroy it.
    SELECT count(*) INTO v_populated
      FROM app.crm_contacts WHERE tags IS NOT NULL AND btrim(tags) <> '';
    IF v_populated > 0 THEN
        RAISE EXCEPTION '315: % contacts now carry a value in crm_contacts.tags. Move them '
                        'into app.crm_lead_tags before dropping the column.', v_populated;
    END IF;

    EXECUTE 'ALTER TABLE app.crm_contacts DROP COLUMN tags';
    RAISE NOTICE '315: crm_contacts.tags dropped (was empty on every row). Labels live in '
                 'app.crm_lead_tags.';
END
$m315$;
