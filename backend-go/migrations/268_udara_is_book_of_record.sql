-- 268 — Udara is the book of record. Retire the uploaded sheet rows that duplicate a
--       Udara facility, and clear three defects the identity work left behind.
--
-- THE RULE (set by the business): where a facility exists in BOTH the uploaded
-- collections sheet and Udara core banking, UDARA WINS. Where a facility exists ONLY in
-- the sheet, the sheet row stands. Udara is live core banking; the sheet is a
-- point-in-time export that drifts.
--
-- Today the delinquency queue returns both copies. Measured 2026-09-22: 30 uploaded rows
-- duplicate a live Udara facility, carrying N543,538,634.32 of sheet figures against the
-- same debts Udara already reports at N740,379,934.32 — every naira of the sheet's
-- N543.5m is counted twice, and the sheet understates the real exposure by N196,841,300.
--
-- HOW A DUPLICATE IS PROVEN. Nothing links the two books — the sheet has no Udara account
-- number and its account_cif is a synthetic 'W...' key on most rows. So a pair must be
-- matched on evidence, and matching on the approved amount alone is worthless: round
-- figures (N4m, N5m, N10m) collide across a dozen unrelated borrowers. The rule applied
-- here is an IDENTICAL APPROVED AMOUNT plus one of:
--
--   'exact name + amount'   the two names are identical
--   'rare token + amount'   they share a word appearing in at most 2 names across either
--                           corpus — BENLAD, FOLTI, HENGOOB, GLISTER, PAUBEE.
--   'trigram + amount'      trigram similarity >= 0.55 (TRADEPORT vs TRADE PORT)
--
-- Token RARITY, not a hand-written stopword list, is what makes this safe. An earlier
-- draft excluded generic words by hand and still matched "Grey Loft Hotel" to "Ambience
-- Hotel and Resorts" on the shared word HOTEL — both N5,000,000 — landing on the right
-- answer only by a similarity tie-break. A document-frequency test rejects HOTEL and
-- UNITED automatically because many names carry them, and keeps GREY/LOFT because almost
-- none do. Ten sheet rows match nothing and are deliberately left alone, including three
-- ODOMETA ONOME facilities whose nearest Udara name is a different person (HARRIET
-- ODOMETA) at a different amount.
--
-- Each uploaded row claims at most one Udara facility and each Udara facility is claimed
-- by at most one uploaded row. That is what keeps FINTRAK right: the sheet carries two
-- FINTRAK facilities (N80m and N60m) and Udara carries one (N80m). The N80m row is the
-- duplicate; the N60m row is sheet-only and SURVIVES. (Its dates are nonsense — disbursed
-- 2026-11-02, six weeks in the future, maturing two days later — but that is a source
-- data problem for the sheet's owner, not something to fix by deleting a facility.)
--
-- NOTHING IS DELETED. A suppressed row keeps its status, its history, its payments and
-- its balance; it is stamped with the Udara facility it duplicates and hidden from the
-- delinquency view. To reverse: NULL the duplicate_of_cbs_id column.
--
-- ALSO IN THIS MIGRATION, three defects found while proving the above:
--
--   (3) Assignment 1503 pursues TEMITAYO BALOGUN, a card customer, for N1,715,555.55 —
--       to the kobo the debt of OLAHAN ABIDEMI, a Udara borrower who happens to share
--       the id 00000179. Balogun's card is NOT delinquent: balance N473,378.86, payment
--       due 2026-09-30, zero days overdue. The row was created by the old merged-
--       namespace generator and cannot self-heal, because the card arm of the view never
--       emits this id, so no refresh ever touches it. Migration 267 correctly declined to
--       re-key it (the card customer does owe something, so the row is theirs) but left
--       the amount. It is closed here: there is no card delinquency to work.
--
--   (4) MY OWN OMISSION IN 267. It moved 27 rows onto Udara identity and set
--       data_source='udara', but left product_type='card' on every one. They are loans.
--       The generator emits 'loan' for the Udara arm, so newly created rows are right and
--       only these 27 re-keyed ones are wrong — they would report as card exposure
--       forever, N829,161,045.10 of loans counted as cards.
--
--   (5) 150 card assignments are open against a card account whose balance is now ZERO —
--       N43,670,611.26 of debt already settled, still sitting in the queue. This applies
--       to cards the rule migrations 222 and 262 already apply to loans: a facility
--       repaid in full is closed, not left at zero in front of an agent. Scoped to rows
--       whose card account EXISTS and reads zero, so a missing account record can never
--       be read as a settled one. The account feed is healthy (last drop 09:19 today,
--       volume 1.6x baseline), so these zeroes are real. A customer who goes delinquent
--       again is re-seeded automatically by Generate Assignments.
--
-- Not addressed here, deliberately: 255 open card rows whose stored balance differs from
-- the live one. That is ordinary drift between syncs and the generator's own refresh
-- corrects it; a migration racing that refresh would only fight it.

BEGIN;

-- ── 1. Columns and audit ─────────────────────────────────────────────────────
ALTER TABLE app.collection_assignments
    ADD COLUMN IF NOT EXISTS duplicate_of_cbs_id   text,
    ADD COLUMN IF NOT EXISTS duplicate_match_basis text,
    ADD COLUMN IF NOT EXISTS duplicate_marked_at   timestamptz;

COMMENT ON COLUMN app.collection_assignments.duplicate_of_cbs_id IS
    'Set when this uploaded-sheet row duplicates a live Udara facility (cbs_loans.cbs_id). '
    'Udara is the book of record, so the row is retained but hidden from '
    'app.collections_delinquent_unified. NULL this column to bring the row back.';

CREATE TABLE IF NOT EXISTS app.collections_dedup_audit (
    id                      bigserial PRIMARY KEY,
    action                  text        NOT NULL,
    assignment_id           bigint      NOT NULL,
    account_cif             text,
    customer_name           text,
    status_before           text,
    status_after            text,
    outstanding_before_kobo bigint,
    outstanding_after_kobo  bigint,
    cbs_id                  text,
    cbs_customer_id         text,
    udara_name              text,
    udara_kobo              bigint,
    match_basis             text,
    similarity              numeric,
    evidence                text,
    acted_at                timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.collections_dedup_audit IS
    'Before/after record of migration 268. Every row it suppressed or closed, with the '
    'evidence that justified it. Nothing was deleted; this table is how to reverse it.';

-- ── 2. Prove the duplicate pairs ─────────────────────────────────────────────
CREATE TEMP TABLE up_book ON COMMIT DROP AS
SELECT ca.id, ca.account_cif, upper(btrim(ca.customer_name)) AS nm,
       COALESCE(ca.target_amount_kobo, ca.original_outstanding_kobo, 0) AS approved,
       ca.outstanding_kobo, ca.customer_name AS raw_name, ca.status
  FROM app.collection_assignments ca
 WHERE ca.data_source = 'manual' AND ca.product_type = 'loan'
   AND ca.superseded_by_id IS NULL
   AND ca.status IN ('active','sent_to_recovery')
   AND ca.duplicate_of_cbs_id IS NULL;

CREATE TEMP TABLE ud_book ON COMMIT DROP AS
SELECT cl.cbs_id, cl.cbs_customer_id, cl.cbs_account_number,
       upper(btrim(COALESCE(NULLIF(btrim(cc.name),''), cl.raw->>'name'))) AS nm,
       cl.loan_amount_kobo,
       COALESCE(cl.outstanding_principal_kobo,0)
         + COALESCE(cl.outstanding_interest_kobo,0)
         + COALESCE(cl.outstanding_fee_kobo,0) AS kobo
  FROM app.cbs_loans cl
  LEFT JOIN app.cbs_customers cc ON cc.cbs_customer_id = cl.cbs_customer_id
 WHERE cl.status NOT IN ('Closed','Revoked');

-- Words of 4+ characters, and how many distinct names across BOTH books carry each.
CREATE TEMP TABLE tok_df ON COMMIT DROP AS
SELECT word, count(DISTINCT nm) AS n
  FROM (
    SELECT nm, w AS word FROM up_book,
         LATERAL unnest(regexp_split_to_array(regexp_replace(nm, '[^A-Za-z0-9]+', ' ', 'g'), '\s+')) w
     WHERE length(w) >= 4
    UNION ALL
    SELECT nm, w FROM ud_book,
         LATERAL unnest(regexp_split_to_array(regexp_replace(nm, '[^A-Za-z0-9]+', ' ', 'g'), '\s+')) w
     WHERE length(w) >= 4
  ) z GROUP BY word;

CREATE TEMP TABLE pair_scored ON COMMIT DROP AS
SELECT u.id, u.account_cif, u.raw_name, u.nm, u.approved, u.outstanding_kobo, u.status,
       d.cbs_id, d.cbs_customer_id, d.nm AS ud_nm, d.kobo AS ud_kobo, d.loan_amount_kobo,
       similarity(u.nm, d.nm) AS sim,
       ARRAY(SELECT tk
               FROM unnest(regexp_split_to_array(regexp_replace(u.nm, '[^A-Za-z0-9]+', ' ', 'g'), '\s+')) tk
              WHERE length(tk) >= 4
                AND tk = ANY (regexp_split_to_array(regexp_replace(d.nm, '[^A-Za-z0-9]+', ' ', 'g'), '\s+'))
                AND (SELECT n FROM tok_df WHERE tok_df.word = tk) <= 2) AS rare_shared
  FROM up_book u
  JOIN ud_book d ON d.loan_amount_kobo = u.approved OR d.nm = u.nm;

CREATE TEMP TABLE pair_basis ON COMMIT DROP AS
SELECT *, CASE
    WHEN nm = ud_nm AND loan_amount_kobo = approved                   THEN 'exact name + amount'
    WHEN cardinality(rare_shared) > 0 AND loan_amount_kobo = approved THEN 'rare token + amount'
    WHEN sim >= 0.55 AND loan_amount_kobo = approved                  THEN 'trigram + amount'
    ELSE NULL END AS basis
  FROM pair_scored;

-- One uploaded row per Udara facility, and one Udara facility per uploaded row. Ranked by
-- strength of evidence so the best-evidenced claimant wins and the loser stays in the book.
CREATE TEMP TABLE dupes ON COMMIT DROP AS
WITH ranked AS (
    SELECT *,
           CASE basis WHEN 'exact name + amount' THEN 0
                      WHEN 'rare token + amount' THEN 1
                      ELSE 2 END AS strength
      FROM pair_basis WHERE basis IS NOT NULL
), best AS (
    SELECT *,
           row_number() OVER (PARTITION BY id     ORDER BY strength, sim DESC, cbs_id) AS r_up,
           row_number() OVER (PARTITION BY cbs_id ORDER BY strength, sim DESC, id)     AS r_ud
      FROM ranked
)
SELECT * FROM best WHERE r_up = 1 AND r_ud = 1;

INSERT INTO app.collections_dedup_audit
    (action, assignment_id, account_cif, customer_name, status_before, status_after,
     outstanding_before_kobo, outstanding_after_kobo, cbs_id, cbs_customer_id,
     udara_name, udara_kobo, match_basis, similarity, evidence)
SELECT 'suppress_uploaded_duplicate', id, account_cif, raw_name, status, status,
       outstanding_kobo, outstanding_kobo, cbs_id, cbs_customer_id, ud_nm, ud_kobo,
       basis, round(sim::numeric, 3),
       'Udara is the book of record. Sheet row duplicates this live Udara facility; '
       || 'approved amount identical (' || to_char(approved / 100.0, 'FM999,999,999,990.00')
       || '). Rare shared words: ' || COALESCE(NULLIF(array_to_string(rare_shared, ','), ''), '(none)')
  FROM dupes;

UPDATE app.collection_assignments ca
   SET duplicate_of_cbs_id   = d.cbs_id,
       duplicate_match_basis = d.basis,
       duplicate_marked_at   = NOW(),
       updated_at            = NOW()
  FROM dupes d
 WHERE ca.id = d.id;

-- ── 3. A card row carrying a Udara borrower's debt ──────────────────────────
-- Pinned by evidence, not by id, so it cannot fire on the wrong row: a card assignment
-- whose stored balance equals, to the kobo, the live Udara debt of the borrower sharing
-- its id, while its own card account carries no delinquency at all.
CREATE TEMP TABLE contaminated_cards ON COMMIT DROP AS
SELECT ca.id, ca.account_cif, ca.customer_name, ca.status, ca.outstanding_kobo,
       (SELECT COALESCE(SUM(l.outstanding_principal_kobo + COALESCE(l.outstanding_interest_kobo, 0)
                          + COALESCE(l.outstanding_fee_kobo, 0)), 0)
          FROM app.cbs_loans l
         WHERE l.cbs_customer_id = ca.account_cif AND l.status NOT IN ('Closed', 'Revoked')) AS udara_kobo,
       (SELECT COALESCE(SUM(a.current_dr_balance), 0) FROM app.accounts a WHERE a.cif = ca.account_cif) AS card_bal,
       (SELECT max(a.payment_due_date)::text FROM app.accounts a WHERE a.cif = ca.account_cif) AS card_due
  FROM app.collection_assignments ca
 WHERE ca.product_type = 'card' AND ca.status IN ('active', 'sent_to_recovery')
   AND ca.account_cif NOT LIKE 'UD-%'
   AND ca.outstanding_kobo > 0
   AND ca.outstanding_kobo = (SELECT COALESCE(SUM(l.outstanding_principal_kobo + COALESCE(l.outstanding_interest_kobo, 0)
                                               + COALESCE(l.outstanding_fee_kobo, 0)), 0)
                                FROM app.cbs_loans l
                               WHERE l.cbs_customer_id = ca.account_cif AND l.status NOT IN ('Closed', 'Revoked'))
   AND NOT EXISTS (SELECT 1 FROM app.accounts a
                    WHERE a.cif = ca.account_cif
                      AND COALESCE(a.current_dr_balance, 0) > 0
                      AND ((a.payment_due_date IS NOT NULL AND a.payment_due_date < CURRENT_DATE)
                        OR (a.payment_due_date IS NULL AND COALESCE(a.days_overdue, 0) > 0)));

INSERT INTO app.collections_dedup_audit
    (action, assignment_id, account_cif, customer_name, status_before, status_after,
     outstanding_before_kobo, outstanding_after_kobo, cbs_customer_id, udara_kobo, evidence)
SELECT 'close_contaminated_card_row', id, account_cif, customer_name, status, 'closed',
       outstanding_kobo, 0, account_cif, udara_kobo,
       'Stored balance equalled the colliding Udara borrower''s debt to the kobo while this '
       || 'card account carried no delinquency (balance ' || to_char(card_bal, 'FM999,999,990.00')
       || ', payment due ' || COALESCE(card_due, '?')
       || '). Created by the pre-267 merged-namespace generator; unreachable by any refresh.'
  FROM contaminated_cards;

UPDATE app.collection_assignments ca
   SET status = 'closed', outstanding_kobo = 0, updated_at = NOW()
  FROM contaminated_cards t
 WHERE ca.id = t.id;

-- ── 4. Migration 267 left product_type='card' on rows it moved to Udara ─────
UPDATE app.collection_assignments
   SET product_type = 'loan', updated_at = NOW()
 WHERE account_cif LIKE 'UD-%' AND COALESCE(data_source, '') = 'udara'
   AND COALESCE(product_type, '') <> 'loan';

-- ── 5. Card assignments already settled ─────────────────────────────────────
-- The card account must EXIST and read zero. A CIF with no account row at all is a
-- different problem (missing data) and is left open rather than closed on an absence.
CREATE TEMP TABLE settled_cards ON COMMIT DROP AS
SELECT ca.id, ca.account_cif, ca.customer_name, ca.status, ca.outstanding_kobo
  FROM app.collection_assignments ca
 WHERE ca.product_type = 'card'
   AND ca.status IN ('active', 'sent_to_recovery')
   AND ca.account_cif NOT LIKE 'UD-%'
   AND EXISTS (SELECT 1 FROM app.accounts a WHERE a.cif = ca.account_cif)
   AND (SELECT COALESCE(SUM(round(COALESCE(a.current_dr_balance, 0) * 100)), 0)
          FROM app.accounts a WHERE a.cif = ca.account_cif) <= 0;

INSERT INTO app.collections_dedup_audit
    (action, assignment_id, account_cif, customer_name, status_before, status_after,
     outstanding_before_kobo, outstanding_after_kobo, evidence)
SELECT 'close_settled_card', id, account_cif, customer_name, status, 'closed',
       outstanding_kobo, 0,
       'Card account exists and its balance is zero: the debt is settled. Same rule '
       || 'migrations 222 and 262 apply to loans. Re-seeds automatically if the customer '
       || 'goes delinquent again, because Generate Assignments creates a row for any '
       || 'delinquent CIF with none active.'
  FROM settled_cards;

UPDATE app.collection_assignments ca
   SET status = 'closed', outstanding_kobo = 0, updated_at = NOW()
  FROM settled_cards s
 WHERE ca.id = s.id;

-- ── 6. Hide suppressed duplicates from the delinquency view ─────────────────
-- Guarded like migration 262's: re-created only if the view exists, still carries the
-- uploaded branch, and does not already have the predicate — so a concurrent session's
-- edit is never clobbered.
DO $$
DECLARE
    def text;
BEGIN
    SELECT pg_get_viewdef('app.collections_delinquent_unified'::regclass, true) INTO def;
    IF def IS NULL THEN
        RAISE NOTICE '268: collections_delinquent_unified absent — duplicate guard NOT applied';
        RETURN;
    END IF;
    IF position('duplicate_of_cbs_id IS NULL' IN def) > 0 THEN
        RAISE NOTICE '268: duplicate guard already present — view left untouched';
        RETURN;
    END IF;
    IF position('ca.superseded_by_id IS NULL' IN def) = 0 THEN
        RAISE WARNING '268: could not locate the uploaded branch — duplicate guard NOT applied, apply by hand';
        RETURN;
    END IF;
    def := replace(def,
        'ca.superseded_by_id IS NULL',
        'ca.superseded_by_id IS NULL AND ca.duplicate_of_cbs_id IS NULL');
    EXECUTE 'CREATE OR REPLACE VIEW app.collections_delinquent_unified AS ' || def;
    RAISE NOTICE '268: duplicate guard applied to collections_delinquent_unified';
END $$;

DO $$
DECLARE d int; c int; s int; p int;
BEGIN
    SELECT count(*) INTO d FROM app.collections_dedup_audit WHERE action = 'suppress_uploaded_duplicate' AND acted_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO c FROM app.collections_dedup_audit WHERE action = 'close_contaminated_card_row'  AND acted_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO s FROM app.collections_dedup_audit WHERE action = 'close_settled_card'           AND acted_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO p FROM app.collection_assignments  WHERE account_cif LIKE 'UD-%' AND product_type = 'loan';
    RAISE NOTICE '268: suppressed % uploaded duplicates, closed % contaminated card row(s), closed % settled card rows, % Udara rows now typed loan', d, c, s, p;
END $$;

COMMIT;
