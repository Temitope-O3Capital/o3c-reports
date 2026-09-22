-- 270 — Two corrections that both come from the same root cause: a CIF was treated as
--       a customer id.
--
-- ── 1. app.credit_customer_ids attributes every Udara loan to the wrong party ───
--
-- Migration 220 built the view with:
--     LEFT JOIN cbs_loans ul ON ul.cbs_customer_id = COALESCE(NULLIF(c.cif,''), c.contact_id)
--
-- That is the forbidden join. `cbs_customer_id` is a Udara360 identifier and `cif` is a
-- CARDS identifier; they share an 8-digit shape and nothing else. 289 of the 295 Udara
-- ids also exist as a live cards CIF and 94% of those belong to a different real person.
--
-- Measured on production 2026-09-22, comparing the view's join against the correct one
-- through app.cbs_links:
--     the view produces      41 party-to-loan pairs
--     cbs_links produces     41 party-to-loan pairs
--     pairs the two AGREE on  0
-- Not "mostly wrong" — wrong in every single case, N938,743,267.65 of loan exposure
-- hung on parties who do not owe it. The view is dormant today (no handler reads it;
-- only migration 220 references it), which is the only reason this has not surfaced as
-- a visible number. It is rebuilt here before something starts reading it.
--
-- The rewrite routes BOTH Udara columns through app.cbs_links — the curated crosswalk
-- that is the only sanctioned bridge between the namespaces — and keeps `cifs` sourced
-- from app.customers, where a CIF genuinely belongs. cbs_links.cbs_account_number is
-- blank on all 295 rows (it links customers, never accounts), so udara_loan_accounts is
-- now taken from the loans actually reached through the link rather than from that
-- empty column.
--
-- ── 2. Fifteen businesses are filed as people ──────────────────────────────────
--
-- party_type disagrees with Udara's customer_type on 15 linked parties. Reading the
-- names settles it — every one of the 15 is a business:
--
--   11 typed 'person', Udara says Corporate:  FINTRAK, G3 GARDEN, FOLTI TECHNOLOGIES,
--      BUNGALOW RESTAURANT, EDWARDS COSMETICS, GLISTER HOME APPLIANCES, GOKE DOUBLE
--      AUTOS, INTERIOR BAZAR NIGERIA, OMEGA UNIVERSAL COLLECTION, THIERRY TECHNOLOGY,
--      VITAL RELIEF WELLNESS.  -> the workspace is wrong, Udara is right.
--    4 typed 'organization', Udara says Individual:  GAB NUELLA CONCEPT LTD, INVESTMENT
--      LIMITED FAHOMI, KALI ENERGY, PATCOM-MAJ LIMITED.  -> Udara is wrong, the
--      workspace is right.
--
-- So this is NOT "copy Udara's value over": in 4 of the 15 that would make things worse.
-- The correct answer in both directions is 'organization', and that is what is written.
-- Neither source is trusted blindly; the name is the evidence.
--
-- In practice 11 rows CHANGE. The other 4 already carry 'organization', which is already
-- correct, so they are left untouched and Udara's 'Individual' stays deliberately
-- contradicted. A residual "party_type disagrees with Udara" check will therefore keep
-- reporting 4 after this runs — that is the intended end state, not unfinished work.
--
-- The one GroupJoint party typed 'person' is deliberately LEFT ALONE — a joint account
-- of individuals is genuinely ambiguous and there is exactly one of them.
--
-- Reversible: app.party_type_correction_audit holds every before value.

BEGIN;

-- ── 1. Rebuild the view on the correct crosswalk ─────────────────────────────
CREATE OR REPLACE VIEW app.credit_customer_ids AS
SELECT p.party_id,
       'CUST-'::text || lpad(p.party_id::text, 6, '0'::text) AS customer_id,
       max(p.full_name) AS full_name,
       array_remove(array_agg(DISTINCT NULLIF(c.cif, ''::text)), NULL::text)   AS cifs,
       array_remove(array_agg(DISTINCT lk.cbs_customer_id), NULL::text)        AS udara_customer_ids,
       array_remove(array_agg(DISTINCT ul.cbs_account_number), NULL::text)     AS udara_loan_accounts
  FROM app.parties p
  LEFT JOIN app.customers c  ON c.party_id = p.party_id
  -- app.cbs_links is the ONLY sanctioned bridge from a party to Udara. Never reach the
  -- Udara tables through a CIF: see the header.
  LEFT JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.entity_id = p.party_id
  LEFT JOIN app.cbs_loans ul ON ul.cbs_customer_id = lk.cbs_customer_id
                            AND ul.status <> ALL (ARRAY['Closed'::text, 'Revoked'::text])
 GROUP BY p.party_id;

COMMENT ON VIEW app.credit_customer_ids IS
    'One row per party: the Customer ID, every cards CIF the party holds, and every Udara '
    'customer id and live loan account reached THROUGH app.cbs_links. Migration 270 '
    'replaced a join of cbs_loans.cbs_customer_id to customers.cif, which agreed with the '
    'correct attribution on 0 of 41 pairs and hung N938,743,267.65 on the wrong parties. '
    'Never join a CIF to a Udara id.';

-- ── 2. Businesses filed as people ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.party_type_correction_audit (
    id              bigserial PRIMARY KEY,
    party_id        bigint      NOT NULL,
    party_name      text,
    udara_name      text,
    old_party_type  text,
    new_party_type  text,
    udara_type      text,
    reason          text        NOT NULL,
    corrected_at    timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.party_type_correction_audit IS
    'Before/after record of migration 270''s party_type corrections. Holds what each '
    'source claimed, so a later disagreement can be judged rather than re-guessed.';

CREATE TEMP TABLE pt_fix ON COMMIT DROP AS
SELECT p.party_id,
       btrim(p.full_name)  AS party_name,
       btrim(cc.name)      AS udara_name,
       p.party_type        AS old_type,
       cc.customer_type    AS udara_type
  FROM app.cbs_links lk
  JOIN app.parties p        ON p.party_id = lk.entity_id
  JOIN app.cbs_customers cc ON cc.cbs_customer_id = lk.cbs_customer_id
 WHERE lk.entity_type = 'party'
   AND p.party_type IS DISTINCT FROM 'organization'
   AND ( (p.party_type = 'person'       AND cc.customer_type = 'Corporate')
      OR (p.party_type = 'organization' AND cc.customer_type = 'Individual') );

INSERT INTO app.party_type_correction_audit
    (party_id, party_name, udara_name, old_party_type, new_party_type, udara_type, reason)
SELECT party_id, party_name, udara_name, old_type, 'organization', udara_type,
       'migration 270: the two sources disagreed on entity type and the registered name '
       || 'is a business, so both are resolved to organization rather than either source '
       || 'being copied over the other'
  FROM pt_fix;

UPDATE app.parties p
   SET party_type = 'organization'
  FROM pt_fix f
 WHERE p.party_id = f.party_id;

DO $$
DECLARE n int; pairs int; agree int;
BEGIN
    SELECT count(*) INTO n FROM app.party_type_correction_audit
     WHERE corrected_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO pairs FROM app.credit_customer_ids v, unnest(v.udara_customer_ids) u;
    SELECT count(*) INTO agree FROM app.cbs_links lk
      JOIN app.cbs_loans l ON l.cbs_customer_id = lk.cbs_customer_id
     WHERE lk.entity_type = 'party' AND l.status NOT IN ('Closed','Revoked');
    RAISE NOTICE '270: % parties re-typed to organization; credit_customer_ids now carries % udara ids over % live linked loans', n, pairs, agree;
END $$;

COMMIT;
