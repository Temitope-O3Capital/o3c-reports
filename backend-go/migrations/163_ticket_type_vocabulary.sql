-- 163_ticket_type_vocabulary.sql
--
-- Aligns helpdesk_tickets_type_check with the vocabulary the workspace actually
-- uses.
--
-- The constraint held nine snake_case values (general_inquiry, payment_dispute,
-- card_block_request, …) that nothing in the application has ever written: all
-- 36,515 tickets carry ticket_type NULL, which the constraint permits. Every
-- screen — the Log-a-Call form, Admin → Helpdesk Settings, the ticket queue —
-- uses human-readable types instead ('General Enquiry', 'Card Dispute',
-- 'Complaint (CBN reportable)' …).
--
-- So the moment a ticket was raised WITH a type — which is exactly what the
-- Log-a-Call form does when a call needs a follow-up — it failed on the
-- constraint and the agent saw "Internal server error".
--
-- The stored vocabulary is replaced by the one in use. The legacy snake_case
-- values are kept as well: nothing holds them today, but an old integration or a
-- routing rule may still send one, and rejecting those here would trade one
-- silent failure for another.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.helpdesk_tickets DROP CONSTRAINT IF EXISTS helpdesk_tickets_type_check;

ALTER TABLE app.helpdesk_tickets
  ADD CONSTRAINT helpdesk_tickets_type_check
  CHECK (ticket_type IS NULL OR ticket_type IN (
    -- In use across the workspace (Log-a-Call + Helpdesk Settings).
    'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Failed Transaction',
    'Card Dispute', 'Statement Request', 'Loan Complaint', 'Collection',
    'FD Enquiry', 'App Download', 'Technical / App Issue', 'Pitching / Marketing',
    'Complaint (CBN reportable)', 'Others',
    -- Legacy enum, retained so an older caller is not newly broken.
    'general_inquiry', 'payment_dispute', 'card_block_request', 'statement_request',
    'loan_inquiry', 'account_update', 'complaint', 'inbound_call', 'technical_issue'
  ));

-- The Zoho ticket import also fails on helpdesk_tickets_status_check, which
-- allows open|pending|in_progress|resolved|closed. Zoho Desk sends its own status
-- names, so those tickets are dropped on import rather than imported with a
-- mapped status. Deliberately NOT widened here: the right fix is a mapping in the
-- importer (Zoho "On Hold" is our "pending", not a new status of its own), and
-- adding Zoho's vocabulary to the column would make status mean two things at
-- once. Tracked separately.
