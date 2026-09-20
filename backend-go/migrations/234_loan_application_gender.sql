-- Gender on a loan application — the last field the origination form collects
-- and throws away.
--
-- Migration 216 rescued BVN, NIN, date of birth, address, job title and
-- employment type from exactly this fate. Gender was missed: the form marks it
-- **required** (NewApplication.tsx refuses to advance without it) and renders it
-- back on the review step, but app.loan_applications has no column for it, so
-- the value dies at the API boundary. Staff are made to supply a mandatory field
-- that is then discarded, with no error to show it.
--
-- Worth having beyond tidiness: gender is populated for only 795 of 21,309
-- customers (3.7%), and the 15-minute cust_file feed has no gender field at all
-- — verified against the retained drops, where no value in any of the 12 fields
-- ever matches M/F/Male/Female. So the origination form is one of only three
-- routes by which this attribute can ever improve, the others being the Udara
-- CBS sync (currently 292 customers) and a BVN-keyed bureau lookup.
--
-- Free text, not an enum: the existing app.customers.gender is text and already
-- holds 'Male', 'Female' and the junk values '0' and '1' from the MSSQL
-- baseline. A CHECK constraint here would be stricter than the column this
-- feeds into, and would reject the form's own value if the option list changes.
ALTER TABLE app.loan_applications
  ADD COLUMN IF NOT EXISTS gender text;

COMMENT ON COLUMN app.loan_applications.gender IS
  'Applicant gender as collected on the origination form (required there). Free text to match app.customers.gender. Never an input to a credit decision — see the FCRA/CBN protected-attribute exclusion in the scoring model.';
