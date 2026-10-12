-- An approved collection payment must name who approved it.
--
-- 1,801 rows in app.collection_payments read status='approved' with approved_by and
-- approved_at both NULL, totalling 1,094,578,699.07 naira. That looked like money
-- walking through the HOP -> COO approval chain unsigned, so it was investigated
-- before anything was changed.
--
-- IT IS NOT A BYPASS. Every one of those rows is a documented historical import, and
-- no payment logged by a person has ever skipped the chain:
--
--   historical import   1,713 rows   278,135,500.07   card repayments backfilled from
--                                                     the card ledger (reference
--                                                     imp:cards-2026-07, GL refs
--                                                     COL-BACKFILL-*)
--   crm_import             88 rows   816,443,199.00   migration 212's load from LOAN
--                                                     REPAYMENT CRM.xlsx
--   GTB / FIDELITY / POLARIS 11 rows  106,393,555.56  logged by staff, and ALL of them
--                                                     are correctly still pending_hop
--
-- So the money is real and the controls were never circumvented. What is missing is
-- the DISTINCTION: nothing in the row says "this was imported as historical fact"
-- rather than "a person approved this", and the only way to tell them apart was to
-- string-match the channel. That is why the staff-performance attribution survey
-- reported 1,801 approvals belonging to nobody, and why an audit asking "who approved
-- this receipt" got silence instead of an answer.
--
-- This migration records the distinction and then makes the rule enforceable, so a
-- genuine approval can never again be written without an approver.
--
-- NO APPROVER IS INVENTED. approved_by stays NULL on the imports and approved_at is
-- not backdated: no person approved them, and writing a name or a timestamp in would
-- be fabricating an approval event to tidy up a column.

ALTER TABLE app.collection_payments
  ADD COLUMN IF NOT EXISTS is_imported boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.collection_payments.is_imported IS
  'True when the row was loaded as historical fact rather than logged and approved in the HOP -> COO chain. An imported row legitimately has no approved_by; a logged one must have it (see collection_payments_approved_names_approver).';

-- Provenance comes from the channel, which is what the two loaders stamped.
UPDATE app.collection_payments
   SET is_imported = true
 WHERE channel IN ('historical import', 'crm_import')
   AND is_imported = false;

DO $$
DECLARE
  unexplained bigint;
  imported    bigint;
  logged      bigint;
BEGIN
  -- The rule the constraint is about to enforce. Asserted BEFORE adding it so the
  -- migration fails loudly on a row nobody has accounted for, rather than the
  -- constraint failing with no explanation of which row or why.
  SELECT COUNT(*) INTO unexplained
    FROM app.collection_payments
   WHERE status = 'approved' AND approved_by IS NULL AND is_imported = false;

  IF unexplained > 0 THEN
    RAISE EXCEPTION
      '% approved payment(s) have no approver and are not a recognised import — that IS an unsigned approval and needs a human decision, not a constraint',
      unexplained;
  END IF;

  SELECT COUNT(*) INTO imported FROM app.collection_payments WHERE is_imported;
  SELECT COUNT(*) INTO logged
    FROM app.collection_payments WHERE status = 'approved' AND NOT is_imported;

  RAISE NOTICE
    'collection payments: % imported as historical fact, % approved by a person, 0 unsigned approvals',
    imported, logged;
END $$;

-- The rule, enforced from here on. An imported row may have no approver; anything
-- that reached 'approved' through the chain must name one.
--
-- Validated rather than NOT VALID, because the assertion above proves there is nothing
-- to grandfather. A NOT VALID check would also still reject UPDATEs to existing rows,
-- which is the trap that makes NOT VALID feel safer than it is.
ALTER TABLE app.collection_payments
  DROP CONSTRAINT IF EXISTS collection_payments_approved_names_approver;

ALTER TABLE app.collection_payments
  ADD CONSTRAINT collection_payments_approved_names_approver
  CHECK (status <> 'approved' OR approved_by IS NOT NULL OR is_imported);

-- Audit asks this question per receipt, so give it an index rather than a scan.
CREATE INDEX IF NOT EXISTS idx_collection_payments_approver
  ON app.collection_payments (approved_by, approved_at DESC)
  WHERE approved_by IS NOT NULL;
