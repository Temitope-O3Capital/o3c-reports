-- 275 — Get Udara customer ids out of the `cif` column, where a cards feed can overwrite
--       a borrower's contact details with a stranger's.
--
-- ── THE HAZARD ───────────────────────────────────────────────────────────────
-- 18 rows in app.customers carry source='udara_cbs' with a UDARA customer id sitting in
-- `cif`, and a contact_id of the form 'Z'||lpad(udara id,15,'0'). They predate the
-- 'U'-namespace that cbssync now uses (it writes cif = NULL for Udara customers).
--
-- custfeed/ingest.go inserts a cards customer as
--     ('Z'||lpad(cif,15,'0'), cif, …) ON CONFLICT (cif) DO UPDATE SET full_name=…,
--         email=…, phone=…, address_1=…, city=…, state=…
-- so a genuine cards customer arriving on one of those 18 numbers does NOT bounce: it
-- MATCHES, and overwrites the Udara borrower's name, phone, email and address in place.
-- Since migration 273/274 put these rows on the borrower's facility party, the corrupted
-- contact detail would land directly on the Customer 360 of someone who owes money —
-- collections would then call a stranger's number about a real debt.
--
-- Not hypothetical in kind: 271 of the 295 Udara ids already exist as a cards CIF and
-- 100% of those are a different person. It is only latent because none of these
-- particular 18 numbers has a live card yet — verified 0 app.accounts and 0 app.card_book
-- rows against each.
--
-- ── THE REPAIR ───────────────────────────────────────────────────────────────
-- 14 of the 18 are DUPLICATES: the same Udara customer already has a canonical
-- 'U'||lpad(id,15,'0') profile. 4 have no U-sibling and are that customer's only profile.
--
--   * 14 duplicates -> blank-fill the canonical U row from the Z row, then delete the Z
--     row. The blank-fill is NOT optional: a column-by-column comparison found the Z row
--     holds `last_name` on 4 pairs and `city` on 7 pairs where the U row is blank. A
--     straight delete would have quietly lost those. The fill is generated over EVERY
--     column rather than a hand-picked list, so nothing else can be missed the same way.
--   * 4 singletons -> re-key contact_id to the 'U' form and NULL the cif. Udara customers
--     have no CIF; that is the correct value, and uq_customers_cif is partial
--     (WHERE cif IS NOT NULL AND cif <> '') so any number of NULLs coexist.
--
-- Both outcomes free the cif AND the 'Z…' contact_id, so a real cards customer on that
-- number gets its own row instead of colliding.
--
-- SAFE TO DELETE/RE-KEY: contact_id is the primary key and only app.accounts and
-- app.transactions reference it (account_contact_fk, txn_contact_fk). Verified 0 of the
-- 18 are referenced by either. No other FK points at app.customers.
--
-- The full pre-image of every deleted row is archived as jsonb, so this is reversible.
-- Idempotent: once the Z rows are gone the selects are empty and it does nothing.

BEGIN;

CREATE TABLE IF NOT EXISTS app.udara_cif_squatter_audit (
    id             bigserial PRIMARY KEY,
    action         text        NOT NULL,
    old_contact_id text        NOT NULL,
    new_contact_id text,
    udara_id       text,
    kept_contact_id text,
    row_before     jsonb       NOT NULL,
    filled_columns text[],
    acted_at       timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.udara_cif_squatter_audit IS
    'Migration 275: the pre-image of every app.customers row that held a Udara customer id '
    'in `cif`. Rows deleted as duplicates are archived here in full (row_before), with the '
    'columns whose values were carried across to the surviving profile. This is how the '
    'merge is reversed. Never delete.';

-- ── The working set ──────────────────────────────────────────────────────────
CREATE TEMP TABLE squatters ON COMMIT DROP AS
SELECT z.contact_id                              AS z_contact_id,
       z.cif                                     AS udara_id,
       'U' || LPAD(z.cif, 15, '0')               AS u_contact_id,
       EXISTS (SELECT 1 FROM app.customers u
                WHERE u.contact_id = 'U' || LPAD(z.cif, 15, '0')) AS has_sibling,
       to_jsonb(z)                               AS row_before
  FROM app.customers z
 WHERE COALESCE(z.source,'') = 'udara_cbs'
   AND z.cif IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.cbs_customers cc WHERE cc.cbs_customer_id = z.cif);

-- Refuse rather than damage: if anything ever does reference one of these, stop.
DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM squatters s
     WHERE EXISTS (SELECT 1 FROM app.accounts a     WHERE a.contact_id = s.z_contact_id)
        OR EXISTS (SELECT 1 FROM app.transactions t WHERE t.contact_id = s.z_contact_id);
    IF n > 0 THEN
        RAISE EXCEPTION '275: % squatter row(s) are referenced by accounts/transactions — aborting rather than breaking a foreign key', n;
    END IF;
END $$;

-- ── 1. Carry every non-blank value across to the surviving U profile ─────────
-- Generated over the full column list so no field can be silently dropped. Keys,
-- provenance and timestamps are excluded: the survivor keeps its own.
DO $$
DECLARE
    col text;
    n   int;
    filled text[] := '{}';
BEGIN
    FOR col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'customers'
           AND column_name NOT IN ('contact_id','cif','party_id','source','source_file',
                                   'created_at','first_seen_at','last_seen')
         ORDER BY ordinal_position
    LOOP
        EXECUTE format($q$
            UPDATE app.customers u
               SET %1$I = z.%1$I
              FROM app.customers z
              JOIN squatters s ON s.z_contact_id = z.contact_id AND s.has_sibling
             WHERE u.contact_id = s.u_contact_id
               AND COALESCE(btrim(u.%1$I::text), '') = ''
               AND COALESCE(btrim(z.%1$I::text), '') <> ''
        $q$, col);
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN
            filled := filled || format('%s(%s)', col, n);
        END IF;
    END LOOP;
    IF array_length(filled, 1) IS NULL THEN
        RAISE NOTICE '275: no blanks to fill on the surviving profiles';
    ELSE
        RAISE NOTICE '275: carried across %', array_to_string(filled, ', ');
    END IF;
END $$;

-- ── 2. Archive and delete the duplicates ─────────────────────────────────────
INSERT INTO app.udara_cif_squatter_audit
    (action, old_contact_id, new_contact_id, udara_id, kept_contact_id, row_before)
SELECT 'deleted_duplicate_profile', z_contact_id, NULL, udara_id, u_contact_id, row_before
  FROM squatters WHERE has_sibling;

DELETE FROM app.customers c
 USING squatters s
 WHERE c.contact_id = s.z_contact_id AND s.has_sibling;

-- ── 3. Re-key the singletons into the U namespace, and drop the false cif ────
INSERT INTO app.udara_cif_squatter_audit
    (action, old_contact_id, new_contact_id, udara_id, kept_contact_id, row_before)
SELECT 'rekeyed_to_u_namespace', z_contact_id, u_contact_id, udara_id, u_contact_id, row_before
  FROM squatters WHERE NOT has_sibling;

UPDATE app.customers c
   SET contact_id = s.u_contact_id,
       cif        = NULL
  FROM squatters s
 WHERE c.contact_id = s.z_contact_id AND NOT s.has_sibling;

-- ── 4. Prove the hazard is gone ──────────────────────────────────────────────
DO $$
DECLARE remaining int; deleted int; rekeyed int;
BEGIN
    SELECT count(*) INTO remaining
      FROM app.customers c
     WHERE COALESCE(c.source,'') = 'udara_cbs' AND c.cif IS NOT NULL
       AND EXISTS (SELECT 1 FROM app.cbs_customers cc WHERE cc.cbs_customer_id = c.cif);
    IF remaining > 0 THEN
        RAISE EXCEPTION '275: % Udara id(s) still sitting in a cif column', remaining;
    END IF;
    SELECT count(*) INTO deleted FROM app.udara_cif_squatter_audit
     WHERE action='deleted_duplicate_profile' AND acted_at >= NOW() - INTERVAL '5 minutes';
    SELECT count(*) INTO rekeyed FROM app.udara_cif_squatter_audit
     WHERE action='rekeyed_to_u_namespace'   AND acted_at >= NOW() - INTERVAL '5 minutes';
    RAISE NOTICE '275: merged % duplicate profile(s), re-keyed % singleton(s); 0 Udara ids left in a cif column', deleted, rekeyed;
END $$;

-- The re-keyed rows are new to assign_parties' Udara branch; settle them now rather than
-- waiting for the next sync tick.
SELECT app.assign_parties();

COMMIT;
