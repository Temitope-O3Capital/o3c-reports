import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, ErrBanner, Spinner, ConfirmModal, TblSearch, filterInputStyle,
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

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpdBg(dpd)
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontWeight: 700,
      padding: '2px 7px', borderRadius: 20,
      background: `${color}18`, color,
      whiteSpace: 'nowrap',
    }}>
      DPD {dpd}
    </span>
  )
}

function PriorityDot({ priority }: { priority: 'High' | 'Medium' | 'Low' }) {
  const bg = priority === 'High' ? RED : priority === 'Medium' ? AMBER : 'var(--chart-lbl)'
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: bg, marginRight: 6, flexShrink: 0,
    }} />
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
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: 600,
      padding: size === 'sm' ? '1px 6px' : '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt,
      whiteSpace: 'nowrap',
    }}>
      {disp}
    </span>
  )
}

// ── Field style ───────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

// ── Label / value ─────────────────────────────────────────────────────────────

function LV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--txt2)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>{value ?? '—'}</span>
    </div>
  )
}

// ── Call History ──────────────────────────────────────────────────────────────

function CallHistory({ contactId }: { contactId: number }) {
  const [calls, setCalls] = useState<CallEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: CallEntry[] }>(`/api/telemarketing/contacts/${contactId}/calls`)
      .then(r => setCalls(r.data ?? []))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false))
  }, [contactId, refresh])

  // Expose a way for LogCallForm to trigger a refresh
  ;(CallHistory as any)._refreshFor = (id: number) => {
    if (id === contactId) setRefresh(v => v + 1)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', color: 'var(--txt2)', fontSize: 13 }}>
        <Spinner size={14} color={NAVY} /> Loading…
      </div>
    )
  }
  if (!calls.length) {
    return <div style={{ fontSize: 13, color: 'var(--txt3)', padding: '6px 0' }}>No calls logged yet</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {calls.map(c => (
        <div key={c.id} style={{
          padding: '9px 11px', borderRadius: 8,
          border: '1px solid var(--bdr)', background: 'var(--th-bg)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
            <DispositionPill disp={c.disposition} size="sm" />
            <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>{fmtDatetime(c.called_at)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--txt)', fontWeight: 500 }}>{c.agent_name}</span>
            <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>{fmtDuration(c.duration_seconds)}</span>
          </div>
          {c.notes && (
            <div
              title={c.notes}
              style={{ fontSize: 11.5, color: 'var(--txt2)', marginTop: 4, lineHeight: 1.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {c.notes.slice(0, 60)}{c.notes.length > 60 ? '…' : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Log Call form ─────────────────────────────────────────────────────────────

const DISPOSITIONS = [
  'Answered-Interested',
  'Answered-Not Interested',
  'No Answer',
  'Wrong Number',
  'PTP',
  'Callback',
]

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
      toast.success('Call logged successfully')
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <ErrBanner error={err} />
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Disposition <span style={{ color: RED }}>*</span>
        </label>
        <select
          value={disposition}
          onChange={e => setDisposition(e.target.value)}
          style={{ ...filterInputStyle, height: 36, width: '100%' }}
        >
          {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      {isPtp && (
        <>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              PTP Date
            </label>
            <input
              type="date"
              value={ptpDate}
              onChange={e => setPtpDate(e.target.value)}
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              PTP Amount ₦
            </label>
            <input
              type="number"
              value={ptpAmountNaira}
              onChange={e => setPtpAmountNaira(e.target.value)}
              placeholder="e.g. 50000"
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
        </>
      )}
      <div>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
          Notes
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={4}
          placeholder="Add call notes…"
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </div>
      <button
        onClick={submit}
        disabled={saving || !disposition}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '7px 15px', background: saving ? `${NAVY}99` : NAVY, color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600,
          cursor: saving || !disposition ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
          opacity: saving || !disposition ? 0.7 : 1,
        }}
      >
        {saving && <Spinner size={13} color="#fff" />}
        Log Call
      </button>
    </div>
  )
}

// ── Detail Panel ──────────────────────────────────────────────────────────────

function DetailPanel({
  contact,
  onAction,
}: {
  contact: TelemarketingContact
  onAction: () => void
}) {
  const [callHistoryKey, setCallHistoryKey] = useState(0)

  function refreshCalls() {
    setCallHistoryKey(k => k + 1)
    onAction()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Customer strip */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--bdr)',
        background: 'var(--th-bg)',
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--txt)', marginBottom: 2 }}>
          {contact.customer_name}
        </div>
        <div style={{ fontSize: 13, color: 'var(--txt)', marginBottom: 2 }}>
          {contact.phone}
        </div>
        {contact.cif && (
          <div style={{ fontSize: 11.5, color: 'var(--txt2)' }}>CIF: {contact.cif}</div>
        )}
        {contact.product_name && (
          <div style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{contact.product_name}</div>
        )}
      </div>

      {/* Relationship summary — only for existing customers */}
      {contact.is_existing_customer && (
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>
            Relationship
          </div>
          <LV label="Loan Outstanding" value={<span style={NUM}>{fmtKobo(contact.outstanding_kobo)}</span>} />
          <LV label="DPD" value={<DpdBadge dpd={contact.dpd} />} />
          <LV label="Next Payment" value={fmtDate(contact.next_payment_date)} />
          <LV label="Loan Product" value={contact.loan_product} />
        </div>
      )}

      {/* Call history */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Recent Calls
          </span>
          <span style={{ fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>last 5</span>
        </div>
        <CallHistory key={callHistoryKey} contactId={contact.id} />
      </div>

      {/* Log call form */}
      <div style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
          Log Call
        </div>
        <LogCallForm contactId={contact.id} onDone={refreshCalls} />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS = ['All', 'High', 'Medium', 'Low']
const DISPOSITION_OPTIONS = [
  'All',
  'Answered-Interested',
  'Answered-Not Interested',
  'No Answer',
  'Wrong Number',
  'PTP',
  'Callback',
]
const DPD_OPTIONS = ['All', '1-30', '31-60', '61-90', '90+']

export default function TelemarketingQueue() {
  const navigate = useNavigate()
  const [items, setItems] = useState<TelemarketingContact[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<TelemarketingContact | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  // Filters
  const [priority, setPriority] = useState('All')
  const [disposition, setDisposition] = useState('All')
  const [dpd, setDpd] = useState('All')
  const [agent, setAgent] = useState('')

  // Confirm modals
  const [skipConfirm, setSkipConfirm] = useState(false)
  const [skipLoading, setSkipLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '200' })
    if (priority !== 'All') params.set('priority', priority)
    if (disposition !== 'All') params.set('disposition', disposition)
    if (dpd !== 'All') params.set('dpd', dpd)
    if (agent) params.set('agent', agent)
    try {
      const res = await apiFetch<{ data: TelemarketingContact[] }>(`/api/telemarketing/queue?${params}`)
      setItems(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [priority, disposition, dpd, agent])

  useEffect(() => { load() }, [load])

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
      const ids = [...checkedIds]
      await apiPost('/api/telemarketing/queue/bulk-skip', { ids })
      toast.success(`${ids.length} contact(s) skipped`)
      clearChecked()
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to skip contacts')
    } finally {
      setSkipLoading(false)
      setSkipConfirm(false)
    }
  }

  async function handleExport() {
    const ids = [...checkedIds]
    try {
      await apiPost('/api/telemarketing/queue/export', { ids })
      toast.success('Export queued')
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed')
    }
  }

  return (
    <Page title="Outbound Queue" subtitle="Telemarketing call queue" noPad>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ─────────────────────────────────────────────────────── */}
        <div style={{
          width: 360, minWidth: 320, maxWidth: 380,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)',
          flexShrink: 0,
        }}>
          {/* Title row */}
          <div style={{
            padding: '14px 14px 10px',
            borderBottom: '1px solid var(--bdr)',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--txt)' }}>Outbound Queue</span>
              <span style={{
                ...NUM, fontSize: 11, fontWeight: 600,
                background: 'var(--chip-bg)', color: 'var(--chip-txt)',
                padding: '1px 7px', borderRadius: 20,
              }}>
                {items.length}
              </span>
            </div>

            {/* Search */}
            <TblSearch value={agent} onChange={v => { setAgent(v); setDisposition('All') }}
              placeholder="Search agent name…" width={0} style={{ marginBottom: 8 }} />

            {/* Priority chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {PRIORITY_OPTIONS.filter(o => o !== 'All').map(o => {
                const on = priority === o
                const color = o === 'High' ? RED : o === 'Medium' ? AMBER : 'var(--chart-lbl)'
                return (
                  <button key={o} onClick={() => setPriority(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{o}</button>
                )
              })}
            </div>

            {/* Disposition chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
              {DISPOSITION_OPTIONS.filter(o => o !== 'All').map(o => {
                const on = disposition === o
                return (
                  <button key={o} onClick={() => setDisposition(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? `${NAVY}12` : 'transparent',
                    color: on ? NAVY : 'var(--txt3)', cursor: 'pointer',
                  }}>{o}</button>
                )
              })}
            </div>

            {/* DPD chips */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {DPD_OPTIONS.filter(o => o !== 'All').map(o => {
                const on = dpd === o
                return (
                  <button key={o} onClick={() => setDpd(on ? 'All' : o)} style={{
                    fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${on ? BLUE : 'var(--bdr)'}`,
                    background: on ? `${BLUE}12` : 'transparent',
                    color: on ? BLUE : 'var(--txt3)', cursor: 'pointer',
                  }}>DPD {o}</button>
                )
              })}
              {(priority !== 'All' || disposition !== 'All' || dpd !== 'All' || agent) && (
                <button onClick={() => { setPriority('All'); setDisposition('All'); setDpd('All'); setAgent('') }} style={{
                  fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 99,
                  border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer',
                }}>Clear</button>
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
              <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>
                {checkedIds.size} selected
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  onClick={() => toast.info('Reassign coming soon')}
                  style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}
                >
                  Reassign
                </button>
                <button
                  onClick={() => setSkipConfirm(true)}
                  style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}
                >
                  Skip
                </button>
                <button
                  onClick={handleExport}
                  style={{ fontSize: 11.5, fontWeight: 500, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: 6, padding: '3px 9px', cursor: 'pointer' }}
                >
                  Export
                </button>
                <button
                  onClick={clearChecked}
                  style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%' }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {err && (
            <div style={{ padding: '10px 14px' }}>
              <ErrBanner error={err} onRetry={load} />
            </div>
          )}

          {/* List */}
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
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelected(item)}
                    style={{
                      padding: '11px 14px',
                      borderBottom: '1px solid var(--bdr)',
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(14,40,65,0.06)' : undefined,
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                    }}
                    onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={e => toggleCheck(item.id, e)}
                      onChange={() => {}}
                      style={{ marginTop: 3, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Line 1: name + priority dot */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                        <PriorityDot priority={item.priority} />
                        <span
                          onClick={item.cif ? (e) => { e.stopPropagation(); navigate(`/contacts/${item.cif}`) } : undefined}
                          style={{ fontSize: 13, fontWeight: 600, color: item.cif ? NAVY : 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, cursor: item.cif ? 'pointer' : undefined, textDecoration: item.cif ? 'underline' : undefined }}
                        >
                          {item.customer_name}
                        </span>
                      </div>
                      {/* Line 2: phone + CIF */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 12, color: 'var(--txt)' }}>{item.phone}</span>
                        {item.cif && (
                          <span style={{ fontSize: 11, color: 'var(--txt2)' }}>· {item.cif}</span>
                        )}
                      </div>
                      {/* Line 3: outstanding + DPD badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                          {fmtKobo(item.outstanding_kobo)}
                        </span>
                        <DpdBadge dpd={item.dpd} />
                      </div>
                      {/* Right meta: disposition + last called */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {item.last_disposition && (
                          <DispositionPill disp={item.last_disposition} size="sm" />
                        )}
                        {item.last_called_at && (
                          <span style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: INTER }}>
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

        {/* ── Right panel ────────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel
              key={selected.id}
              contact={selected}
              onAction={load}
            />
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 12, color: 'var(--txt2)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>
                phone
              </span>
              <span style={{ fontSize: 14 }}>Select a contact from the queue</span>
            </div>
          )}
        </div>

      </div>

      {/* Skip confirm modal */}
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
