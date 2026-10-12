-- 356: every alert the app sends can be switched off.
--
-- Admin → Notification Settings lists one row per (event_type, channel) from
-- notification_event_config, and that table is also layer 2 of the channel resolution in
-- handlers/notify.go. An event with no row there still SENDS — it falls through to the
-- built-in default of in-app and email on — but it cannot be seen or changed by anybody.
--
-- Swept 2026-10-12: the app emits 75 distinct event types and 41 were configurable, so
-- 38 of them were firing with no off switch. Among them are the ones most likely to be
-- unwanted in somebody's inbox (every ticket hand-over, every queue assignment) and the
-- ones a head would most want ON (a prudential breach, a data breach, a write-off
-- awaiting approval). Both problems have the same cause and the same fix.
--
-- This changes no behaviour on its own. Every row below is seeded with the same values
-- the code already defaults to — in-app and email enabled — so nothing starts or stops
-- sending today. What changes is that the switches now exist.
--
-- SMS and WhatsApp are deliberately NOT seeded. They cost money and reach people out of
-- hours, notify.go defaults them off, and an absent row is already off. Seeding a
-- disabled row for 38 events would double the length of a settings screen with 76
-- switches nobody is looking for.
--
-- ON CONFLICT DO NOTHING throughout: a channel an admin has already configured keeps
-- whatever they chose, and the migration is safe to re-run.

INSERT INTO app.notification_event_config (event_type, channel, enabled, label, description)
SELECT e.event_type, ch.channel, TRUE, e.label, e.description
  FROM (VALUES
    -- ── The lead journey (new in migration 353's work) ──────────────────────
    ('cc_lead_forwarded',      'Lead Forwarded to Sales',
     'A call-centre agent qualified a lead. Goes to whoever owns it, or to the office that covers its state.'),
    ('sales_lead_assigned',    'Leads Assigned to You',
     'Leads dealt to a sales officer when a head distributes the pool.'),
    ('sales_lead_claimed',     'Lead Claimed',
     'An officer took a lead out of the unowned pool. Heads only.'),
    ('sales_lead_converted',   'Lead Converted',
     'A lead became a customer, naming the product line it closed on.'),
    ('lead_no_location',       'Qualified Lead Has No Location',
     'A lead was qualified without a state, so no office can be given it and no visit can be planned.'),
    ('leads_assigned',         'Leads Assigned (Call Centre)',
     'Leads handed to a call-centre agent to dial. Distinct from the sales assignment above.'),
    ('queue_contacts_assigned', 'Queue Contacts Assigned',
     'Outbound queue contacts handed to an agent.'),

    -- ── The sales diary ─────────────────────────────────────────────────────
    ('visit_planned',  'Visit Added to Your Diary',
     'Someone else planned a visit, call or meeting in your calendar.'),
    ('visit_due_today', 'Your Diary Today',
     'The morning summary of what you planned for today.'),
    ('follow_up_due',  'Follow-Ups Due',
     'Leads whose next action has arrived, and how many are already late.'),

    -- ── Finance: the maker-checker chain that announced nothing ─────────────
    ('manual_posting_submitted', 'Manual Posting Needs Approval',
     'A manual GL posting is waiting for a second pair of eyes.'),
    ('payment_approval_pending', 'Payment Awaiting Approval',
     'A collections payment needs approving.'),
    ('payment_approved',         'Payment Approved', 'A payment you raised was approved.'),
    ('payment_rejected',         'Payment Rejected', 'A payment you raised was rejected.'),
    ('writeoff_approval_pending', 'Write-Off Awaiting Approval',
     'A write-off needs approving.'),
    ('writeoff_approved',        'Write-Off Approved', 'A write-off you raised was approved.'),
    ('writeoff_rejected',        'Write-Off Rejected', 'A write-off you raised was rejected.'),

    -- ── Risk and compliance: the ones a head would want ON ──────────────────
    ('prudential_breach', 'Prudential Breach',
     'A regulatory limit has been breached.'),
    ('data_breach',       'Data Breach',
     'A suspected or confirmed data breach. NDPR puts a clock on this one.'),
    ('finding_created',   'Compliance Finding Raised', 'A new compliance finding.'),
    ('finding_closed',    'Compliance Finding Closed', 'A finding was closed out.'),
    ('survey_low_score',  'Low Survey Score', 'A customer survey came back poor.'),

    -- ── Cards ───────────────────────────────────────────────────────────────
    ('card_dispute_filed',      'Card Dispute Filed', 'A customer disputed a card transaction.'),
    ('credit_limit_approved',   'Credit Limit Approved', 'A card credit limit change was approved.'),
    ('billing_cycle_generated', 'Billing Cycle Generated', 'A card billing cycle has been produced.'),
    ('card_cycle_risk',         'Card Cycle at Risk',
     'A card cycle looks wrong or incomplete and needs checking before statements go out.'),

    -- ── Collections and recovery ────────────────────────────────────────────
    ('collections_assigned',     'Collections Accounts Assigned',
     'Accounts handed to a collections agent.'),
    ('repayment_plan_created',   'Repayment Plan Created', 'A customer agreed a repayment plan.'),
    ('recovery_case_assigned',   'Recovery Case Assigned', 'A recovery case was given to you.'),
    ('recovery_legal_milestone', 'Recovery Legal Milestone', 'A legal step was reached on a recovery case.'),
    ('recovery_debt_sale',       'Debt Sale', 'A debt sale was recorded.'),

    -- ── Lending ─────────────────────────────────────────────────────────────
    ('los_application_submitted', 'Loan Application Submitted',
     'An application was submitted for review.'),

    -- ── Help desk hand-overs ────────────────────────────────────────────────
    ('ticket_escalated',            'Ticket Escalated', 'A ticket was escalated to you or your team.'),
    ('ticket_escalation_resolved',  'Escalation Resolved', 'An escalation you raised was resolved.'),
    ('ticket_taken_over',           'Ticket Taken Over', 'Someone took over a ticket you were working.'),
    ('ticket_reassigned_away',      'Ticket Reassigned Away', 'A ticket was moved off you.'),
    ('ticket_assisted',             'Ticket Assist Requested', 'You were asked to assist on a ticket.'),
    ('ticket_delete_decided',       'Ticket Deletion Decided', 'A request to delete a ticket was decided.')
  ) AS e(event_type, label, description)
  CROSS JOIN (VALUES ('in_app'), ('email')) AS ch(channel)
ON CONFLICT DO NOTHING;

-- A label and description on rows that already existed but never carried one, so the
-- settings screen does not show a bare event key next to the ones that read as English.
UPDATE app.notification_event_config c
   SET label       = COALESCE(NULLIF(btrim(c.label), ''), e.label),
       description = COALESCE(NULLIF(btrim(c.description), ''), e.description)
  FROM (VALUES
    ('cc_lead_forwarded', 'Lead Forwarded to Sales',
     'A call-centre agent qualified a lead.')
  ) AS e(event_type, label, description)
 WHERE c.event_type = e.event_type
   AND COALESCE(btrim(c.label), '') = '';
