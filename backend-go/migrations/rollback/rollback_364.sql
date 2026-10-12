-- Rollback for 364_one_ledger_for_every_whatsapp_message.sql
--
-- THIS DISCARDS THE DELIVERY RECORD FOR EVERY WHATSAPP MESSAGE, and it is not
-- recoverable from Meta: status webhooks are delivered once and the Cloud API offers no
-- backfill. It also drops the ctwa_clid values, which are the only link between an ad
-- click and the conversation it produced — Meta sends that identifier on the first
-- inbound message and never again.
--
-- Drop the sender's dependency first, or every send will error on a missing table:
-- waLogMessage in handlers/whatsapp.go writes here.
--
--   CREATE TABLE app.whatsapp_messages_backup_364 AS SELECT * FROM app.whatsapp_messages;

BEGIN;

DROP VIEW  IF EXISTS app.v_whatsapp_window;
DROP TABLE IF EXISTS app.whatsapp_messages;

COMMIT;
