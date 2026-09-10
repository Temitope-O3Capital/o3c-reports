-- 199_care_mail_workspace.sql
-- Care Module build-out: full email reply, recall/undo-send hold window, deletion
-- approvals, escalation response-timer, mail flagging + subgroups, and an outbox.
--
-- All statements are idempotent. The same objects are also created at runtime by
-- ensureCareSchema() in handlers/helpdesk_care.go, so a fresh boot is self-healing
-- even if this migration has not been applied yet.

-- ── helpdesk_tickets: escalation timer, flagging, subgroup, soft-delete ───────
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_due_at        TIMESTAMPTZ;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_warned        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS escalation_overdue_alerted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS is_flagged               BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flagged_at               TIMESTAMPTZ;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flagged_by               BIGINT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS flag_note                TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS mail_subgroup            TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS deleted_at               TIMESTAMPTZ;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS deleted_by               BIGINT;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS delete_requested         BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_hd_tickets_open_escalation_due
  ON helpdesk_tickets (escalation_due_at)
  WHERE escalated_at IS NOT NULL AND escalation_resolved_at IS NULL AND escalation_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_flagged
  ON helpdesk_tickets (is_flagged) WHERE is_flagged = TRUE;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_subgroup
  ON helpdesk_tickets (mail_subgroup) WHERE mail_subgroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hd_tickets_not_deleted
  ON helpdesk_tickets (id) WHERE deleted_at IS NULL;

-- Anti-storm guard: any escalation already open when this runs should not suddenly
-- fire a "due"/"overdue" alert. Mark them warned + alerted; leave due_at NULL so the
-- worker ignores them entirely (mirrors migration 144's backfill guard).
UPDATE helpdesk_tickets
   SET escalation_warned = TRUE, escalation_overdue_alerted = TRUE
 WHERE escalated_at IS NOT NULL AND escalation_resolved_at IS NULL;

-- ── helpdesk_messages: hold window / recall, cc/bcc ───────────────────────────
-- send_state defaults to 'sent' so EVERY existing row is treated as already-sent
-- and is never re-dispatched by the new outbox worker.
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS send_state  TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS send_after  TIMESTAMPTZ;
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ;
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS recalled_by BIGINT;
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS cc_addrs    JSONB NOT NULL DEFAULT '[]';
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS bcc_addrs   JSONB NOT NULL DEFAULT '[]';
ALTER TABLE helpdesk_messages ADD COLUMN IF NOT EXISTS error_text  TEXT;

CREATE INDEX IF NOT EXISTS idx_hd_messages_pending
  ON helpdesk_messages (send_after)
  WHERE send_state = 'pending';

-- ── helpdesk_delete_requests: one-member-approval to delete a mail/ticket ──────
CREATE TABLE IF NOT EXISTS helpdesk_delete_requests (
    id            BIGSERIAL PRIMARY KEY,
    ticket_id     BIGINT NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
    requested_by  BIGINT NOT NULL REFERENCES o3c_users(id),
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
    decided_by    BIGINT REFERENCES o3c_users(id),
    decided_at    TIMESTAMPTZ,
    decision_note TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- At most one open request per ticket.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hd_delete_req_open
  ON helpdesk_delete_requests (ticket_id) WHERE status = 'pending';

-- ── mail_outbox: undo-send / recall staging for the Mail module ───────────────
-- A composed mail lands here first and is dispatched (via SendMail) only after
-- send_after passes, so it can be recalled inside the window. Reusing SendMail
-- unchanged keeps the real provider path untouched.
CREATE TABLE IF NOT EXISTS mail_outbox (
    id           BIGSERIAL PRIMARY KEY,
    created_by   BIGINT NOT NULL REFERENCES o3c_users(id),
    from_email   TEXT,
    subject      TEXT NOT NULL DEFAULT '',
    payload      JSONB NOT NULL,               -- {to,cc,bcc,html_body,text_body,attachments,send_copy_to_sender}
    send_after   TIMESTAMPTZ NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | sent | recalled | failed
    mail_id      BIGINT,                        -- resulting mail_messages.id once dispatched
    error_text   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending
  ON mail_outbox (send_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mail_outbox_mine
  ON mail_outbox (created_by, created_at DESC);

-- ── notification_event_config: escalation-timer events (in-app only) ──────────
-- Mirrors migration 159's in-app-only pattern so these do not flood inboxes.
INSERT INTO notification_event_config (event_type, channel, enabled, label, description) VALUES
  ('escalation_response_due',    'in_app',   TRUE,  'Escalation response due',     'The escalation assigned to you is approaching its response deadline'),
  ('escalation_response_due',    'email',    FALSE, 'Escalation response due',     ''),
  ('escalation_response_due',    'sms',      FALSE, 'Escalation response due',     ''),
  ('escalation_response_due',    'whatsapp', FALSE, 'Escalation response due',     ''),
  ('escalation_response_overdue','in_app',   TRUE,  'Escalation overdue',          'An escalation assigned to you has passed its response deadline'),
  ('escalation_response_overdue','email',    FALSE, 'Escalation overdue',          ''),
  ('escalation_response_overdue','sms',      FALSE, 'Escalation overdue',          ''),
  ('escalation_response_overdue','whatsapp', FALSE, 'Escalation overdue',          ''),
  ('ticket_delete_requested',    'in_app',   TRUE,  'Mail deletion requested',     'A colleague has requested approval to delete a mail/ticket'),
  ('ticket_delete_requested',    'email',    FALSE, 'Mail deletion requested',     '')
ON CONFLICT (event_type, channel) DO UPDATE SET enabled = EXCLUDED.enabled;

-- ── Seed real email reply templates (channel='email') ─────────────────────────
-- Idempotent via NOT EXISTS on name (the table has no unique constraint on name).
-- Bodies are INNER html — the branded wrapper (wrapBrandedEmail) is applied on send.
INSERT INTO helpdesk_canned_responses (name, channel, subject, category, body_text, body_html)
SELECT v.name, 'email', v.subject, v.category, v.body_text, v.body_html
FROM (VALUES
  ('Acknowledgement — request received',
   'We have received your request [{{ticket_ref}}]',
   'Acknowledgement',
   'Dear {{customer_name}}, thank you for contacting O3 Capital. We have received your request (reference {{ticket_ref}}) and one of our agents is now looking into it. We will get back to you shortly.',
   '<p>Dear {{customer_name}},</p><p>Thank you for contacting O3 Capital. We have received your request and reference <strong>{{ticket_ref}}</strong> has been assigned to it.</p><p>One of our agents is now looking into this and we will get back to you shortly. If you have any additional details to add, simply reply to this email.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Request resolved',
   'Your request has been resolved [{{ticket_ref}}]',
   'Resolution',
   'Dear {{customer_name}}, we are pleased to let you know that your request ({{ticket_ref}}) has been resolved. If you need anything else, please do not hesitate to reach out.',
   '<p>Dear {{customer_name}},</p><p>We are pleased to let you know that your request <strong>{{ticket_ref}}</strong> has now been resolved.</p><p>If there is anything further we can help you with, simply reply to this email and we will be happy to assist.</p><p>Thank you for banking with O3 Capital.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Need more information',
   'A little more information needed [{{ticket_ref}}]',
   'Information',
   'Dear {{customer_name}}, to help us resolve your request ({{ticket_ref}}) we need a little more information from you. Please reply with the details requested and we will proceed right away.',
   '<p>Dear {{customer_name}},</p><p>Thank you for your patience. To help us resolve your request <strong>{{ticket_ref}}</strong>, we need a little more information from you:</p><ul><li>Your registered phone number or account (CIF)</li><li>A short description of what happened, including the date and time</li><li>Any reference or transaction ID you may have</li></ul><p>Simply reply to this email with the details and we will proceed right away.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Escalated to a specialist',
   'Your request has been escalated [{{ticket_ref}}]',
   'Escalation',
   'Dear {{customer_name}}, your request ({{ticket_ref}}) has been escalated to a specialist team for a closer look. We are treating it with priority and will update you as soon as we have news.',
   '<p>Dear {{customer_name}},</p><p>Your request <strong>{{ticket_ref}}</strong> has been escalated to a specialist team for a closer look.</p><p>We are treating this with priority and will update you as soon as we have made progress. Thank you for your patience.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Card blocked / replacement',
   'Your card request [{{ticket_ref}}]',
   'Cards',
   'Dear {{customer_name}}, as requested, we have actioned your card instruction (reference {{ticket_ref}}). For your security, please do not share your card details, PIN or OTP with anyone.',
   '<p>Dear {{customer_name}},</p><p>As requested, we have actioned your card instruction under reference <strong>{{ticket_ref}}</strong>.</p><p>A replacement, where applicable, will be processed within the standard timeline and you will be notified once it is ready.</p><p><strong>For your security:</strong> O3 Capital will never ask for your full card number, PIN or OTP. Please never share these with anyone.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Failed transaction — reversal',
   'Your transaction reversal [{{ticket_ref}}]',
   'Transactions',
   'Dear {{customer_name}}, thank you for reporting the failed transaction (reference {{ticket_ref}}). Confirmed reversals are typically completed within 24 hours for card transactions and within the timelines set by the relevant switch for others. We will confirm once it is done.',
   '<p>Dear {{customer_name}},</p><p>Thank you for reporting the failed transaction under reference <strong>{{ticket_ref}}</strong>.</p><p>We have logged it for reversal. Confirmed reversals are typically completed within <strong>24 hours</strong> for card transactions, and within the timelines set by the relevant switch for others. We will confirm here as soon as the funds are returned.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Statement request',
   'Your account statement [{{ticket_ref}}]',
   'Statements',
   'Dear {{customer_name}}, please find your requested statement attached (reference {{ticket_ref}}). Do let us know if you need a different period or format.',
   '<p>Dear {{customer_name}},</p><p>Please find your requested account statement attached under reference <strong>{{ticket_ref}}</strong>.</p><p>If you need a different period or format, simply reply to this email and we will send it over.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Welcome — new registration',
   'Welcome to O3 Capital',
   'Registration',
   'Dear {{customer_name}}, welcome to O3 Capital! Your registration is complete. If you have any questions getting started, our Care team is here to help.',
   '<p>Dear {{customer_name}},</p><p>Welcome to O3 Capital — we are delighted to have you on board! Your registration is now complete.</p><p>If you have any questions as you get started, simply reply to this email or reach our Care team anytime. We are here to help.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Loan enquiry',
   'Your loan enquiry [{{ticket_ref}}]',
   'Loans',
   'Dear {{customer_name}}, thank you for your loan enquiry (reference {{ticket_ref}}). An officer will review your eligibility and get back to you with the applicable terms. Please have your latest details ready.',
   '<p>Dear {{customer_name}},</p><p>Thank you for your loan enquiry under reference <strong>{{ticket_ref}}</strong>.</p><p>An officer will review your eligibility and get back to you with the applicable terms, tenor and rate. To speed things up, please have your latest income and identification details ready.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Fixed deposit enquiry',
   'Your fixed deposit enquiry [{{ticket_ref}}]',
   'Fixed Deposit',
   'Dear {{customer_name}}, thank you for your interest in our fixed deposit (reference {{ticket_ref}}). Our current rates depend on tenor and amount. An officer will share the exact terms for your preferred option shortly.',
   '<p>Dear {{customer_name}},</p><p>Thank you for your interest in an O3 Capital fixed deposit, logged under reference <strong>{{ticket_ref}}</strong>.</p><p>Our rates depend on tenor and amount. An officer will share the exact terms for your preferred option shortly. Do let us know your intended amount and tenor to help us tailor the offer.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Complaint acknowledgement',
   'We are sorry — your complaint [{{ticket_ref}}]',
   'Complaints',
   'Dear {{customer_name}}, we are sorry for the inconvenience. Your complaint (reference {{ticket_ref}}) has been logged and is receiving our attention. We will keep you updated until it is fully resolved.',
   '<p>Dear {{customer_name}},</p><p>Please accept our sincere apologies for the inconvenience. Your complaint has been logged under reference <strong>{{ticket_ref}}</strong> and is receiving our full attention.</p><p>We will keep you updated at every step until it is fully resolved. Thank you for giving us the opportunity to make it right.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>'),
  ('Follow-up — closing the loop',
   'Following up on your request [{{ticket_ref}}]',
   'Closure',
   'Dear {{customer_name}}, we are following up on your request ({{ticket_ref}}). If everything is now in order we will close it shortly; if you still need help, just reply and we will keep it open.',
   '<p>Dear {{customer_name}},</p><p>We are following up on your request <strong>{{ticket_ref}}</strong>.</p><p>If everything is now in order, we will close it shortly. If you still need help, simply reply to this email and we will keep it open and continue assisting you.</p><p>Warm regards,<br>{{agent_name}}<br>O3 Capital Customer Care</p>')
) AS v(name, subject, category, body_text, body_html)
WHERE NOT EXISTS (
  SELECT 1 FROM helpdesk_canned_responses c WHERE c.name = v.name
);
