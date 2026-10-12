-- ─────────────────────────────────────────────────────────────────────────────────
-- o3_bi_readonly — the database boundary for the BI SQL Console
--
-- RUN THIS AS A SUPERUSER (postgres), BY HAND, ONCE. It is not a migration and must
-- never be moved into backend-go/migrations/: migrate.List() runs EVERY .sql in that
-- directory as o3_app, which has rolsuper = false and rolcreaterole = false (verified
-- 2026-10-12), so a CREATE ROLE there fails — and a failed migration stops the backend
-- booting. That is why this file lives in docs/.
--
-- WHY IT IS WANTED. The SQL console's application controls are real and verified against
-- Postgres: the query runs in a read-only transaction (CREATE TABLE inside it is
-- refused), under a statement timeout (pg_sleep(2) under 300ms is cancelled), and the
-- RESULT is screened for credential-shaped columns and values before any row is
-- returned. Both layers are needed, because each defeats the other's blind spot: a
-- query-text scan is beaten by SELECT *, and a result scan is beaten by
-- substr(password_hash,2,12) AS x.
--
-- WHY IT IS NOT URGENT. What those controls are not is a database boundary. The app
-- connects as o3_app, which CAN still read app.o3c_users.password_hash — the console
-- refuses to return it, but the connection could read it. This role closes that. The
-- console works without it and says which connection it used, so this is a hardening
-- step for whenever Infrastructure has a window, not a prerequisite.
--
-- SAFE TO RE-RUN. Every statement is guarded or idempotent.
-- ─────────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

-- 1. The role. Replace the password before running; do not commit the real one.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'o3_bi_readonly') THEN
        CREATE ROLE o3_bi_readonly LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
        RAISE NOTICE 'created role o3_bi_readonly';
    ELSE
        RAISE NOTICE 'role o3_bi_readonly already exists — leaving its password alone';
    END IF;
END $$;

-- 2. Read everything in app, including tables added later.
--
-- CONNECT is granted through a DO block rather than written literally, because GRANT ...
-- ON DATABASE takes an identifier and not an expression: there is no way to spell
-- current_database() into it, and a psql :variable would have to be set on the command
-- line (if it is not, the statement fails before anything else runs). This way the file
-- is correct whichever database you are connected to.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO o3_bi_readonly', current_database());
    RAISE NOTICE 'granted CONNECT on %', current_database();
END $$;

GRANT USAGE   ON SCHEMA app  TO o3_bi_readonly;
GRANT SELECT  ON ALL TABLES IN SCHEMA app TO o3_bi_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO o3_bi_readonly;

-- 3. Then take back what no analyst needs to read. Column-level REVOKEs are the point
--    of the exercise: the console already refuses to RETURN these, and this makes the
--    connection unable to READ them, so the two layers stop being the same layer.
--
--    Each of these is guarded, because a REVOKE on a column that has been renamed or
--    dropped is an error, and this file must stay re-runnable.
DO $$
DECLARE
    t text;
    c text;
BEGIN
    -- Whole tables that are nothing but secrets.
    FOREACH t IN ARRAY ARRAY['api_credentials', 'sse_tokens', 'fx_api_clients']
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'app' AND table_name = t) THEN
            EXECUTE format('REVOKE SELECT ON app.%I FROM o3_bi_readonly', t);
            RAISE NOTICE 'revoked app.%', t;
        END IF;
    END LOOP;

    -- Credential and secret COLUMNS on tables an analyst otherwise needs.
    FOREACH c IN ARRAY ARRAY['password_hash', 'totp_secret_encrypted',
                             'telnyx_sip_password_enc', 'zoho_voice_refresh_token',
                             'zoho_voice_access_token']
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'app' AND table_name = 'o3c_users'
                      AND column_name = c) THEN
            EXECUTE format('REVOKE SELECT (%I) ON app.o3c_users FROM o3_bi_readonly', c);
            RAISE NOTICE 'revoked app.o3c_users.%', c;
        END IF;
    END LOOP;

    -- The SAR subject fields. A suspicious-activity report names a person who must not
    -- be identifiable from a reporting tool — the dataset that exposes SARs is already
    -- built to name nobody (TestTheSARDatasetNamesNobody pins it); this makes the
    -- connection incapable of it rather than merely unwilling.
    FOREACH c IN ARRAY ARRAY['subject_name_encrypted', 'subject_id_encrypted',
                             'summary_encrypted']
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'app' AND table_name = 'sars'
                      AND column_name = c) THEN
            EXECUTE format('REVOKE SELECT (%I) ON app.sars FROM o3_bi_readonly', c);
            RAISE NOTICE 'revoked app.sars.%', c;
        END IF;
    END LOOP;
END $$;

-- 4. Belt and braces at the role level, so even a connection that forgets to set them
--    inherits them. The console sets both per-transaction as well.
ALTER ROLE o3_bi_readonly SET statement_timeout = '25s';
ALTER ROLE o3_bi_readonly SET default_transaction_read_only = on;

-- ─────────────────────────────────────────────────────────────────────────────────
-- VERIFY — run these afterwards. All four must come out as stated.
-- ─────────────────────────────────────────────────────────────────────────────────
--
--   -- (a) the role exists and is not privileged
--   SELECT rolname, rolsuper, rolcreaterole, rolcreatedb
--     FROM pg_roles WHERE rolname = 'o3_bi_readonly';
--   -- expect: f | f | f
--
--   -- (b) it can read an ordinary table
--   SELECT has_table_privilege('o3_bi_readonly', 'app.customers', 'SELECT');
--   -- expect: t
--
--   -- (c) it CANNOT read the password column
--   SELECT has_column_privilege('o3_bi_readonly', 'app.o3c_users', 'password_hash', 'SELECT');
--   -- expect: f          <-- this is the whole point of the file
--
--   -- (d) it cannot read the credential store
--   SELECT has_table_privilege('o3_bi_readonly', 'app.api_credentials', 'SELECT');
--   -- expect: f
--
-- THEN set BI_SQL_DATABASE_URL in backend-go/.env to this role's connection string and
-- restart. The console reads it when present, PINGS IT, and falls back to the app
-- connection if the ping fails — so a wrong password degrades to today's behaviour
-- instead of breaking the page. It announces which connection it used in the UI.
--
-- WRITE THAT .env LINE WITH CARE: a BOM in .env stops the backend booting (recorded
-- against this repo). Append the line with `Add-Content -Encoding ascii`, or echo it
-- from bash — do not rewrite the file with PowerShell's Set-Content.
-- ─────────────────────────────────────────────────────────────────────────────────
