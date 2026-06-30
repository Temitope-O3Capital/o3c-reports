-- Rollback for 018_task_comments
DROP INDEX IF EXISTS idx_crm_task_comments_task;
DROP TABLE IF EXISTS crm_task_comments;
