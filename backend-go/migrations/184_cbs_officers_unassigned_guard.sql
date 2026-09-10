-- 184: harden app.sync_cbs_officers() so it only mints a no-login officer-user when that
-- officer still has at least one UNASSIGNED customer. Without this, correcting an officer's
-- name (e.g. fixing a typo carried in from Udara) breaks the name-match against Udara's
-- unchanged spelling and the next sync would recreate an orphan stub. Idempotent
-- (CREATE OR REPLACE); assignment behaviour is unchanged.

CREATE OR REPLACE FUNCTION app.sync_cbs_officers()
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  assigned integer := 0;
BEGIN
  -- 1) Mint a no-login user for each distinct CBS officer that (a) has no name-matched
  --    user and (b) still has an unassigned customer (nobody to assign => nothing to create).
  INSERT INTO app.o3c_users
    (email, password_hash, full_name, first_name, last_name, role, is_active, must_change_password)
  SELECT
    'cbs.' || regexp_replace(d.skey, ' ', '.', 'g') || '@officer.o3c.local',
    '!cbs-no-login',
    btrim(d.first_name || ' ' || d.last_name),
    d.first_name,
    d.last_name,
    'account_officer', false, false
  FROM (
    SELECT DISTINCT
      app.name_sortkey(s.oname) AS skey,
      array_to_string((s.toks)[2:array_length(s.toks,1)], ' ') AS first_name,
      (s.toks)[1] AS last_name
    FROM (
      SELECT o.oname, regexp_split_to_array(initcap(regexp_replace(o.oname,'\s+',' ','g')), ' ') AS toks
      FROM (
        -- one officer per customer, keep only officers with >=1 unassigned customer
        SELECT one.oname
        FROM (
          SELECT cif, (array_agg(oname))[1] AS oname
          FROM (
            SELECT cbs_customer_id AS cif, btrim(raw->>'accountOfficerName') AS oname
              FROM app.cbs_loans
              WHERE coalesce(btrim(cbs_customer_id),'') <> '' AND btrim(coalesce(raw->>'accountOfficerName','')) <> ''
            UNION ALL
            SELECT cbs_customer_id, btrim(raw->>'accountOfficerName')
              FROM app.cbs_fixed_deposits
              WHERE coalesce(btrim(cbs_customer_id),'') <> '' AND btrim(coalesce(raw->>'accountOfficerName','')) <> ''
          ) ac
          GROUP BY cif
        ) one
        WHERE NOT EXISTS (SELECT 1 FROM app.customer_officers co WHERE co.cif = one.cif)
        GROUP BY one.oname
      ) o
    ) s
  ) d
  WHERE d.skey IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM app.o3c_users u WHERE app.name_sortkey(u.full_name) = d.skey)
  ON CONFLICT (email) DO NOTHING;

  -- 2) Assign one officer per Udara customer, keyed on CIF, never overwriting an existing row.
  WITH ac AS (
    SELECT cbs_customer_id AS cif, btrim(raw->>'accountOfficerName') AS oname
      FROM app.cbs_loans
      WHERE coalesce(btrim(cbs_customer_id),'') <> '' AND btrim(coalesce(raw->>'accountOfficerName','')) <> ''
    UNION ALL
    SELECT cbs_customer_id, btrim(raw->>'accountOfficerName')
      FROM app.cbs_fixed_deposits
      WHERE coalesce(btrim(cbs_customer_id),'') <> '' AND btrim(coalesce(raw->>'accountOfficerName','')) <> ''
  ),
  one AS (SELECT cif, (array_agg(oname))[1] AS oname FROM ac GROUP BY cif),
  resolved AS (
    SELECT DISTINCT ON (o.cif) o.cif, u.id AS officer_id
    FROM one o
    JOIN app.o3c_users u ON app.name_sortkey(u.full_name) = app.name_sortkey(o.oname)
    ORDER BY o.cif, u.id
  ),
  ins AS (
    INSERT INTO app.customer_officers (cif, officer_id, assigned_by, source, note)
    SELECT cif, officer_id, 1, 'cbs', 'Udara account officer (auto)'
    FROM resolved
    ON CONFLICT (cif) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO assigned FROM ins;

  RETURN assigned;
END
$fn$;
