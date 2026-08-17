import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ErrBanner, Spinner, ConfirmModal, Modal, TblSearch, NameCell,
} from '../../components/UI'
import { apiFetch, apiPost, apiExport } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime, today } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, BLUE, PURPLE, NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

type Purpose = 'marketing' | 'collections' | 'support'

interface CallCenterContact {
  id: number
  customer_name: string
  phone: string
  cif: string | null
  product_name: string | null
  priority: 'High' | 'Medium' | 'Low'
  outstanding_kobo: number
  dpd: number
  last_disposition: string | null
  last_called_at: string | null
  is_existing_customer: boolean
  loan_product: string | null
  next_payment_date: string | null
  purpose: Purpose
  source: string | null
  ref: string | null
  // Call-derived (migration 144). These come from helpdesk_calls, the real call
  // ledger — the queue used to be blind to any call an agent placed via the carrier.
  attempts: number
  connects: number
  last_call_outcome: string | null
  is_cooling: boolean    // dialled inside the cooldown window; rest it
  is_exhausted: boolean  // many attempts, never once answered
  disposition_code: string | null
  callback_at: string | null
  callback_due: boolean  // the agreed callback time has passed — serve it first
}

interface CallEntry {
  id: number
  called_at: string
  duration_seconds: number
  disposition: string
  agent_name: string
  notes: string | null
  direction?: string | null
  purpose?: string | null
  recording_url?: string | null
  log_source?: string | null
}

interface QueueSummary {
  total: number; uncalled: number; contacted: number
  callbacks: number      // scheduled, any time
  callbacks_due: number  // the agreed time has passed
  ready: number; cooling: number; exhausted: number
  marketing?: number; collections?: number; support?: number
}

// The working buckets. "ready" is what an agent should dial now; the rest exist so a
// supervisor can see — and act on — the part of the backlog that should not be dialled.
type Bucket = '' | 'ready' | 'uncalled' | 'cooling' | 'exhausted'

// Purpose presentation — colors + labels for the segmentation tabs and row tags.
const PURPOSE_META: Record<Purpose, { label: string; color: string; icon: string }> = {
  marketing:   { label: 'Marketing',   color: BLUE,  icon: 'campaign' },
  collections: { label: 'Collections', color: RED,   icon: 'account_balance_wallet' },
  support:     { label: 'Support',     color: GREEN, icon: 'support_agent' },
}

// A contact carries collections context (outstanding / DPD) only when it's an
// existing customer with a live balance. Telemarketing leads have neither, so the
// UI must not render misleading "₦0.00 / DPD 0" for them.
function hasCollectionsContext(c: CallCenterContact): boolean {
  return c.is_existing_customer && c.outstanding_kobo > 0
}
function isGenericProduct(p: string | null): boolean {
  const v = (p || '').trim().toLowerCase()
  return v === '' || v === 'zoho lead'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function dpdBg(dpd: number): string {
  if (dpd === 0) return GREEN
  if (dpd <= 30) return AMBER
  if (dpd <= 90) return RED
  return DARKRED
}

function priorityColor(p: 'High' | 'Medium' | 'Low'): string {
  return p === 'High' ? RED : p === 'Medium' ? AMBER : 'var(--chart-lbl)'
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpdBg(dpd)
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS['2xl'],
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>DPD {dpd}</span>
  )
}

// Keyed by canonical code. It was keyed by display label, which meant any rewording of
// a label silently dropped the colour back to grey.
const DISP_COLORS: Record<string, { bg: string; txt: string }> = {
  answered_interested:     { bg: 'rgba(22,163,74,.12)',   txt: '#16A34A' },
  answered_not_interested: { bg: 'rgba(192,0,0,.1)',      txt: '#C00000' },
  ptp:                     { bg: 'rgba(37,99,235,.12)',   txt: '#2563EB' },
  callback:                { bg: 'rgba(217,119,6,.12)',   txt: '#D97706' },
  wrong_number:            { bg: 'rgba(124,58,237,.12)',  txt: '#7C3AED' },
  do_not_call:             { bg: 'rgba(192,0,0,.1)',      txt: '#C00000' },
}

// `disp` is what the user reads; `code` is what picks the colour. Call trails from the
// ledger carry only the raw outcome text, so code is optional and falls back to neutral.
function DispositionPill({ disp, code, size = 'md' }: { disp: string; code?: string | null; size?: 'sm' | 'md' }) {
  const s = DISP_COLORS[code ?? ''] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: FW.semibold,
      padding: size === 'sm' ? '1px 6px' : '2px 8px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{disp}</span>
  )
}

// A chip doubles as the bucket selector — the counts are the navigation, so a
// supervisor who sees "3,773 exhausted" can click straight into them.
function StatChip({ label, value, color, active, onClick, title }: {
  label: string; value: number; color: string
  active?: boolean; onClick?: () => void; title?: string
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '8px 10px', borderRadius: RADIUS.md, flex: 1,
        background: active ? `${color}22` : `${color}0f`,
        border: `1px solid ${active ? color : `${color}28`}`,
        cursor: onClick ? 'pointer' : 'default',
        font: 'inherit', textAlign: 'center',
      }}
    >
      <span style={{ ...NUM, fontSize: value >= 10000 ? TEXT.xl : TEXT['2xl'], fontWeight: FW.extrabold, color, lineHeight: 1 }}>{value.toLocaleString()}</span>
      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginTop: 3, fontWeight: FW.medium, textAlign: 'center' }}>{label}</span>
    </Tag>
  )
}

function InfoField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginBottom: 3, fontWeight: FW.medium }}>{label}</div>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{value ?? '—'}</div>
    </div>
  )
}

// ── Call History ──────────────────────────────────────────────────────────────

function CallHistoryTimeline({ contactId, refreshKey }: { contactId: number; refreshKey: number }) {
  const [calls, setCalls] = useState<CallEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: CallEntry[] }>(`/api/call-center/contacts/${contactId}/calls`)
      .then(r => setCalls(r.data ?? []))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false))
  }, [contactId, refreshKey])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: '24px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
      <Spinner size={14} color={NAVY} /> Loading call history…
    </div>
  )
  if (!calls.length) return (
    <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt3)', fontSize: TEXT.base }}>
      No calls logged yet
    </div>
  )
  return (
    <div style={{ position: 'relative', paddingLeft: 22 }}>
      <div style={{ position: 'absolute', left: 6, top: 8, bottom: 8, width: 2, background: 'var(--bdr)' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {calls.map((c, i) => (
          <div key={c.id} style={{ position: 'relative' }}>
            <div style={{
              position: 'absolute', left: -18, top: 5,
              width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box',
              background: i === 0 ? NAVY : 'var(--card)',
              border: `2px solid ${i === 0 ? NAVY : 'var(--bdr)'}`,
            }} />
            <div style={{
              padding: '10px 12px', borderRadius: RADIUS.md,
              border: '1px solid var(--bdr)',
              background: i === 0 ? `${NAVY}06` : 'var(--th-bg)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {c.direction && (
                    <span className="material-symbols-rounded" title={c.direction} style={{ fontSize: 14, color: c.direction === 'inbound' ? GREEN : NAVY }}>
                      {c.direction === 'inbound' ? 'call_received' : 'call_made'}
                    </span>
                  )}
                  <DispositionPill disp={c.disposition} size="sm" />
                  {c.purpose && (
                    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'capitalize' }}>{c.purpose}</span>
                  )}
                </div>
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER, flexShrink: 0 }}>
                  {fmtDatetime(c.called_at)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.semibold }}>{c.agent_name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {c.recording_url && (
                    <a href={c.recording_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                      style={{ fontSize: TEXT['2xs'], color: NAVY, display: 'inline-flex', alignItems: 'center', gap: 2, textDecoration: 'none' }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>play_circle</span>Recording
                    </a>
                  )}
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{fmtDuration(c.duration_seconds)}</span>
                </div>
              </div>
              {c.notes && (
                <div style={{
                  fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 6, lineHeight: 1.5,
                  paddingTop: 6, borderTop: '1px solid var(--bdr)',
                }}>
                  {c.notes}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Log Call Form ─────────────────────────────────────────────────────────────

// Served by GET /api/call-center/dispositions — the Go side owns the vocabulary and
// what each outcome does to the contact, so there is one list, not three.
interface DispositionOption {
  code: string
  label: string
  status: string
  needs_callback: boolean
  add_to_dnc: boolean
  connected: boolean
  hint: string
}

// Presentation only — keyed by the canonical code.
const DISP_BTN_COLORS: Record<string, string> = {
  answered_interested: GREEN,
  answered_not_interested: RED,
  no_answer: 'var(--txt2)',
  wrong_number: PURPLE,
  ptp: BLUE,
  callback: AMBER,
  do_not_call: RED,
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

function LogCallForm({ contactId, onDone }: { contactId: number; onDone: () => void }) {
  // The vocabulary comes from the server (GET /dispositions) rather than a local array.
  // It used to be hardcoded here AND again further down the file, in two copies that had
  // already drifted, with the backend accepting any string at all.
  const options = useDispositions()
  const [disposition, setDisposition] = useState('')
  const [notes, setNotes] = useState('')
  const [ptpDate, setPtpDate] = useState(today())
  const [ptpAmountNaira, setPtpAmountNaira] = useState('')
  const [callbackAt, setCallbackAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Default to the first option once the vocabulary arrives, without clobbering a
  // choice the agent has already made while it was loading.
  useEffect(() => {
    if (options.length) setDisposition(d => d || options[0].code)
  }, [options])

  const chosen = options.find(o => o.code === disposition)
  const isPtp = disposition === 'ptp'

  async function submit() {
    if (!disposition) return
    if (chosen?.needs_callback && !callbackAt) {
      setErr('Pick the date and time you agreed to call back')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      const body: Record<string, unknown> = { disposition, notes }
      if (isPtp) {
        body.ptp_date = ptpDate
        body.ptp_amount_kobo = Math.round(parseFloat(ptpAmountNaira || '0') * 100)
      }
      if (chosen?.needs_callback && callbackAt) body.callback_at = new Date(callbackAt).toISOString()
      await apiPost(`/api/call-center/contacts/${contactId}/log-call`, body)
      toast.success(chosen?.hint ? `Call logged — ${chosen.hint.toLowerCase()}` : 'Call logged')
      setNotes('')
      setDisposition(options[0]?.code ?? '')
      setPtpAmountNaira('')
      setCallbackAt('')
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to log call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
      <ErrBanner error={err} />

      {/* Outcome buttons */}
      <div>
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: SP[2] }}>
          Call Outcome <span style={{ color: RED }}>*</span>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {options.map(d => {
            const on = disposition === d.code
            const color = DISP_BTN_COLORS[d.code] ?? NAVY
            return (
              <button key={d.code} onClick={() => setDisposition(d.code)} title={d.hint} style={{
                padding: '8px 10px', borderRadius: RADIUS.md,
                fontSize: TEXT.xs, fontWeight: FW.semibold, textAlign: 'center',
                border: `1.5px solid ${on ? color : 'var(--bdr)'}`,
                background: on ? `${color}15` : 'transparent',
                color: on ? color : 'var(--txt2)',
                cursor: 'pointer', transition: 'all .12s',
              }}>{d.label}</button>
            )
          })}
        </div>
        {/* Say what the choice will DO. "Wrong Number" quietly removing the contact is
            only acceptable if the agent was told that before they clicked. */}
        {chosen?.hint && (
          <div style={{ marginTop: 6, fontSize: TEXT['2xs'], color: 'var(--txt2)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>info</span>
            {chosen.hint}
          </div>
        )}
      </div>

      {/* Callback time — required, because a callback with no time is a promise nobody keeps */}
      {chosen?.needs_callback && (
        <div style={{ padding: 12, background: `${AMBER}0d`, borderRadius: RADIUS.md, border: `1px solid ${AMBER}28` }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Call back at <span style={{ color: RED }}>*</span>
          </label>
          <input
            type="datetime-local"
            value={callbackAt}
            onChange={e => setCallbackAt(e.target.value)}
            style={{ ...fieldStyle, height: 36 }}
          />
        </div>
      )}

      {/* PTP fields */}
      {isPtp && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '12px', background: `${BLUE}08`, borderRadius: RADIUS.md, border: `1px solid ${BLUE}20` }}>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>PTP Date</label>
            <input type="date" value={ptpDate} onChange={e => setPtpDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>PTP Amount NGN</label>
            <input type="number" value={ptpAmountNaira} onChange={e => setPtpAmountNaira(e.target.value)} placeholder="50000" style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>
      )}

      {/* Notes */}
      <div>
        <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: 6 }}>Notes</label>
        <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={4}
          placeholder="Add call notes…"
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </div>

      {/* Submit */}
      <button
        onClick={submit}
        disabled={saving}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP[2],
          padding: '11px 0', background: saving ? `${NAVY}80` : NAVY,
          color: '#fff', border: 'none', borderRadius: RADIUS.md,
          fontSize: TEXT.md, fontWeight: FW.bold,
          cursor: saving ? 'not-allowed' : 'pointer', width: '100%',
        }}
      >
        {saving ? <Spinner size={14} color="#fff" /> : (
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>save</span>
        )}
        {saving ? 'Saving…' : 'Log Call'}
      </button>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

type DetailTab = 'log' | 'history' | 'info'

function DetailPanel({ contact, onAction }: { contact: CallCenterContact; onAction: () => void }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<DetailTab>('log')
  const [historyKey, setHistoryKey] = useState(0)

  const pColor = priorityColor(contact.priority)

  function afterLog() {
    setHistoryKey(k => k + 1)
    setTab('history')
    onAction()
  }

  const tabs: { key: DetailTab; label: string; icon: string }[] = [
    { key: 'log',     label: 'Log Call',      icon: 'save'    },
    { key: 'history', label: 'Call History',  icon: 'history' },
    { key: 'info',    label: 'Customer Info', icon: 'person'  },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Action header ───────────────────────────────────────────────── */}
      <div style={{
        padding: '18px 24px',
        borderBottom: '1px solid var(--bdr)',
        background: 'var(--card)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          {/* Initials avatar */}
          <div style={{
            width: 46, height: 46, borderRadius: '50%', flexShrink: 0,
            background: `${pColor}1a`, color: pColor,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: TEXT.lg, fontWeight: FW.extrabold, letterSpacing: '-0.5px',
          }}>
            {(contact.customer_name || 'Unknown Lead').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap', marginBottom: 5 }}>
              <span style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>
                {contact.customer_name || 'Unknown Lead'}
              </span>
              <span style={{
                fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 8px', borderRadius: RADIUS.full,
                background: `${pColor}18`, color: pColor,
              }}>{contact.priority}</span>
              {hasCollectionsContext(contact) && <DpdBadge dpd={contact.dpd} />}
              {contact.last_disposition ? (
                <DispositionPill disp={contact.last_disposition} code={contact.disposition_code} size="sm" />
              ) : (
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: BLUE, background: `${BLUE}14`, padding: '1px 8px', borderRadius: RADIUS.full }}>
                  Not yet called
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
              <span style={{ fontSize: TEXT.md, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.semibold, letterSpacing: '0.3px' }}>
                {contact.phone}
              </span>
              {contact.cif && (
                <button
                  onClick={() => navigate(`/contacts/${contact.cif}`)}
                  style={{ fontSize: TEXT.xs, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                >
                  CIF: {contact.cif}
                </button>
              )}
            </div>
          </div>

          {/* Call button */}
          <a
            href={`tel:${contact.phone}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', background: GREEN, color: '#fff',
              borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.bold,
              textDecoration: 'none', flexShrink: 0,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>call</span>
            Call
          </a>
        </div>

        {/* Loan summary strip */}
        {contact.is_existing_customer && (
          <div style={{
            display: 'flex', gap: 0, marginTop: 14,
            paddingTop: 14, borderTop: '1px solid var(--bdr)',
          }}>
            <div style={{ flex: 1, paddingRight: SP[4], borderRight: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginBottom: 3 }}>Outstanding</div>
              <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.extrabold, color: 'var(--txt)' }}>
                {fmtKobo(contact.outstanding_kobo)}
              </div>
            </div>
            <div style={{ flex: 1, paddingLeft: SP[4], paddingRight: SP[4], borderRight: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginBottom: 3 }}>Next Payment</div>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                {fmtDate(contact.next_payment_date) ?? '—'}
              </div>
            </div>
            {contact.loan_product && (
              <div style={{ flex: 1, paddingLeft: SP[4] }}>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginBottom: 3 }}>Product</div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                  {contact.loan_product}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--bdr)',
        background: 'var(--card)', flexShrink: 0, padding: '0 20px',
      }}>
        {tabs.map(t => {
          const on = tab === t.key
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '10px 12px', fontSize: TEXT.sm,
              fontWeight: on ? 700 : 500,
              color: on ? NAVY : 'var(--txt2)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: on ? `2px solid ${NAVY}` : '2px solid transparent',
              marginBottom: -1,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{t.icon}</span>
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: `${SP[5]} ${SP[6]}` }}>
        {tab === 'log' && (
          <LogCallForm contactId={contact.id} onDone={afterLog} />
        )}

        {tab === 'history' && (
          <CallHistoryTimeline contactId={contact.id} refreshKey={historyKey} />
        )}

        {tab === 'info' && (
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: SP[3] }}>
              Contact Details
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginBottom: SP[6] }}>
              <InfoField label="Full Name" value={contact.customer_name || 'Unknown Lead'} />
              <InfoField label="Phone" value={<span style={{ fontFamily: INTER }}>{contact.phone}</span>} />
              <InfoField label="CIF" value={contact.cif} />
              {contact.purpose === 'marketing'
                ? <InfoField label="Campaign List" value={contact.ref || 'Unlisted'} />
                : <InfoField label="Product" value={contact.product_name} />}
              <InfoField label="Last Called" value={contact.last_called_at ? fmtDatetime(contact.last_called_at) : null} />
              <InfoField label="Last Outcome" value={contact.last_disposition
                ? <DispositionPill disp={contact.last_disposition} code={contact.disposition_code} size="sm" />
                : contact.last_call_outcome}
              />
              {/* Straight from the call ledger, so it counts carrier calls the queue
                  itself never recorded — the reason a number can read "0 attempts"
                  in an agent's memory and 37 in reality. */}
              <InfoField label="Attempts" value={
                contact.attempts > 0
                  ? <span style={{ ...NUM, color: contact.is_exhausted ? RED : 'var(--txt)' }}>
                      {contact.attempts} · {contact.connects} answered
                    </span>
                  : 'Never called'
              } />
              <InfoField label="Dial Status" value={
                contact.is_exhausted ? <span style={{ color: RED, fontWeight: FW.bold }}>Exhausted — 6+ tries, no answer</span>
                : contact.is_cooling ? <span style={{ color: AMBER, fontWeight: FW.bold }}>Cooling — called in last 7 days</span>
                : <span style={{ color: GREEN, fontWeight: FW.bold }}>Ready to call</span>
              } />
            </div>
            {contact.is_existing_customer && (
              <>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: SP[3] }}>
                  Loan Summary
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
                  <InfoField label="Outstanding" value={<span style={NUM}>{fmtKobo(contact.outstanding_kobo)}</span>} />
                  <InfoField label="DPD" value={<DpdBadge dpd={contact.dpd} />} />
                  <InfoField label="Next Payment" value={fmtDate(contact.next_payment_date)} />
                  <InfoField label="Loan Product" value={contact.loan_product} />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Filter constants ──────────────────────────────────────────────────────────

const PRIORITY_OPTIONS = ['High', 'Medium', 'Low'] as const
// One fetch of the server vocabulary, shared by the log form and the queue filter.
function useDispositions() {
  const [options, setOptions] = useState<DispositionOption[]>([])
  useEffect(() => {
    apiFetch<{ data: DispositionOption[] }>('/api/call-center/dispositions')
      .then(res => setOptions(res.data ?? []))
      .catch(() => setOptions([]))
  }, [])
  return options
}

// ── Import modal ──────────────────────────────────────────────────────────────

function ImportContactsModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [purpose, setPurpose] = useState<Purpose>('marketing')
  const [raw, setRaw] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // One contact per line: "name, phone, cif?, product?" — phone is required.
  const parsed = raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [name = '', phone = '', cif = '', product = ''] = line.split(',').map(s => s.trim())
    return { name, phone, cif, product }
  }).filter(c => c.phone)

  async function submit() {
    if (parsed.length === 0) { setErr('Add at least one row with a phone number'); return }
    setSaving(true); setErr(null)
    try {
      const res = await apiPost<{ inserted: number; skipped: number }>('/api/call-center/queue/import', { purpose, contacts: parsed })
      toast.success(`${res.inserted ?? 0} added${res.skipped ? ` · ${res.skipped} skipped` : ''}`)
      setRaw(''); onDone(); onClose()
    } catch (e: any) { setErr(e.message ?? 'Import failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import Contacts" width={480}
      footer={
        <>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving || parsed.length === 0} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (saving || !parsed.length) ? 'not-allowed' : 'pointer', opacity: (saving || !parsed.length) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}Import{parsed.length ? ` ${parsed.length}` : ''}
          </button>
        </>
      }
    >
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Add to</label>
          <select value={purpose} onChange={e => setPurpose(e.target.value as Purpose)} style={{ ...fieldStyle, height: 38 }}>
            <option value="marketing">Marketing</option>
            <option value="collections">Collections</option>
            <option value="support">Support</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Contacts — one per line: name, phone, cif, product
          </label>
          <textarea
            spellCheck={false}
            value={raw}
            onChange={e => setRaw(e.target.value)}
            rows={8}
            placeholder={'Jane Doe, 08012345678\nJohn Smith, 08087654321, 00012345, Loan follow-up'}
            style={{ ...fieldStyle, resize: 'vertical', fontFamily: INTER }}
          />
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{parsed.length} valid row(s) detected</div>
      </div>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CallCenterQueue() {
  const [items, setItems] = useState<CallCenterContact[]>([])
  const [summary, setSummary] = useState<QueueSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<CallCenterContact | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  const dispositionOptions = useDispositions()
  const [purposeF, setPurposeF] = useState<'' | Purpose>('')
  const [bucket, setBucket] = useState<Bucket>('ready')
  const [priority, setPriority] = useState('All')
  const [disposition, setDisposition] = useState('All')
  const [search, setSearch] = useState('')
  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke

  const [skipConfirm, setSkipConfirm] = useState(false)
  const [skipLoading, setSkipLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)
  const [collLoading, setCollLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const isHead = isHeadRole()

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    // A work queue is a live list, not a date-bounded report — no date filter.
    const params = new URLSearchParams({ limit: '200' })
    if (purposeF) params.set('purpose', purposeF)
    if (bucket) params.set('bucket', bucket)
    if (priority !== 'All') params.set('priority', priority)
    if (disposition !== 'All') params.set('disposition', disposition)
    if (dq) params.set('search', dq)
    try {
      const res = await apiFetch<{ data: CallCenterContact[]; summary?: QueueSummary }>(`/api/call-center/queue?${params}`)
      setItems(res.data ?? [])
      setSummary(res.summary ?? null)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [purposeF, bucket, priority, disposition, dq])

  useEffect(() => { load() }, [load])
  useLiveData(load)

  const anyFilter = priority !== 'All' || disposition !== 'All' || search !== ''

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() { setCheckedIds(new Set()) }

  async function handleSkip() {
    setSkipLoading(true)
    try {
      await apiPost('/api/call-center/queue/bulk-skip', { ids: [...checkedIds] })
      toast.success(`${checkedIds.size} contact(s) skipped`)
      clearChecked()
      setSelected(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to skip')
    } finally {
      setSkipLoading(false)
      setSkipConfirm(false)
    }
  }

  async function handleSyncCRM() {
    setSyncLoading(true)
    try {
      const res = await apiPost<{ inserted: number }>('/api/call-center/queue/sync-from-crm', {})
      toast.success(`${res.inserted ?? 0} new marketing lead(s) added`)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Sync failed')
    } finally {
      setSyncLoading(false)
    }
  }

  async function handlePullCollections() {
    setCollLoading(true)
    try {
      const res = await apiPost<{ inserted: number }>('/api/call-center/queue/sync-collections', {})
      toast.success(`${res.inserted ?? 0} overdue account(s) added to Collections`)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Collections pull failed')
    } finally {
      setCollLoading(false)
    }
  }

  async function handleExport() {
    try {
      const ids = [...checkedIds]
      const qs = ids.length ? `?ids=${ids.join(',')}` : ''
      await apiExport(`/api/call-center/queue/export${qs}`, 'call_center_queue')
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed')
    }
  }

  return (
    <Page title="Outbound Queue" subtitle={isHead ? 'Marketing, collections & support calls — from Zoho, our accounts, and manual lists' : 'Your assigned calls to make — dial through your list'} noPad
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          {(() => {
            const feedBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }
            // Feeding and assigning the queue are supervisor actions; agents just work
            // the list they were given.
            if (!isHead) return null
            return (
              <>
                <button onClick={handleSyncCRM} disabled={syncLoading} title="Pull Zoho CRM leads (Marketing)" style={{ ...feedBtn, cursor: syncLoading ? 'wait' : 'pointer', opacity: syncLoading ? 0.7 : 1 }}>
                  {syncLoading ? <Spinner size={13} color={NAVY} /> : <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: BLUE }}>campaign</span>}
                  Sync CRM
                </button>
                <button onClick={handlePullCollections} disabled={collLoading} title="Pull overdue accounts (Collections)" style={{ ...feedBtn, cursor: collLoading ? 'wait' : 'pointer', opacity: collLoading ? 0.7 : 1 }}>
                  {collLoading ? <Spinner size={13} color={RED} /> : <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: RED }}>account_balance_wallet</span>}
                  Pull Collections
                </button>
                <button onClick={() => setImportOpen(true)} title="Upload a manual list" style={feedBtn}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
                  Import
                </button>
                {isHead && (
                  <button onClick={() => setAssignOpen(true)} title="Assign a batch of the queue to one agent"
                    style={{ ...feedBtn, background: NAVY, color: '#fff', border: `1px solid ${NAVY}` }}>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment_ind</span>
                    Assign to agent
                  </button>
                )}
              </>
            )
          })()}
        </div>
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ─────────────────────────────────────────────────── */}
        <div style={{
          width: 380, minWidth: 320, maxWidth: 400,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)', flexShrink: 0,
        }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>Call Queue</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>
                {/* Count the bucket in view, not the whole backlog — the list is
                    bucket-filtered, so "of 14,708" would overstate what is loaded. */}
                showing {items.length} of {((bucket ? summary?.[bucket] : summary?.total) ?? items.length).toLocaleString()}
              </div>
            </div>

            {/* Purpose segmentation — Marketing / Collections / Support */}
            <div style={{ display: 'flex', gap: 3, marginBottom: 10, background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
              {([['', 'All'], ['marketing', 'Marketing'], ['collections', 'Collections'], ['support', 'Support']] as const).map(([val, label]) => {
                const on = purposeF === val
                const count = val === '' ? (summary?.total ?? 0) : (summary?.[val] ?? 0)
                const color = val === '' ? NAVY : PURPOSE_META[val].color
                return (
                  <button key={label || 'all'} onClick={() => setPurposeF(val)} style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                    padding: '5px 2px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer',
                    background: on ? 'var(--card)' : 'transparent',
                    boxShadow: on ? '0 1px 2px rgba(0,0,0,.10)' : 'none',
                  }}>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: on ? color : 'var(--txt2)' }}>{label}</span>
                    <span style={{ ...NUM, fontSize: TEXT['2xs'], color: on ? color : 'var(--txt3)' }}>{count.toLocaleString()}</span>
                  </button>
                )
              })}
            </div>

            {/* Buckets — counted from real call history, and clickable. These read
                "Contacted 0 / Not Yet Called 14,708" before the queue was joined to the
                call ledger; every contact claimed to be untouched while 13,669 of them
                had been dialled 97,938 times. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {/* Only shown when there are any — a permanent "0 Callbacks Due" chip
                  would cost a quarter of the strip to say nothing. */}
              {!!summary?.callbacks_due && (
                <StatChip
                  label="Callbacks Due" value={summary.callbacks_due} color={AMBER}
                  title="A customer agreed a time and it has passed — call these first"
                />
              )}
              <StatChip
                label="Ready to Call" value={summary?.ready ?? 0} color={GREEN}
                active={bucket === 'ready'} onClick={() => setBucket(bucket === 'ready' ? '' : 'ready')}
                title="Never called, or rested past the 7-day cooldown — and not an exhausted number"
              />
              <StatChip
                label="Never Called" value={summary?.uncalled ?? 0} color={BLUE}
                active={bucket === 'uncalled'} onClick={() => setBucket(bucket === 'uncalled' ? '' : 'uncalled')}
                title="No call to this number exists in the call ledger"
              />
              <StatChip
                label="Cooling" value={summary?.cooling ?? 0} color={AMBER}
                active={bucket === 'cooling'} onClick={() => setBucket(bucket === 'cooling' ? '' : 'cooling')}
                title="Called within the last 7 days — resting before the next attempt"
              />
              <StatChip
                label="Exhausted" value={summary?.exhausted ?? 0} color={RED}
                active={bucket === 'exhausted'} onClick={() => setBucket(bucket === 'exhausted' ? '' : 'exhausted')}
                title="6+ attempts and never once answered — consider skipping these"
              />
            </div>

            {/* Search */}
            <TblSearch
              value={search}
              onChange={v => setSearch(v)}
              placeholder="Search name or phone…"
              width={0}
              style={{ marginBottom: SP[2] }}
            />

            {/* Priority chips */}
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap', marginBottom: 6 }}>
              {PRIORITY_OPTIONS.map(o => {
                const on = priority === o
                const color = o === 'High' ? RED : o === 'Medium' ? AMBER : 'var(--chart-lbl)'
                return (
                  <button key={o} onClick={() => setPriority(on ? 'All' : o)} style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS.full,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{o}</button>
                )
              })}
            </div>

            {/* Disposition chips */}
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap', marginBottom: 6 }}>
              {dispositionOptions.map(o => {
                const on = disposition === o.code
                return (
                  <button key={o.code} onClick={() => setDisposition(on ? 'All' : o.code)} style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS.full,
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? `${NAVY}12` : 'transparent',
                    color: on ? NAVY : 'var(--txt3)', cursor: 'pointer',
                  }}>{o.label}</button>
                )
              })}
            </div>

            {anyFilter && (
              <button
                onClick={() => { setPriority('All'); setDisposition('All'); setSearch('') }}
                style={{
                  fontSize: TEXT['2xs'], fontWeight: FW.medium, padding: '2px 9px', borderRadius: RADIUS.full,
                  border: '1px solid var(--bdr)', background: 'none',
                  color: 'var(--txt3)', cursor: 'pointer',
                }}
              >Clear filters</button>
            )}
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: SP[2],
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setSkipConfirm(true)} style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.sm, padding: '3px 9px', cursor: 'pointer' }}>Skip</button>
                <button onClick={handleExport} style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.sm, padding: '3px 9px', cursor: 'pointer' }}>Export</button>
                <button onClick={clearChecked} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {err && <div style={{ padding: '10px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* Contact list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No contacts match the current filters.
              </div>
            ) : (
              items.map(item => {
                const isSelected = selected?.id === item.id
                const isChecked = checkedIds.has(item.id)
                const pColor = priorityColor(item.priority)
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelected(item)}
                    style={{
                      display: 'flex', alignItems: 'stretch',
                      borderBottom: '1px solid var(--bdr)',
                      cursor: 'pointer',
                      background: isSelected ? `${NAVY}08` : undefined,
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    {/* Priority bar */}
                    <div style={{ width: 3, flexShrink: 0, background: pColor }} />

                    {/* Checkbox */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 8px', flexShrink: 0 }}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onClick={e => toggleCheck(item.id, e)}
                        onChange={() => {}}
                        style={{ marginTop: 2, cursor: 'pointer', accentColor: NAVY, flexShrink: 0 }}
                      />
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 2px' }}>
                      {/* Row 1+2: name + phone via NameCell, with disposition badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SP[1] }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <NameCell
                            name={item.customer_name || 'Unknown Lead'}
                            sub={`${item.phone}${item.cif ? ` · ${item.cif}` : ''}`}
                            avatar={false}
                          />
                        </div>
                        {item.last_disposition && (
                          <DispositionPill disp={item.last_disposition} code={item.disposition_code} size="sm" />
                        )}
                      </div>
                      {/* Row 3: collections context when real, else product + call-status */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {purposeF === '' && PURPOSE_META[item.purpose] && (
                          <span title={PURPOSE_META[item.purpose].label} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: PURPOSE_META[item.purpose].color }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{PURPOSE_META[item.purpose].icon}</span>
                          </span>
                        )}
                        {hasCollectionsContext(item) ? (
                          <>
                            <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                              {fmtKobo(item.outstanding_kobo)}
                            </span>
                            <DpdBadge dpd={item.dpd} />
                          </>
                        ) : item.purpose === 'marketing' ? (
                          <span title="Campaign list" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: item.ref ? `${BLUE}14` : 'var(--chip-bg)', color: item.ref ? BLUE : 'var(--txt3)' }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>format_list_bulleted</span>
                            {item.ref || 'Unlisted'}
                          </span>
                        ) : (
                          !isGenericProduct(item.product_name) && (
                            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                              {item.product_name}
                            </span>
                          )
                        )}
                        {/* Call history at a glance. An agent needs to know a number has
                            already swallowed 14 attempts BEFORE dialling it again. */}
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {item.attempts > 0 && (
                            <span
                              title={`${item.attempts} attempt${item.attempts === 1 ? '' : 's'}, ${item.connects} answered`}
                              style={{
                                ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold,
                                padding: '1px 6px', borderRadius: RADIUS.full,
                                background: item.is_exhausted ? `${RED}14` : 'var(--chip-bg)',
                                color: item.is_exhausted ? RED : 'var(--txt2)',
                              }}
                            >
                              {item.attempts}× · {item.connects} ans
                            </span>
                          )}
                          {item.callback_due ? (
                            <span title={`Callback agreed for ${fmtDatetime(item.callback_at!)}`} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', background: AMBER, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Callback due
                            </span>
                          ) : item.is_exhausted ? (
                            <span title="6+ attempts, never answered" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: RED, background: `${RED}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Exhausted
                            </span>
                          ) : item.is_cooling ? (
                            <span title={`Called ${fmtDate(item.last_called_at!)} — resting`} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: AMBER, background: `${AMBER}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Cooling
                            </span>
                          ) : item.last_called_at ? (
                            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>
                              {fmtDate(item.last_called_at)}
                            </span>
                          ) : (
                            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: BLUE, background: `${BLUE}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              New
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ── Right panel ────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selected ? (
            <DetailPanel key={selected.id} contact={selected} onAction={load} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>phone_in_talk</span>
              <span style={{ fontSize: TEXT.md }}>Select a contact to begin calling</span>
            </div>
          )}
        </div>

      </div>

      <ConfirmModal
        open={skipConfirm}
        title="Skip Selected Contacts"
        body={`Skip ${checkedIds.size} selected contact(s) from the queue?`}
        confirmLabel="Skip"
        loading={skipLoading}
        onConfirm={handleSkip}
        onClose={() => setSkipConfirm(false)}
      />

      <ImportContactsModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
      <AssignBatchModal open={assignOpen} defaultPurpose={purposeF || 'all'} available={summary}
        onClose={() => setAssignOpen(false)} onDone={load} />
    </Page>
  )
}

// ── Assign-a-batch modal (supervisor) ─────────────────────────────────────────
// Hand a chunk of the queue to one agent by count — 20/50/100 or a custom number,
// optionally scoped to a purpose. Assigns the still-pending, unassigned contacts.

function isHeadRole(): boolean {
  try { return /head|admin|super|manager|lead|supervisor/i.test(String(JSON.parse(localStorage.getItem('o3c_user') || '{}').role || '')) } catch { return false }
}

const ASSIGN_PRESETS = [20, 50, 100, 200]

function AssignBatchModal({ open, onClose, onDone, defaultPurpose, available }: {
  open: boolean; onClose: () => void; onDone: () => void
  defaultPurpose: string; available: QueueSummary | null
}) {
  const [agents, setAgents] = useState<{ id: number; full_name: string }[]>([])
  const [agentId, setAgentId] = useState('')
  const [count, setCount] = useState(50)
  const [purpose, setPurpose] = useState(defaultPurpose)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPurpose(defaultPurpose)
    apiFetch<any>('/api/call-center/agents')
      .then(r => setAgents(Array.isArray(r) ? r : (r?.data ?? [])))
      .catch(() => setAgents([]))
  }, [open, defaultPurpose])

  // Best-effort "available" count for the chosen purpose, from the queue summary.
  const availText = (() => {
    const s = available as any
    if (!s) return ''
    const per = s.by_purpose as Record<string, number> | undefined
    const n = purpose === 'all' ? (s.pending ?? s.total) : per?.[purpose]
    return n != null ? `${Number(n).toLocaleString()} pending available` : ''
  })()

  async function submit() {
    if (!agentId) { toast.error('Pick an agent'); return }
    if (!count || count < 1) { toast.error('Enter a count'); return }
    setSaving(true)
    try {
      const res = await apiPost<{ assigned: number }>('/api/call-center/queue/assign-batch', {
        agent_id: Number(agentId), count, purpose: purpose === 'all' ? '' : purpose,
      })
      const name = agents.find(a => a.id === Number(agentId))?.full_name ?? 'agent'
      toast.success(`Assigned ${res.assigned} contact(s) to ${name}`)
      onClose(); onDone()
    } catch (e: any) { toast.error(e?.message || 'Assign failed') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Assign queue to an agent" width={460}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Assign {count}
          </button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={fld}>
            <option value="">Select an agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>How many</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {ASSIGN_PRESETS.map(p => (
              <button key={p} onClick={() => setCount(p)} style={{
                padding: '7px 13px', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${count === p ? NAVY : 'var(--bdr)'}`, background: count === p ? `${NAVY}0e` : 'var(--card)', color: count === p ? NAVY : 'var(--txt2)',
              }}>{p}</button>
            ))}
            <input type="number" min={1} max={1000} value={count} onChange={e => setCount(Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
              style={{ ...fld, width: 90, height: 34 }} title="Custom count" />
          </div>
        </div>
        <div>
          <label style={lbl}>Purpose</label>
          <select value={purpose} onChange={e => setPurpose(e.target.value)} style={fld}>
            <option value="all">All purposes</option>
            <option value="marketing">Marketing</option>
            <option value="collections">Collections</option>
            <option value="support">Support</option>
          </select>
          {availText && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5 }}>{availText}</div>}
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          Assigns the highest-priority, oldest-queued pending contacts that aren’t already assigned.
        </div>
      </div>
    </Modal>
  )
}
