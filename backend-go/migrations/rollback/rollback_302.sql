-- Rollback for 302_a_lead_is_in_sales_or_it_is_not
--
-- Order matters: undo the two data repairs FIRST, while the events that record what
-- they changed still exist, then drop the columns. Dropping first would still work but
-- leaves no way to check the repairs reversed cleanly.
--
-- NOTE ON WHAT THIS RESTORES. Reversing the repairs puts the book back into the broken
-- state 302 found: 127 qualified leads with no qualified_at, and 10 leads that are a
-- customer and an open lead at once. That is the point of a rollback, but it is worth
-- knowing before running it — the two repairs are independent of the ownership columns,
-- so if only the Leads-page change needs reverting, run just Part three.

-- --- Part one: un-reconcile the converted leads -----------------------------------
UPDATE app.crm_contacts c
   SET status = 'lead', updated_at = NOW()
  FROM app.crm_lead_events e
 WHERE e.contact_id = c.id
   AND e.event = 'status_reconciled'
   AND c.lead_stage = 'converted'
   AND c.status = 'customer';

DELETE FROM app.crm_lead_events WHERE event = 'status_reconciled';

-- --- Part two: un-backfill qualified_at ------------------------------------------
UPDATE app.crm_contacts c
   SET qualified_at = NULL, updated_at = NOW()
  FROM app.crm_lead_events e
 WHERE e.contact_id = c.id
   AND e.event = 'qualified_at_backfilled';

DELETE FROM app.crm_lead_events WHERE event = 'qualified_at_backfilled';

-- --- Part three: drop the Sales ownership columns ---------------------------------
-- Additive columns, so this is a clean drop. Any lead a sales officer claimed or was
-- transferred since the deploy loses that claim — the transfer history survives in
-- crm_lead_events(from_owner,to_owner), which this does not touch, so the claims can
-- be replayed if 302 is re-applied.
ALTER TABLE app.crm_contacts
    DROP CONSTRAINT IF EXISTS crm_contacts_sales_owner_needs_entry;

DROP INDEX IF EXISTS app.idx_crm_contacts_sales_pool;
DROP INDEX IF EXISTS app.idx_crm_contacts_sales_owner;

ALTER TABLE app.crm_contacts
    DROP COLUMN IF EXISTS sales_source,
    DROP COLUMN IF EXISTS sales_entered_at,
    DROP COLUMN IF EXISTS sales_owner_id;
