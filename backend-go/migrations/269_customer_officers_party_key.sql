-- 269 — app.customer_officers is keyed by a Udara id in a column called `cif`.
--       Re-key it so a cards join cannot silently resolve to the wrong person.
--
-- WHAT IS WRONG. Every one of the 201 rows was written by the CBS sync (source='cbs',
-- 2026-08-26 to 2026-09-18) with Udara's customerID in a column named `cif`. CIF is a
-- CARDS identifier. All 201 of those ids ALSO exist as a live cards CIF, 183 of them
-- carry real card accounts, and — measured, not estimated — the party the Udara id
-- resolves to has a DIFFERENT NAME from the card customer at that id in **201 of 201**
-- cases. So the column is 100% mislabelled.
--
-- The damage is not theoretical. handlers/sales_applications.go joins
--     FROM app.customers c LEFT JOIN customer_officers o ON o.cif = c.cif
-- to decide which officer owns a loan applicant. Against this table that join reads a
-- Udara borrower's officer and attaches it to whichever CARD customer happens to share
-- the digits. handlers/overview.go and handlers/sales.go were already moved off this
-- table for exactly this reason (see their comments); sales_applications.go was missed.
--
-- THE FIX, in the same shape migration 267 used for collections:
--   * `party_id` — the workspace Customer ID, the key that actually unifies people.
--     Resolved through app.cbs_links, the only sanctioned bridge. Verified: all 201
--     resolve, 0 dangling, and they map 1:1 onto 201 DISTINCT parties, so a party-keyed
--     join cannot fan out.
--   * `udara_customer_id` — the Udara id, kept verbatim, in a column that says so.
--   * `cif` is rewritten to 'UD-' || <udara id>. It cannot be NULLed: it is the PRIMARY
--     KEY and NOT NULL. Prefixing achieves the same safety — every cards CIF is exactly
--     8 characters and all digits (verified across 21,852 rows: min=max=8, 0
--     non-numeric), so a 'UD-…' key can NEVER equal one. A stray cards join now resolves
--     to NULL — visibly nameless, which someone reports — instead of silently to a
--     stranger.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not invent cards rows. handlers/crm.go and
-- handlers/sales_book.go write genuine cards-CIF rows through the CRM and sales-book
-- assignment flows (source 'converted'/'manual'); there are none today, and after this
-- migration their `WHERE cif=$1` lookups simply will not match a Udara row — which is
-- correct, because they are looking for a card customer's officer.
--
-- REVERSIBLE. Every original value is copied to app.customer_officer_rekey_audit first.
-- Nothing is deleted. Idempotent: rows already carrying a 'UD-' key are skipped.

BEGIN;

CREATE TABLE IF NOT EXISTS app.customer_officer_rekey_audit (
    id                bigserial PRIMARY KEY,
    old_cif           text        NOT NULL,
    new_cif           text        NOT NULL,
    udara_customer_id text,
    party_id          bigint,
    officer_id        bigint,
    source            text,
    udara_name        text,   -- who the Udara id actually is
    card_name         text,   -- who a cards join WOULD have named
    card_accounts     bigint, -- how many real card accounts sat behind that wrong name
    rekeyed_at        timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.customer_officer_rekey_audit IS
    'Before/after record of migration 269, which moved app.customer_officers off a Udara '
    'customer id stored in a column named `cif` onto party_id. Holds the name a cards '
    'join would have produced, so the scale of the previous mis-attribution stays on '
    'record. Never delete: this is the evidence.';

ALTER TABLE app.customer_officers
    ADD COLUMN IF NOT EXISTS party_id          bigint,
    ADD COLUMN IF NOT EXISTS udara_customer_id text;

COMMENT ON COLUMN app.customer_officers.party_id IS
    'The workspace Customer ID (app.parties.party_id) — the correct key to join on.';
COMMENT ON COLUMN app.customer_officers.udara_customer_id IS
    'Udara360 customerID, verbatim, for rows sourced from core banking. NOT a CIF.';
COMMENT ON COLUMN app.customer_officers.cif IS
    'PRIMARY KEY. A cards CIF for rows assigned through the CRM or sales book; '
    '''UD-''||udara_customer_id for rows sourced from Udara core banking, which have no '
    'CIF at all. Never join this to app.customers.cif without checking the prefix — see '
    'migration 269.';

-- The provable set: a CBS-sourced row whose id resolves through cbs_links.
CREATE TEMP TABLE co_rekey ON COMMIT DROP AS
SELECT co.cif AS old_cif,
       'UD-' || co.cif AS new_cif,
       co.cif AS udara_id,
       lk.entity_id AS party_id,
       co.officer_id,
       co.source,
       COALESCE(NULLIF(btrim(cc.name), ''), NULLIF(btrim(p.full_name), '')) AS udara_name,
       NULLIF(btrim(concat_ws(' ', cu.first_name, cu.last_name)), '')       AS card_name,
       (SELECT count(*) FROM app.accounts a WHERE a.cif = co.cif)           AS card_accounts
  FROM app.customer_officers co
  JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.cbs_customer_id = co.cif
  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = co.cif
  LEFT JOIN app.parties p        ON p.party_id = lk.entity_id
  LEFT JOIN app.customers cu     ON cu.cif = co.cif
 WHERE co.cif NOT LIKE 'UD-%';

INSERT INTO app.customer_officer_rekey_audit
    (old_cif, new_cif, udara_customer_id, party_id, officer_id, source,
     udara_name, card_name, card_accounts)
SELECT old_cif, new_cif, udara_id, party_id, officer_id, source,
       udara_name, card_name, card_accounts
  FROM co_rekey;

UPDATE app.customer_officers co
   SET cif               = r.new_cif,
       udara_customer_id = r.udara_id,
       party_id          = r.party_id
  FROM co_rekey r
 WHERE co.cif = r.old_cif;

CREATE INDEX IF NOT EXISTS idx_customer_officers_party
    ON app.customer_officers (party_id) WHERE party_id IS NOT NULL;

DO $$
DECLARE n int; wrong int; parties int;
BEGIN
    SELECT count(*) INTO n      FROM app.customer_officers WHERE cif LIKE 'UD-%';
    SELECT count(*) INTO wrong  FROM app.customer_officer_rekey_audit
                                WHERE card_name IS NOT NULL AND udara_name IS DISTINCT FROM card_name;
    SELECT count(DISTINCT party_id) INTO parties FROM app.customer_officers WHERE party_id IS NOT NULL;
    RAISE NOTICE '269: % officer rows re-keyed to Udara identity across % distinct parties; % of them would previously have named a different person via a cards join', n, parties, wrong;
END $$;

COMMIT;
