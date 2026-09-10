-- ─────────────────────────────────────────────────────────────────────────────
-- Flexible sales team model.
--
-- Until now "who is a sales head" was a role check (salesHeadRoles) and a head saw
-- EVERY lead — there was no notion of a head owning a TEAM of officers. This adds a
-- real, flexible structure: a team has one head and many member officers, a head may
-- run more than one team, and an officer belongs to at most one team (so lead-scoping
-- is unambiguous). core/scope.go already reserved ScopeTeam for exactly this.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app.sales_teams (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  head_user_id bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_teams_head ON app.sales_teams (head_user_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS app.sales_team_members (
  team_id  bigint NOT NULL REFERENCES app.sales_teams(id) ON DELETE CASCADE,
  user_id  bigint NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by bigint REFERENCES o3c_users(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, user_id)
);

-- An officer sits on at most one team: with two teams claiming the same officer, "the
-- leads my team owns" would double-count and distribution would be ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_team_member_user
  ON app.sales_team_members (user_id);
