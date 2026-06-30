-- Rollback for 017_helpdesk_notifications_tracking
ALTER TABLE campaign_contacts DROP COLUMN IF EXISTS tracking_id;
ALTER TABLE campaign_events   DROP COLUMN IF EXISTS contact_id;
ALTER TABLE campaign_events   DROP COLUMN IF EXISTS tracking_id;
ALTER TABLE campaign_events   DROP COLUMN IF EXISTS channel;
ALTER TABLE campaign_events   DROP COLUMN IF EXISTS url;

-- inbound_mail columns (if added in this migration)
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS ticket_id;
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS ticket_ref;
ALTER TABLE inbound_mail DROP COLUMN IF EXISTS ticket_subject;
