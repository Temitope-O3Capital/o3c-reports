-- 139: Durable Zoho→workspace agent crosswalk.
--
-- Agent attribution was previously re-derived by email equality on every import
-- (o3c_users.email = Zoho assignee/agent email). When the emails differ, or the
-- agent isn't a workspace user, the record landed unattributed with no record of
-- who it should have been. This table is the persistent map: resolved once,
-- reused thereafter, and it retains UNMATCHED agents so a supervisor can map them.
--
-- match_method: how o3c_user_id was decided — 'manual' (a human mapped it, wins
-- and is never overwritten by the importer), 'email', 'name', or 'unmatched'
-- (seen in Zoho, no workspace user found yet → surfaced in the admin view).

CREATE TABLE IF NOT EXISTS zoho_agent_map (
  zoho_agent_id  text PRIMARY KEY,
  zoho_email     text,
  zoho_name      text,
  o3c_user_id    bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  match_method   text NOT NULL DEFAULT 'unmatched',  -- manual | email | name | unmatched
  call_count     bigint NOT NULL DEFAULT 0,          -- rough activity signal for the admin view
  first_seen_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zoho_agent_map_user  ON zoho_agent_map(o3c_user_id) WHERE o3c_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_zoho_agent_map_email ON zoho_agent_map(lower(zoho_email)) WHERE zoho_email IS NOT NULL;

-- Stamp the raw Zoho agent id on each imported call so re-mapping an agent is a
-- cheap set-based UPDATE rather than a full re-import.
ALTER TABLE helpdesk_calls ADD COLUMN IF NOT EXISTS zoho_agent_id text;
CREATE INDEX IF NOT EXISTS idx_helpdesk_calls_zoho_agent ON helpdesk_calls(zoho_agent_id) WHERE zoho_agent_id IS NOT NULL;
