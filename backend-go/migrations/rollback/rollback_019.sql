-- Rollback for 019_notification_prefs
ALTER TABLE helpdesk_messages DROP COLUMN IF EXISTS sender_name;
ALTER TABLE helpdesk_tickets  DROP COLUMN IF EXISTS contact_phone;
ALTER TABLE helpdesk_tickets  DROP COLUMN IF EXISTS contact_name;
ALTER TABLE crm_contacts      DROP COLUMN IF EXISTS birthday;
ALTER TABLE crm_contacts      DROP COLUMN IF EXISTS account_manager_id;

DROP TABLE IF EXISTS notification_preferences;
