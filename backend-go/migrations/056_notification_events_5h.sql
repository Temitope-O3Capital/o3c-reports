-- Migration 056: Wave 5H — complete the notification event matrix (26 events)

INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
-- Helpdesk / SLA
('ticket_sla_warning',      'in_app', true,  'SLA Warning',            'Ticket within 2 hours of SLA breach'),
('ticket_unassigned_alert', 'in_app', true,  'Unassigned Ticket',      'Ticket unassigned for more than 30 minutes'),
('ticket_unassigned_alert', 'email',  true,  'Unassigned Ticket',      'Ticket unassigned for more than 30 minutes'),
('csat_low_score',          'in_app', true,  'Low CSAT Score',         'Customer rated satisfaction ≤ 2 stars'),
('csat_low_score',          'email',  true,  'Low CSAT Score',         'Customer rated satisfaction ≤ 2 stars'),

-- Compliance / AML
('aml_watchlist_hit',       'in_app', true,  'AML Watchlist Match',    'Customer matched on AML watchlist'),
('aml_watchlist_hit',       'email',  true,  'AML Watchlist Match',    'Customer matched on AML watchlist'),
('sar_filed',               'in_app', true,  'SAR Filed',              'Suspicious Activity Report has been filed'),
('sar_filed',               'email',  true,  'SAR Filed',              'Suspicious Activity Report has been filed'),

-- Collections
('ptp_due_today',           'in_app', true,  'PTP Due Today',          'Promise-to-pay is due today'),
('ptp_due_today',           'email',  false, 'PTP Due Today',          'Promise-to-pay is due today'),
('ptp_broken',              'in_app', true,  'PTP Broken',             'Customer missed a promise-to-pay date'),
('ptp_broken',              'email',  true,  'PTP Broken',             'Customer missed a promise-to-pay date'),
('account_dpd90',           'in_app', true,  'Account at DPD 90',      'Loan account crossed 90 days past due'),
('account_dpd90',           'email',  true,  'Account at DPD 90',      'Loan account crossed 90 days past due'),

-- Finance
('fd_maturing_7days',       'in_app', true,  'FD Maturing Soon',       'Fixed deposit matures in 7 days'),
('fd_maturing_7days',       'email',  true,  'FD Maturing Soon',       'Fixed deposit matures in 7 days'),
('fd_matured_unactioned',   'in_app', true,  'FD Matured — No Action', 'Fixed deposit matured today with no rollover or liquidation'),
('fd_matured_unactioned',   'email',  true,  'FD Matured — No Action', 'Fixed deposit matured today with no rollover or liquidation'),

-- Campaigns / Marketing
('campaign_delivery_failed','in_app', true,  'Campaign Delivery Failed','Campaign send job encountered errors'),
('campaign_delivery_failed','email',  true,  'Campaign Delivery Failed','Campaign send job encountered errors'),

-- IT / System
('api_key_expiry',          'in_app', true,  'API Key Expiring',       'API key or JWT secret expires in 30 days'),
('api_key_expiry',          'email',  true,  'API Key Expiring',       'API key or JWT secret expires in 30 days'),
('system_alert',            'email',  true,  'System Alert',           'Critical system event (deployment failure, tunnel offline)'),

-- Onboarding / Staff
('new_account_created',     'in_app', true,  'New Account Created',    'A new user account has been created'),
('first_login',             'in_app', true,  'First Login',            'User logged in for the first time — show getting started tour')

ON CONFLICT DO NOTHING;
