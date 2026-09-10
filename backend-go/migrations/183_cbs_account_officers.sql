-- 183: give Udara/CBS customers their account officer as a proper relationship-manager
-- assignment. Udara records the officer only as free text ("Surname Firstname") and few
-- of them are workspace operators, so we (a) mint any missing officer as a no-login user
-- and (b) assign one officer per customer into app.customer_officers. Additive, idempotent,
-- and non-destructive (never overwrites an existing/ manual assignment). The same function
-- is called every CBS sync so new customers/officers are picked up going forward.

-- Order-independent name key: lowercased, whitespace-collapsed, tokens sorted. Lets us
-- match Udara's "Surname Firstname" against a user's "Firstname Surname" without guessing
-- which order a given record uses.
CREATE OR REPLACE FUNCTION app.name_sortkey(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(tok, ' ' ORDER BY tok)
  FROM unnest(regexp_split_to_array(lower(regexp_replace(coalesce(p,''), '\s+', ' ', 'g')), ' ')) AS tok
  WHERE tok <> ''
$$;

CREATE OR REPLACE FUNCTION app.sync_cbs_officers()
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  assigned integer := 0;
BEGIN
  -- 1) Mint a no-login user for every distinct CBS officer not already a workspace user.
  --    password_hash is a sentinel that can never match a bcrypt check, and is_active is
  --    false, so these rows cannot authenticate; they exist only to be named as an RM.
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
      -- Udara stores "Surname Firstname"; rebuild "Firstname Surname" for display.
      array_to_string((s.toks)[2:array_length(s.toks,1)], ' ') AS first_name,
      (s.toks)[1] AS last_name
    FROM (
      SELECT oname, regexp_split_to_array(initcap(regexp_replace(oname,'\s+',' ','g')), ' ') AS toks
      FROM (
        SELECT DISTINCT btrim(raw->>'accountOfficerName') AS oname
        FROM (SELECT raw FROM app.cbs_loans UNION ALL SELECT raw FROM app.cbs_fixed_deposits) t
        WHERE btrim(coalesce(raw->>'accountOfficerName','')) <> ''
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

-- Initial backfill (safe on a fresh env: returns 0 when the CBS tables are empty).
SELECT app.sync_cbs_officers();
