-- Rollback for 370_what_an_ad_actually_produced.sql
--
-- THIS DISCARDS AD ATTRIBUTION PERMANENTLY. ctwa_clid is issued once, on the first inbound
-- message after an ad click, and Meta never sends it again — there is no API to re-fetch
-- it and no way to reconstruct which conversation came from which ad after the fact. The
-- raw click ids survive in app.whatsapp_messages.ctwa_clid, so the conversations can be
-- re-derived, but every OUTCOME recorded against them (lead, qualified, converted, value)
-- is gone, as is every campaign's recorded spend.
--
-- Drop the writer first or inbound attribution will error: waRecordAttribution in
-- handlers/whatsapp.go writes app.ad_attribution.
--
--   CREATE TABLE app.ad_attribution_backup_370 AS SELECT * FROM app.ad_attribution;
--   CREATE TABLE app.ad_campaigns_backup_370   AS SELECT * FROM app.ad_campaigns;

BEGIN;

DROP VIEW  IF EXISTS app.v_ad_performance;
DROP TABLE IF EXISTS app.ad_attribution;
DROP TABLE IF EXISTS app.ad_campaigns;

COMMIT;
