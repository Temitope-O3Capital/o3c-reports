-- 174_wire_leads_to_sales_pipeline.sql
--
-- Connects the call-centre lead book to the sales pipeline.
--
-- There were two lead books with nothing between them. The call centre dials
-- app.call_center_leads; Sales works app.crm_contacts.lead_stage. Only 7 of 246
-- call-centre leads existed in the CRM book at all, and lead_stage only ever held
-- 'new' or 'converted' — the 'contacted' and 'qualified' stages the Sales funnel
-- is built on had never been used, and crm_lead_events was empty.
--
-- So an agent could work a lead all day — reach them, qualify them, book a
-- callback — and Sales would still see 'new', which is why the pipeline reads
-- zero. Conversion had nowhere to land: not one lead has ever reached 'converted'
-- in the call-centre book either.
--
-- This does three things:
--   1. Gives call_center_leads a contact_id and fills it by phone.
--   2. Creates a CRM contact for a worked lead that has none, so the call
--      centre's book is visible to Sales instead of being a private list.
--   3. Derives each contact's stage from the work already done.
--
-- Stages only ever move FORWARD (using the same rank the Go code uses:
-- new 0, contacted 1, qualified 2, converted/disqualified 3). A lead already
-- converted in the CRM is never dragged back to 'contacted' by a later dial.

ALTER TABLE app.call_center_leads ADD COLUMN IF NOT EXISTS contact_id bigint;
CREATE INDEX IF NOT EXISTS call_center_leads_contact_idx ON app.call_center_leads (contact_id);

-- 1. Link by phone, using the same last-10-digits rule as the rest of the workspace.
UPDATE app.call_center_leads l
   SET contact_id = c.id
  FROM app.crm_contacts c
 WHERE l.contact_id IS NULL
   AND COALESCE(l.customer_phone,'') <> ''
   AND right(regexp_replace(COALESCE(c.phone,''),'\D','','g'),10)
     = right(regexp_replace(l.customer_phone,'\D','','g'),10)
   -- A number shared by several contacts cannot be resolved to one person, and
   -- guessing would attach a lead's progress to a stranger. Left unlinked.
   -- Measured: all 7 overlapping numbers match TWO contacts each, so none link.
   -- That is the guard working, not a failure — see [[cif-is-card-not-person]].
   AND (SELECT COUNT(*) FROM app.crm_contacts c2
         WHERE right(regexp_replace(COALESCE(c2.phone,''),'\D','','g'),10)
             = right(regexp_replace(l.customer_phone,'\D','','g'),10)) = 1;

-- 2. Create a CRM contact for any lead that has been worked but has none.
--    Only leads that have actually been called: an untouched imported number is
--    not yet a sales prospect and would just inflate the book.
WITH created AS (
  INSERT INTO app.crm_contacts (first_name, last_name, phone, email, source, lead_source,
                                source_type, lead_stage, lead_owner_id, status)
  SELECT COALESCE(NULLIF(split_part(TRIM(l.customer_name), ' ', 1),''), 'Lead'),
         NULLIF(TRIM(substring(TRIM(l.customer_name) from position(' ' in TRIM(l.customer_name))+1)),''),
         l.customer_phone, NULLIF(TRIM(COALESCE(l.email,'')),''),
         -- source_type is a two-value enum (bd_assigned/self_sourced); the call centre
         -- working its own list is self-sourced. 'call_centre' goes in the free-text
         -- source columns so the origin is still visible in the CRM.
         'call_centre', 'call_centre', 'self_sourced', 'new', l.assigned_to, 'lead'
    FROM app.call_center_leads l
   WHERE l.contact_id IS NULL
     AND COALESCE(l.customer_phone,'') <> ''
     AND l.last_called_at IS NOT NULL
  RETURNING id, phone
)
UPDATE app.call_center_leads l
   SET contact_id = created.id
  FROM created
 WHERE l.contact_id IS NULL AND l.customer_phone = created.phone;

-- 3. Derive the stage from the work already done, forward-only.
WITH want AS (
  SELECT l.contact_id,
         MAX(CASE
               WHEN l.status = 'converted'                         THEN 3
               WHEN l.status IN ('dnc','closed','invalid')         THEN 3
               WHEN l.status IN ('callback','called')              THEN 2
               WHEN l.last_called_at IS NOT NULL                   THEN 1
               ELSE 0 END) AS rank,
         -- 'disqualified' and 'converted' share rank 3, so the label is decided
         -- separately from the ordering.
         bool_or(l.status = 'converted')                    AS any_converted,
         bool_or(l.status IN ('dnc','closed','invalid'))    AS any_dead
    FROM app.call_center_leads l
   WHERE l.contact_id IS NOT NULL
   GROUP BY l.contact_id
),
target AS (
  SELECT w.contact_id,
         CASE WHEN w.any_converted THEN 'converted'
              WHEN w.rank = 3      THEN 'disqualified'
              WHEN w.rank = 2      THEN 'qualified'
              WHEN w.rank = 1      THEN 'contacted'
              ELSE 'new' END AS stage,
         w.rank
    FROM want w
),
moved AS (
  UPDATE app.crm_contacts c
     SET lead_stage = t.stage, updated_at = NOW()
    FROM target t
   WHERE c.id = t.contact_id
     AND t.rank > CASE c.lead_stage WHEN 'new' THEN 0 WHEN 'contacted' THEN 1
                                    WHEN 'qualified' THEN 2 ELSE 3 END
  RETURNING c.id, c.lead_stage
)
INSERT INTO app.crm_lead_events (contact_id, event, to_stage, note)
SELECT id, 'stage_changed', lead_stage,
       'Derived from call-centre activity when the two lead books were connected'
  FROM moved;
