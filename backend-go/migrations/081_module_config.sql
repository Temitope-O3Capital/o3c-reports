-- Module configuration — controls which sidebar sections are visible to all users.
-- Managed by it_admin via /admin/modules. root and admin sections are always on.

CREATE TABLE module_config (
  key        TEXT        PRIMARY KEY,
  label      TEXT        NOT NULL,
  enabled    BOOLEAN     NOT NULL DEFAULT true,
  sort_order INT         NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO module_config (key, label, enabled, sort_order) VALUES
  ('sales',      'Sales & Business Development', true, 1),
  ('contact',    'Contact Centre',               true, 2),
  ('cards',      'Cards',                        true, 3),
  ('lending',    'Credit Management',            true, 4),
  ('finance',    'Finance',                      true, 5),
  ('compliance', 'Compliance',                   true, 6),
  ('people',     'People & HR',                  true, 7),
  ('analytics',  'Analytics & Reports',          true, 8);
