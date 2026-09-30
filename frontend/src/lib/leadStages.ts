// leadStages — the one lead-stage vocabulary the UI reads.
//
// WHY THIS FILE EXISTS. The stage list was declared in four TypeScript files plus five Go
// locations plus a SQL CHECK, and the only thing holding the copies together was a comment in
// each saying "matches migration 246":
//
//   frontend/src/pages/sales/Leads.tsx        STAGES (key/label/color)
//   frontend/src/pages/bd/Pipeline.tsx        STAGES + STAGE_COLORS + STAGE_LABELS
//   frontend/src/pages/sales/LeadDrawer.tsx   STAGE_COLOR
//   frontend/src/pages/sales/ContactDetail.tsx LEAD_OPEN_ORDER (+ a verbatim FORWARD_KINDS)
//
// All nine members agreed when this was written — verified 2026-09-29, member by member — so
// this is prevention, not repair. The cost of the old arrangement was not a live bug but the
// shape of one: adding a stage meant nine edits, and missing Go's openLeadStagesSQL alone would
// silently drop the new stage from every stalled-lead worklist while the pipeline still showed it.
//
// The canonical list is the crm_contacts_lead_stage_chk CHECK constraint (migration 246). This
// file mirrors it in lifecycle order. Adding a stage means the migration FIRST, then Go's
// leadStages / leadStageOrder / openLeadStagesSQL / crmStageRank, then here.
//
// 'qualified' is the stored key and "Interested" is what it is called on screen — the two differ
// on purpose. Only a call where the customer said they were interested puts a lead there (the
// rule agreed 14 Sept 2026, enforced by app.regrade_unqualified_leads), and "Qualified" read to
// agents as a machine judgement rather than something the customer had said.

import { RED, GREEN, AMBER, BLUE } from './design'

export interface LeadStage {
  key: string
  label: string
  color: string
}

// Lifecycle order. Every consumer that renders a funnel or orders a board relies on this being
// the order, not just the set.
export const LEAD_STAGES: LeadStage[] = [
  { key: 'new',                   label: 'New',                   color: '#6B7280' },
  { key: 'contacted',             label: 'Contacted',             color: BLUE },
  { key: 'qualified',             label: 'Interested',            color: '#7C3AED' }, // stored key stays 'qualified'
  // 'In Progress', not 'Handed to Sales'. The stored key is shared with BD and the call centre,
  // where "handed to sales" is literally what happened — but this is now also the stage a SALES
  // officer's own call or visit moves a lead into, and "Jennifer moved this lead to Handed to
  // Sales" reads as nonsense to the person who IS sales. 'In Progress' is true from every side:
  // BD sees a lead in progress with Sales, Sales sees one in progress with them. Same
  // key-versus-label split as 'qualified'/'Interested' above, and for the same reason.
  { key: 'handed_to_sales',       label: 'In Progress',           color: '#0891B2' },
  { key: 'documents_requested',   label: 'Documents Requested',   color: AMBER },
  { key: 'application_submitted', label: 'Application Submitted', color: '#4F46E5' },
  { key: 'approved',              label: 'Approved',              color: '#059669' },
  { key: 'converted',             label: 'Converted',             color: GREEN },
  { key: 'disqualified',          label: 'Disqualified',          color: RED },
]

// The two terminal stages. Named rather than repeated, because "open" is defined as "not one of
// these" in several places and an inline list is how one of them ends up disagreeing.
export const TERMINAL_LEAD_STAGES = ['converted', 'disqualified'] as const

// Still being worked. Mirrors Go's openLeadStagesSQL.
export const OPEN_LEAD_STAGES = LEAD_STAGES
  .map(s => s.key)
  .filter(k => !(TERMINAL_LEAD_STAGES as readonly string[]).includes(k))

const BY_KEY: Record<string, LeadStage> = Object.fromEntries(LEAD_STAGES.map(s => [s.key, s]))

// Unknown stages fall back to their own key rather than to a wrong label. A stage that reached
// the database without reaching this file should look unfamiliar on screen, not be quietly
// rendered as "New" — that is how a file at an unhandled stage becomes invisible.
export function leadStageLabel(key?: string | null): string {
  return (key && BY_KEY[key]?.label) || key || '—'
}
export function leadStageColor(key?: string | null): string {
  return (key && BY_KEY[key]?.color) || '#6B7280'
}
export function isOpenLeadStage(key?: string | null): boolean {
  return !!key && OPEN_LEAD_STAGES.includes(key)
}
