-- Final tidy: the team is "Call Center", so rename the backing tables off the
-- old "telemarketing_" prefix. Postgres tracks dependent FKs/views/sequences by
-- OID, so a table rename leaves them intact. Idempotent (IF EXISTS).

ALTER TABLE IF EXISTS telemarketing_contacts     RENAME TO call_center_contacts;
ALTER TABLE IF EXISTS telemarketing_leads        RENAME TO call_center_leads;
ALTER TABLE IF EXISTS telemarketing_dispositions RENAME TO call_center_dispositions;
ALTER TABLE IF EXISTS telemarketing_call_logs    RENAME TO call_center_call_logs;
ALTER TABLE IF EXISTS telemarketing_campaigns    RENAME TO call_center_campaigns;
