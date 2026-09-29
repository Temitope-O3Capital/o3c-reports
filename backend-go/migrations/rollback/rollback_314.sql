-- Rollback 314: drop the lead tag table and undo the campaign backfill.
--
-- Dropping crm_lead_tags DESTROYS every label anyone has applied since 314 ran. There is
-- no way to recover them — they exist nowhere else. Check first:
--   SELECT count(*), count(DISTINCT tag) FROM app.crm_lead_tags;
--
-- The campaign undo only clears values that still MATCH the forward they were copied
-- from, which is exactly the set 314 wrote plus the 86 that already agreed. A value that
-- now differs was set deliberately afterwards and is left alone. Note this does clear
-- those 86 pre-existing agreeing values too — they are recoverable by re-running 314.

DROP TABLE IF EXISTS app.crm_lead_tags;

UPDATE app.crm_contacts c
   SET source_campaign_id = NULL
  FROM app.call_center_lead_forwards f
 WHERE f.contact_id = c.id
   AND c.source_campaign_id = f.marketing_campaign_id;
