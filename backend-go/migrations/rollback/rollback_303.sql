-- Rollback for 303_two_more_sales_teams
--
-- Removes both teams and, by ON DELETE CASCADE on sales_team_members.team_id, their
-- membership rows with them. Nothing else references a team, so this is a clean delete.
--
-- Deliberately keyed on name and NOT conditioned on the membership being untouched: if
-- someone has since added Husseini or moved an officer in, they still go with the team
-- — the team itself is what is being withdrawn. Check who is on them before running:
--
--   SELECT t.name, u.full_name FROM app.sales_team_members m
--     JOIN app.sales_teams t ON t.id = m.team_id
--     JOIN app.o3c_users  u ON u.id = m.user_id
--    WHERE t.name IN ('Team Ozioma','Team Ikechukwu Okoro');
--
-- Officers released this way become unteamed, not deleted, and fall back to seeing only
-- their own leads.

DELETE FROM app.sales_teams WHERE name IN ('Team Ozioma', 'Team Ikechukwu Okoro');

-- The name index is additive and harmless, but 303 introduced it, so 303 takes it back.
-- Dropped last: while the rows above still existed it was doing useful work.
DROP INDEX IF EXISTS app.uq_sales_teams_name;
