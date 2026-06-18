-- Rollback for 013_campaign_tracking.sql
BEGIN;
DROP TABLE IF EXISTS campaign_contacts CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
COMMIT;
