-- Consequence language for the older arrears templates, limited to what O3 can show
-- it actually does.
--
-- WHAT WAS CHECKED BEFORE A WORD WAS WRITTEN.
--
--   app.recovery_cases        1,615 rows — 507 active, 248 legal, 860 closed.
--   app.legal_proceedings        95 rows.
--   app.bureau_submission_logs    0 rows. Never used. Not once.
--   app.recovery_field_visits     0 rows.
--
-- So referral to a recovery team is a thing this company demonstrably does, and so is
-- instructing solicitors. Those two facts are the only ones these letters assert.
--
-- THERE IS NO MENTION OF CREDIT BUREAU REPORTING, AND THAT IS DELIBERATE. The table
-- built to record bureau submissions has never held a row, so there is no evidence O3
-- has ever reported anyone to CRC or any other bureau. A letter that threatens a
-- consequence the company has no record of applying is a bluff, and a borrower who
-- checks their bureau file and finds nothing has been told something untrue by their
-- lender in writing. If O3 starts reporting, add the line then, and this comment is
-- where to look for why it was left out.
--
-- Nor is there any mention of field visits (nothing recorded), asset seizure, or
-- "legal action will be taken". Firmness comes from being specific about what happens,
-- not from adjectives.
--
-- THIS LANGUAGE DEPENDS ON THE SELECTION FIX SHIPPED ALONGSIDE IT. Until today the
-- eligible pool included 186 facilities already at recovery status 'legal' and 382
-- being worked by a recovery officer. Telling someone their account "may be referred to
-- our recovery team" when it has been with solicitors for months is false, and it is
-- false in a letter. batchDunningRun now excludes 'legal' unconditionally and 'active'
-- by default, so a borrower reading this sentence is genuinely not there yet.

BEGIN;

-- 91-180: the classification has happened. Name where it goes if nothing changes.
UPDATE app.message_templates SET
  email_body_text = replace(email_body_text,
    'We would still rather resolve this with you than without you.',
    'Accounts that remain unresolved are referred to our recovery team. We would still rather resolve this with you than without you.'),
  email_body_html = replace(email_body_html,
    '<p>We would still rather resolve this with you than without you.',
    '<p>Accounts that remain unresolved are referred to our recovery team. We would still rather resolve this with you than without you.'),
  whatsapp_body = replace(whatsapp_body,
    'A part payment now with an arrangement for the balance changes how it is handled from here.',
    'Accounts that remain unresolved are referred to our recovery team. A part payment now with an arrangement for the balance changes how it is handled from here.'),
  updated_at = NOW()
WHERE category = 'collections' AND name LIKE '%91-180%';

-- 181-360: it is going to recovery. Say so in the present tense, once.
UPDATE app.message_templates SET
  email_body_text = replace(email_body_text,
    'This account has been passed to our collections team for resolution. They can agree a repayment arrangement with you, and they would prefer to.',
    'Unless we hear from you, this account will be referred to our recovery team. Our collections team can still agree a repayment arrangement with you, and they would prefer to.'),
  email_body_html = replace(email_body_html,
    'This account has been passed to our collections team for resolution. They can agree a repayment arrangement with you, and they would prefer to.',
    'Unless we hear from you, this account will be referred to our recovery team. Our collections team can still agree a repayment arrangement with you, and they would prefer to.'),
  whatsapp_body = replace(whatsapp_body,
    'The account is with our collections team, who can agree a repayment arrangement.',
    'Unless we hear from you, this account will be referred to our recovery team. Our collections team can still agree a repayment arrangement.'),
  updated_at = NOW()
WHERE category = 'collections' AND name LIKE '%181-360%';

-- 360+: the last of the three. Solicitors are named because 95 proceedings say they
-- are real, and the sentence still ends on the thing the reader can do.
UPDATE app.message_templates SET
  email_body_text = replace(email_body_text,
    'An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.',
    'Accounts left at this stage are referred to our recovery team, and where matters are not resolved there, to our solicitors. An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.'),
  email_body_html = replace(email_body_html,
    '<p>An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.</p>',
    '<p>Accounts left at this stage are referred to our recovery team, and where matters are not resolved there, to our solicitors.</p><p>An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.</p>'),
  whatsapp_body = replace(whatsapp_body,
    'Tell us where you stand:',
    'Accounts left at this stage are referred to our recovery team, and then to our solicitors. Tell us where you stand:'),
  updated_at = NOW()
WHERE category = 'collections' AND name LIKE '%360+%';

-- The SMS bodies are left alone on purpose. They are already 161-175 characters in the
-- worst case, which is two GSM-7 segments; the recovery sentence would push every one
-- of them to three. An SMS that says "call us, quote your reference" and a letter that
-- explains why are the right division of labour between a 160-character channel and an
-- unlimited one.

-- THE AGE BOUND, RECORDED RATHER THAN LEFT ABSENT. COLLECTIONS_DUNNING_MAX_DPD has
-- never existed as a row, so the code fell through to 0 (no bound). The behaviour was
-- right and the silence was not: an absent key reads as nobody having decided. The
-- decision is that there is no upper bound, because as of migration 320 the 401
-- facilities over a year old have copy written for them instead of borrowing the
-- 1-30 day wording. Capping by age now would mute the group the escalation was
-- written for.
INSERT INTO app.api_credentials (key_name, encrypted_value, description, category, is_active, is_secret, updated_at)
VALUES ('COLLECTIONS_DUNNING_MAX_DPD', '0',
        'Oldest debt that still receives an automated reminder, in days past due. 0 means no upper bound, which is the decision on record: every bucket including 360+ has its own wording, so age no longer needs to gate the run.',
        'messaging', true, false, NOW())
ON CONFLICT (key_name) DO NOTHING;

INSERT INTO app.api_credentials (key_name, encrypted_value, description, category, is_active, is_secret, updated_at)
VALUES ('COLLECTIONS_DUNNING_SKIP_RECOVERY', 'on',
        'Leave accounts a recovery officer is actively working out of the automated run. Set to off to include them. Accounts at recovery status legal are excluded regardless and this setting cannot reach them.',
        'messaging', true, false, NOW())
ON CONFLICT (key_name) DO NOTHING;

COMMIT;
