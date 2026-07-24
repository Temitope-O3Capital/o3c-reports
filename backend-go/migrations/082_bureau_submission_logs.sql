-- Credit bureau submission log — tracks monthly CRC / FirstCentral file submissions.

CREATE TABLE bureau_submission_logs (
  id           BIGSERIAL   PRIMARY KEY,
  month        TEXT        NOT NULL,            -- YYYY-MM
  bureau       TEXT        NOT NULL DEFAULT 'CRC',
  submitted_by TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  file_name    TEXT,
  row_count    INT,
  notes        TEXT,
  status       TEXT        NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','acknowledged','rejected'))
);

CREATE INDEX idx_bureau_submission_logs_month ON bureau_submission_logs(month);
