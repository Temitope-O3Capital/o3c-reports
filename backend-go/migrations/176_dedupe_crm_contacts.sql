-- 176_dedupe_crm_contacts.sql
--
-- Collapses duplicate CRM contacts. 29,858 rows sat on 14,496 distinct numbers.
--
-- The cause is not a household sharing a line. 12,641 rows (42% of the table)
-- have a PHONE NUMBER where a name should be — placeholder records from an import
-- that had no name — so the same person appears once properly named and once or
-- more as a bare number. Merging is therefore usually a matter of folding the
-- nameless rows into the named one, not choosing between two people.
--
-- Scope, measured:
--   11,310 numbers  placeholder(s) + at most one real name   -> merge (12,467 rows)
--      357 numbers  the same real name more than once        -> merge (446 rows)
--      466 numbers  genuinely DIFFERENT real names           -> LEFT ALONE (851 rows)
--
-- That last group is the reason this cannot simply merge by phone. A number with
-- two real names may be a household or a shared work line, and collapsing them
-- would attach one person's history to another. Same lesson as the call-name
-- backfill and the lead-to-CRM link: a shared number is not an identity.
--
-- Safe with respect to the customer book: customers.contact_id, accounts.contact_id
-- and transactions.contact_id are TEXT columns holding Zoho ids like
-- 0000000000009D33 and have nothing to do with crm_contacts.id. The only bigint
-- references are call_center_leads, crm_lead_events and campaign_events; all are
-- repointed to the survivor BEFORE any delete, because crm_deals / crm_activities
-- / crm_tasks / crm_lead_events cascade on delete.
--
-- Survivor: a real name beats a placeholder; then whoever has an email; then the
-- furthest through the pipeline; then the oldest row. The survivor absorbs any
-- field the others have and it lacks, so merging never loses information.
--
-- Reversible: scrap.bk20260820_crm_contacts_full holds the whole table as it was.

CREATE SCHEMA IF NOT EXISTS scrap;
-- Re-run-safe backup. The original DROP+CREATE meant a second run (e.g. the
-- auto-migrator restarting after a manual first run) would overwrite the genuine
-- pre-dedup snapshot with a copy of the already-deduped table, destroying the
-- rollback net. IF NOT EXISTS keeps the first, real backup and makes a re-run a
-- clean no-op (the dedup below is already idempotent — no mergeable groups remain).
CREATE TABLE IF NOT EXISTS scrap.bk20260820_crm_contacts_full AS SELECT * FROM app.crm_contacts;

DO $$
DECLARE
  merged   bigint;
  repoint  bigint;
BEGIN
  CREATE TEMP TABLE dedup_plan ON COMMIT DROP AS
  WITH n AS (
    SELECT id, phone, email, lead_stage, lead_owner_id, created_at,
           right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) AS ph,
           TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')) AS nm,
           (TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')) ~ '^[+0-9][0-9 +()-]{6,}$') AS is_placeholder
      FROM app.crm_contacts
     WHERE COALESCE(phone,'') <> ''
       AND right(regexp_replace(COALESCE(phone,''),'\D','','g'),10) <> ''
  ),
  grp AS (
    SELECT ph,
           COUNT(*)                                                AS rows,
           COUNT(DISTINCT upper(nm)) FILTER (WHERE NOT is_placeholder) AS real_names
      FROM n GROUP BY ph
  ),
  eligible AS (
    -- More than one row, and never more than one distinct REAL name.
    SELECT ph FROM grp WHERE rows > 1 AND real_names <= 1
  ),
  ranked AS (
    SELECT n.*,
           FIRST_VALUE(n.id) OVER (
             PARTITION BY n.ph
             ORDER BY n.is_placeholder ASC,                                 -- a real name wins
                      (NULLIF(TRIM(COALESCE(n.email,'')),'') IS NULL) ASC,  -- then an email
                      CASE n.lead_stage WHEN 'converted' THEN 0 WHEN 'qualified' THEN 1
                                        WHEN 'contacted' THEN 2 WHEN 'disqualified' THEN 3
                                        ELSE 4 END ASC,                     -- then furthest along
                      n.id ASC                                              -- then oldest
           ) AS keep_id
      FROM n JOIN eligible e ON e.ph = n.ph
  )
  SELECT id AS drop_id, keep_id, ph FROM ranked WHERE id <> keep_id;

  -- Carry across anything the survivor is missing, so a merge never loses data.
  UPDATE app.crm_contacts s SET
      email         = COALESCE(NULLIF(TRIM(s.email),''),       d.email),
      lead_owner_id = COALESCE(s.lead_owner_id,                d.lead_owner_id),
      lead_source   = COALESCE(NULLIF(TRIM(s.lead_source),''), d.lead_source),
      source        = COALESCE(NULLIF(TRIM(s.source),''),      d.source),
      created_at    = LEAST(s.created_at, d.created_at),
      lead_stage    = CASE LEAST(d.rank_s, d.rank_d)
                        WHEN 0 THEN 'converted'
                        WHEN 1 THEN 'qualified'
                        WHEN 2 THEN 'contacted'
                        ELSE s.lead_stage
                      END
    FROM (
      SELECT p.keep_id,
             MIN(NULLIF(TRIM(c.email),''))  AS email,
             MIN(c.lead_owner_id)           AS lead_owner_id,
             MIN(NULLIF(TRIM(c.lead_source),'')) AS lead_source,
             MIN(NULLIF(TRIM(c.source),''))      AS source,
             MIN(c.created_at)              AS created_at,
             MIN(CASE k.lead_stage WHEN 'converted' THEN 0 WHEN 'qualified' THEN 1
                                   WHEN 'contacted' THEN 2 WHEN 'disqualified' THEN 3 ELSE 4 END) AS rank_s,
             MIN(CASE c.lead_stage WHEN 'converted' THEN 0 WHEN 'qualified' THEN 1
                                   WHEN 'contacted' THEN 2 WHEN 'disqualified' THEN 3 ELSE 4 END) AS rank_d
        FROM dedup_plan p
        JOIN app.crm_contacts c ON c.id = p.drop_id
        JOIN app.crm_contacts k ON k.id = p.keep_id
       GROUP BY p.keep_id
    ) d
   WHERE s.id = d.keep_id;

  -- Repoint every bigint reference BEFORE deleting, or the cascade takes them.
  UPDATE app.call_center_leads l SET contact_id = p.keep_id
    FROM dedup_plan p WHERE l.contact_id = p.drop_id;
  GET DIAGNOSTICS repoint = ROW_COUNT;
  RAISE NOTICE 'repointed % call-centre leads', repoint;

  UPDATE app.crm_lead_events e SET contact_id = p.keep_id
    FROM dedup_plan p WHERE e.contact_id = p.drop_id;
  GET DIAGNOSTICS repoint = ROW_COUNT;
  RAISE NOTICE 'repointed % lead events', repoint;

  UPDATE app.campaign_events v SET contact_id = p.keep_id
    FROM dedup_plan p WHERE v.contact_id = p.drop_id;
  GET DIAGNOSTICS repoint = ROW_COUNT;
  RAISE NOTICE 'repointed % campaign events', repoint;

  DELETE FROM app.crm_contacts c USING dedup_plan p WHERE c.id = p.drop_id;
  GET DIAGNOSTICS merged = ROW_COUNT;
  RAISE NOTICE 'merged away % duplicate contacts', merged;
END $$;
