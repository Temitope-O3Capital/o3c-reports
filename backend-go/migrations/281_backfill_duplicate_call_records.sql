-- 281 — Collapse the historical duplicate call records the live de-duper never saw.
--
-- WHY. Zoho splits a single dial across several records. zohoCollapseDuplicateCall()
-- (handlers/zoho.go) folds them into one, but it runs per call AS THAT CALL IS IMPORTED,
-- so every row imported before it existed was never collapsed. 15,485 rows have been
-- merged by the live path; 4,423 older ones are still standing as separate dials.
--
-- The effect is that the call centre's numbers count some dials twice: 167,724 live call
-- records where there were 163,301 actual dials. Agent call counts, connect rates and
-- "calls per lead" are all computed off that.
--
-- THE MATCHING RULE IS THE LIVE ONE, UNCHANGED. Same normalised phone, same direction,
-- same agent, same provider agent, same started_at to the second. That conjunction is
-- what makes it safe — a shared phone alone would not be.
--
--   * length(app.norm_phone(...)) = 10 is REQUIRED, not cosmetic: app.norm_phone returns
--     '' (never NULL) for anything it cannot parse, so without it every blank-phone call
--     would match every other blank-phone call.
--
-- TWO PEOPLE MUST NEVER BECOME ONE. 19 of the 4,214 candidate groups disagree internally
-- about who was called. Every one was read by hand before this was written:
--
--     '+234 8969664849'  vs  'ALIYU RUFAI'        — one row never resolved the name
--     'LANEM TERSEER MANUEL' vs 'Terseer Lanem'   — the same name, reordered
--     'AMOS ODIBO' vs 'ODIBO AMOS'                — likewise, but under TWO CIFs
--
-- None are two different customers; the name cases are formatting variants. But the three
-- groups carrying two distinct CIFs are excluded anyway (the HAVING below), because a
-- second CIF is the one signal that could mean a second person, and leaving three pairs
-- of calls un-merged costs nothing. Those three are worth a look on their own: they are
-- one human being holding two customer records.
--
-- NAMES ARE RECOVERED, NOT JUST KEPT. 677 of the surviving rows carry the raw phone
-- number in customer_name because that record never resolved the caller, while the twin
-- being merged into them holds the actual name. A plain COALESCE would keep the digits,
-- since they are not empty. The fold below treats a name that is merely the phone number
-- as absent, so the real name wins.
--
-- IDEMPOTENT. The survivor is the LOWEST id in each group and the twins are marked, never
-- deleted — so a second pass sees them already merged, excludes them, and does nothing.
--
-- DRY RUN (rolled back, 2026-09-23): 4,211 groups, 4,423 rows to merge, 0 chained
-- merges, 0 bad survivors, 677 names recovered, live calls 167,724 -> 163,301.

BEGIN;

CREATE TEMP TABLE m281_groups ON COMMIT DROP AS
SELECT app.norm_phone(customer_phone) AS ph, direction, agent_id, zoho_agent_id,
       date_trunc('second', started_at) AS sec,
       MIN(id) AS keep_id
  FROM app.helpdesk_calls
 WHERE length(app.norm_phone(customer_phone)) = 10
   AND source_system = 'zoho_desk'
   AND zoho_call_id IS NOT NULL
   AND merged_into_call_id IS NULL
   AND voided_at IS NULL
 GROUP BY 1,2,3,4,5
HAVING COUNT(*) > 1
   AND COUNT(DISTINCT NULLIF(customer_cif,'')) <= 1;

CREATE TEMP TABLE m281_merges ON COMMIT DROP AS
SELECT h.id AS dup, g.keep_id
  FROM app.helpdesk_calls h
  JOIN m281_groups g
    ON app.norm_phone(h.customer_phone) = g.ph
   AND h.direction = g.direction
   AND h.agent_id      IS NOT DISTINCT FROM g.agent_id
   AND h.zoho_agent_id IS NOT DISTINCT FROM g.zoho_agent_id
   AND date_trunc('second', h.started_at) = g.sec
 WHERE h.source_system = 'zoho_desk' AND h.zoho_call_id IS NOT NULL
   AND h.merged_into_call_id IS NULL AND h.voided_at IS NULL
   AND h.id <> g.keep_id;

-- Refuse to proceed if a row would be merged into one that is itself being merged away,
-- which would leave a dangling survivor.
DO $$
DECLARE chained int;
BEGIN
    SELECT COUNT(*) INTO chained FROM m281_merges m
     WHERE EXISTS (SELECT 1 FROM m281_merges m2 WHERE m2.dup = m.keep_id);
    IF chained > 0 THEN
        RAISE EXCEPTION '281: % merge(s) point at a row that is itself being merged — refusing', chained;
    END IF;
END $$;

-- Fold the group's content onto the survivor BEFORE marking the twins merged, so the
-- source rows are still visible to this statement.
UPDATE app.helpdesk_calls k
   SET duration_sec       = NULLIF(GREATEST(COALESCE(k.duration_sec,0), COALESCE(d.duration_sec,0)), 0),
       recording_filename = COALESCE(k.recording_filename, d.recording_filename),
       notes              = COALESCE(k.notes, d.notes),
       resolution         = COALESCE(k.resolution, d.resolution),
       disposition        = COALESCE(NULLIF(k.disposition,''), d.disposition),
       -- A customer_name that is just the phone number counts as no name at all.
       customer_name      = COALESCE(
                              NULLIF(CASE WHEN length(app.norm_phone(k.customer_name)) = 10
                                            AND app.norm_phone(k.customer_name) = app.norm_phone(k.customer_phone)
                                          THEN '' ELSE k.customer_name END, ''),
                              d.real_name,
                              NULLIF(k.customer_name,''),
                              ''),
       customer_cif       = COALESCE(NULLIF(k.customer_cif,''), NULLIF(d.customer_cif,''), ''),
       ticket_id          = COALESCE(k.ticket_id, d.ticket_id),
       ticket_ref         = COALESCE(k.ticket_ref, d.ticket_ref),
       lead_id            = COALESCE(k.lead_id, d.lead_id),
       -- One dial reported twice counts as connected if EITHER record says it connected.
       outcome            = CASE WHEN k.outcome IN ('missed','no_answer','voicemail')
                                  AND d.outcome IS NOT NULL THEN d.outcome ELSE k.outcome END
  FROM (
    SELECT m.keep_id,
           MAX(h.duration_sec)                                     AS duration_sec,
           MIN(h.recording_filename)                               AS recording_filename,
           MIN(h.notes)                                            AS notes,
           MIN(h.resolution)                                       AS resolution,
           MIN(h.disposition)                                      AS disposition,
           MIN(NULLIF(h.customer_cif,''))                          AS customer_cif,
           MIN(h.customer_name) FILTER (
             WHERE NULLIF(h.customer_name,'') IS NOT NULL
               AND NOT (length(app.norm_phone(h.customer_name)) = 10
                        AND app.norm_phone(h.customer_name) = app.norm_phone(h.customer_phone)))
                                                                   AS real_name,
           MIN(h.ticket_id)                                        AS ticket_id,
           MIN(h.ticket_ref)                                       AS ticket_ref,
           MIN(h.lead_id)                                          AS lead_id,
           MIN(h.outcome) FILTER (
             WHERE h.outcome NOT IN ('missed','no_answer','voicemail','')) AS outcome
      FROM m281_merges m JOIN app.helpdesk_calls h ON h.id = m.dup
     GROUP BY m.keep_id
  ) d
 WHERE k.id = d.keep_id;

UPDATE app.helpdesk_calls h
   SET merged_into_call_id = m.keep_id
  FROM m281_merges m
 WHERE h.id = m.dup;

-- Re-point anything that was ALREADY merged into a row this migration is now merging
-- away. Without this the pointer chains: an older duplicate points at X, X points at Y,
-- and every reader that follows one hop lands on a row that is itself merged. Measured:
-- 13 such rows. merged_into_call_id must always name the FINAL survivor.
UPDATE app.helpdesk_calls h
   SET merged_into_call_id = m.keep_id
  FROM m281_merges m
 WHERE h.merged_into_call_id = m.dup
   AND h.id <> m.keep_id;

DO $$
DECLARE bad int; merged int;
BEGIN
    SELECT COUNT(*) INTO merged FROM m281_merges;
    -- Scoped to the rows THIS migration touched. There are 22 pre-existing chains in the
    -- table from earlier merges, which are a real but separate defect: failing on them
    -- would only stop the server booting and fix nothing. What must be true is that this
    -- migration adds none.
    SELECT COUNT(*) INTO bad
      FROM app.helpdesk_calls h
      JOIN app.helpdesk_calls k ON k.id = h.merged_into_call_id
     WHERE k.merged_into_call_id IS NOT NULL
       AND (k.id IN (SELECT dup FROM m281_merges)
            OR h.id IN (SELECT dup FROM m281_merges));
    IF bad > 0 THEN
        RAISE EXCEPTION '281: % call(s) now point at a survivor that is itself merged — refusing', bad;
    END IF;
    RAISE NOTICE '281: collapsed % duplicate call record(s)', merged;
END $$;

COMMIT;
