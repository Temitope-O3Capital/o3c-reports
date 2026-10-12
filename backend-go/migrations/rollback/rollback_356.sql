-- Rollback 356. Removes only the rows it seeded, and only where they still carry the
-- seeded default — a channel an admin has since switched off is their decision and is
-- left alone rather than deleted out from under them.
DELETE FROM app.notification_event_config
 WHERE channel IN ('in_app', 'email')
   AND enabled = TRUE
   AND event_type IN (
     'cc_lead_forwarded','sales_lead_assigned','sales_lead_claimed','sales_lead_converted',
     'lead_no_location','leads_assigned','queue_contacts_assigned',
     'visit_planned','visit_due_today','follow_up_due',
     'manual_posting_submitted','payment_approval_pending','payment_approved','payment_rejected',
     'writeoff_approval_pending','writeoff_approved','writeoff_rejected',
     'prudential_breach','data_breach','finding_created','finding_closed','survey_low_score',
     'card_dispute_filed','credit_limit_approved','billing_cycle_generated','card_cycle_risk',
     'collections_assigned','repayment_plan_created','recovery_case_assigned',
     'recovery_legal_milestone','recovery_debt_sale','los_application_submitted',
     'ticket_escalated','ticket_escalation_resolved','ticket_taken_over',
     'ticket_reassigned_away','ticket_assisted','ticket_delete_decided'
   );
