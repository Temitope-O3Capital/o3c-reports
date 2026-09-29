-- 311 — The SQL label map learns the three outcomes the "Other" notes asked for.
--
-- "Other" was shipped on 2026-09-28 as a BACKLOG rather than a landfill: the argument for
-- offering it at all was that what agents write there becomes the next named outcome. Eleven
-- real uses in two days, and they clustered into three things the vocabulary could not say —
-- a signup abandoned part-way, a customer claiming a payment we cannot see, and a card with
-- nothing owed this cycle. Those are now codes in ccDispositions (registration_incomplete,
-- payment_to_verify, not_yet_due) and this is their other half.
--
-- WHY THIS MIGRATION IS NOT OPTIONAL. app.cc_disposition_label is the only labeller for the
-- supervisor's disposition breakdown, and migration 308 added a guard that REFUSES to apply
-- if any code in use falls through to its ELSE branch. So the first time an agent picks one
-- of these three, the next deploy would fail — by design. That guard was written yesterday to
-- catch exactly this, and it has now caught its author.
--
-- app.cc_disposition_connected needs no change: all three are conversations, so the default
-- (anything not in the silent list is connected) is already right.

BEGIN;

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
    WHEN 'info_sent'               THEN 'Information Sent — Awaiting Reply'
    WHEN 'price_objection'         THEN 'Rate or Charges Too High'
    WHEN 'wrong_product'           THEN 'Wants a Product We Do Not Offer'
    WHEN 'call_rejected'           THEN 'Customer Rejected the Call'
    -- New, 29 Sept, read out of the Other notes.
    WHEN 'registration_incomplete' THEN 'Registration Not Completed'
    WHEN 'payment_to_verify'       THEN 'Says They Have Paid — To Verify'
    WHEN 'not_yet_due'             THEN 'Nothing Due This Cycle'
    WHEN 'converted'               THEN 'Converted'
    WHEN 'paid'                    THEN 'Paid'
    WHEN 'dispute'                 THEN 'Dispute'
    WHEN 'escalated'               THEN 'Escalated'
    WHEN 'complaint_logged'        THEN 'Complaint Logged'
    WHEN 'info_provided'           THEN 'Information Provided'
    WHEN 'pending_followup'        THEN 'Pending / Follow-up'
    WHEN 'closed'                  THEN 'Closed'
    WHEN 'winback_reactivated'     THEN 'Reactivating — Will Use Again'
    WHEN 'winback_wants_offer'     THEN 'Interested in a New Offer'
    WHEN 'winback_price'           THEN 'Left Over Charges or Rates'
    WHEN 'winback_service'         THEN 'Left Over Service or an Unresolved Issue'
    WHEN 'winback_competitor'      THEN 'Using Another Provider'
    WHEN 'winback_no_need'         THEN 'No Longer Needs the Product'
    WHEN 'winback_declined'        THEN 'Not Interested in Returning'
    WHEN 'connected'               THEN 'Connected'
    WHEN 'other'                   THEN 'Other — Describe What Happened'
    ELSE COALESCE(NULLIF(code,''), 'Unknown')
  END
$$;

DO $m311$
DECLARE r record; n_bad int := 0;
BEGIN
    -- The same guard migration 308 installed, re-run here so this file cannot itself be the
    -- one that leaves a code unlabelled.
    FOR r IN
        SELECT DISTINCT lower(COALESCE(outcome,'')) AS code
          FROM app.call_center_dispositions WHERE COALESCE(outcome,'') <> ''
    LOOP
        IF app.cc_disposition_label(r.code) = r.code THEN
            RAISE WARNING '311: disposition code % still has no label', r.code;
            n_bad := n_bad + 1;
        END IF;
    END LOOP;
    IF n_bad > 0 THEN
        RAISE EXCEPTION '311: % disposition code(s) in use have no label — refusing', n_bad;
    END IF;

    -- And the three new ones must resolve to real prose, not to themselves.
    IF app.cc_disposition_label('registration_incomplete') = 'registration_incomplete'
       OR app.cc_disposition_label('payment_to_verify') = 'payment_to_verify'
       OR app.cc_disposition_label('not_yet_due') = 'not_yet_due' THEN
        RAISE EXCEPTION '311: one of the new codes did not get a label — refusing';
    END IF;

    RAISE NOTICE '311: registration_incomplete, payment_to_verify and not_yet_due can now be '
        'shown to a supervisor by name';
END $m311$;

COMMIT;
