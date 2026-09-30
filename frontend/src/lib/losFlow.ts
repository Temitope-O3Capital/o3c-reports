// losFlow — single source of truth for the LOS credit-application pipeline.
//
// Mirrors the backend `allowedTransitions` + `transitionRequiredPage` in
// handlers/los.go. Keep the two in step: the page that authorises a stage's forward
// transition here MUST match the server, or the UI will show an action the API then
// 403s (or hide one the user could actually perform).
//
// Consumed by ApplicationDetail (action-bar gating), AppReview, LOSQueue, MyApprovals
// and the pipeline stepper so every screen agrees on stage order, ownership, colours
// and who may advance from where.
import { hasPage } from '../hooks/useAuth'
import { humanLabel } from '../lib/labels'

export type LosStage =
  | 'draft' | 'submitted' | 'document_collection' | 'risk_review'
  | 'risk_head_review' | 'pending_committee' | 'pending_conditions' | 'finance_approval'
  | 'booking' | 'active' | 'declined'

export interface StageMeta {
  key: LosStage
  label: string              // full label, e.g. "Risk Review"
  short: string              // stepper node label
  owner: string              // team/role that acts at this stage
  forward: LosStage | null   // the single next stage (null = terminal)
  forwardPage: string | null // page-key that authorises the forward transition
  action: string | null      // forward-button label, e.g. "Recommend to Risk Head"
  group: 'origination' | 'risk' | 'finance' | 'ops' | 'terminal'
  txt: string                // pill text colour
  bg: string                 // pill background
}

// Palette reused from the existing Queue/AppReview pills for visual continuity:
// origination = blue, risk = amber, finance = purple, ops = navy, active = green,
// declined = red.
const C = {
  blue:   { txt: '#2563EB', bg: 'rgba(37,99,235,.12)' },
  amber:  { txt: '#D97706', bg: 'rgba(217,119,6,.12)' },
  purple: { txt: '#7C3AED', bg: 'rgba(124,58,237,.12)' },
  navy:   { txt: '#0E2841', bg: 'rgba(14,40,65,.10)' },
  green:  { txt: '#16A34A', bg: 'rgba(22,163,74,.12)' },
  red:    { txt: '#C00000', bg: 'rgba(192,0,0,.10)' },
  grey:   { txt: '#6B7280', bg: 'rgba(75,85,99,.10)' },
}

// Ordered pipeline. `forwardPage` values are the authoritative gate keys.
export const STAGE_FLOW: StageMeta[] = [
  { key: 'draft',               label: 'Draft',               short: 'Draft',      owner: 'Sales Officer',  forward: 'submitted',           forwardPage: 'los',                 action: 'Submit Application', group: 'origination', ...C.grey },
  { key: 'submitted',           label: 'Submitted',           short: 'Submitted',  owner: 'Sales Officer',  forward: 'document_collection', forwardPage: 'los',                 action: 'Begin Document Collection', group: 'origination', ...C.blue },
  { key: 'document_collection', label: 'Document Collection', short: 'Documents',  owner: 'Risk Officer',   forward: 'risk_review',         forwardPage: 'los_risk_review',     action: 'Send to Risk Review',group: 'origination', ...C.blue },
  { key: 'risk_review',         label: 'Risk Review',         short: 'Risk',       owner: 'Risk Officer',   forward: 'risk_head_review',    forwardPage: 'los_risk_review',     action: 'Recommend to Risk Head',group: 'risk',        ...C.amber },
  { key: 'risk_head_review',    label: 'Risk Head Review',    short: 'Risk Head',  owner: 'Risk Head',      forward: 'pending_conditions',  forwardPage: 'los_risk_head',       action: 'Approve (Credit)',group: 'risk',        ...C.amber },
  // pending_committee was MISSING from this list while los.go has had an exit for it since
  // the stage was given one, precisely so a stranded file could be moved on. Absent here,
  // stageMeta() fell through to its default and reported key 'draft', forward null and
  // forwardPage null — so canAdvance, canDecline and canRequestInfo all returned false and
  // the risk head saw the stage with NO action bar: exactly the dead end los.go:326 says the
  // transition exists to remove, while risk.go goes on counting the file as pending in their
  // KPI. Sits here because risk_head_review is where Go routes in from, and forwards to
  // pending_conditions on los_risk_head, matching allowedTransitions and
  // transitionRequiredPage. Excluded from STAGE_SEQUENCE below — see there.
  { key: 'pending_committee',   label: 'Pending Committee',   short: 'Committee',  owner: 'Risk Head',      forward: 'pending_conditions',  forwardPage: 'los_risk_head',       action: 'Approve (Committee)',group: 'risk',        ...C.amber },
  { key: 'pending_conditions',  label: 'Pending Conditions',  short: 'Conditions', owner: 'Finance Officer',forward: 'finance_approval',    forwardPage: 'los_finance',         action: 'Clear Conditions → Finance',group: 'finance',     ...C.purple },
  { key: 'finance_approval',    label: 'Finance Approval',    short: 'Finance',    owner: 'Finance Head',   forward: 'booking',             forwardPage: 'los_finance_approve', action: 'Approve Disbursement',group: 'finance',     ...C.purple },
  { key: 'booking',             label: 'Booking',             short: 'Booking',    owner: 'Card Ops',       forward: 'active',              forwardPage: 'los_booking',         action: 'Book & Disburse', group: 'ops',         ...C.navy },
  { key: 'active',              label: 'Active',              short: 'Active',     owner: '—',              forward: null,                  forwardPage: null,                  action: null,                        group: 'terminal',    ...C.green },
  { key: 'declined',            label: 'Declined',            short: 'Declined',   owner: '—',              forward: null,                  forwardPage: null,                  action: null,                        group: 'terminal',    ...C.red },
]

const STAGE_MAP: Record<string, StageMeta> = Object.fromEntries(STAGE_FLOW.map(s => [s.key, s]))
// The happy-path stepper. pending_committee is excluded alongside declined: both are
// exceptional stages that no application passes through on the normal route, and adding
// either would draw an extra node on every file's progress bar.
export const STAGE_SEQUENCE: LosStage[] = STAGE_FLOW.filter(s => s.key !== 'declined' && s.key !== 'pending_committee').map(s => s.key)

export function stageMeta(stage?: string | null): StageMeta {
  return (stage && STAGE_MAP[stage]) || { key: 'draft', label: prettyStage(stage), short: prettyStage(stage), owner: '—', forward: null, forwardPage: null, action: null, group: 'origination', ...C.grey }
}

export function prettyStage(s?: string | null): string {
  return s ? humanLabel(s) : '—'
}

const TERMINAL = new Set(['active', 'declined', 'closed'])
export function isTerminalStage(stage?: string | null): boolean {
  return !!stage && TERMINAL.has(stage)
}

// canAdvance — may the current user move this application forward from `stage`?
// Mirrors the server: the stage's forwardPage, or the los_all supervisor override.
export function canAdvance(stage?: string | null): boolean {
  const m = stageMeta(stage)
  if (!m.forward || !m.forwardPage) return false
  return hasPage(m.forwardPage) || hasPage('los_all')
}

// Stages that can still be declined (a live credit decision is in play). Sales-only
// stages (draft/submitted/document_collection) are pre-decision; booking is post-credit
// (a booking failure is an ops issue, not a decline).
// pending_committee included: los.go's declineRequiredPage accepts a decline from it, and
// omitting it here was half of why a file parked at that stage had no action bar at all.
const DECLINABLE: LosStage[] = ['risk_review', 'risk_head_review', 'pending_committee', 'pending_conditions', 'finance_approval']
export function canDecline(stage?: string | null): boolean {
  if (!stage || !DECLINABLE.includes(stage as LosStage)) return false
  const m = stageMeta(stage)
  return hasPage(m.forwardPage ?? '') || hasPage('los_all')
}

// canRequestInfo — bounce back for more information. Same authority as advancing.
export function canRequestInfo(stage?: string | null): boolean {
  return canAdvance(stage) && !isTerminalStage(stage)
}

// The set of stages the current user is authorised to act on — used to label the
// My Approvals inbox and to know whether to surface it at all.
export function myActionableStages(): StageMeta[] {
  return STAGE_FLOW.filter(s => s.forward && s.forwardPage && (hasPage(s.forwardPage) || hasPage('los_all')))
}

// A short heading describing the caller's approval role, e.g. "Finance approvals".
export function inboxRoleLabel(): string {
  if (hasPage('los_all')) return 'All Approvals'
  const groups = new Set(myActionableStages().map(s => s.group))
  if (groups.has('finance')) return 'Finance Approvals'
  if (groups.has('ops')) return 'Booking & Disbursement'
  if (groups.has('risk')) return 'Risk Approvals'
  if (groups.has('origination')) return 'My Applications'
  return 'Approvals'
}

// ── Phoenix decision meta ──────────────────────────────────────────────────────
// The decisioning verdict written onto the application by Phoenix (or the Eye
// service). Advisory — it does NOT advance the stage; a human still approves.
export type LosDecision = 'approve' | 'decline' | 'refer' | 'pending' | ''

export function decisionMeta(d?: string | null): { label: string; txt: string; bg: string; icon: string } {
  switch ((d ?? '').toLowerCase()) {
    case 'approve': return { label: 'Recommend Approve', ...C.green, icon: 'thumb_up' }
    case 'decline': return { label: 'Recommend Decline', ...C.red, icon: 'thumb_down' }
    case 'refer':   return { label: 'Refer to Analyst',  ...C.amber, icon: 'help' }
    case 'pending': return { label: 'Decision Pending',  ...C.grey, icon: 'hourglass_empty' }
    default:        return { label: 'No Decision Yet',   ...C.grey, icon: 'remove' }
  }
}

// phoenix_sync_state → a small provenance badge so reviewers know whether the score
// is live from Phoenix, still in flight, or absent.
export function syncStateMeta(s?: string | null, decision?: string | null): { label: string; txt: string; bg: string } | null {
  const state = (s ?? '').toLowerCase()
  // 'decided' is written in the same statement as the decision fields, so the two
  // should never disagree — yet a row can carry the state with every decision field
  // empty, and it then showed a settled green "Phoenix decided" for an application
  // with no decision, no score and no decided-at. Phoenix emits decision.completed
  // only for approve and decline, never for a REFER, so a referred application can
  // sit in exactly this state indefinitely. Say that rather than showing it as done.
  if (state === 'decided' && !(decision ?? '').trim()) {
    return { label: 'Decision not received', ...C.amber }
  }
  switch (state) {
    case 'decided':      return { label: 'Phoenix decided', ...C.green }
    case 'sent':         return { label: 'Awaiting Phoenix', ...C.blue }
    case 'pending':      return { label: 'Queued for Phoenix', ...C.grey }
    case 'failed':       return { label: 'Phoenix Sync Failed', ...C.red }
    case 'not_required': return { label: 'Phoenix-Originated', ...C.purple }
    default:             return null
  }
}
