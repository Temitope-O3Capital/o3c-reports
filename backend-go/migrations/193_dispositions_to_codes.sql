-- 193: Standardize call_center_dispositions.outcome on canonical CODES.
--
-- syncLeadFromCall was writing the business-disposition LABEL (or a raw telephony
-- outcome) into call_center_dispositions.outcome, while the reporting readers
-- (ccPerformanceKPIs / ccAgentPerformance) tested it as if it held short codes:
--   * connected = outcome NOT IN ('no_answer','voicemail')  → the 2,293 rows stored as
--     "Unreachable / No Answer" counted as CONNECTED (connect-rate badly inflated);
--   * ptp_count = outcome = 'ptp'                            → the "Promise to Pay" rows
--     never matched → always 0;
--   * conversion = outcome = 'converted'                     → 'converted' is a lead
--     STATUS, never a disposition → always 0.
-- And duration_sec was never populated → avg_handle = 0.
--
-- This migration (a) backfills the stored labels to codes, mirroring the Go normalizer
-- ccDispositionCode exactly, and (b) installs two IMMUTABLE helper functions so every
-- reader shares one source of truth for the code→label display and the connected test
-- instead of re-hardcoding a NOT IN list. The Go writer is changed in the same batch to
-- write codes + duration going forward. Idempotent: canonical codes pass through
-- unchanged, so re-running is a no-op.

-- ── Code → human label (for display: ccByDisposition, the overview outcomes list) ──
CREATE OR REPLACE FUNCTION app.cc_disposition_label(code text) RETURNS text AS $$
  SELECT CASE lower(COALESCE(code,''))
    WHEN 'answered_interested'     THEN 'Answered — Interested'
    WHEN 'answered_not_interested' THEN 'Answered — Not Interested'
    WHEN 'callback'                THEN 'Callback Requested'
    WHEN 'ptp'                     THEN 'Promise to Pay'
    WHEN 'not_eligible'            THEN 'Not Eligible'
    WHEN 'not_ready'               THEN 'Not Ready Yet'
    WHEN 'call_dropped'            THEN 'Call Dropped'
    WHEN 'no_answer'               THEN 'No Answer'
    WHEN 'wrong_number'            THEN 'Wrong Number'
    WHEN 'do_not_call'             THEN 'Do Not Call'
    WHEN 'connected'               THEN 'Connected'
    WHEN 'other'                   THEN 'Other'
    ELSE COALESCE(NULLIF(code,''), 'Unknown')
  END
$$ LANGUAGE sql IMMUTABLE;

-- ── Did a human actually speak? Mirrors ccDisposition.Connected in Go. ──
-- Not-connected = no answer / wrong number / voicemail (and empty). Everything else,
-- including call_dropped (line was answered, then dropped), counts as connected.
CREATE OR REPLACE FUNCTION app.cc_disposition_connected(code text) RETURNS boolean AS $$
  SELECT lower(COALESCE(code,'')) NOT IN ('no_answer','wrong_number','voicemail','')
$$ LANGUAGE sql IMMUTABLE;

-- ── Backfill: labels → codes (order matters — "not interested" before "interested"). ──
UPDATE app.call_center_dispositions
   SET outcome = CASE
     -- already canonical → unchanged (keeps this migration idempotent)
     WHEN lower(outcome) IN ('answered_interested','answered_not_interested','callback',
                             'ptp','not_eligible','not_ready','call_dropped','no_answer',
                             'wrong_number','do_not_call','connected','other')
                                                        THEN lower(outcome)
     WHEN lower(outcome) LIKE '%do not call%'           THEN 'do_not_call'
     WHEN lower(outcome) LIKE '%promise to pay%'
       OR lower(outcome) = 'ptp'                        THEN 'ptp'
     WHEN lower(outcome) LIKE '%not eligible%'          THEN 'not_eligible'
     WHEN lower(outcome) LIKE '%not ready%'             THEN 'not_ready'
     WHEN lower(outcome) LIKE '%callback%'              THEN 'callback'
     WHEN lower(outcome) LIKE '%drop%'                  THEN 'call_dropped'
     WHEN lower(outcome) LIKE '%not interested%'        THEN 'answered_not_interested'
     WHEN lower(outcome) LIKE '%interested%'            THEN 'answered_interested'
     WHEN lower(outcome) LIKE '%wrong number%'          THEN 'wrong_number'
     WHEN lower(outcome) LIKE '%unreachable%'
       OR lower(outcome) LIKE '%no answer%'
       OR lower(outcome) LIKE '%voicemail%'
       OR lower(outcome) = 'missed'                     THEN 'no_answer'
     WHEN lower(outcome) IN ('completed','answered','resolved') THEN 'connected'
     WHEN COALESCE(TRIM(outcome),'') = ''               THEN outcome
     ELSE 'other'
   END
 WHERE outcome IS NOT NULL;
