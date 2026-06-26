CREATE TABLE IF NOT EXISTS customer_statement_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  subject TEXT,
  message TEXT,
  password_hint TEXT,
  requested_limit INT,
  total_recipients INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_statement_run_recipients (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES customer_statement_runs(id) ON DELETE CASCADE,
  cif_number TEXT NOT NULL,
  customer_name TEXT,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  statement_email_id BIGINT REFERENCES customer_statement_emails(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, cif_number, recipient_email)
);

CREATE INDEX IF NOT EXISTS idx_customer_statement_runs_status
  ON customer_statement_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_statement_run_recipients_run
  ON customer_statement_run_recipients(run_id, status, id);

INSERT INTO settings (key, value)
VALUES
  ('statement_send_delay_ms', '250'),
  ('statement_daily_email_limit', '0')
ON CONFLICT (key) DO NOTHING;
