-- 267 — Re-key the collections and recovery rows that pursue a Udara borrower's debt
--        under a card customer's identity. Narrow, evidence-led, and fully auditable.
--
-- BACKGROUND. collectionsGenerateAssignments read app.collections_delinquent_unified with a
-- bare GROUP BY cif. That view UNIONs a cards arm keyed by app.customers.cif with a Udara arm
-- keyed by cbs_loans.cbs_customer_id — two colliding key spaces — and the INSERT then filed
-- the result in cards-namespace columns. escalateSevereToRecovery (nightly, 02:00) copied
-- those into recovery_cases. Every read-back's `JOIN app.customers ON cif = account_cif` then
-- named the CARD customer. 288 of 295 Udara ids also exist as a cards cif and 271 of those
-- (94%) are a different real person.
--
-- The handlers are fixed in the same change set: a Udara-sourced row is now keyed
-- 'UD-' || cbs_customer_id. Every cards cif is exactly 8 characters and all digits (verified:
-- min=max=8, 0 non-numeric), so a 'UD-' key can never equal one — a stray cards join resolves
-- to NULL, visibly nameless, instead of silently to the wrong person.
--
-- SCOPE — deliberately NARROW. A row is re-keyed ONLY where the debt is provably Udara's:
--   (a) the account_cif resolves through app.cbs_links to a party, AND
--   (b) the named CARD customer owes nothing (no positive card balance), AND
--   (c) a live Udara facility for that id carries a debt.
--
-- Rows merely sharing a colliding number are LEFT ALONE. This matters: of 51 candidate
-- assignments, 20 carry a real card balance and are legitimate card work; of 36 recovery
-- cases whose id appears in cbs_links, only 5 have a card customer owing nothing. An earlier
-- draft of this correction would have re-keyed all 36 — moving 31 genuine card cases onto
-- Udara identity, the exact mirror of the bug being fixed. Provenance is proven per row, not
-- inferred from the collision.
--
-- Expected: 27 collection_assignments (N829,161,045.10) and 5 recovery_cases
-- (N340,013,333.33), of which 4 match the Udara debt to the kobo.
--
-- REVERSIBLE. Every original value is copied to app.identity_rekey_audit before the write,
-- with the evidence that justified it. Nothing is deleted. To undo, restore from that table.

BEGIN;

-- ── 1. The audit trail ───────────────────────────────────────────────────────
-- Kept as its own table rather than overwriting `notes`, because a recovery case may have
-- had a demand letter sent under the wrong name: the record of WHAT WAS SENT AND TO WHOM
-- must survive the correction. Whoever handles recovery needs to see that, not just the
-- corrected row.
CREATE TABLE IF NOT EXISTS app.identity_rekey_audit (
    id                bigserial PRIMARY KEY,
    source_table      text        NOT NULL,
    row_id            bigint      NOT NULL,
    row_ref           text,                  -- case_ref where one exists
    old_account_cif   text,
    new_account_cif   text,
    old_cif_number    text,
    new_cif_number    text,
    old_party_id      bigint,
    new_party_id      bigint,
    old_customer_name text,
    new_customer_name text,
    outstanding_kobo  bigint,
    card_balance      numeric,               -- evidence (b): what the named card customer owed
    udara_debt_kobo   bigint,                -- evidence (c): what the Udara borrower owed
    status_at_rekey   text,
    reason            text        NOT NULL,
    rekeyed_at        timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.identity_rekey_audit IS
    'Before/after record of migration 267, which moved collections and recovery rows off a '
    'card customer''s identity onto the Udara borrower who actually owes the debt. Holds the '
    'name each row displayed BEFORE correction — needed because demand letters may have gone '
    'out under that name. Never delete: this is the evidence of what was sent and to whom.';

-- ── 2. The provable set ──────────────────────────────────────────────────────
CREATE TEMP TABLE rekey_targets ON COMMIT DROP AS
WITH ev AS (
    SELECT 'collection_assignments'::text AS src, ca.id, NULL::text AS row_ref,
           ca.account_cif, ca.cif_number, ca.party_id, ca.customer_name,
           ca.outstanding_kobo, ca.status,
           (SELECT COALESCE(SUM(a.current_dr_balance),0) FROM app.accounts a
             WHERE a.cif = ca.account_cif) AS card_bal,
           (SELECT COALESCE(SUM(l.outstanding_principal_kobo
                               + COALESCE(l.outstanding_interest_kobo,0)
                               + COALESCE(l.outstanding_fee_kobo,0)),0) FROM app.cbs_loans l
             WHERE l.cbs_customer_id = ca.account_cif) AS udara_kobo
      FROM app.collection_assignments ca
     WHERE ca.status IN ('active','sent_to_recovery')
       AND NOT (COALESCE(ca.data_source,'') = 'manual' AND COALESCE(ca.product_type,'') = 'loan')
       AND COALESCE(ca.account_cif,'') NOT LIKE 'UD-%'
    UNION ALL
    SELECT 'recovery_cases', rc.id, rc.case_ref,
           rc.account_cif, rc.cif_number, rc.party_id, rc.customer_name,
           rc.outstanding_kobo, rc.status,
           (SELECT COALESCE(SUM(a.current_dr_balance),0) FROM app.accounts a
             WHERE a.cif = rc.account_cif),
           (SELECT COALESCE(SUM(l.outstanding_principal_kobo
                               + COALESCE(l.outstanding_interest_kobo,0)
                               + COALESCE(l.outstanding_fee_kobo,0)),0) FROM app.cbs_loans l
             WHERE l.cbs_customer_id = rc.account_cif)
      FROM app.recovery_cases rc
     WHERE COALESCE(rc.status,'') NOT IN ('closed','written_off')
       AND COALESCE(rc.account_cif,'') NOT LIKE 'UD-%'
)
SELECT ev.*, lk.entity_id AS new_party_id,
       COALESCE(NULLIF(btrim(cc.name),''), p.full_name) AS new_customer_name,
       'UD-' || ev.account_cif AS new_account_cif,
       -- The name the row actually DISPLAYED before correction. Most of these rows store no
       -- customer_name of their own — the wrong name was produced at read time by
       -- `JOIN app.customers ON cif = account_cif`. Once the key moves to 'UD-…' that join no
       -- longer resolves, so unless the displayed name is captured HERE it is lost, and with
       -- it the record of whose name went on a demand letter. Resolved the same (wrong) way
       -- the application did, deliberately, because that is what was on screen and on paper.
       COALESCE(
           NULLIF(btrim(ev.customer_name), ''),
           NULLIF(btrim(cu.full_name), ''),
           NULLIF(btrim(concat_ws(' ', cu.first_name, cu.last_name)), '')
       ) AS displayed_name_before
  FROM ev
  JOIN app.cbs_links lk ON lk.entity_type = 'party' AND lk.cbs_customer_id = ev.account_cif
  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = ev.account_cif
  LEFT JOIN app.parties p        ON p.party_id = lk.entity_id
  LEFT JOIN app.customers cu     ON cu.cif = ev.account_cif
 WHERE COALESCE(ev.card_bal, 0) <= 0      -- (b) the named card customer owes nothing
   AND ev.udara_kobo > 0;                 -- (c) a live Udara debt exists

-- ── 3. Record before writing ─────────────────────────────────────────────────
INSERT INTO app.identity_rekey_audit
    (source_table, row_id, row_ref, old_account_cif, new_account_cif,
     old_cif_number, new_cif_number, old_party_id, new_party_id,
     old_customer_name, new_customer_name, outstanding_kobo,
     card_balance, udara_debt_kobo, status_at_rekey, reason)
SELECT src, id, row_ref, account_cif, new_account_cif,
       cif_number, new_account_cif, party_id, new_party_id,
       displayed_name_before, new_customer_name, outstanding_kobo,
       card_bal, udara_kobo, status,
       'migration 267: row pursued a Udara borrower''s debt under a card customer''s '
       || 'identity; named card customer owed nothing and a live Udara facility carried the debt'
  FROM rekey_targets;

-- ── 4. Re-key ────────────────────────────────────────────────────────────────
UPDATE app.collection_assignments ca
   SET account_cif   = t.new_account_cif,
       cif_number    = t.new_account_cif,
       party_id      = t.new_party_id,
       customer_name = COALESCE(t.new_customer_name, ca.customer_name),
       data_source   = 'udara',
       updated_at    = NOW()
  FROM rekey_targets t
 WHERE t.src = 'collection_assignments' AND ca.id = t.id;

UPDATE app.recovery_cases rc
   SET account_cif   = t.new_account_cif,
       cif_number    = t.new_account_cif,
       party_id      = t.new_party_id,
       customer_name = COALESCE(t.new_customer_name, rc.customer_name),
       data_source   = 'udara',
       updated_at    = NOW()
  FROM rekey_targets t
 WHERE t.src = 'recovery_cases' AND rc.id = t.id;

COMMIT;
