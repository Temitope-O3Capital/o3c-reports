-- 331: Whether we got through, and what the customer said, are two facts. Two columns.
--
-- app.collection_contacts.outcome was taking BOTH, from two screens, in two vocabularies:
--
--   collections/AccountDetail.tsx  -> REACHABILITY, 7 snake_case codes from
--                                     lib/contactVocab.ts COLLECTION_CONTACT_OUTCOMES:
--                                     'answered', 'no_answer', 'not_reachable', ...
--   collections/Queue.tsx          -> a CALL DISPOSITION, 12 human-readable labels from
--                                     LogCallModal dispositionsFor('collections'):
--                                     'Promise to Pay', 'Says They Have Paid - To Verify', ...
--
-- Two separate defects, not one:
--
--   1. SAME FACT, TWO SPELLINGS. 'not_reachable' and 'Unreachable / No Answer' are one thing.
--      Any GROUP BY on outcome would have answered "how many could we not reach?" with two
--      rows, for ever, and invisibly -- neither value being wrong on its own.
--
--   2. TWO DIFFERENT FACTS, ONE COLUMN. 'answered' says the phone was picked up.
--      'Promise to Pay' says what was agreed. A customer who answered AND promised to pay
--      could only be recorded as one of them, so every contact silently discarded whichever
--      fact its screen did not carry.
--
-- I checked whether the queue's disposition was safely duplicated in the call log, which would
-- have made "keep reachability only" nearly free. It is NOT: Queue.tsx posts to
-- /api/collections-ops/{id}/contact, not the call-log endpoint, and says so in its own comment.
-- That disposition exists nowhere else, so dropping it would lose the richer fact.
--
-- WHY NOW. Both of these tables are still EMPTY -- 0 rows in collection_contacts. There is
-- nothing to convert and no report to restate. Once an agent logs the first contact, history
-- exists in a mixed vocabulary and cleaning it means GUESSING which kind of fact each old row
-- was. This is the cheapest this will ever be, which is the same reason migration 326 settled
-- the visit vocabulary.
--
-- WHICH REPRESENTATION. Codes, not labels, for two reasons. The sibling columns on this very
-- table (contact_type, and outcome itself) are snake_case codes, and mixing representations
-- inside one table is precisely the defect being removed here. And the code set can then be
-- the one Go already owns: ccDispositionsForPurpose("collections") in
-- handlers/call_center_dispositions.go, 15 codes, a clean superset of the 12 labels the screen
-- offers. One source, not a sixteenth copy.
--
-- NOT FIXED HERE, and worth its own decision: app.helpdesk_calls.disposition holds 201,000+
-- rows of the LABEL form ('Unreachable / No Answer'), while app.call_center_contacts
-- .disposition_code holds the code form. Two live representations of one vocabulary, and the Go
-- labels for two of them ("Callback Requested", "No Answer") do not even match the labels the
-- screen shows ("Callback Scheduled", "Unreachable / No Answer"). That is a real divergence,
-- but it spans a large table and is not free the way this one was.

BEGIN;

-- outcome can no longer be mandatory: the queue records a disposition and may know nothing
-- about reachability beyond it.
ALTER TABLE app.collection_contacts ALTER COLUMN outcome DROP NOT NULL;

ALTER TABLE app.collection_contacts ADD COLUMN IF NOT EXISTS disposition text;

COMMENT ON COLUMN app.collection_contacts.outcome IS
  'Did we reach the customer? snake_case code from COLLECTION_CONTACT_OUTCOMES / collectionContactOutcomes. NULL when the screen only knows the disposition.';
COMMENT ON COLUMN app.collection_contacts.disposition IS
  'What came of the contact? snake_case code from ccDispositionsForPurpose("collections"). NULL for a contact with no call result (an SMS send, say).';

-- Reachability vocabulary.
ALTER TABLE app.collection_contacts
  ADD CONSTRAINT collection_contacts_outcome_chk CHECK (
    outcome IS NULL OR outcome = ANY (ARRAY[
      'answered', 'no_answer', 'not_reachable',
      'promised_to_pay', 'broken_promise', 'refused_to_pay', 'wrong_number'
    ])
  );

-- Call-result vocabulary, mirroring ccDispositionsForPurpose("collections").
ALTER TABLE app.collection_contacts
  ADD CONSTRAINT collection_contacts_disposition_chk CHECK (
    disposition IS NULL OR disposition = ANY (ARRAY[
      'callback', 'ptp', 'call_dropped', 'no_answer', 'wrong_number', 'do_not_call',
      'call_rejected', 'payment_to_verify', 'not_yet_due', 'paid', 'dispute',
      'escalated', 'pending_followup', 'closed', 'other'
    ])
  );

-- A contact that records neither fact is not a contact.
ALTER TABLE app.collection_contacts
  ADD CONSTRAINT collection_contacts_says_something_chk CHECK (
    outcome IS NOT NULL OR disposition IS NOT NULL
  );

DO $g$
DECLARE
    v_rows      bigint;
    v_unvalid   int;
BEGIN
    SELECT count(*) INTO v_rows FROM app.collection_contacts;
    IF v_rows <> 0 THEN
        -- The whole justification for splitting the column without a data migration is that
        -- there is no data. If that has changed, this needs a backfill plan first.
        RAISE EXCEPTION '331: collection_contacts now holds % rows -- the free window has closed, '
                        'and these rows need classifying before the column can be split', v_rows;
    END IF;

    SELECT count(*) INTO v_unvalid FROM pg_constraint
     WHERE conrelid = 'app.collection_contacts'::regclass
       AND contype = 'c' AND NOT convalidated;
    IF v_unvalid <> 0 THEN
        RAISE EXCEPTION '331: % CHECK constraints on collection_contacts failed to validate', v_unvalid;
    END IF;

    RAISE NOTICE '331: outcome and disposition split; 4 CHECKs validated on an empty table';
END
$g$;

COMMIT;
