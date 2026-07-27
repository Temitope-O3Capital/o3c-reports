-- Migration 101: Notification defaults for Sales AM account alert events

INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES

-- Loan repayment alerts
('loan_repayment_due_soon',   'in_app', true,  'Loan Due in 7 Days',  'A customer loan repayment is due in 7 days'),
('loan_repayment_due_soon',   'email',  true,  'Loan Due in 7 Days',  'A customer loan repayment is due in 7 days'),
('loan_repayment_due_soon',   'sms',    false, 'Loan Due in 7 Days',  'A customer loan repayment is due in 7 days'),

('loan_repayment_due_3days',  'in_app', true,  'Loan Due in 3 Days',  'A customer loan repayment is due in 3 days'),
('loan_repayment_due_3days',  'email',  true,  'Loan Due in 3 Days',  'A customer loan repayment is due in 3 days'),
('loan_repayment_due_3days',  'sms',    true,  'Loan Due in 3 Days',  'A customer loan repayment is due in 3 days'),

('loan_repayment_due_today',  'in_app', true,  'Loan Due Today',      'A customer loan repayment is due today'),
('loan_repayment_due_today',  'email',  true,  'Loan Due Today',      'A customer loan repayment is due today'),
('loan_repayment_due_today',  'sms',    true,  'Loan Due Today',      'A customer loan repayment is due today'),

('loan_past_due',             'in_app', true,  'Overdue Loan',        'A customer loan is past its repayment date (DPD > 0)'),
('loan_past_due',             'email',  true,  'Overdue Loan',        'A customer loan is past its repayment date (DPD > 0)'),
('loan_past_due',             'sms',    false, 'Overdue Loan',        'A customer loan is past its repayment date (DPD > 0)'),

-- FD maturity alerts
('fd_maturing_3days',         'in_app', true,  'FD Maturing in 3 Days', 'A customer fixed deposit matures in 3 days'),
('fd_maturing_3days',         'email',  true,  'FD Maturing in 3 Days', 'A customer fixed deposit matures in 3 days'),
('fd_maturing_3days',         'sms',    true,  'FD Maturing in 3 Days', 'A customer fixed deposit matures in 3 days'),

('fd_maturing_today',         'in_app', true,  'FD Maturing Today',   'A customer fixed deposit matures today'),
('fd_maturing_today',         'email',  true,  'FD Maturing Today',   'A customer fixed deposit matures today'),
('fd_maturing_today',         'sms',    true,  'FD Maturing Today',   'A customer fixed deposit matures today')

ON CONFLICT DO NOTHING;
