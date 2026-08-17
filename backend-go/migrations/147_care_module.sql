-- Care becomes its own module (previously an item nested under Contact Centre).
-- Registers it in module_config so it appears in the Sync/Modules admin and can be
-- enabled/disabled independently of Call Center. sort_order 7 was a free slot between
-- Compliance (6) and Analytics (8); the actual sidebar order is set in Sidebar.tsx.
INSERT INTO module_config (key, label, enabled, sort_order)
VALUES ('care', 'Care', true, 7)
ON CONFLICT (key) DO NOTHING;
