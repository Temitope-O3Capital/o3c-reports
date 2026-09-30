-- 326: close the contact and field-visit vocabularies while both tables are still empty.
--
-- recovery_field_visits and collection_contacts hold **0 rows**. The screens that write them are
-- built and mounted, so this is the cheapest moment this will ever be fixed: no data to migrate,
-- no report to restate, and a VALIDATING constraint costs nothing to add.
--
-- WHAT WAS WRONG. Three frontend screens held three vocabularies for the same two columns, and
-- none of them was wrong on its own — which is why nothing had flagged it:
--
--   POST /api/recovery-ops/cases/{id}/visit   (recovery_field_visits.visit_type / .outcome)
--     recovery/Cases.tsx, recovery/CaseDetail.tsx : 'Physical Visit' 'Phone Call' 'WhatsApp'
--        'Email' 'Legal Notice' / 'Customer Met' 'Not Home' 'Promised to Pay' 'Refused to Pay'
--        'No Response' 'Other'
--     recovery-ops/Agent.tsx                     : 'field' 'phone' 'letter' 'legal'
--        / 'paid' 'promised' 'refused' 'absent' 'no_contact'
--
--   POST /api/collections-ops/{id}/contact    (collection_contacts.contact_type)
--     collections/AccountDetail.tsx      : 'phone' 'sms' 'whatsapp' 'email' 'field_visit'
--     collections-ops/AgentDashboard.tsx : 'call' 'sms' 'email' 'visit'
--     collections/Queue.tsx              : hardcodes 'call'
--
-- Two screens describing the same physical act as 'Physical Visit' and 'field' would have put two
-- rows per real category into every GROUP BY, permanently and invisibly.
--
-- THE CONVENTION is the one migration 321 settled for legal_stage and customerSteps settled
-- before that: the database stores a snake_case CODE, the screen shows a LABEL. A label can then
-- be reworded without a migration. The codes below are the union of the two sets collapsed to one
-- code per real category, so nothing either screen could previously express is lost — 'paid' and
-- 'promised_to_pay' stay separate, because money received and money promised are different
-- events and only one of the three screens could tell them apart.
--
-- collection_contacts.outcome IS DELIBERATELY LEFT OPEN. Two screens write two different KINDS of
-- fact into it: AccountDetail sends a reachability outcome ('answered', 'no_answer', …), while
-- Queue sends a CALL DISPOSITION — one of ~45 human-readable strings from the shared disposition
-- list ('Promise to Pay', 'Issue Resolved', 'Other — Describe What Happened'). Constraining to
-- either one throws the other away: reachability loses the disposition, dispositions leave an SMS
-- with no outcome to give. The honest model is probably a second `disposition` column — free,
-- while the table is empty — but which fact collections actually wants to measure is a business
-- decision, so it is written down rather than settled by whoever edits last.

ALTER TABLE recovery_field_visits DROP CONSTRAINT IF EXISTS recovery_field_visits_type_chk;
ALTER TABLE recovery_field_visits ADD CONSTRAINT recovery_field_visits_type_chk
    CHECK (visit_type = ANY (ARRAY[
        'field_visit', 'phone', 'whatsapp', 'email', 'letter', 'legal_notice']));

ALTER TABLE recovery_field_visits DROP CONSTRAINT IF EXISTS recovery_field_visits_outcome_chk;
ALTER TABLE recovery_field_visits ADD CONSTRAINT recovery_field_visits_outcome_chk
    CHECK (outcome IS NULL OR outcome = ANY (ARRAY[
        'customer_met', 'paid', 'promised_to_pay', 'refused_to_pay',
        'not_home', 'no_response', 'other']));

ALTER TABLE collection_contacts DROP CONSTRAINT IF EXISTS collection_contacts_type_chk;
ALTER TABLE collection_contacts ADD CONSTRAINT collection_contacts_type_chk
    CHECK (contact_type = ANY (ARRAY[
        'phone', 'sms', 'whatsapp', 'email', 'field_visit']));

DO $m326$
DECLARE
    v_visits   int;
    v_contacts int;
BEGIN
    SELECT count(*) INTO v_visits   FROM recovery_field_visits;
    SELECT count(*) INTO v_contacts FROM collection_contacts;

    -- The entire justification for a validating constraint is that there is nothing to validate.
    -- If either table has gained a row since this was written, someone has started logging real
    -- work and the vocabulary question is no longer free — stop and look at what they wrote
    -- before forcing it into this list.
    IF v_visits > 0 THEN
        RAISE EXCEPTION '326: recovery_field_visits now holds % row(s). Check what vocabulary they used before applying this.', v_visits;
    END IF;
    IF v_contacts > 0 THEN
        RAISE EXCEPTION '326: collection_contacts now holds % row(s). Check what vocabulary they used before applying this.', v_contacts;
    END IF;

    RAISE NOTICE '326: both tables empty; visit and contact vocabularies closed. collection_contacts.outcome left open on purpose.';
END
$m326$;
