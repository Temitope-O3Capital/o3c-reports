-- 258 — Carry Udara360 identity/KYC data into the workspace customer record.
--
-- Two defects this closes, both rooted in the same namespace confusion:
--
-- 1. cbssync.upsertUdaraCustomers wrote the Udara *customerID* into app.customers.cif —
--    a CARDS identifier — and ended with ON CONFLICT (cif) DO NOTHING. 269 of the 294
--    Udara customer ids already existed in app.customers as mssql_baseline CARD rows
--    belonging to unrelated people, so the insert silently did nothing. It had created
--    18 rows ever, and only 31 of 294 Udara customers had a workspace profile at all.
--    Customer 360 reads app.customers by party_id, so the other 263 showed nothing.
--
--    The three namespaces, kept straight from here on:
--      app.parties.party_id            the workspace Customer ID — the unifying key
--      app.customers.cif               a CARDS id (CCS/Sage). NOT a customer id.
--      cbs_customers.cbs_customer_id   Udara360 core-banking only
--    app.cbs_links (entity_type='party') is the only correct bridge, and it already
--    covers 294/294 Udara customers.
--
-- 2. enrichCustomersFromCBS backfilled 9 fields because app.customers had nowhere to
--    put the rest. The Udara master carries NIN (91 customers), next-of-kin (85),
--    means of ID (102), marital status (108), LGA (146), occupation (63), employer (55)
--    and a PEP flag on all 294 — none of which reached the workspace.
--
-- Additive and reversible: every new column is nullable, and rows created here are
-- identifiable by source='udara_cbs' AND cif IS NULL. Nothing existing is overwritten
-- or deleted — the backfill is blank-only.

BEGIN;

-- ── 1. Identity / KYC columns ────────────────────────────────────────────────
-- Named to match cbs_customers so the enrichment mapping stays one-to-one and obvious.
-- `country` and `job_title` already exist and mean the postal country and the card
-- feed's job title, so nationality and occupation are kept separate rather than
-- overloaded onto them.
ALTER TABLE app.customers
    ADD COLUMN IF NOT EXISTS nin                   text,
    ADD COLUMN IF NOT EXISTS tin                   text,
    ADD COLUMN IF NOT EXISTS lga                   text,
    ADD COLUMN IF NOT EXISTS nationality           text,
    ADD COLUMN IF NOT EXISTS marital_status        text,
    ADD COLUMN IF NOT EXISTS occupation            text,
    ADD COLUMN IF NOT EXISTS employer_name         text,
    ADD COLUMN IF NOT EXISTS employer_address      text,
    ADD COLUMN IF NOT EXISTS office_phone          text,
    ADD COLUMN IF NOT EXISTS means_of_id           text,
    ADD COLUMN IF NOT EXISTS id_number             text,
    ADD COLUMN IF NOT EXISTS nok_name              text,
    ADD COLUMN IF NOT EXISTS nok_phone             text,
    ADD COLUMN IF NOT EXISTS nok_relationship      text,
    ADD COLUMN IF NOT EXISTS business_phone        text,
    ADD COLUMN IF NOT EXISTS nature_of_business    text,
    ADD COLUMN IF NOT EXISTS industrial_sector     text,
    ADD COLUMN IF NOT EXISTS registration_number   text,
    ADD COLUMN IF NOT EXISTS contact_person_name   text,
    ADD COLUMN IF NOT EXISTS contact_person_phone  text,
    ADD COLUMN IF NOT EXISTS state_of_operation    text,
    ADD COLUMN IF NOT EXISTS religion              text,
    ADD COLUMN IF NOT EXISTS hometown              text,
    ADD COLUMN IF NOT EXISTS pep                   boolean;

COMMENT ON COLUMN app.customers.pep IS
    'Politically-exposed-person flag from the Udara360 customer master. Sensitive: '
    'treat alongside bvn/nin/birthday for access control.';

-- ── 2. A profile for every Udara customer that has none ──────────────────────
-- Keyed on party_id, the workspace Customer ID. cif stays NULL — these customers hold
-- no card, and writing a Udara id into the cards column is the defect above.
-- uq_customers_cif is partial (WHERE cif IS NOT NULL AND cif <> ''), so NULL is free
-- and any number of rows may carry it.
--
-- Only for parties with NO existing profile. Where app.link_cbs_customers merged a
-- Udara customer into an existing card party on a unique BVN, that party already has a
-- richer card-fed row and must keep it — section 3 fills that row's blanks instead.
--
-- contact_id: 'U' + 15-digit zero-padded Udara id = 16 chars, matching the existing
-- width. Prefixes in use are '0' (baseline), 'Z' (card feed) and 'W'; 'U' is free.
-- DISTINCT ON guards the case of two Udara customers linked to one party: the fuller
-- name wins, and the second is reached through cbs_links regardless.
INSERT INTO app.customers
    (contact_id, cif, party_id, full_name, first_name, last_name,
     source, first_seen_at, created_at, last_seen)
SELECT DISTINCT ON (l.entity_id)
    'U' || LPAD(cc.cbs_customer_id, 15, '0'),
    NULL,
    l.entity_id,
    NULLIF(btrim(cc.name), ''),
    NULLIF(btrim(cc.first_name), ''),
    NULLIF(btrim(cc.last_name), ''),
    'udara_cbs', NOW(), NOW(), NOW()
  FROM app.cbs_links l
  JOIN app.cbs_customers cc ON cc.cbs_customer_id = l.cbs_customer_id
 WHERE l.entity_type = 'party'
   AND NOT EXISTS (SELECT 1 FROM app.customers c WHERE c.party_id = l.entity_id)
 ORDER BY l.entity_id, length(COALESCE(btrim(cc.name), '')) DESC
ON CONFLICT (contact_id) DO NOTHING;

-- ── 3. Backfill the identity fields onto every linked profile ────────────────
-- Blank-only, exactly as enrichCustomersFromCBS does it: the card feed is richer for
-- the customers it covers and must never be overwritten by the CBS master. Routed
-- through cbs_links -> party_id, NEVER a cif join.
UPDATE app.customers cu SET
    phone                = COALESCE(NULLIF(btrim(cu.phone),''),                NULLIF(btrim(cc.phone),'')),
    email                = COALESCE(NULLIF(btrim(cu.email),''),                NULLIF(btrim(cc.email),'')),
    address_1            = COALESCE(NULLIF(btrim(cu.address_1),''),            NULLIF(btrim(cc.address),'')),
    full_address         = COALESCE(NULLIF(btrim(cu.full_address),''),         NULLIF(btrim(cc.address),'')),
    city                 = COALESCE(NULLIF(btrim(cu.city),''),                 NULLIF(btrim(cc.city),'')),
    state                = COALESCE(NULLIF(btrim(cu.state),''),                NULLIF(btrim(cc.state),'')),
    bvn                  = COALESCE(NULLIF(btrim(cu.bvn),''),                  NULLIF(btrim(cc.bvn),'')),
    birthday             = COALESCE(cu.birthday,                               cc.date_of_birth),
    gender               = COALESCE(NULLIF(btrim(cu.gender),''),               NULLIF(btrim(cc.gender),'')),
    nin                  = COALESCE(NULLIF(btrim(cu.nin),''),                  NULLIF(btrim(cc.nin),'')),
    tin                  = COALESCE(NULLIF(btrim(cu.tin),''),                  NULLIF(btrim(cc.tin),'')),
    lga                  = COALESCE(NULLIF(btrim(cu.lga),''),                  NULLIF(btrim(cc.lga),'')),
    nationality          = COALESCE(NULLIF(btrim(cu.nationality),''),          NULLIF(btrim(cc.nationality),'')),
    marital_status       = COALESCE(NULLIF(btrim(cu.marital_status),''),       NULLIF(btrim(cc.marital_status),'')),
    occupation           = COALESCE(NULLIF(btrim(cu.occupation),''),           NULLIF(btrim(cc.occupation),'')),
    employer_name        = COALESCE(NULLIF(btrim(cu.employer_name),''),        NULLIF(btrim(cc.employer_name),'')),
    employer_address     = COALESCE(NULLIF(btrim(cu.employer_address),''),     NULLIF(btrim(cc.employer_address),'')),
    office_phone         = COALESCE(NULLIF(btrim(cu.office_phone),''),         NULLIF(btrim(cc.office_phone),'')),
    means_of_id          = COALESCE(NULLIF(btrim(cu.means_of_id),''),          NULLIF(btrim(cc.means_of_id),'')),
    id_number            = COALESCE(NULLIF(btrim(cu.id_number),''),            NULLIF(btrim(cc.id_number),'')),
    nok_name             = COALESCE(NULLIF(btrim(cu.nok_name),''),             NULLIF(btrim(cc.nok_name),'')),
    nok_phone            = COALESCE(NULLIF(btrim(cu.nok_phone),''),            NULLIF(btrim(cc.nok_phone),'')),
    nok_relationship     = COALESCE(NULLIF(btrim(cu.nok_relationship),''),     NULLIF(btrim(cc.nok_relationship),'')),
    business_phone       = COALESCE(NULLIF(btrim(cu.business_phone),''),       NULLIF(btrim(cc.business_phone),'')),
    nature_of_business   = COALESCE(NULLIF(btrim(cu.nature_of_business),''),   NULLIF(btrim(cc.nature_of_business),'')),
    industrial_sector    = COALESCE(NULLIF(btrim(cu.industrial_sector),''),    NULLIF(btrim(cc.industrial_sector),'')),
    registration_number  = COALESCE(NULLIF(btrim(cu.registration_number),''),  NULLIF(btrim(cc.registration_number),'')),
    contact_person_name  = COALESCE(NULLIF(btrim(cu.contact_person_name),''),  NULLIF(btrim(cc.contact_person_name),'')),
    contact_person_phone = COALESCE(NULLIF(btrim(cu.contact_person_phone),''), NULLIF(btrim(cc.contact_person_phone),'')),
    state_of_operation   = COALESCE(NULLIF(btrim(cu.state_of_operation),''),   NULLIF(btrim(cc.state_of_operation),'')),
    religion             = COALESCE(NULLIF(btrim(cu.religion),''),             NULLIF(btrim(cc.religion),'')),
    hometown             = COALESCE(NULLIF(btrim(cu.hometown),''),             NULLIF(btrim(cc.hometown),'')),
    -- PEP is a risk flag, not contact detail: once flagged it stays flagged, and a
    -- workspace value of NULL takes whatever the master says.
    pep                  = COALESCE(cu.pep, FALSE) OR COALESCE(cc.pep, FALSE),
    last_seen            = NOW()
  FROM app.cbs_links l
  JOIN app.cbs_customers cc ON cc.cbs_customer_id = l.cbs_customer_id
 WHERE l.entity_type = 'party'
   AND cu.party_id = l.entity_id;

COMMIT;
