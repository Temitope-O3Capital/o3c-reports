-- Task comments table (for per-task threaded notes)
CREATE TABLE IF NOT EXISTS crm_task_comments (
    id         BIGSERIAL PRIMARY KEY,
    task_id    BIGINT      NOT NULL REFERENCES crm_tasks(id) ON DELETE CASCADE,
    author_id  BIGINT      REFERENCES o3c_users(id),
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_task_comments_task ON crm_task_comments(task_id);
