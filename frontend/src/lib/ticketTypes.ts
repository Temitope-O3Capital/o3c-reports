// ticketTypes — the one list of helpdesk ticket types the UI offers.
//
// WHY THIS FILE EXISTS. The vocabulary was declared in three places and two of them were
// five members short:
//
//   components/LogCallModal.tsx   14  ← complete, and it AUTO-ASSIGNS some of the missing ones
//   pages/helpdesk/NewTicket.tsx   9  ← feeds the TicketType union
//   pages/admin/HelpdeskSettings.tsx 9  ← the screen that owns routing and SLAs
//
// Missing from both short copies: Failed Transaction, Collection, App Download,
// Pitching / Marketing, Others.
//
// The consequence was not cosmetic. LogCallModal assigns "Pitching / Marketing" and
// "Collection" to call-raised tickets, so those tickets exist and are legal in the database —
// but HelpdeskSettings could not write a routing rule or an SLA for a type it did not list,
// and NewTicket's TicketType union did not include them. The same ticket type was therefore
// unroutable and untypeable on the two screens that own routing. Migration 163's own header
// records that this exact mismatch previously produced "Internal server error" on every typed
// ticket.
//
// KEEPING IT HONEST. This list mirrors the helpdesk_tickets ticket_type CHECK constraint
// (migration 163), verified against the live constraint on 2026-09-29. The constraint also
// retains nine legacy snake_case values (general_inquiry, payment_dispute, card_block_request,
// statement_request, loan_inquiry, account_update, complaint, inbound_call, technical_issue)
// so historical rows stay valid; those are deliberately NOT offered here, because nothing
// should create a new one. Adding a type means adding it to the CHECK in a migration first —
// a value this list offers but the constraint rejects is a 500 at save time.
export const TICKET_TYPES = [
  'General Enquiry',
  'Balance Enquiry',
  'Payment Confirmation',
  'Failed Transaction',
  'Card Dispute',
  'Statement Request',
  'Loan Complaint',
  'Collection',
  'FD Enquiry',
  'App Download',
  'Technical / App Issue',
  'Pitching / Marketing',
  'Complaint (CBN reportable)',
  'Others',
] as const

export type TicketType = typeof TICKET_TYPES[number]
