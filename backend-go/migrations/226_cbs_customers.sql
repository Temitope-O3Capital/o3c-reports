-- 226: snapshot of the Udara360 CUSTOMER master (individual + corporate).
--
-- Until now the CBS sync only spooled the loan and fixed-deposit books. Those feeds
-- carry a customer NAME but no contact detail, so Udara-only customers landed in the
-- workspace as a bare name with no phone, email or address — and customers who hold
-- no facility yet never arrived at all.
--
-- Udara's own customer endpoints (SearchIndividualCustomers / SearchGroupCustomers)
-- DO expose full PII: phone, email, address, state/LGA, BVN/NIN, date of birth,
-- gender, next-of-kin, and (for corporates) contact person + registration detail.
-- This table mirrors that master, keyed by Udara's customerID (== cbs_customer_id on
-- cbs_loans / cbs_fixed_deposits — the SAME namespace, so it joins cleanly to the
-- book, unlike the card-feed app.customers.cif which is a different id space).
--
-- Read-only mirror: refreshed by the cbssync worker, never written by workflows.
-- app.customers is enriched from this table (fill-blanks only) so contact detail
-- flows into Collections / Recovery / Customer-360 without clobbering card-fed data.

CREATE TABLE IF NOT EXISTS cbs_customers (
    cbs_customer_id       text PRIMARY KEY,          -- Udara customerID (== cbs_loans.cbs_customer_id)
    cbs_id                text,                       -- Udara record GUID
    customer_type         text,                       -- Individual | Corporate
    name                  text,
    title                 text,
    first_name            text,
    last_name             text,
    other_names           text,
    phone                 text,
    email                 text,
    address               text,
    city                  text,                       -- hometown
    state                 text,
    lga                   text,
    nationality           text,
    bvn                   text,
    nin                   text,
    tin                   text,
    date_of_birth         date,
    gender                text,
    marital_status        text,
    occupation            text,
    employer_name         text,
    employer_address      text,
    office_phone          text,
    means_of_id           text,
    id_number             text,
    -- next of kin (individuals)
    nok_name              text,
    nok_phone             text,
    nok_relationship      text,
    -- corporate fields
    business_phone        text,
    nature_of_business    text,
    industrial_sector     text,
    registration_number   text,
    contact_person_name   text,
    contact_person_phone  text,
    state_of_operation    text,
    pep                   boolean,
    raw                   jsonb,
    synced_at             timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cbs_customers_bvn   ON cbs_customers (bvn)   WHERE bvn   IS NOT NULL AND bvn   <> '';
CREATE INDEX IF NOT EXISTS idx_cbs_customers_phone ON cbs_customers (phone) WHERE phone IS NOT NULL AND phone <> '';
