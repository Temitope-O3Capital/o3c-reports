-- 180: admin user cleanup (2026-08-24)
-- One-off data fix requested by the workspace owner. Each statement is targeted by
-- the current email address so a re-run (or a fresh environment where the row does
-- not exist) is a harmless no-op. Deletions are soft (deleted_at + is_active) so the
-- users' historical records keep their foreign keys.

-- Test account — remove.
UPDATE o3c_users SET deleted_at = NOW(), is_active = FALSE
 WHERE email = 'notif-test-zz@o3cards.com' AND deleted_at IS NULL;

-- Duplicate COO login — retire 'Kehinde Nahibi' (knahibi), keep 'Kehinde Naibi' (knaibi).
UPDATE o3c_users SET deleted_at = NOW(), is_active = FALSE
 WHERE email = 'knahibi@o3cards.com' AND deleted_at IS NULL;

-- Correct Olayinka Akinbinu's email.
UPDATE o3c_users SET email = 'yakinbinu@o3cards.com'
 WHERE email = 'oakinbinu@o3cards.com';
