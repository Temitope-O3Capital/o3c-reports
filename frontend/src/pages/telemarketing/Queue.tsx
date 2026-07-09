import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ErrBanner, Spinner, ConfirmModal, TblSearch,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime, today } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, BLUE, PURPLE, NAVY, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TelemarketingContact {
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
}

interface CallEntry {
  id: number
  called_at: string
  duration_seconds: number
  disposition: string
  agent_name: string
  notes: string | null
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
      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>DPD {dpd}</span>
  )
}

const DISP_COLORS: Record<string, { bg: string; txt: string }> = {
  'Answered-Interested':     { bg: 'rgba(22,163,74,.12)',   txt: '#16A34A' },
  'Answered-Not Interested': { bg: 'rgba(192,0,0,.1)',      txt: '#C00000' },
  'PTP':                     { bg: 'rgba(37,99,235,.12)',   txt: '#2563EB' },
  'Callback':                { bg: 'rgba(217,119,6,.12)',   txt: '#D97706' },
}

function DispositionPill({ disp, size = 'md' }: { disp: string; size?: 'sm' | 'md' }) {
  const s = DISP_COLORS[disp] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 600,
      padding: size === 'sm' ? '1px 6px' : '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{disp}</span>
  )
}

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '8px 10px', borderRadius: 8, flex: 1,
      background: `${color}0f`, border: `1px solid ${color}28`,
    }}>
      <span style={{ ...NUM, fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10, color: 'var(--txt2)', marginTop: 3, fontWeight: 500, textAlign: 'center' }}>{label}</span>
    </div>
  )
}

function InfoField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--txt2)', marginBottom: 3, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{value ?? '—'}</div>
    </div>
  )
}

// ── Call History ──────────────────────────────────────────────────────────────

function CallHistoryTimeline({ contactId, refreshKey }: { contactId: number; refreshKey: number }) {
  const [calls, setCalls] = useState<CallEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: CallEntry[] }>(`/api/telemarketing/contacts/${contactId}/calls`)
      .then(r => setCalls(r.data ?? []))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false))
  }, [contactId, refreshKey])

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', color: 'var(--txt2)', fontSize: 13 }}>
      <Spinner size={14} color={NAVY} /> Loading call history…
    </div>
  )
  if (!calls.length) return (
    <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt3)', fontSize: 13 }}>
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
              padding: '10px 12px', borderRadius: 8,
              border: '1px solid var(--bdr)',
              background: i === 0 ? `${NAVY}06` : 'var(--th-bg)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <DispositionPill disp={c.disposition} size="sm" />
                <span style={{ fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>
                  {fmtDatetime(c.called_at)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--txt)', fontWeight: 600 }}>{c.agent_name}</span>
                <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>{fmtDuration(c.duration_seconds)}</span>
              </div>
              {c.notes && (
                <div style={{
                  fontSize: 11.5, color: 'var(--txt2)', marginTop: 6, lineHeight: 1.5,
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

const DISPOSITIONS = [
  'Answered-Interested', 'Answered-Not Interested',
  'No Answer', 'Wrong Number', 'PTP', 'Callback',
]

const DISP_BTN_COLORS: Record<string, string> = {
  'Answered-Interested': GREEN,
  'Answered-Not Interested': RED,
  'No Answer': 'var(--txt2)',
  'Wrong Number': PURPLE,
  'PTP': BLUE,
  'Callback': AMBER,
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

function LogCallForm({ contactId, onDone }: { contactId: number; onDone: () => void }) {
  const [disposition, setDisposition] = useState(DISPOSITIONS[0])
  const [notes, setNotes] = useState('')
  const [ptpDate, setPtpDate] = useState(today())
  const [ptpAmountNaira, setPtpAmountNaira] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isPtp = disposition === 'PTP'

  async function submit() {
    setSaving(true)
    setErr(null)
    try {
      const body: Record<string, unknown> = { disposition, notes }
      if (isPtp) {
        body.ptp_date = ptpDate
        body.ptp_amount_kobo = Math.round(parseFloat(ptpAmountNaira || '0') * 100)
      }
      await apiPost(`/api/telemarketing/contacts/${contactId}/log-call`, body)
      toast.success('Call logged')
      setNotes('')
      setDisposition(DISPOSITIONS[0])
      setPtpAmountNaira('')
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to log call')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ErrBanner error={err} />

      {/* Outcome buttons */}
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: 8 }}>
          Call Outcome <span style={{ color: RED }}>*</span>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {DISPOSITIONS.map(d => {
            const on = disposition === d
            const color = DISP_BTN_COLORS[d] ?? NAVY
            return (
              <button key={d} onClick={() => setDisposition(d)} style={{
                padding: '8px 10px', borderRadius: 7,
                fontSize: 11.5, fontWeight: 600, textAlign: 'center',
                border: `1.5px solid ${on ? color : 'var(--bdr)'}`,
                background: on ? `${color}15` : 'transparent',
                color: on ? color : 'var(--txt2)',
                cursor: 'pointer', transition: 'all .12s',
              }}>{d}</button>
            )
          })}
        </div>
      </div>

      {/* PTP fields */}
      {isPtp && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '12px', background: `${BLUE}08`, borderRadius: 8, border: `1px solid ${BLUE}20` }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>PTP Date</label>
            <input type="date" value={ptpDate} onChange={e => setPtpDate(e.target.value)} style={{ ...fieldStyle, height: 36 }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>PTP Amount ₦</label>
            <input type="number" value={ptpAmountNaira} onChange={e => setPtpAmountNaira(e.target.value)} placeholder="50000" style={{ ...fieldStyle, height: 36 }} />
          </div>
        </div>
      )}

      {/* Notes */}
      <div>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: 6 }}>Notes</label>
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
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          padding: '11px 0', background: saving ? `${NAVY}80` : NAVY,
          color: '#fff', border: 'none', borderRadius: 8,
          fontSize: 14, fontWeight: 700,
          cursor: saving ? 'not-allowed' : 'pointer', width: '100%',
        }}
      >
        {saving ? <Spinner size={14} color="#fff" /> : (
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>save</span>
        )}
        {saving ? 'Saving…' : 'Log Call'}
      </button>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

type DetailTab = 'log' | 'history' | 'info'

function DetailPanel({ contact, onAction }: { contact: TelemarketingContact; onAction: () => void }) {
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
            fontSize: 16, fontWeight: 800, letterSpacing: '-0.5px',
          }}>
            {contact.customer_name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>
                {contact.customer_name}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 99,
                background: `${pColor}18`, color: pColor,
              }}>{contact.priority}</span>
              <DpdBadge dpd={contact.dpd} />
              {contact.last_disposition && (
                <DispositionPill disp={contact.last_disposition} size="sm" />
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14, color: 'var(--txt)', fontFamily: INTER, fontWeight: 600, letterSpacing: '0.3px' }}>
                {contact.phone}
              </span>
              {contact.cif && (
                <button
                  onClick={() => navigate(`/contacts/${contact.cif}`)}
                  style={{ fontSize: 11.5, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
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
              borderRadius: 8, fontSize: 13, fontWeight: 700,
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
            <div style={{ flex: 1, paddingRight: 16, borderRight: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--txt2)', marginBottom: 3 }}>Outstanding</div>
              <div style={{ ...NUM, fontSize: 15, fontWeight: 800, color: 'var(--txt)' }}>
                {fmtKobo(contact.outstanding_kobo)}
              </div>
            </div>
            <div style={{ flex: 1, paddingLeft: 16, paddingRight: 16, borderRight: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 10.5, color: 'var(--txt2)', marginBottom: 3 }}>Next Payment</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
                {fmtDate(contact.next_payment_date) ?? '—'}
              </div>
            </div>
            {contact.loan_product && (
              <div style={{ flex: 1, paddingLeft: 16 }}>
                <div style={{ fontSize: 10.5, color: 'var(--txt2)', marginBottom: 3 }}>Product</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
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
              padding: '10px 12px', fontSize: 12.5,
              fontWeight: on ? 700 : 500,
              color: on ? NAVY : 'var(--txt2)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: on ? `2px solid ${NAVY}` : '2px solid transparent',
              marginBottom: -1,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{t.icon}</span>
              {t.label}
            </button>
          )
        })}
      </div>

      {/* ── Tab content ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {tab === 'log' && (
          <LogCallForm contactId={contact.id} onDone={afterLog} />
        )}

        {tab === 'history' && (
          <CallHistoryTimeline contactId={contact.id} refreshKey={historyKey} />
        )}

        {tab === 'info' && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 12 }}>
              Contact Details
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', marginBottom: 24 }}>
              <InfoField label="Full Name" value={contact.customer_name} />
              <InfoField label="Phone" value={<span style={{ fontFamily: INTER }}>{contact.phone}</span>} />
              <InfoField label="CIF" value={contact.cif} />
              <InfoField label="Product" value={contact.product_name} />
              <InfoField label="Last Called" value={contact.last_called_at ? fmtDatetime(contact.last_called_at) : null} />
              <InfoField label="Last Outcome" value={contact.last_disposition
                ? <DispositionPill disp={contact.last_disposition} size="sm" />
                : null}
              />
            </div>
            {contact.is_existing_customer && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 12 }}>
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
const DISPOSITION_OPTIONS = [
  'Answered-Interested', 'Answered-Not Interested',
  'No Answer', 'Wrong Number', 'PTP', 'Callback',
] as const
const DPD_OPTIONS = ['1-30', '31-60', '61-90', '90+'] as const

// ── Main component ────────────────────────────────────────────────────────────

export default function TelemarketingQueue() {
  const [items, setItems] = useState<TelemarketingContact[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<TelemarketingContact | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  const [priority, setPriority] = useState('All')
  const [disposition, setDisposition] = useState('All')
  const [dpd, setDpd] = useState('All')
  const [search, setSearch] = useState('')

  const [skipConfirm, setSkipConfirm] = useState(false)
  const [skipLoading, setSkipLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '200' })
    if (priority !== 'All') params.set('priority', priority)
    if (disposition !== 'All') params.set('disposition', disposition)
    if (dpd !== 'All') params.set('dpd', dpd)
    if (search) params.set('search', search)
    try {
      const res = await apiFetch<{ data: TelemarketingContact[] }>(`/api/telemarketing/queue?${params}`)
      setItems(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [priority, disposition, dpd, search])

  useEffect(() => { load() }, [load])

  // Derived stats
  const highCount = items.filter(i => i.priority === 'High').length
  const callbackCount = items.filter(i => i.last_disposition === 'Callback').length
  const anyFilter = priority !== 'All' || disposition !== 'All' || dpd !== 'All' || search !== ''

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
      await apiPost('/api/telemarketing/queue/bulk-skip', { ids: [...checkedIds] })
      toast.success(`${checkedIds.size} contact(s) skipped`)
      clearChecked()
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to skip')
    } finally {
      setSkipLoading(false)
      setSkipConfirm(false)
    }
  }

  async function handleExport() {
    try {
      await apiPost('/api/telemarketing/queue/export', { ids: [...checkedIds] })
      toast.success('Export queued')
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed')
    }
  }

  return (
    <Page title="Outbound Queue" subtitle="Telemarketing call queue" noPad>
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
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', marginBottom: 10 }}>
              Outbound Queue
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <StatChip label="Total" value={items.length} color={NAVY} />
              <StatChip label="High Priority" value={highCount} color={RED} />
              <StatChip label="Callbacks" value={callbackCount} color={AMBER} />
            </div>

            {/* Search */}
            <TblSearch
              value={search}
              onChange={v => setSearch(v)}
              placeholder="Search name or phone…"
              width={0}
              style={{ marginBottom: 8 }}
            />

            {/* Priority chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {PRIORITY_OPTIONS.map(o => {
                const on = priority === o
                const color = o === 'High' ? RED : o === 'Medium' ? AMBER : 'var(--chart-lbl)'
                return (
                  <button key={o} onClick={() => setPriority(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 99,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{o}</button>
                )
              })}
            </div>

            {/* Disposition chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {DISPOSITION_OPTIONS.map(o => {
                const on = disposition === o
                return (
                  <button key={o} onClick={() => setDisposition(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 99,
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? `${NAVY}12` : 'transparent',
                    color: on ? NAVY : 'var(--txt3)', cursor: 'pointer',
                  }}>{o}</button>
                )
              })}
            </div>

            {/* DPD chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {DPD_OPTIONS.map(o => {
                const on = dpd === o
                return (
                  <button key={o} onClick={() => setDpd(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 99,
                    border: `1px solid ${on ? BLUE : 'var(--bdr)'}`,
                    background: on ? `${BLUE}12` : 'transparent',
                    color: on ? BLUE : 'var(--txt3)', cursor: 'pointer',
                  }}>DPD {o}</button>
                )
              })}
              {anyFilter && (
                <button
                  onClick={() => { setPriority('All'); setDisposition('All'); setDpd('All'); setSearch('') }}
                  style={{
                    fontSize: 10.5, fontWeight: 500, padding: '2px 9px', borderRadius: 99,
                    border: '1px solid var(--bdr)', background: 'none',
                    color: 'var(--txt3)', cursor: 'pointer',
                  }}
                >Clear</button>
              )}
            </div>
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => toast.info('Reassign — coming soon')} style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}>Reassign</button>
                <button onClick={() => setSkipConfirm(true)} style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}>Skip</button>
                <button onClick={handleExport} style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}>Export</button>
                <button onClick={clearChecked} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {err && <div style={{ padding: '10px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* Contact list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: 13 }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: 13 }}>
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
                      {/* Row 1: name + last disposition */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {item.customer_name}
                        </span>
                        {item.last_disposition && (
                          <DispositionPill disp={item.last_disposition} size="sm" />
                        )}
                      </div>
                      {/* Row 2: phone + CIF */}
                      <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginBottom: 4, fontFamily: INTER }}>
                        {item.phone}{item.cif ? ` · ${item.cif}` : ''}
                      </div>
                      {/* Row 3: outstanding + DPD + last called */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                          {fmtKobo(item.outstanding_kobo)}
                        </span>
                        <DpdBadge dpd={item.dpd} />
                        {item.last_called_at && (
                          <span style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: INTER, marginLeft: 'auto' }}>
                            {fmtDate(item.last_called_at)}
                          </span>
                        )}
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
              <span style={{ fontSize: 14 }}>Select a contact to begin calling</span>
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
    </Page>
  )
}
