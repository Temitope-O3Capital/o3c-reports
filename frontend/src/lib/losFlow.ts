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

export type LosStage =
  | 'draft' | 'submitted' | 'document_collection' | 'risk_review'
  | 'risk_head_review' | 'pending_conditions' | 'finance_approval'
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
  { key: 'draft',               label: 'Draft',               short: 'Draft',      owner: 'Sales Officer',  forward: 'submitted',           forwardPage: 'los',                 action: 'Submit application',        group: 'origination', ...C.grey },
  { key: 'submitted',           label: 'Submitted',           short: 'Submitted',  owner: 'Sales Officer',  forward: 'document_collection', forwardPage: 'los',                 action: 'Begin document collection', group: 'origination', ...C.blue },
  { key: 'document_collection', label: 'Document Collection', short: 'Documents',  owner: 'Risk Officer',   forward: 'risk_review',         forwardPage: 'los_risk_review',     action: 'Send to risk review',       group: 'origination', ...C.blue },
  { key: 'risk_review',         label: 'Risk Review',         short: 'Risk',       owner: 'Risk Officer',   forward: 'risk_head_review',    forwardPage: 'los_risk_review',     action: 'Recommend to risk head',    group: 'risk',        ...C.amber },
  { key: 'risk_head_review',    label: 'Risk Head Review',    short: 'Risk Head',  owner: 'Risk Head',      forward: 'pending_conditions',  forwardPage: 'los_risk_head',       action: 'Approve (credit)',          group: 'risk',        ...C.amber },
  { key: 'pending_conditions',  label: 'Pending Conditions',  short: 'Conditions', owner: 'Finance Officer',forward: 'finance_approval',    forwardPage: 'los_finance',         action: 'Clear conditions → Finance',group: 'finance',     ...C.purple },
  { key: 'finance_approval',    label: 'Finance Approval',    short: 'Finance',    owner: 'Finance Head',   forward: 'booking',             forwardPage: 'los_finance_approve', action: 'Approve disbursement',      group: 'finance',     ...C.purple },
  { key: 'booking',             label: 'Booking',             short: 'Booking',    owner: 'Card Ops',       forward: 'active',              forwardPage: 'los_booking',         action: 'Book & disburse',           group: 'ops',         ...C.navy },
  { key: 'active',              label: 'Active',              short: 'Active',     owner: '—',              forward: null,                  forwardPage: null,                  action: null,                        group: 'terminal',    ...C.green },
  { key: 'declined',            label: 'Declined',            short: 'Declined',   owner: '—',              forward: null,                  forwardPage: null,                  action: null,                        group: 'terminal',    ...C.red },
]

const STAGE_MAP: Record<string, StageMeta> = Object.fromEntries(STAGE_FLOW.map(s => [s.key, s]))

// The linear happy-path sequence (excludes declined) — for the stepper.
export const STAGE_SEQUENCE: LosStage[] = STAGE_FLOW.filter(s => s.key !== 'declined').map(s => s.key)

export function stageMeta(stage?: string | null): StageMeta {
  return (stage && STAGE_MAP[stage]) || { key: 'draft', label: prettyStage(stage), short: prettyStage(stage), owner: '—', forward: null, forwardPage: null, action: null, group: 'origination', ...C.grey }
}

export function prettyStage(s?: string | null): string {
  return s ? s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—'
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
const DECLINABLE: LosStage[] = ['risk_review', 'risk_head_review', 'pending_conditions', 'finance_approval']
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
  if (hasPage('los_all')) return 'All approvals'
  const groups = new Set(myActionableStages().map(s => s.group))
  if (groups.has('finance')) return 'Finance approvals'
  if (groups.has('ops')) return 'Booking & disbursement'
  if (groups.has('risk')) return 'Risk approvals'
  if (groups.has('origination')) return 'My applications'
  return 'Approvals'
}

// ── Phoenix decision meta ──────────────────────────────────────────────────────
// The decisioning verdict written onto the application by Phoenix (or the Eye
// service). Advisory — it does NOT advance the stage; a human still approves.
export type LosDecision = 'approve' | 'decline' | 'refer' | 'pending' | ''

export function decisionMeta(d?: string | null): { label: string; txt: string; bg: string; icon: string } {
  switch ((d ?? '').toLowerCase()) {
    case 'approve': return { label: 'Recommend approve', ...C.green, icon: 'thumb_up' }
    case 'decline': return { label: 'Recommend decline', ...C.red, icon: 'thumb_down' }
    case 'refer':   return { label: 'Refer to analyst',  ...C.amber, icon: 'help' }
    case 'pending': return { label: 'Decision pending',  ...C.grey, icon: 'hourglass_empty' }
    default:        return { label: 'No decision yet',   ...C.grey, icon: 'remove' }
  }
}

// phoenix_sync_state → a small provenance badge so reviewers know whether the score
// is live from Phoenix, still in flight, or absent.
export function syncStateMeta(s?: string | null): { label: string; txt: string; bg: string } | null {
  switch ((s ?? '').toLowerCase()) {
    case 'decided':      return { label: 'Phoenix decided', ...C.green }
    case 'sent':         return { label: 'Awaiting Phoenix', ...C.blue }
    case 'pending':      return { label: 'Queued for Phoenix', ...C.grey }
    case 'failed':       return { label: 'Phoenix sync failed', ...C.red }
    case 'not_required': return { label: 'Phoenix-originated', ...C.purple }
    default:             return null
  }
}
