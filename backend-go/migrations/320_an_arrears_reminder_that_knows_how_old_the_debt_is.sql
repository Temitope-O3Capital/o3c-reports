-- One arrears template was going to every borrower.
--
-- It is named "Arrears Reminder · 1-30 Days" and it was being sent to all six DPD
-- buckets, including the 401 facilities more than a year overdue. A borrower eleven
-- days late and a borrower three years late were reading the same sentence, which
-- wastes the gentle version on someone who has stopped answering and spends the firm
-- version on nobody at all.
--
-- dunningTemplateFor now matches a template to the bucket named in its title, so this
-- adds the five that were missing and rewrites the first.
--
-- THE CURRENCY MOVED OUT OF THE TEXT. Every body said "N{{amount}}" with a literal N,
-- which rendered as N100000000.00. The sign now comes from the merge field, because it
-- is not the same on every channel: email and WhatsApp carry ₦, SMS carries NGN,
-- because ₦ is outside the GSM 7-bit alphabet and one of them costs an extra segment on
-- every message forever. Leaving the literal N here would print "N₦100,000,000.00".
--
-- ON THE ESCALATION. The wording gets firmer with age and stops short of asserting any
-- consequence O3 has not decided to apply. "Non-performing" at 91 days is the bank's
-- own canonical rule (app.is_npl, DPD > 90) so it is a statement of fact. There is no
-- mention of credit bureau reporting, legal action, or asset recovery anywhere in these
-- six templates: those are claims Collections and Legal have to approve before a
-- machine makes them nightly, and they are easier to add later than to retract from
-- someone's inbox. Nothing sends until someone types SEND TO CUSTOMERS on the Arrears
-- Reminders page.

BEGIN;

-- The original, rewritten: same gentle tone, no literal N, and a name that no longer
-- claims a bucket it does not serve.
UPDATE app.message_templates SET
  name = 'Arrears Reminder · 1-30 Days',
  email_subject = 'Your O3 Capital {{facility|account}} is {{dpd}} days past due',
  email_body_text =
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital is {{dpd}} days past due, with an outstanding balance of {{amount}}.

If you have already made this payment, please ignore this message and accept our thanks.

To make a payment or discuss a repayment arrangement, call us on {{contact_phone|0201 330 3030}} or reply to this email.

O3 Capital',
  email_body_html =
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital is <strong>{{dpd}} days past due</strong>, with an outstanding balance of <strong>{{amount}}</strong>.</p><p>If you have already made this payment, please ignore this message and accept our thanks.</p><p>To make a payment or discuss a repayment arrangement, call us on {{contact_phone|0201 330 3030}} or reply to this email.</p><p>O3 Capital</p>',
  sms_body =
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due. Balance: {{amount}}. Please pay or call us on {{contact_phone|0201 330 3030}}.',
  whatsapp_body =
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due. The outstanding balance is {{amount}}. If you have already paid, please ignore this message. To discuss repayment, reply here or call {{contact_phone|0201 330 3030}}.',
  updated_at = NOW()
WHERE id = 7;

-- 31-60. Still courteous, but it asks for a date rather than hoping.
INSERT INTO app.message_templates (name, channel, category, email_subject, email_body_text, email_body_html, sms_body, whatsapp_body)
VALUES (
'Arrears Reminder · 31-60 Days', 'multi', 'collections',
'Your O3 Capital {{facility|account}} is now {{dpd}} days past due',
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital is now {{dpd}} days past due. The outstanding balance is {{amount}}.

We have not heard from you since this fell due. If something has changed and the full amount is difficult right now, we would rather know: we can usually agree a repayment arrangement that works, and the earlier we start it the more room there is.

Call us on {{contact_phone|0201 330 3030}} this week and tell us when you can pay.

O3 Capital',
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital is now <strong>{{dpd}} days past due</strong>. The outstanding balance is <strong>{{amount}}</strong>.</p><p>We have not heard from you since this fell due. If something has changed and the full amount is difficult right now, we would rather know: we can usually agree a repayment arrangement that works, and the earlier we start it the more room there is.</p><p>Call us on {{contact_phone|0201 330 3030}} this week and tell us when you can pay.</p><p>O3 Capital</p>',
'Dear {{first_name|Customer}}, your {{facility|account}} is now {{dpd}} days past due. Balance: {{amount}}. Call {{contact_phone|0201 330 3030}} this week and tell us when you can pay.',
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is now {{dpd}} days past due and the balance is {{amount}}. If paying in full is difficult, we can usually agree an arrangement. Reply here or call {{contact_phone|0201 330 3030}} and tell us when you can pay.'
);

-- 61-90. Names what happens at 90 days, because it is about to and the borrower can
-- still prevent it.
INSERT INTO app.message_templates (name, channel, category, email_subject, email_body_text, email_body_html, sms_body, whatsapp_body)
VALUES (
'Arrears Reminder · 61-90 Days', 'multi', 'collections',
'Action needed on your O3 Capital {{facility|account}}, {{dpd}} days past due',
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital is {{dpd}} days past due and the outstanding balance is {{amount}}.

At 90 days past due this account is classified as non-performing. That classification follows the number of days, not a decision by anyone here, and it is harder to undo than to avoid.

There is still time. Call us on {{contact_phone|0201 330 3030}} today, pay what you can, and agree a date for the rest.

O3 Capital',
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital is <strong>{{dpd}} days past due</strong> and the outstanding balance is <strong>{{amount}}</strong>.</p><p>At 90 days past due this account is classified as non-performing. That classification follows the number of days, not a decision by anyone here, and it is harder to undo than to avoid.</p><p>There is still time. Call us on {{contact_phone|0201 330 3030}} today, pay what you can, and agree a date for the rest.</p><p>O3 Capital</p>',
'Dear {{first_name|Customer}}, your {{facility|account}} is {{dpd}} days past due, balance {{amount}}. At 90 days it becomes non-performing. Call {{contact_phone|0201 330 3030}} today.',
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due and the balance is {{amount}}. At 90 days past due the account is classified as non-performing, which follows the days rather than any decision here. There is still time. Call {{contact_phone|0201 330 3030}} today and agree a date.'
);

-- 91-180. The classification has happened. Say so plainly and once.
INSERT INTO app.message_templates (name, channel, category, email_subject, email_body_text, email_body_html, sms_body, whatsapp_body)
VALUES (
'Arrears Reminder · 91-180 Days', 'multi', 'collections',
'Your O3 Capital {{facility|account}} is now classified as non-performing',
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital is {{dpd}} days past due, with an outstanding balance of {{amount}}. The account is now classified as non-performing.

We would still rather resolve this with you than without you. A part payment now, with a written arrangement for the balance, changes how this account is handled from here.

Call us on {{contact_phone|0201 330 3030}} and ask for the collections team.

O3 Capital',
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital is <strong>{{dpd}} days past due</strong>, with an outstanding balance of <strong>{{amount}}</strong>. The account is now classified as <strong>non-performing</strong>.</p><p>We would still rather resolve this with you than without you. A part payment now, with a written arrangement for the balance, changes how this account is handled from here.</p><p>Call us on {{contact_phone|0201 330 3030}} and ask for the collections team.</p><p>O3 Capital</p>',
'Dear {{first_name|Customer}}, your {{facility|account}} is {{dpd}} days past due, balance {{amount}}, and is now non-performing. Call {{contact_phone|0201 330 3030}} and ask for collections.',
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital is {{dpd}} days past due, balance {{amount}}, and the account is now classified as non-performing. A part payment now with an arrangement for the balance changes how it is handled from here. Call {{contact_phone|0201 330 3030}} and ask for the collections team.'
);

-- 181-360. Short. A long letter at this age reads as another letter.
INSERT INTO app.message_templates (name, channel, category, email_subject, email_body_text, email_body_html, sms_body, whatsapp_body)
VALUES (
'Arrears Reminder · 181-360 Days', 'multi', 'collections',
'{{amount}} outstanding on your O3 Capital {{facility|account}}',
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital has been past due for {{dpd}} days. The outstanding balance is {{amount}}.

This account has been passed to our collections team for resolution. They can agree a repayment arrangement with you, and they would prefer to.

Call {{contact_phone|0201 330 3030}} and ask for collections, quoting {{cif}}.

O3 Capital',
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital has been past due for <strong>{{dpd}} days</strong>. The outstanding balance is <strong>{{amount}}</strong>.</p><p>This account has been passed to our collections team for resolution. They can agree a repayment arrangement with you, and they would prefer to.</p><p>Call {{contact_phone|0201 330 3030}} and ask for collections, quoting <strong>{{cif}}</strong>.</p><p>O3 Capital</p>',
'Dear {{first_name|Customer}}, {{amount}} is outstanding on your {{facility|account}}, {{dpd}} days past due. Call {{contact_phone|0201 330 3030}}, ask for collections, quote {{cif}}.',
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital has been past due for {{dpd}} days and {{amount}} is outstanding. The account is with our collections team, who can agree a repayment arrangement. Call {{contact_phone|0201 330 3030}} and quote {{cif}}.'
);

-- 360+. The largest bucket by count, 401 facilities. Most of these people have not
-- answered in a year, so this asks for one reply rather than the whole sum.
INSERT INTO app.message_templates (name, channel, category, email_subject, email_body_text, email_body_html, sms_body, whatsapp_body)
VALUES (
'Arrears Reminder · 360+ Days', 'multi', 'collections',
'We still need to hear from you about your O3 Capital {{facility|account}}',
'Dear {{first_name|Customer}},

Your {{facility|account}} with O3 Capital has been past due for {{dpd}} days. The outstanding balance is {{amount}}.

We have written before and had no reply. This letter asks for one thing only: tell us where you stand. If you cannot pay the balance, say so. If you can pay part of it, say how much and when. If you believe this amount is wrong, tell us and we will check it against our records.

An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.

Call {{contact_phone|0201 330 3030}} and quote {{cif}}, or reply to this email.

O3 Capital',
'<p>Dear {{first_name|Customer}},</p><p>Your <strong>{{facility|account}}</strong> with O3 Capital has been past due for <strong>{{dpd}} days</strong>. The outstanding balance is <strong>{{amount}}</strong>.</p><p>We have written before and had no reply. This letter asks for one thing only: tell us where you stand. If you cannot pay the balance, say so. If you can pay part of it, say how much and when. If you believe this amount is wrong, tell us and we will check it against our records.</p><p>An account nobody has discussed cannot be settled, reduced, or corrected. One call starts that.</p><p>Call {{contact_phone|0201 330 3030}} and quote <strong>{{cif}}</strong>, or reply to this email.</p><p>O3 Capital</p>',
'Dear {{first_name|Customer}}, {{amount}} has been outstanding on your {{facility|account}} for {{dpd}} days. Tell us where you stand. Call {{contact_phone|0201 330 3030}}, quote {{cif}}.',
'Dear {{first_name|Customer}}, your {{facility|account}} with O3 Capital has been past due for {{dpd}} days and {{amount}} is outstanding. We have written before with no reply. Tell us where you stand: if you cannot pay, say so; if you can pay part, say how much and when; if you think the amount is wrong, we will check it. Call {{contact_phone|0201 330 3030}} and quote {{cif}}.'
);

COMMIT;
