-- Register "Fixed Deposits" as a first-class sidebar module so the new Deposits
-- pillar is visible (the sidebar hides any section whose key is not an enabled
-- module in module_config). Without this row the Deposits section is filtered out
-- for everyone, including admins.

INSERT INTO module_config (key, label, enabled, sort_order) VALUES
  ('deposits', 'Fixed Deposits', true, 35)
ON CONFLICT (key) DO NOTHING;
