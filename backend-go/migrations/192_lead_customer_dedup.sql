-- ─────────────────────────────────────────────────────────────────────────────
-- Drop already-customers out of the lead queue.
--
-- A chunk of the Zoho-imported contacts are people who are already customers — they
-- do not belong in the "leads to win" queue. Match a lead to the customer book by
-- normalised phone (app.normalise_ng_phone → 0 + last 10 digits) against app.customers
-- (the person-level SoT the conversion path already trusts). Flag the matches so the
-- queue can hide them; keep the matched CIF so an officer can jump to the customer.
--
-- NB: match on the normalised phone only — do NOT filter on customers.phone_was_fake,
-- which is unreliable (it misses the biggest placeholders yet wrongly drops ~73 real
-- matches). Placeholder numbers happen not to collide with any live lead, so the raw
-- match is clean.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE app.crm_contacts
  ADD COLUMN IF NOT EXISTS already_customer     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS matched_customer_cif text,
  ADD COLUMN IF NOT EXISTS customer_matched_at  timestamptz;

-- One-time flag of the current matches (~166). Re-runnable: the handler
-- rescanCustomerLeads runs the same statement for customers that arrive later.
UPDATE app.crm_contacts c
   SET already_customer     = true,
       matched_customer_cif = (
         SELECT cu.cif FROM app.customers cu
          WHERE app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone)
          ORDER BY cu.cif LIMIT 1),
       customer_matched_at  = now()
 WHERE c.lead_stage <> 'converted'
   AND COALESCE(c.already_customer, false) = false
   AND app.normalise_ng_phone(c.phone) IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM app.customers cu
      WHERE app.normalise_ng_phone(cu.phone) = app.normalise_ng_phone(c.phone));

CREATE INDEX IF NOT EXISTS idx_crm_contacts_already_customer
  ON app.crm_contacts (already_customer) WHERE already_customer;
