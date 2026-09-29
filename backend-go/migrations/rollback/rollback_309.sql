-- Rollback 309: remove Hussein Abba from Team Ikechukwu Okoro and soft-delete the account.
--
-- The account is SOFT-deleted, not removed. A hard DELETE would cascade through
-- sales_team_members (ON DELETE CASCADE) and, more importantly, would orphan anything he
-- had already been assigned by the time this runs — leads carry sales_owner_id and targets
-- carry user_id, and both would either break a foreign key or silently lose their owner.
-- Soft-delete is how the rest of the platform retires a user, and it is reversible.
--
-- If he genuinely holds nothing and a hard delete is wanted, check first:
--   SELECT COUNT(*) FROM app.crm_contacts WHERE sales_owner_id =
--          (SELECT id FROM o3c_users WHERE email='habba@o3cards.com');
--   SELECT COUNT(*) FROM app.sales_targets  WHERE user_id =
--          (SELECT id FROM o3c_users WHERE email='habba@o3cards.com');

-- No explicit BEGIN/COMMIT, for the same reason as the migration: the file is already
-- atomic, and an explicit COMMIT would commit whatever transaction the caller is in.

DELETE FROM app.sales_team_members m
 USING o3c_users u
 WHERE m.user_id = u.id
   AND u.email = 'habba@o3cards.com';

UPDATE o3c_users
   SET is_active  = FALSE,
       deleted_at = COALESCE(deleted_at, NOW()),
       updated_at = NOW()
 WHERE email = 'habba@o3cards.com';
