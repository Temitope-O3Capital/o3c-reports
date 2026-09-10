-- 181: assign Kehinde Naibi to the new Head of Operations role (2026-08-24).
-- Targeted by email; re-run / fresh-env safe (no-op when already head_ops or absent).
UPDATE o3c_users SET role = 'head_ops'
 WHERE email = 'knaibi@o3cards.com' AND role <> 'head_ops';
