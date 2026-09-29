-- 304 — A lead converts onto a PRODUCT, not onto a card.
--
-- WHY. convertLead required a card CIF and refused anything else:
--
--     if req.CIF == ""  → 400 "cif is required to convert a lead"
--     not in customers  → 400 "the customer must exist in the card system"
--
-- app.customers is the CARD book, and CIF is a cards identifier — it is not the same
-- key as a Udara customerID or a party_id, and joining them gives a different person.
-- So a lead who took a salary loan or opened a fixed deposit could not be converted at
-- all: they have no card, therefore no CIF, therefore no way to close the lead. The
-- officer's only options were to leave a won deal sitting open in the queue for ever,
-- or to type in somebody else's CIF to make the form submit.
--
-- The workspace already has the three product lines this business actually sells —
-- cards, loans, fixed_deposit (handlers/products.go, mirrored in lib/products.ts) — and
-- already has a canonical person in app.parties. Conversion is rebuilt on both: the
-- lead converts on a LINE, carries the reference appropriate to that line, and is
-- pinned to a party regardless of which line it was.
--
--     cards          → converted_ref is the CIF, checked against app.customers
--     loans          → the Udara loan account number, checked against app.cbs_loans
--     fixed_deposit  → the Udara FD account number, checked against app.cbs_fixed_deposits
--
-- party_id is what makes the record answer "who is this customer?" in a way that
-- survives them later taking a second product on a different line. converted_cif is
-- kept and still written for cards, so everything already reading it keeps working.
--
-- BACKFILL. Every one of the 1,447 historical conversions carrying a CIF is a card
-- conversion by definition — a CIF is a card identifier and there was no other way to
-- convert — so they are stamped line='cards' with their existing CIF as the reference.
-- The 10 that converted with no CIF are left with a NULL line rather than guessed at:
-- they are the rows repaired by migration 302, and inventing a product for them would
-- be inventing a sale.
--
-- REVERSIBLE: additive columns only. rollback/rollback_304.sql drops them.

ALTER TABLE app.crm_contacts
    ADD COLUMN IF NOT EXISTS converted_line text,
    ADD COLUMN IF NOT EXISTS converted_ref  text;

COMMENT ON COLUMN app.crm_contacts.converted_line IS
  'Which product line the lead converted on: cards | loans | fixed_deposit. NULL on '
  'historical rows that converted before the line was recorded.';

COMMENT ON COLUMN app.crm_contacts.converted_ref IS
  'The identifier for the converted product, in the namespace of its own line: a card '
  'CIF for cards, a Udara account number for loans and fixed deposits. Deliberately NOT '
  'a single shared id — CIF, Udara customerID and party_id are different namespaces and '
  'joining across them returns a different person.';

-- The line vocabulary, so a typo cannot create a fourth product line by accident.
ALTER TABLE app.crm_contacts
    DROP CONSTRAINT IF EXISTS crm_contacts_converted_line_chk;
ALTER TABLE app.crm_contacts
    ADD CONSTRAINT crm_contacts_converted_line_chk
    CHECK (converted_line IS NULL OR converted_line IN ('cards', 'loans', 'fixed_deposit'));

-- A line without a reference is a conversion nobody can trace back to a product.
ALTER TABLE app.crm_contacts
    DROP CONSTRAINT IF EXISTS crm_contacts_converted_ref_chk;
ALTER TABLE app.crm_contacts
    ADD CONSTRAINT crm_contacts_converted_ref_chk
    CHECK (converted_line IS NULL OR NULLIF(btrim(converted_ref), '') IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_converted_line
    ON app.crm_contacts (converted_line, converted_at DESC)
    WHERE converted_line IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Backfill: historical conversions were cards, because nothing else was possible.
-- ---------------------------------------------------------------------------

UPDATE app.crm_contacts
   SET converted_line = 'cards',
       converted_ref  = converted_cif,
       updated_at     = NOW()
 WHERE lead_stage = 'converted'
   AND converted_line IS NULL
   AND NULLIF(btrim(converted_cif), '') IS NOT NULL;

-- Every converted lead should resolve to a party, so the customer is identifiable even
-- where the product reference is missing. ensure_lead_party (migration 253) reuses an
-- existing party where the contact already matches one and only creates where it must.
SELECT app.ensure_lead_party(id)
  FROM app.crm_contacts
 WHERE lead_stage = 'converted' AND party_id IS NULL;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

DO $m304$
DECLARE
    v_cards      bigint;
    v_unstamped  bigint;
    v_no_party   bigint;
BEGIN
    SELECT count(*) INTO v_cards
      FROM app.crm_contacts WHERE converted_line = 'cards';
    IF v_cards = 0 THEN
        RAISE EXCEPTION '304: no historical conversion was stamped as a card sale.';
    END IF;

    -- Anything converted, carrying a CIF, and still without a line means the backfill
    -- missed rows it should have caught.
    SELECT count(*) INTO v_unstamped
      FROM app.crm_contacts
     WHERE lead_stage = 'converted'
       AND NULLIF(btrim(converted_cif), '') IS NOT NULL
       AND converted_line IS NULL;
    IF v_unstamped > 0 THEN
        RAISE EXCEPTION '304: % converted leads with a CIF were left unstamped.', v_unstamped;
    END IF;

    SELECT count(*) INTO v_no_party
      FROM app.crm_contacts WHERE lead_stage = 'converted' AND party_id IS NULL;
    IF v_no_party > 0 THEN
        RAISE NOTICE
          '304: % converted leads still resolve to no party (ensure_lead_party could not '
          'place them, usually no usable phone). They convert fine; they just are not '
          'linked to a person record.', v_no_party;
    END IF;

    RAISE NOTICE '304: % historical conversions stamped as card sales. Loans and fixed '
                 'deposits can now be converted too.', v_cards;
END
$m304$;
