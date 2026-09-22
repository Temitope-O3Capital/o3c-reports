import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal, ErrBanner, Pill } from '../../../components/UI'
import { apiFetch } from '../../../lib/api'
import { fmtNum } from '../../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, NAVY, PURPLE, INTER, TEXT, FW, SP, RADIUS } from '../../../lib/design'
import { currentUser, hasPage } from '../../../hooks/useAuth'
import { MGMT } from '../../../lib/roles'

/*
  Shared pieces for the Email Reports list and the report editor: the API shapes,
  how times and schedules are worded, the email preview, and waiting on a build.
*/

// ── API shapes ────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'sent' | 'built' | 'failed' | 'skipped'
export type Trigger = 'schedule' | 'manual' | 'preview' | 'test'
export type Cadence = 'daily' | 'weekly' | 'monthly'
export type Template = 'management' | 'sales' | 'custom'

export interface ReportRow {
  report_key: string
  name: string
  description: string
  audience: string
  template: Template
  cadence: Cadence
  due_rule: string
  send_time: string
  sections: string[]
  recipients: string[]
  is_active: boolean
  is_builtin: boolean
  sort_order: number
  updated_at: string | null
  updated_by_name: string
  created_by_name: string
  last_run_id: number | null
  last_run_trigger: Trigger | null
  last_run_status: RunStatus | null
  last_run_subject: string | null
  last_run_started_at: string | null
  last_run_finished_at: string | null
  last_run_error: string | null
  last_run_requested_by_name: string
  preview_run_id: number | null
  preview_at: string | null
  sent_7d: number
  failed_7d: number
  scheduled_today: boolean
  next_due_at: string | null
}

export interface RunRow {
  id: number
  report_key: string
  name: string
  run_trigger: Trigger
  status: RunStatus
  run_date: string
  subject: string
  recipients: string[]
  body_kb: number | null
  chart_count: number | null
  provider_message_id: string | null
  error: string | null
  has_preview: boolean
  requested_by_name: string
  started_at: string
  finished_at: string | null
}

export interface RunState {
  id: number
  report_key: string | null
  run_trigger: Trigger
  status: RunStatus
  subject: string
  error: string | null
  has_preview: boolean
  started_at: string
  finished_at: string | null
}

export interface Summary {
  active: number
  total: number
  sent_today: number
  failed_7d: number
  running: number
  last_sent: { report_key: string; name: string; subject: string; finished_at: string } | null
  next_due: { report_key: string; name: string; at: string } | null
}

export interface CatalogueSection { id: string; group: string; title: string; description: string }
export interface TemplateSpec { title: string; description: string; daily: string[]; weekly: string[]; monthly: string[] }
export interface Catalogue {
  groups: { id: string; title: string }[]
  sections: CatalogueSection[]
  templates: { management: TemplateSpec; sales: TemplateSpec }
  due_rules: { id: string; label: string; cadence: Cadence }[]
  audiences: { id: string; label: string }[]
}

// ── Permissions ───────────────────────────────────────────────────────────────

/** Mirrors the backend: management, or anyone holding the reports page, may change reports. */
export function canManageReports(): boolean {
  const user = currentUser()
  return !!user && (MGMT.has(user.role) || hasPage('reports', user))
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

// Fetched once per page load: it only changes when the generator ships new sections.
let cataloguePromise: Promise<Catalogue> | null = null

export function useCatalogue() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (!cataloguePromise) cataloguePromise = apiFetch<Catalogue>('/api/management-reports/catalogue')
    cataloguePromise
      .then(c => { if (live) setCatalogue(c) })
      .catch((e: any) => { cataloguePromise = null; if (live) setError(e.message) })
    return () => { live = false }
  }, [])
  return { catalogue, error }
}

// ── Words ─────────────────────────────────────────────────────────────────────

// Every time on these pages is WAT: reports go out at 09:00 Lagos time, and a reader
// abroad should still see "09:00", not their own clock.
export const WAT = 'Africa/Lagos'

const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: WAT }).format(d)
const clock = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: WAT, hour: '2-digit', minute: '2-digit' }).format(d)

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = Date.now()
  const k = dayKey(d)
  if (k === dayKey(new Date(now))) return `Today, ${clock(d)}`
  if (k === dayKey(new Date(now + 86_400_000))) return `Tomorrow, ${clock(d)}`
  if (k === dayKey(new Date(now - 86_400_000))) return `Yesterday, ${clock(d)}`
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: WAT, weekday: 'short', day: 'numeric', month: 'short' }).format(d)
  return `${day}, ${clock(d)}`
}

export function howSent(trigger: Trigger | null, who: string): string {
  if (trigger === 'schedule') return 'Scheduled'
  const name = who || 'a colleague'
  if (trigger === 'test') return `Test by ${name}`
  if (trigger === 'preview') return `Preview by ${name}`
  return `Sent by ${name}`
}

export const firstLine = (s: string | null | undefined) => (s ?? '').split('\n')[0].slice(0, 180)
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`

/** What period each cadence covers — the same rule the generator applies. */
export const COVERS: Record<Cadence, string> = {
  daily: 'the previous working day',
  weekly: 'the last full week, Monday to Sunday',
  monthly: 'the month just closed',
}

export function ruleLabel(catalogue: Catalogue | null, id: string): string {
  return catalogue?.due_rules.find(r => r.id === id)?.label ?? id.replace(/_/g, ' ')
}

export function audienceLabel(catalogue: Catalogue | null, id: string): string {
  return catalogue?.audiences.find(a => a.id === id)?.label ?? (id.charAt(0).toUpperCase() + id.slice(1))
}

/** "Every weekday at 09:00 WAT, covering the previous working day." */
export function scheduleSentence(r: { cadence: Cadence; due_rule: string; send_time: string }, catalogue: Catalogue | null): string {
  return `${ruleLabel(catalogue, r.due_rule)} at ${r.send_time} WAT, covering ${COVERS[r.cadence]}.`
}

export const AUDIENCE_COLOR: Record<string, string> = {
  management: NAVY, sales: AMBER, collections: RED, cards: BLUE, risk: PURPLE, operations: GREEN, other: '#6B7280',
}

// ── Status ────────────────────────────────────────────────────────────────────

const STATUS: Record<RunStatus, { label: string; color: string }> = {
  running: { label: 'Sending', color: BLUE },
  sent:    { label: 'Sent', color: GREEN },
  built:   { label: 'Preview Built', color: NAVY },
  failed:  { label: 'Failed', color: RED },
  skipped: { label: 'Skipped', color: AMBER },
}

export function StatusPill({ status, trigger }: { status: RunStatus; trigger?: Trigger | null }) {
  const s = STATUS[status] ?? { label: status, color: NAVY }
  const label = status === 'running' && (trigger === 'preview' || trigger === 'test')
    ? (trigger === 'test' ? 'Sending Test' : 'Building')
    : status === 'sent' && trigger === 'test' ? 'Test Sent' : s.label
  return <Pill label={label} color={s.color} bg={`${s.color}18`} />
}

// ── Small pieces ──────────────────────────────────────────────────────────────

/** Two letters from an email address: temitope_babatunde@… → TB. */
export function emailInitials(email: string): string {
  const local = email.split('@')[0] || email
  const parts = local.split(/[._-]+/).filter(Boolean)
  return ((parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2)) || '?').toUpperCase()
}

const AVATAR_TONES = [NAVY, '#0891B2', PURPLE, AMBER, GREEN, BLUE]

export function RecipientStack({ recipients, max = 4 }: { recipients: string[]; max?: number }) {
  const shown = recipients.slice(0, max)
  const more = recipients.length - shown.length
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }} aria-hidden="true">
      {shown.map((email, i) => (
        <span key={email} title={email} style={{
          width: 24, height: 24, borderRadius: RADIUS.full, marginLeft: i ? -6 : 0,
          background: AVATAR_TONES[i % AVATAR_TONES.length], color: '#fff',
          border: '2px solid var(--card)', fontSize: 9.5, fontWeight: FW.bold, fontFamily: INTER,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', letterSpacing: 0.2,
        }}>{emailInitials(email)}</span>
      ))}
      {more > 0 && (
        <span style={{
          height: 24, minWidth: 24, padding: '0 6px', borderRadius: RADIUS.full, marginLeft: -6,
          background: 'var(--chip-bg)', color: 'var(--chip-txt)', border: '2px solid var(--card)',
          fontSize: 10, fontWeight: FW.semibold, fontFamily: INTER, display: 'inline-flex', alignItems: 'center',
        }}>+{more}</span>
      )}
    </span>
  )
}

/** A compact segmented control. Each option is a real toggle button for keyboard and screen readers. */
export function Segmented<T extends string | number>({ options, value, onChange, ariaLabel, disabled, size = 'md' }: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  ariaLabel: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={{
      display: 'inline-flex', flexWrap: 'wrap', gap: 2, padding: 3, borderRadius: RADIUS.md,
      background: 'var(--chip-bg)', border: '1px solid var(--bdr)', maxWidth: '100%',
    }}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={String(o.value)} type="button" aria-pressed={on} disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              padding: size === 'sm' ? '4px 10px' : '6px 14px', borderRadius: RADIUS.sm, border: 'none',
              cursor: disabled ? 'default' : 'pointer', fontFamily: INTER,
              fontSize: size === 'sm' ? TEXT.xs : TEXT.sm, fontWeight: on ? FW.semibold : FW.medium,
              background: on ? 'var(--card)' : 'transparent',
              color: on ? 'var(--txt)' : 'var(--txt2)',
              boxShadow: on ? '0 1px 2px rgba(15,22,35,.08), 0 0 0 1px var(--bdr)' : 'none',
              transition: 'background 120ms, color 120ms',
              whiteSpace: 'nowrap',
            }}>{o.label}</button>
        )
      })}
    </div>
  )
}

// ── Preview ───────────────────────────────────────────────────────────────────

export const PREVIEW_WIDTHS: { value: number; label: string }[] = [
  { value: 600, label: 'Desktop' },
  { value: 375, label: 'iPhone' },
  { value: 320, label: 'Small Phone' },
]

/**
 * The email exactly as built, at a chosen width. The email is read on phones as much as
 * at a desk, and a layout that holds at 600px can still clip at 320, so the width is a
 * real control rather than a nicety. Sandboxed: the body is data, never script.
 */
export function PreviewFrame({ html, width, height = '70vh', title }: {
  html: string; width: number; height?: string | number; title: string
}) {
  return (
    <div style={{
      background: '#e8e6e1', borderRadius: RADIUS.lg, padding: SP[3],
      display: 'flex', justifyContent: 'center', overflowX: 'auto',
    }}>
      <iframe
        title={title}
        srcDoc={html}
        sandbox=""
        style={{ width, flexShrink: 0, height, border: 0, background: '#fffffe', display: 'block', borderRadius: 4 }}
      />
    </div>
  )
}

export function PreviewModal({ runId, title, onClose }: { runId: number; title: string; onClose: () => void }) {
  const [data, setData] = useState<{ subject: string; html: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [width, setWidth] = useState(600)

  useEffect(() => {
    let live = true
    setData(null)
    setErr(null)
    apiFetch<{ subject: string; html: string }>(`/api/management-reports/runs/${runId}/preview`)
      .then(d => { if (live) setData(d) })
      .catch((e: any) => { if (live) setErr(e.message) })
    return () => { live = false }
  }, [runId])

  return (
    <Modal open onClose={onClose} title={title} width={760}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SP[3], flexWrap: 'wrap', marginBottom: SP[3] }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {data ? data.subject : err ? '' : 'Loading…'}
        </div>
        <Segmented ariaLabel="Preview width" size="sm" options={PREVIEW_WIDTHS} value={width} onChange={setWidth} />
      </div>
      <ErrBanner error={err} />
      {data && <PreviewFrame html={data.html} width={width} title={`${title} as sent`} />}
    </Modal>
  )
}

// ── Waiting on a build ────────────────────────────────────────────────────────

/**
 * Poll a run until it leaves "running". Builds take from a few seconds (sales) to about a
 * minute (charts), so a short interval with a generous ceiling; the caller can cancel by
 * flipping the token when the component unmounts or a newer build supersedes this one.
 */
export async function waitForRun(runId: number, token: { cancelled: boolean }, timeoutMs = 5 * 60_000): Promise<RunState> {
  const started = Date.now()
  for (;;) {
    if (token.cancelled) throw new Error('cancelled')
    const run = await apiFetch<RunState>(`/api/management-reports/runs/${runId}`)
    if (run.status !== 'running') return run
    if (Date.now() - started > timeoutMs) {
      throw new Error('The report is taking longer than five minutes to build. It will still appear in the send history when it finishes.')
    }
    await new Promise(res => setTimeout(res, 2500))
  }
}
