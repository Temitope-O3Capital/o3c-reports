-- Migration 019: Multi-channel notification preferences + WhatsApp inbound
-- Idempotent — safe to run multiple times

-- Add sender_name to helpdesk_messages for inbound WhatsApp
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS sender_name TEXT;

-- Add contact_phone / contact_name to helpdesk_tickets (used by WhatsApp inbound)
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS contact_name  TEXT;

-- Drop the restrictive notifications type CHECK so the Notify() dispatcher can
-- insert any event-type string (task_assigned, loan_approved, etc.)
DO $$ BEGIN
    ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Add birthday / date_of_birth to crm_contacts (used by birthday worker)
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS birthday         DATE;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS account_manager_id BIGINT REFERENCES o3c_users(id);

-- Global admin config: which channels are on by default per event type
CREATE TABLE IF NOT EXISTS notification_event_config (
    event_type  TEXT    NOT NULL,
    channel     TEXT    NOT NULL, -- 'in_app','email','sms','whatsapp'
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    label       TEXT,
    description TEXT,
    PRIMARY KEY (event_type, channel)
);

-- Per-user overrides
CREATE TABLE IF NOT EXISTS notification_preferences (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT  NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
    event_type TEXT    NOT NULL,
    channel    TEXT    NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (user_id, event_type, channel)
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_preferences(user_id);

-- Seed default event config
INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
('task_assigned',       'in_app',   true,  'Task Assigned',        'When a task is assigned to you'),
('task_assigned',       'email',    true,  'Task Assigned',        'When a task is assigned to you'),
('task_assigned',       'sms',      false, 'Task Assigned',        'When a task is assigned to you'),
('task_assigned',       'whatsapp', false, 'Task Assigned',        'When a task is assigned to you'),
('task_due_soon',       'in_app',   true,  'Task Due Tomorrow',    'Task due in 24 hours'),
('task_due_soon',       'email',    true,  'Task Due Tomorrow',    'Task due in 24 hours'),
('task_due_soon',       'sms',      false, 'Task Due Tomorrow',    'Task due in 24 hours'),
('task_due_soon',       'whatsapp', false, 'Task Due Tomorrow',    'Task due in 24 hours'),
('task_overdue',        'in_app',   true,  'Task Overdue',         'Task is past its due date'),
('task_overdue',        'email',    true,  'Task Overdue',         'Task is past its due date'),
('task_overdue',        'sms',      true,  'Task Overdue',         'Task is past its due date'),
('task_overdue',        'whatsapp', false, 'Task Overdue',         'Task is past its due date'),
('birthday_soon',       'in_app',   true,  'Birthday in 3 Days',   'Contact birthday approaching'),
('birthday_soon',       'email',    true,  'Birthday in 3 Days',   'Contact birthday approaching'),
('birthday_soon',       'sms',      false, 'Birthday in 3 Days',   'Contact birthday approaching'),
('birthday_soon',       'whatsapp', false, 'Birthday in 3 Days',   'Contact birthday approaching'),
('birthday_today',      'in_app',   true,  'Birthday Today',       'Contact birthday is today'),
('birthday_today',      'email',    false, 'Birthday Today',       'Contact birthday is today'),
('birthday_today',      'sms',      false, 'Birthday Today',       'Contact birthday is today'),
('birthday_today',      'whatsapp', true,  'Birthday Today',       'Contact birthday is today'),
('loan_submitted',      'in_app',   true,  'Loan Application',     'New loan application submitted'),
('loan_submitted',      'email',    true,  'Loan Application',     'New loan application submitted'),
('loan_submitted',      'sms',      false, 'Loan Application',     'New loan application submitted'),
('loan_submitted',      'whatsapp', false, 'Loan Application',     'New loan application submitted'),
('loan_stage_changed',  'in_app',   true,  'Loan Stage Changed',   'Application moved to new stage'),
('loan_stage_changed',  'email',    true,  'Loan Stage Changed',   'Application moved to new stage'),
('loan_stage_changed',  'sms',      false, 'Loan Stage Changed',   'Application moved to new stage'),
('loan_stage_changed',  'whatsapp', false, 'Loan Stage Changed',   'Application moved to new stage'),
('loan_approved',       'in_app',   true,  'Loan Approved',        'Application approved'),
('loan_approved',       'email',    true,  'Loan Approved',        'Application approved'),
('loan_approved',       'sms',      true,  'Loan Approved',        'Application approved'),
('loan_approved',       'whatsapp', true,  'Loan Approved',        'Application approved'),
('loan_rejected',       'in_app',   true,  'Loan Rejected',        'Application rejected'),
('loan_rejected',       'email',    true,  'Loan Rejected',        'Application rejected'),
('loan_rejected',       'sms',      false, 'Loan Rejected',        'Application rejected'),
('loan_rejected',       'whatsapp', false, 'Loan Rejected',        'Application rejected'),
('ticket_assigned',     'in_app',   true,  'Ticket Assigned',      'A helpdesk ticket assigned to you'),
('ticket_assigned',     'email',    true,  'Ticket Assigned',      'A helpdesk ticket assigned to you'),
('ticket_assigned',     'sms',      false, 'Ticket Assigned',      'A helpdesk ticket assigned to you'),
('ticket_assigned',     'whatsapp', false, 'Ticket Assigned',      'A helpdesk ticket assigned to you'),
('ticket_replied',      'in_app',   true,  'Ticket Reply',         'New message on your ticket'),
('ticket_replied',      'email',    true,  'Ticket Reply',         'New message on your ticket'),
('ticket_replied',      'sms',      false, 'Ticket Reply',         'New message on your ticket'),
('ticket_replied',      'whatsapp', false, 'Ticket Reply',         'New message on your ticket'),
('ticket_sla_breach',   'in_app',   true,  'SLA Breach Warning',   'Ticket nearing SLA deadline'),
('ticket_sla_breach',   'email',    true,  'SLA Breach Warning',   'Ticket nearing SLA deadline'),
('ticket_sla_breach',   'sms',      true,  'SLA Breach Warning',   'Ticket nearing SLA deadline'),
('ticket_sla_breach',   'whatsapp', false, 'SLA Breach Warning',   'Ticket nearing SLA deadline'),
('deal_stage_changed',  'in_app',   true,  'Deal Stage Changed',   'CRM deal moved to new stage'),
('deal_stage_changed',  'email',    false, 'Deal Stage Changed',   'CRM deal moved to new stage'),
('deal_stage_changed',  'sms',      false, 'Deal Stage Changed',   'CRM deal moved to new stage'),
('deal_stage_changed',  'whatsapp', false, 'Deal Stage Changed',   'CRM deal moved to new stage'),
('crm_request_created', 'in_app',   true,  'New CRM Request',      'A new customer request created'),
('crm_request_created', 'email',    true,  'New CRM Request',      'A new customer request created'),
('crm_request_created', 'sms',      false, 'New CRM Request',      'A new customer request created'),
('crm_request_created', 'whatsapp', false, 'New CRM Request',      'A new customer request created')
ON CONFLICT DO NOTHING;
