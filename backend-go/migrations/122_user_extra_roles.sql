-- Secondary roles for multi-team staff.
--
-- A user has one primary `role` plus zero or more `extra_roles`. Page access is
-- the union of all their roles; the sidebar shows a module if any of their roles
-- grants it; row scope stays per-user (own rows) in each module. This lets e.g.
-- an agent belong to both Care and Cards and see only those two teams.
-- JSONB (not text[]) so it round-trips cleanly through the database/sql layer,
-- matching how o3c_custom_roles.pages is stored.
ALTER TABLE o3c_users ADD COLUMN IF NOT EXISTS extra_roles JSONB NOT NULL DEFAULT '[]'::jsonb;
