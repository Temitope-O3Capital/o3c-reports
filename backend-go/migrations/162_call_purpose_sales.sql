-- 162_call_purpose_sales.sql
--
-- Fixes a live 500 on logging a call.
--
-- The Log-a-Call form offers four purposes — Support / Service, Marketing /
-- Leads, Outbound Sales, Collections — and carries a whole disposition list for
-- the sales book. The CHECK constraint on helpdesk_calls.purpose allows
-- collections, marketing, support, retention and other. It does not allow
-- 'sales'.
--
-- So every call an agent logged as Outbound Sales failed on
-- helpdesk_calls_purpose_chk, and the handler surfaced it as a bare "Internal
-- server error" with nothing to act on. The form and the table simply disagreed
-- about the vocabulary.
--
-- 'sales' is a real book: an outbound sales call is not a marketing blast and not
-- a support call, the disposition lists already differ, and the queue reports on
-- them separately. So the constraint is widened rather than the option removed.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.helpdesk_calls DROP CONSTRAINT IF EXISTS helpdesk_calls_purpose_chk;

ALTER TABLE app.helpdesk_calls
  ADD CONSTRAINT helpdesk_calls_purpose_chk
  CHECK (purpose IS NULL OR purpose IN
    ('collections', 'marketing', 'sales', 'support', 'retention', 'other'));

-- The outbound queue describes the same books and must not drift from the call
-- ledger; widen it the same way if it carries its own constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app.call_center_contacts'::regclass
      AND conname  = 'call_center_contacts_purpose_chk'
  ) THEN
    ALTER TABLE app.call_center_contacts DROP CONSTRAINT call_center_contacts_purpose_chk;
    ALTER TABLE app.call_center_contacts
      ADD CONSTRAINT call_center_contacts_purpose_chk
      CHECK (purpose IS NULL OR purpose IN
        ('collections', 'marketing', 'sales', 'support', 'retention', 'other'));
  END IF;
END $$;
