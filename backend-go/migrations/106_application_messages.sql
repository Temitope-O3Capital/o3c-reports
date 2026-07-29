CREATE TABLE IF NOT EXISTS application_messages (
  id               BIGSERIAL PRIMARY KEY,
  application_id   BIGINT NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
  author_user_id   BIGINT REFERENCES o3c_users(id),
  author_name      TEXT,
  author_role      TEXT,
  body             TEXT NOT NULL,
  mention_ids      JSONB NOT NULL DEFAULT '[]',
  msg_type         TEXT NOT NULL DEFAULT 'message',   -- 'message' | 'system'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS application_messages_app_id_idx
  ON application_messages(application_id, created_at ASC);
