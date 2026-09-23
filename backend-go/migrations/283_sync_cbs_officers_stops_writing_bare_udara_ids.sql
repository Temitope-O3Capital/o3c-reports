-- 283 — app.sync_cbs_officers() is putting Udara customer ids back into `cif`,
--       undoing migration 269 on every CBS sync run.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
--
-- Migration 269 re-keyed app.customer_officers off a Udara customer id stored in a
-- column named `cif` — a CARDS identifier — onto 'UD-'||<udara id>, with party_id
-- resolved through app.cbs_links and the Udara id kept verbatim in
-- udara_customer_id. Its stated protection was that "a stray cards join now
-- resolves to NULL — visibly nameless, which someone reports — instead of
-- silently to a stranger."
--
-- What 269 did not do was fix the thing that WRITES those rows. app.sync_cbs_officers()
-- (migrations 183/184), called by the CBS sync worker on every run
-- (cbssync/sync.go assignCBSOfficers), still does:
--
--     INSERT INTO app.customer_officers (cif, officer_id, assigned_by, source, note)
--     SELECT cbs_customer_id, ..., 'cbs', 'Udara account officer (auto)'
--     ON CONFLICT (cif) DO NOTHING
--
-- Its ON CONFLICT guard keys on `cif`. After 269 the existing rows are 'UD-…', so
-- the bare id no longer conflicts with anything — and the sync inserted all 201
-- rows straight back. Measured 2026-09-23: 402 rows where there should be 201.
--
--     201 rows  cif='UD-00000179'  party_id set      assigned 2026-08-26  (correct)
--     201 rows  cif='00000179'     party_id NULL     assigned 2026-09-22  (re-added)
--
-- Every one of the 201 bare rows is the twin of a UD- row, and 183 of those bare
-- ids are ALSO a live cards CIF belonging to a DIFFERENT PERSON — so
-- handlers/sales_applications.go's `LEFT JOIN customer_officers o ON o.cif = c.cif`
-- is once again naming a Udara borrower's officer as the owner of whichever card
-- customer happens to share the digits. That is the wrong-officer symptom, and it
-- regenerates on every sync until the function is fixed.
--
-- 55 of the twins also disagree on WHO the officer is. The bare rows are the newer
-- output (2026-09-22) and reflect Udara's current accountOfficerName; the UD- rows
-- carry what 269 re-keyed from the 2026-08-26 data. Verified before writing this:
-- all 201 UD- twins are source='cbs', so NOT ONE of them is a human decision made
-- in the CRM. The 55 can therefore be refreshed from Udara without overriding
-- anybody.
--
-- ── THE REPAIR ───────────────────────────────────────────────────────────────
--   1. Archive the 201 bare rows (the same audit table 269 used — it is the
--      evidence trail and is never deleted).
--   2. Refresh the officer on any UD- twin Udara now disagrees with, source='cbs'
--      only, with a history row so the change is attributable.
--   3. Delete the 201 bare rows.
--   4. Replace app.sync_cbs_officers() so it writes the 269 convention and can
--      never mint a bare Udara id in `cif` again. Its upsert now refreshes
--      source='cbs' rows and LEAVES MANUAL ONES ALONE — an officer corrected in
--      the CRM (source 'manual'/'converted', via /api/sales/book/assign) must win
--      over the feed, or correcting a wrong match would last until the next sync.
--
-- Idempotent: once the bare rows are gone steps 1–3 match nothing, and step 4 is a
-- CREATE OR REPLACE.

BEGIN;

-- 1. Archive ------------------------------------------------------------------
INSERT INTO app.customer_officer_rekey_audit
    (old_cif, new_cif, udara_customer_id, party_id, officer_id, source,
     udara_name, card_name, card_accounts)
SELECT co.cif,
       'UD-' || co.cif,
       co.cif,
       k.entity_id,
       co.officer_id,
       co.source,
       (SELECT p.full_name FROM app.customers p
         WHERE p.party_id = k.entity_id AND p.full_name IS NOT NULL LIMIT 1),
       c.full_name,
       (SELECT COUNT(*) FROM app.accounts a WHERE a.cif = co.cif)
  FROM app.customer_officers co
  LEFT JOIN app.cbs_links k ON k.entity_type = 'party' AND k.cbs_customer_id = co.cif
  LEFT JOIN app.customers c ON c.cif = co.cif
 WHERE co.party_id IS NULL
   AND co.cif NOT LIKE 'UD-%';

-- 2. Refresh the twins Udara now disagrees with, auto-assigned rows only -------
INSERT INTO app.customer_officer_history (cif, from_officer_id, to_officer_id, changed_by, reason)
SELECT g.cif, g.officer_id, l.officer_id, NULL,
       'Migration 283: refreshed from Udara accountOfficerName; the duplicate bare-id row '
       || l.cif || ' carried a newer officer'
  FROM app.customer_officers l
  JOIN app.customer_officers g
    ON g.cif = 'UD-' || l.cif AND g.source = 'cbs'
 WHERE l.party_id IS NULL AND l.cif NOT LIKE 'UD-%'
   AND g.officer_id IS DISTINCT FROM l.officer_id;

UPDATE app.customer_officers g
   SET officer_id  = l.officer_id,
       assigned_at = NOW(),
       note        = 'Udara account officer (auto, refreshed by migration 283)'
  FROM app.customer_officers l
 WHERE g.cif = 'UD-' || l.cif
   AND g.source = 'cbs'
   AND l.party_id IS NULL AND l.cif NOT LIKE 'UD-%'
   AND g.officer_id IS DISTINCT FROM l.officer_id;

-- 3. Remove the re-added bare rows --------------------------------------------
DELETE FROM app.customer_officers
 WHERE party_id IS NULL AND cif NOT LIKE 'UD-%'
   AND EXISTS (SELECT 1 FROM app.customer_officers g WHERE g.cif = 'UD-' || app.customer_officers.cif);

-- 4. The writer ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.sync_cbs_officers()
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  assigned integer := 0;
BEGIN
  -- One officer per Udara customer, from the loan and FD books. Shared by both
  -- steps below so "who needs a user minting" and "who gets assigned" can never
  -- drift apart.
  CREATE TEMP TABLE _cbs_off ON COMMIT DROP AS
  WITH ac AS (
    SELECT cbs_customer_id AS udara_id, btrim(raw->>'accountOfficerName') AS oname
      FROM app.cbs_loans
     WHERE COALESCE(btrim(cbs_customer_id),'') <> ''
       AND btrim(COALESCE(raw->>'accountOfficerName','')) <> ''
    UNION ALL
    SELECT cbs_customer_id, btrim(raw->>'accountOfficerName')
      FROM app.cbs_fixed_deposits
     WHERE COALESCE(btrim(cbs_customer_id),'') <> ''
       AND btrim(COALESCE(raw->>'accountOfficerName','')) <> ''
  )
  SELECT udara_id, (array_agg(oname))[1] AS oname FROM ac GROUP BY udara_id;

  -- 1) Mint a no-login user for each distinct CBS officer that has no name-matched
  --    user AND still has an unassigned customer. The "unassigned" test keys on the
  --    'UD-' form — against the bare id it matched nothing after migration 269 and
  --    would have kept re-minting.
  INSERT INTO app.o3c_users
    (email, password_hash, full_name, first_name, last_name, role, is_active, must_change_password)
  SELECT
    'cbs.' || regexp_replace(d.skey, ' ', '.', 'g') || '@officer.o3c.local',
    '!cbs-no-login',
    btrim(d.first_name || ' ' || d.last_name),
    d.first_name, d.last_name, 'account_officer', false, false
  FROM (
    SELECT DISTINCT
      app.name_sortkey(s.oname) AS skey,
      array_to_string((s.toks)[2:array_length(s.toks,1)], ' ') AS first_name,
      (s.toks)[1] AS last_name
    FROM (
      SELECT o.oname,
             regexp_split_to_array(initcap(regexp_replace(o.oname, '\s+', ' ', 'g')), ' ') AS toks
        FROM (
          SELECT t.oname
            FROM _cbs_off t
           WHERE NOT EXISTS (
             SELECT 1 FROM app.customer_officers co WHERE co.cif = 'UD-' || t.udara_id)
           GROUP BY t.oname
        ) o
    ) s
  ) d
  WHERE d.skey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM app.o3c_users u WHERE app.name_sortkey(u.full_name) = d.skey)
  ON CONFLICT (email) DO NOTHING;

  -- 2) Assign, in the migration-269 key shape: cif = 'UD-'||udara id (never a bare
  --    id, which collides with a real cards CIF), the Udara id kept verbatim, and
  --    party_id resolved through app.cbs_links — the only sanctioned bridge.
  --
  --    The upsert refreshes rows this function owns (source='cbs') so a genuine
  --    officer change in Udara flows through, and skips every other source: a
  --    'manual' or 'converted' assignment is a person's decision made in the CRM
  --    and must outlive the next sync, otherwise correcting a wrong match is
  --    pointless.
  WITH resolved AS (
    SELECT DISTINCT ON (t.udara_id)
           t.udara_id, u.id AS officer_id,
           (SELECT k.entity_id FROM app.cbs_links k
             WHERE k.entity_type = 'party' AND k.cbs_customer_id = t.udara_id LIMIT 1) AS party_id
      FROM _cbs_off t
      JOIN app.o3c_users u ON app.name_sortkey(u.full_name) = app.name_sortkey(t.oname)
     ORDER BY t.udara_id, u.id
  ),
  ins AS (
    INSERT INTO app.customer_officers
        (cif, officer_id, assigned_by, source, note, party_id, udara_customer_id)
    SELECT 'UD-' || udara_id, officer_id, 1, 'cbs', 'Udara account officer (auto)',
           party_id, udara_id
      FROM resolved
    ON CONFLICT (cif) DO UPDATE
       SET officer_id        = EXCLUDED.officer_id,
           assigned_at       = NOW(),
           note              = EXCLUDED.note,
           party_id          = COALESCE(EXCLUDED.party_id, app.customer_officers.party_id),
           udara_customer_id = COALESCE(EXCLUDED.udara_customer_id, app.customer_officers.udara_customer_id)
     WHERE app.customer_officers.source = 'cbs'
       AND app.customer_officers.officer_id IS DISTINCT FROM EXCLUDED.officer_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO assigned FROM ins;

  RETURN assigned;
END
$fn$;

COMMENT ON FUNCTION app.sync_cbs_officers() IS
  'Assigns each Udara customer to the account officer their loan/FD record names. Writes '
  'app.customer_officers keyed ''UD-''||<udara customer id> with party_id (migration 269 '
  'convention) — NEVER a bare Udara id, which collides with a real cards CIF. Refreshes '
  'only rows it owns (source=''cbs''); a manual CRM assignment always wins.';

COMMIT;
