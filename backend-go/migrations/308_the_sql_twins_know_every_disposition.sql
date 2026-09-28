-- 308 — The SQL twins of the disposition catalogue stop lagging behind Go.
--
-- app.cc_disposition_label and app.cc_disposition_connected (migration 193) are SQL
-- restatements of the Go catalogue `ccDispositions`. Both were written as CLOSED lists in
-- the vocabulary of the day, so every disposition added since has silently fallen through
-- their ELSE branch. Eleven were added on 2026-09-28 and the two functions never heard
-- about any of them.
--
-- LIVE DAMAGE, MEASURED TODAY.
--
--   * cc_disposition_label returns the raw code for anything it does not know, so the
--     supervisor's disposition breakdown (ccByDisposition, and the outcomes list in
--     call_center_outbound.go) literally prints `call_rejected`, `info_sent` and
--     `price_objection` as if they were labels. 25 rows already do this.
--
--   * cc_disposition_connected is a deny-list — NOT IN ('no_answer','wrong_number',
--     'voicemail',''). Anything unknown is therefore CONNECTED. So:
--
--       call_rejected   16 rows  Go says nobody spoke (Connected=false, and ccCallOutcome
--                                writes outcome='no_answer'), SQL counted it as a connect.
--       call_dropped   315 rows  PRE-EXISTING, and larger. ccCallOutcome deliberately
--                                returns 'no_answer' for a call that picked up and died
--                                within seconds, but this function says connected.
--
--     The same call is an unanswered dial on the agent's Call Log and a CONNECT in the
--     supervisor's connect rate. That is the exact defect migration 193 was written to
--     remove — its own header describes 2,293 rows inflating the connect rate — recurring
--     because the fix was a frozen list.
--
-- WHAT "CONNECTED" MEANS HERE. It mirrors Go's ccCallOutcome == 'completed', NOT the
-- catalogue's Connected flag, because the rest of the module counts connects as
-- outcome='completed' (ccStampQueueForPhone) and the ledger is written from ccCallOutcome.
-- The two differ on exactly one code: call_dropped carries Connected=true (the line did
-- pick up) yet is written 'no_answer' (no conversation happened, and a 3-second call
-- satisfies no connect test reliably). Mirroring the flag instead of the outcome would
-- keep those 315 rows wrong.
--
-- AND IT IS MADE TO FAIL LOUDLY NEXT TIME. The guard at the bottom refuses to apply if any
-- code present in app.call_center_dispositions still falls through to the ELSE branch. A
-- twelfth disposition added to Go without touching this file will now break the deploy
-- instead of quietly printing snake_case at a supervisor for three weeks.

BEGIN;

-- Ordered as ccDispositions orders them, so the two files can be read side by side.
CREATE OR REPLACE FUNCTION app.cc_disposition_label(code text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(COALESCE(code,''))
    WHEN 'answered_interested'     THEN 'Answered — Interested'
    WHEN 'answered_not_interested' THEN 'Answered — Not Interested'
    WHEN 'callback'                THEN 'Callback Requested'
    WHEN 'ptp'                     THEN 'Promise to Pay'
    WHEN 'not_eligible'            THEN 'Not Eligible'
    WHEN 'not_ready'               THEN 'Not Ready Yet'
    WHEN 'resolved'                THEN 'Resolved'
    WHEN 'call_dropped'            THEN 'Call Dropped'
    WHEN 'no_answer'               THEN 'No Answer'
    WHEN 'wrong_number'            THEN 'Wrong Number'
    WHEN 'do_not_call'             THEN 'Do Not Call'
    -- The four outcomes that were being buried in "Not Interested".
    WHEN 'info_sent'               THEN 'Information Sent — Awaiting Reply'
    WHEN 'price_objection'         THEN 'Rate or Charges Too High'
    WHEN 'wrong_product'           THEN 'Wants a Product We Do Not Offer'
    WHEN 'call_rejected'           THEN 'Customer Rejected the Call'
    -- The Call Log labels that used to no-op on the queue contact.
    WHEN 'converted'               THEN 'Converted'
    WHEN 'paid'                    THEN 'Paid'
    WHEN 'dispute'                 THEN 'Dispute'
    WHEN 'escalated'               THEN 'Escalated'
    WHEN 'complaint_logged'        THEN 'Complaint Logged'
    WHEN 'info_provided'           THEN 'Information Provided'
    WHEN 'pending_followup'        THEN 'Pending / Follow-up'
    WHEN 'closed'                  THEN 'Closed'
    -- Retention / win-back. These are the only churn reasons the schema captures.
    WHEN 'winback_reactivated'     THEN 'Reactivating — Will Use Again'
    WHEN 'winback_wants_offer'     THEN 'Interested in a New Offer'
    WHEN 'winback_price'           THEN 'Left Over Charges or Rates'
    WHEN 'winback_service'         THEN 'Left Over Service or an Unresolved Issue'
    WHEN 'winback_competitor'      THEN 'Using Another Provider'
    WHEN 'winback_no_need'         THEN 'No Longer Needs the Product'
    WHEN 'winback_declined'        THEN 'Not Interested in Returning'
    -- Soft codes: a connected call with no business disposition, and the escape hatch.
    WHEN 'connected'               THEN 'Connected'
    WHEN 'other'                   THEN 'Other — Describe What Happened'
    ELSE COALESCE(NULLIF(code,''), 'Unknown')
  END
$$;

COMMENT ON FUNCTION app.cc_disposition_label(text) IS
  'SQL twin of the Label field in Go ccDispositions (handlers/call_center_dispositions.go). '
  'Add a disposition there and you MUST add it here — migration 308''s guard fails the '
  'deploy if a code in use falls through to the ELSE branch, because the ELSE prints raw '
  'snake_case at a supervisor.';

-- An ALLOW-list of the codes where nobody spoke, not a deny-list of them. A deny-list
-- defaults the unknown to "connected", which is how a rejected call became a connect; an
-- allow-list defaults the unknown to "not connected", which merely understates a KPI until
-- someone notices, instead of overstating it silently.
CREATE OR REPLACE FUNCTION app.cc_disposition_connected(code text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(COALESCE(code,'')) NOT IN (
      'no_answer',      -- nobody picked up
      'wrong_number',   -- not the customer
      'voicemail',      -- legacy value, retained
      'call_rejected',  -- they saw it and ended it: the number is live, the person did not speak
      'call_dropped',   -- picked up then died within seconds; ccCallOutcome writes no_answer
      ''
  )
$$;

COMMENT ON FUNCTION app.cc_disposition_connected(text) IS
  'Did a human actually speak? Mirrors Go ccCallOutcome(d) == ''completed'' — NOT the '
  'catalogue''s Connected flag, which differs on call_dropped (the line picked up, no '
  'conversation happened, and the ledger records no_answer). Kept as an allow-list of the '
  'silent codes so an unknown disposition understates rather than inflates the connect '
  'rate — migration 308.';

DO $m308$
DECLARE r record; n_bad int := 0; n_fixed int; n_conn_changed int;
BEGIN
    -- Every code actually in use must now have a real label. This is the guard that stops
    -- the next added disposition rotting silently.
    FOR r IN
        SELECT DISTINCT lower(COALESCE(outcome,'')) AS code
          FROM app.call_center_dispositions
         WHERE COALESCE(outcome,'') <> ''
    LOOP
        IF app.cc_disposition_label(r.code) = r.code THEN
            RAISE WARNING '308: disposition code % has no label — it will print as raw '
                'snake_case to a supervisor', r.code;
            n_bad := n_bad + 1;
        END IF;
    END LOOP;
    IF n_bad > 0 THEN
        RAISE EXCEPTION '308: % disposition code(s) in use have no label. Add them to '
            'app.cc_disposition_label (and to ccDispositions if they are missing there '
            'too) — refusing', n_bad;
    END IF;

    SELECT COUNT(*) INTO n_fixed FROM app.call_center_dispositions
     WHERE lower(COALESCE(outcome,'')) IN ('call_rejected','info_sent','price_objection',
           'wrong_product','converted','paid','dispute','escalated','complaint_logged',
           'info_provided','pending_followup','closed','resolved');
    SELECT COUNT(*) INTO n_conn_changed FROM app.call_center_dispositions
     WHERE lower(COALESCE(outcome,'')) IN ('call_rejected','call_dropped');

    RAISE NOTICE '308: % row(s) now render a real label instead of their raw code; '
        '% row(s) (call_rejected + call_dropped) stop counting as connects and now agree '
        'with what the Call Log shows', n_fixed, n_conn_changed;
END $m308$;

COMMIT;
