-- Saved SQL for the BI team's console.
--
-- WHY A TABLE AT ALL. The console works without it — an analyst can type a query and run
-- it — but a query nobody can save is a query nobody can re-run next month, and the
-- Report Builder already proved what that costs: 1 saved report and 0 schedules after
-- six weeks. Something that cannot be kept does not get used twice.
--
-- is_shared, not is_public. The word matters: a shared query is visible to the other
-- analysts, not to the company. Visibility is scoped by the endpoint's own guard — the
-- "reports" page, which core/auth.go grants to bi_analyst, bi_head and admin only — so
-- "shared" here means shared WITHIN BI. A department head cannot reach the console at
-- all, with or without this flag.
--
-- VISIBILITY IS NOT PERMISSION TO EDIT. biSQLUpdateSaved and biSQLDeleteSaved both scope
-- on created_by in the WHERE clause rather than reading the row and then checking, so a
-- shared query can be read and run by any analyst and changed only by its author. That
-- is deliberate: a shared query someone else is relying on should not change under them.
--
-- sql_text IS NOT VALIDATED BY THIS SCHEMA, and must not be. A CHECK constraint that
-- tried to enforce "SELECT only" would be a parser in a constraint — the same mistake as
-- trying to make a regex the security boundary. Safety lives where it can be enforced:
-- the read-only transaction and statement timeout in handlers/bi_sql.go, which Postgres
-- applies at execution. The text is validated on save as well as on run so a query that
-- could never execute is not stored for a colleague to find, but that is a courtesy, not
-- the control.

BEGIN;

CREATE TABLE IF NOT EXISTS app.bi_sql_queries (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    sql_text    TEXT        NOT NULL,
    is_shared   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by  BIGINT      REFERENCES app.o3c_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list query is "mine, or shared", ordered by recency. ON DELETE SET NULL above
-- means a departed analyst's shared queries survive them, which is the point of sharing.
CREATE INDEX IF NOT EXISTS bi_sql_queries_owner_idx
    ON app.bi_sql_queries (created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS bi_sql_queries_shared_idx
    ON app.bi_sql_queries (updated_at DESC) WHERE is_shared;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────
-- THE HARDENING THIS MIGRATION CANNOT APPLY, AND WHY IT IS STILL WORTH DOING
-- ─────────────────────────────────────────────────────────────────────────────────
--
-- The console's application controls are real: the query runs in a read-only
-- transaction (Postgres refuses CREATE TABLE inside it — verified 2026-10-09), under a
-- statement timeout (verified the same day), and the RESULT is screened for
-- credential-shaped columns and values before any row is returned.
--
-- What they are not is a database boundary. The app connects as o3_app, which can still
-- SELECT app.o3c_users.password_hash; the console refuses to RETURN it, but the
-- connection could read it. Closing that needs a role, and o3_app has
-- rolcreaterole = false, so this migration cannot make one. It has to be run by a
-- superuser, once, by hand:
--
--   -- As postgres, against the o3 workspace database:
--   CREATE ROLE o3_bi_readonly LOGIN PASSWORD '<generate one, store it in .env>'
--     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
--
--   GRANT CONNECT ON DATABASE <db> TO o3_bi_readonly;
--   GRANT USAGE   ON SCHEMA app  TO o3_bi_readonly;
--   GRANT SELECT  ON ALL TABLES IN SCHEMA app TO o3_bi_readonly;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA app
--     GRANT SELECT ON TABLES TO o3_bi_readonly;   -- so a new table is readable too
--
--   -- And then take back the things no analyst needs to read:
--   REVOKE SELECT ON app.api_credentials, app.sse_tokens, app.fx_api_clients
--       FROM o3_bi_readonly;
--   REVOKE SELECT (password_hash, totp_secret_encrypted, telnyx_sip_password_enc,
--                  zoho_voice_refresh_token, zoho_voice_access_token)
--       ON app.o3c_users FROM o3_bi_readonly;
--   REVOKE SELECT (subject_name_encrypted, subject_id_encrypted, summary_encrypted)
--       ON app.sars FROM o3_bi_readonly;
--
--   ALTER ROLE o3_bi_readonly SET statement_timeout = '25s';
--   ALTER ROLE o3_bi_readonly SET default_transaction_read_only = on;
--
-- Then set BI_SQL_DATABASE_URL in backend-go/.env to that role's connection string. The
-- console reads it when present and falls back to the app connection when it is not,
-- announcing which one it used — so this is a hardening step that can be taken whenever
-- Infrastructure has a window, not a prerequisite.
--
-- WRITE THE PASSWORD WITH CARE: a BOM in .env stops the backend booting (recorded
-- against this repo), so append the line rather than rewriting the file with PowerShell.
