-- 390_the_week_abuja_worked_on_paper.sql
--
-- Twenty-two Abuja leads were worked in the week to 2026-10-16 and the only record of it
-- lives in a spreadsheet, because every Abuja sales officer has zero sessions: the CRM
-- answers only on 10.1.2.30 and nobody in that office has a route to it. The lead
-- notifications fired correctly and every one of them is still unread.
--
-- This migration puts that week into the CRM. It does NOT pretend the officers typed it.
-- Each outcome is attributed to the officer who reported it (agent_id on the disposition is
-- real), and every note says where it came from and when it was entered, so a reader in six
-- months can tell a field report transcribed on 22 Oct from a call logged live.
--
-- Two of the six names on the sheet are not the officers' own. "UGOCHI" is Ozioma Okpara --
-- the tracker's own notes give it away, "sent to Okpara Ugochi" -- and "CHIDIMMA" / "CHDIMMA"
-- is Justina Ekomaru, confirmed by the user. The only Chidimma with an account is in Internal
-- Control and is a different person. Officers are resolved by email and never by id, so a
-- reseeded account cannot silently redirect four leads to a stranger.

BEGIN;

CREATE TEMP TABLE _officer(sheet_name text, email text, user_id bigint, full_name text) ON COMMIT DROP;
INSERT INTO _officer(sheet_name, email) VALUES
    ('UGOCHI',    'ookpara@o3cards.com'),
    ('IKECHUKWU', 'iokoro@o3cards.com'),
    ('CHIDIMMA',  'jekomaru@o3cards.com'),
    ('REUBEN',    'rorekoya@o3cards.com'),
    ('EBUNOLUWA', 'doluwole@o3cards.com'),
    ('MAIMUNAT',  'maisah@o3cards.com');

UPDATE _officer o
   SET user_id = u.id, full_name = u.full_name
  FROM app.o3c_users u
 WHERE lower(u.email) = o.email AND u.deleted_at IS NULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM _officer WHERE user_id IS NULL) THEN
        RAISE EXCEPTION 'migration 390: officer email did not resolve: %',
            (SELECT string_agg(email, ', ') FROM _officer WHERE user_id IS NULL);
    END IF;
END $$;

-- The tracker. `outcome` is the disposition CODE from handlers/call_center_dispositions.go,
-- which is the only vocabulary the handlers accept. `closes` is set ONLY where the officer's
-- own words close the lead. Gloryland is the one that looks closeable and is not: a rate
-- objection maps to price_objection, which closes, but her feedback says a second meeting is
-- being arranged and she is interested in the investment product. Mapping her prose to a code
-- would have killed a live lead, which is why the dropdown in any sheet pipeline has to be the
-- officer's own choice and never inferred from what they wrote.
CREATE TEMP TABLE _sheet(
    lead_id       bigint,
    sheet_officer text,
    outcome       text,
    closes        text,
    feedback      text
) ON COMMIT DROP;

INSERT INTO _sheet VALUES
    (18872, 'UGOCHI',    'not_eligible',            'closed', 'His account statement can not support his request.'),
    (20340, 'UGOCHI',    'not_ready',               NULL,     'The customer is willing to do business with us, but it will be November'),
    (19537, 'UGOCHI',    'not_eligible',            'closed', 'The customer is interested in credit card but his business is not define, and it is high risk to release money to him.'),
    (17378, 'UGOCHI',    'other',                   NULL,     'The customer has successfully submitted his documents, we are waiting for him to clear some over due loan'),
    (20171, 'IKECHUKWU', 'no_answer',               NULL,     'customer is not picking calls several call have been made to reach customer'),
    (20109, 'IKECHUKWU', 'info_sent',               NULL,     'Customer has been sent document to apply and provide request letter, including bank statement'),
    (18448, 'IKECHUKWU', 'callback',                NULL,     'Customer said he will come to the office by Friday with filled form and he wanted to know who we are.'),
    (20552, 'IKECHUKWU', NULL,                      NULL,     'No feedback was returned on the tracker for this lead.'),
    (19894, 'CHIDIMMA',  'callback',                NULL,     'I called him, and he confirmed he would visit our office on Thursday to make a decision on the credit card.'),
    (20448, 'CHIDIMMA',  'no_answer',               NULL,     'He requested a callback on Wednesday due to a meeting, but he did not answer when I called back.'),
    (19647, 'CHIDIMMA',  'not_eligible',            'closed', 'I contacted him, but Ibrahim advised that we cannot proceed due to insufficient account inflow.'),
    (20445, 'REUBEN',    'no_answer',               NULL,     'Promised to call back but has not even after several call attempts'),
    (19376, 'REUBEN',    'answered_not_interested', 'closed', 'Declined based on religious grounds'),
    (20172, 'REUBEN',    'no_answer',               NULL,     'Not responding to calls at all, sent text message and awaiting response'),
    (19188, 'EBUNOLUWA', 'price_objection',         'closed', 'Requesting for lower interest against company policy'),
    (19498, 'EBUNOLUWA', 'other',                   NULL,     'She complained of a high interest rate but we are trying to set up another meeting with her so we could conclude on what she wants exactly as she also shows interest in our investment'),
    (15282, 'EBUNOLUWA', 'callback',                NULL,     'called but he is out of Abuja and that he would call as soon as he gets back'),
    (19820, 'EBUNOLUWA', 'pending_followup',        NULL,     'Met with him to retrieve some of the forms he has filled and he also promise to introduce us to other business partners as soon as we are done with his own'),
    (19634, 'MAIMUNAT',  'callback',                NULL,     'Appointment scheduled for Monday 19th'),
    (20222, 'MAIMUNAT',  'callback',                NULL,     'He promise to call me today by 5:30 pm'),
    (19106, 'MAIMUNAT',  'no_answer',               NULL,     'No response. I will follow up');

-- Sunok Global is the one row whose ASSIGNED ACCOUNT OFFICER cell holds a sentence instead of
-- a name -- "Discussions currently ongoing, he will be assigned to a team member when he is
-- ready" -- so it stays deliberately unowned, and that sentence is its feedback.
INSERT INTO _sheet VALUES
    (20271, NULL, 'not_ready', NULL, 'Discussions currently ongoing, he will be assigned to a team member when he is ready.');

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM _sheet;
    IF n <> 22 THEN RAISE EXCEPTION 'migration 390: expected 22 tracker rows, built %', n; END IF;

    SELECT count(*) INTO n FROM _sheet s LEFT JOIN app.call_center_leads l ON l.id = s.lead_id WHERE l.id IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'migration 390: % tracker rows match no lead', n; END IF;

    SELECT count(*) INTO n FROM _sheet s LEFT JOIN _officer o ON o.sheet_name = s.sheet_officer
     WHERE s.sheet_officer IS NOT NULL AND o.user_id IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'migration 390: % tracker rows name an unresolved officer', n; END IF;
END $$;

-- 1. The field report goes in as what it is: a contact outcome logged against the officer who
--    reported it. No call_id and no duration, because this was not a tracked call -- and no
--    contact_id: that column FKs to call_center_contacts, NOT the crm_contacts the lead's
--    own contact_id points at, and all 26,156 existing rows leave it NULL. lead_id already
--    identifies the subject.
INSERT INTO app.call_center_dispositions (lead_id, agent_id, outcome, notes, created_at)
SELECT s.lead_id, o.user_id, s.outcome,
       '[Abuja tracker, feedback as at 2026-10-16, reported by ' || s.sheet_officer ||
       ' (' || o.full_name || '), transcribed 2026-10-22] ' || s.feedback,
       timestamptz '2026-10-16 17:00+01'
  FROM _sheet s
  JOIN _officer o ON o.sheet_name = s.sheet_officer
  JOIN app.call_center_leads l ON l.id = s.lead_id
 WHERE s.outcome IS NOT NULL;

-- 2. The lead's own summary fields. Status moves ONLY where `closes` says so. The em-dash in
--    three of the labels is built with chr(8212) rather than typed, because a literal U+2014
--    has been corrupted to 0xB7 passing through psql on this host before.
UPDATE app.call_center_leads l
   SET last_disposition = CASE s.outcome
           WHEN 'not_eligible'            THEN 'Not Eligible'
           WHEN 'not_ready'               THEN 'Not Ready Yet'
           WHEN 'no_answer'               THEN 'Unreachable / No Answer'
           WHEN 'info_sent'               THEN 'Information Sent ' || chr(8212) || ' Awaiting Reply'
           WHEN 'callback'                THEN 'Callback Scheduled'
           WHEN 'answered_not_interested' THEN 'Answered ' || chr(8212) || ' Not Interested'
           WHEN 'price_objection'         THEN 'Rate or Charges Too High'
           WHEN 'pending_followup'        THEN 'Pending / Follow-up'
           WHEN 'other'                   THEN 'Other ' || chr(8212) || ' Describe What Happened'
           ELSE l.last_disposition END,
       status = COALESCE(s.closes, l.status),
       notes = btrim(COALESCE(NULLIF(l.notes, ''), '') || chr(10) ||
               '[Abuja tracker, feedback as at 2026-10-16, reported by ' ||
               COALESCE(s.sheet_officer, 'no officer named on the sheet') ||
               ', transcribed 2026-10-22] ' || s.feedback, chr(10)),
       updated_at = now()
  FROM _sheet s
 WHERE l.id = s.lead_id;

-- 3. Location. All 22 sit under LOCATION = ABUJA on the tracker and are worked by officers
--    whose office_location is Abuja, which is better evidence than a blank column. Lead 15282
--    is the one whose contact record says Lagos; its own feedback -- "he is out of Abuja and
--    ... would call as soon as he gets back" -- corroborates Abuja independently, so it is
--    corrected rather than left to route to the wrong hub. FCT is the dominant literal in
--    crm_contacts (74 rows against 14 ABUJA and 9 Abuja) and all three resolve to the hub.
UPDATE app.call_center_leads l SET state = 'FCT', updated_at = now()
  FROM _sheet s WHERE l.id = s.lead_id AND COALESCE(l.state, '') = '';

UPDATE app.crm_contacts k SET state = 'FCT'
  FROM _sheet s JOIN app.call_center_leads l ON l.id = s.lead_id
 WHERE k.id = l.contact_id AND COALESCE(k.state, '') = '';

UPDATE app.crm_contacts SET state = 'FCT' WHERE id = 46228 AND state = 'Lagos';

-- 4. Assignment. The sheet already distributed these by hand, and that is real information the
--    round-robin router does not have, so it wins. crm_contacts.sales_owner_id is the canonical
--    owner; the forward row mirrors it.
--
--    sales_entered_at is not optional: crm_contacts_sales_owner_needs_entry requires that a
--    contact with an owner also records when it entered sales, which is a rule worth having --
--    an owned contact with no entry date has no clock to measure anything against. The date
--    is taken from the lead's own forward where there is one, so the 15 that were genuinely
--    forwarded keep their real date, and only the 7 being reconstructed fall back to the
--    tracker. This runs BEFORE step 5 creates the missing forwards, so that fallback is what
--    those 7 get, deliberately.
UPDATE app.crm_contacts k
   SET sales_owner_id   = o.user_id,
       sales_entered_at = COALESCE(
           k.sales_entered_at,
           (SELECT min(f.forwarded_at) FROM app.call_center_lead_forwards f
             WHERE f.lead_id = s.lead_id),
           timestamptz '2026-10-16 17:00+01')
  FROM _sheet s
  JOIN _officer o ON o.sheet_name = s.sheet_officer
  JOIN app.call_center_leads l ON l.id = s.lead_id
 WHERE k.id = l.contact_id;

UPDATE app.call_center_lead_forwards f
   SET sales_owner_id = o.user_id, sales_owner_name = o.full_name,
       status = 'assigned', updated_at = now(),
       notes = COALESCE(NULLIF(f.notes, ''), '') ||
               ' | Assigned from the Abuja tracker (feedback as at 2026-10-16), transcribed 2026-10-22'
  FROM _sheet s
  JOIN _officer o ON o.sheet_name = s.sheet_officer
 WHERE f.lead_id = s.lead_id;

-- 5. Seven of the 22 have no forward row at all, yet an officer has demonstrably been working
--    them -- UG Daddy was met in person and his filled forms collected. Without a forward row
--    they stay invisible to the sales module, so one is reconstructed, dated to the tracker and
--    labelled as reconstructed. TWO are excluded -- Hussaini Mohammed (17378) and De Bright
--    Global Osotex (20445) -- because both have no contact_id and
--    no party_id, so there is nothing to hang an owner on. Those two are being worked in the
--    field against no customer record whatsoever, which is a data problem this migration
--    deliberately does not paper over by inventing one.
INSERT INTO app.call_center_lead_forwards
    (lead_id, contact_id, forwarded_by, forwarded_by_name, customer_name, customer_phone,
     sales_owner_id, sales_owner_name, status, notes, forwarded_at, updated_at)
SELECT s.lead_id, l.contact_id, o.user_id, o.full_name, l.customer_name, l.customer_phone,
       o.user_id, o.full_name, 'assigned',
       'Reconstructed from the Abuja tracker (feedback as at 2026-10-16) on 2026-10-22: this lead '
       || 'was being worked in the field with no forward record in the CRM.',
       timestamptz '2026-10-16 17:00+01', now()
  FROM _sheet s
  JOIN _officer o ON o.sheet_name = s.sheet_officer
  JOIN app.call_center_leads l ON l.id = s.lead_id
 WHERE l.contact_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM app.call_center_lead_forwards f WHERE f.lead_id = s.lead_id);

DO $$
DECLARE n int;
BEGIN
    SELECT count(*) INTO n FROM app.call_center_dispositions d
      JOIN _sheet s ON s.lead_id = d.lead_id
     WHERE d.notes LIKE '[Abuja tracker,%';
    IF n <> 20 THEN RAISE EXCEPTION 'migration 390: expected 20 transcribed dispositions -- 22 tracker rows, less Kendo which carries no outcome, less Sunok which names no officer to attribute one to -- got %', n; END IF;

    SELECT count(*) INTO n FROM app.call_center_leads l JOIN _sheet s ON s.lead_id = l.id
     WHERE s.closes = 'closed' AND l.status <> 'closed';
    IF n <> 0 THEN RAISE EXCEPTION 'migration 390: % leads that should have closed did not', n; END IF;

    SELECT count(*) INTO n FROM app.call_center_leads l JOIN _sheet s ON s.lead_id = l.id
     WHERE s.closes IS NULL AND l.status = 'closed' AND l.id <> 17378;
    IF n <> 0 THEN RAISE EXCEPTION 'migration 390: % leads closed that should not have', n; END IF;

    -- Hussaini (17378) keeps the status he already had. The contradiction between a lead closed
    -- on 24 Sep for a bad credit report and a field report of documents submitted on 16 Oct is
    -- for a human to settle, not a migration.
    IF (SELECT status FROM app.call_center_leads WHERE id = 17378) <> 'closed' THEN
        RAISE EXCEPTION 'migration 390: lead 17378 status was changed; it must be left for review';
    END IF;

    SELECT count(*) INTO n FROM _sheet s
      JOIN app.call_center_leads l ON l.id = s.lead_id
      JOIN app.crm_contacts k ON k.id = l.contact_id
     WHERE s.sheet_officer IS NOT NULL AND k.sales_owner_id IS NOT NULL;
    IF n <> 19 THEN RAISE EXCEPTION 'migration 390: expected 19 owned contacts -- 21 tracker rows naming an officer, less Hussaini Mohammed (17378) and De Bright Global Osotex (20445), which have no contact_id and no party_id at all -- got %', n; END IF;

    SELECT count(*) INTO n FROM _sheet s JOIN app.call_center_leads l ON l.id = s.lead_id
     WHERE COALESCE(l.state, '') = '' OR app.sales_hub_for_state(l.state) IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'migration 390: % of the 22 still do not resolve to a hub', n; END IF;
END $$;

INSERT INTO app.schema_migrations (filename) VALUES ('390_the_week_abuja_worked_on_paper.sql')
ON CONFLICT DO NOTHING;

COMMIT;
