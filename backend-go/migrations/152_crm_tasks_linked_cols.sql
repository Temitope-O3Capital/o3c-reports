-- 152: crm_tasks linked_type / linked_id columns.
--
-- These columns let a CRM task point at the record it concerns (a book customer, a
-- loan application, a lead, etc.) so task notifications can deep-link (see
-- crm_task_routing.go taskActionURL). Previously listTasks() ran these ALTERs on
-- every GET request via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — schema mutation
-- in a hot read path, on context.Background(), with the error ignored. Moved here so
-- the columns are guaranteed by migration and the read path does no DDL.
--
-- Idempotent: safe to re-run.

ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS linked_type TEXT;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS linked_id   BIGINT;
