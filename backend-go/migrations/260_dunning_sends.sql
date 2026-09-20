-- 260: the arrears-reminder send log, and the template that feeds it.
--
-- Dunning gets its OWN log rather than reusing campaign_contacts. That table is
-- campaign-shaped (campaign_id, position, tracking_id; 16,256 rows across 4 campaigns)
-- and, more importantly, marketing contacts are purged on a 2-year NDPR consent basis
-- (batch.go). "We told this customer they owed money, on this date, in these words" is
-- a different record with a different retention story, and it must survive a marketing
-- purge. Keeping them apart also keeps consent honest: agreeing to marketing is not
-- agreeing to debt collection, and vice versa.
--
-- Every row records the DECISION as well as the send, including suppressed and skipped
-- attempts. A dunning log that only lists successful sends cannot answer the question
-- that actually gets asked — "why did this customer get a message when they had opted
-- out?" — so suppression is a logged outcome, not an absence of a row.

CREATE TABLE IF NOT EXISTS app.dunning_sends (
    id             BIGSERIAL PRIMARY KEY,
    party_id       BIGINT      REFERENCES app.parties(party_id) ON DELETE SET NULL,
    account_cif    TEXT        NOT NULL,
    facility       TEXT,                       -- product_name from the delinquency view
    channel        TEXT        NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
    dpd            INT         NOT NULL,
    dpd_bucket     TEXT        NOT NULL,
    outstanding_kobo BIGINT    NOT NULL DEFAULT 0,
    recipient      TEXT,                       -- the address/number actually used
    subject        TEXT,
    body           TEXT,                       -- rendered copy, exactly as sent
    outcome        TEXT        NOT NULL
                   CHECK (outcome IN ('sent','failed','suppressed','throttled','no_contact','staff_preview')),
    outcome_detail TEXT,                       -- provider id, error, or which rule skipped it
    template_id    BIGINT      REFERENCES app.message_templates(id) ON DELETE SET NULL,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE app.dunning_sends IS
  'One row per arrears-reminder ATTEMPT, including suppressed, throttled and staff-preview attempts. Kept separate from campaign_contacts: different consent basis, different retention. outcome=staff_preview means the pipeline resolved a real message but delivered it to the staff inbox instead of the customer.';

-- The throttle reads this constantly: "has this facility been contacted this week?"
CREATE INDEX IF NOT EXISTS idx_dunning_sends_cif_sent
  ON app.dunning_sends (account_cif, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dunning_sends_party_sent
  ON app.dunning_sends (party_id, sent_at DESC) WHERE party_id IS NOT NULL;
-- Reporting: what went out, on what channel, with what result.
CREATE INDEX IF NOT EXISTS idx_dunning_sends_outcome
  ON app.dunning_sends (sent_at DESC, channel, outcome);

-- ── The reminder copy ────────────────────────────────────────────────────────────────
-- One template row carries all three channels (message_templates already has sms_body,
-- whatsapp_body and the email fields), so the ladder selects a template by name and the
-- channel decides which column renders. Merge tags use the existing {{field|default}}
-- syntax handled by renderTemplate.
--
-- Copy is deliberately plain: states the facility, the amount and what to do, without
-- threat or urgency language. Firmer wording belongs in the later bands, not the first.
-- No "Reply STOP" line — nothing can receive it (see withSMSOptOut).
INSERT INTO app.message_templates
       (name, channel, category, sms_body, whatsapp_body, email_subject, email_body_text, email_body_html, merge_tags, created_by)
SELECT 'Arrears Reminder · 1-30 Days',
       'multi',
       'collections',
       'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due. Balance: N{{amount}}. Please pay or call us on {{contact_phone|0201 330 3030}}.',
       'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due. The outstanding balance is N{{amount}}. If you have already paid, please ignore this message. To discuss repayment, reply here or call {{contact_phone|0201 330 3030}}.',
       'Your O3 Capital {{facility|account}} is {{dpd}} days past due',
       E'Dear {{first_name|Customer}},\n\nYour {{facility|account}} with O3 Capital is {{dpd}} days past due, with an outstanding balance of N{{amount}}.\n\nIf you have already made this payment, please ignore this message and accept our thanks.\n\nTo make a payment or discuss a repayment arrangement, call us on {{contact_phone|0201 330 3030}} or reply to this email.\n\nO3 Capital',
       '<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital is <strong>{{dpd}} days past due</strong>, with an outstanding balance of <strong>N{{amount}}</strong>.</p><p>If you have already made this payment, please ignore this message and accept our thanks.</p><p>To make a payment or discuss a repayment arrangement, call us on {{contact_phone|0201 330 3030}} or reply to this email.</p><p>O3 Capital</p>',
       '["first_name","facility","dpd","amount","contact_phone"]'::jsonb,
       1
WHERE NOT EXISTS (SELECT 1 FROM app.message_templates WHERE name = 'Arrears Reminder · 1-30 Days');
