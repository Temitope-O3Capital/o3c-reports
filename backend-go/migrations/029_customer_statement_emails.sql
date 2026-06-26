-- Audit log for transactional customer statement emails.
CREATE TABLE IF NOT EXISTS customer_statement_emails (
  id                  BIGSERIAL PRIMARY KEY,
  cif_number          TEXT NOT NULL,
  customer_name       TEXT,
  recipient_email     TEXT NOT NULL,
  date_from           DATE NOT NULL,
  date_to             DATE NOT NULL,
  subject             TEXT NOT NULL,
  pdf_filename        TEXT NOT NULL,
  mail_message_id     BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  last_error          TEXT,
  sent_by             BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_cif
  ON customer_statement_emails(cif_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_mail
  ON customer_statement_emails(mail_message_id) WHERE mail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_statement_emails_status
  ON customer_statement_emails(status, created_at DESC);
