import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter, Modal, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, today, monthStart } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, RED, AMBER, NUM, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallLog {
  id: number
  agent_name: string
  customer_name: string | null
  phone: string        // aliased from customer_phone in backend
  call_to: string | null
  direction: string    // 'Inbound' | 'Outbound' (INITCAP'd by backend)
  duration_seconds: number
  outcome: string
  ticket_id: number | null
  ticket_ref: string | null
  called_at: string    // aliased from started_at in backend
}

// ── Call script types ──────────────────────────────────────────────────────────

const TICKET_TYPES_CALL = [
  'General Enquiry', 'Balance Enquiry', 'Payment Confirmation', 'Card Dispute',
  'Statement Request', 'Loan Complaint', 'FD Enquiry', 'Technical / App Issue',
  'Complaint (CBN reportable)',
]

interface CallScriptStep { order: number; prompt: string; options?: string[] }
interface CallScript { id: number; ticket_type: string; name: string; steps: CallScriptStep[]; is_active: boolean }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number | null | undefined): string {
  if (s == null || s <= 0) return '—'
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// ── Direction pill ─────────────────────────────────────────────────────────────

function DirectionPill({ direction }: { direction: string }) {
  const isInbound = direction === 'Inbound'
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: isInbound ? `rgba(37,99,235,.12)` : `rgba(124,58,237,.12)`,
      color: isInbound ? BLUE : PURPLE,
      whiteSpace: 'nowrap',
    }}>
      {direction}
    </span>
  )
}

// ── Outcome pill ───────────────────────────────────────────────────────────────

const OUTCOME_COLORS: Record<string, { bg: string; txt: string }> = {
  completed:   { bg: 'rgba(22,163,74,.12)',   txt: GREEN },
  missed:      { bg: 'rgba(192,0,0,.10)',      txt: RED },
  transferred: { bg: 'rgba(217,119,6,.12)',   txt: AMBER },
  escalated:   { bg: 'rgba(192,0,0,.10)',      txt: RED },
}

function OutcomePill({ outcome }: { outcome: string }) {
  const key = outcome.toLowerCase()
  const s = OUTCOME_COLORS[key] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = outcome.charAt(0).toUpperCase() + outcome.slice(1)
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

// ── Table columns ──────────────────────────────────────────────────────────────

function buildCols(navigate: ReturnType<typeof useNavigate>): TableCol<CallLog>[] {
  return [
    {
      key: 'agent_name',
      label: 'Agent',
      render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.agent_name}</span>,
    },
    {
      key: 'customer_name',
      label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name ?? '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER, marginTop: 1 }}>{r.phone}</div>
        </div>
      ),
    },
    {
      key: 'call_to',
      label: 'To',
      render: r => <span style={{ fontSize: 13, color: 'var(--txt2)' }}>{r.call_to ?? '—'}</span>,
    },
    {
      key: 'direction',
      label: 'Direction',
      render: r => <DirectionPill direction={r.direction} />,
    },
    {
      key: 'duration_seconds',
      label: 'Duration',
      align: 'right',
      render: r => <span style={{ ...NUM, fontSize: 12.5, color: 'var(--txt)' }}>{fmtDuration(r.duration_seconds)}</span>,
    },
    {
      key: 'outcome',
      label: 'Outcome',
      render: r => <OutcomePill outcome={r.outcome} />,
    },
    {
      key: 'ticket_id',
      label: 'Ticket #',
      render: r => r.ticket_id && r.ticket_ref ? (
        <span
          onClick={e => { e.stopPropagation(); navigate(`/helpdesk/${r.ticket_id}`) }}
          style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {r.ticket_ref}
        </span>
      ) : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'called_at',
      label: 'Date',
      sortable: true,
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(r.called_at)}</span>,
    },
  ]
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Calls() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<CallLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [agentFilter, setAgentFilter] = useState('')
  const [outcome, setOutcome] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  // Log Call modal state
  const [logOpen, setLogOpen] = useState(false)
  const [logForm, setLogForm] = useState({ customer_name: '', phone: '', direction: 'Inbound', outcome_val: 'completed', ticket_type: '', notes: '' })
  const [logSaving, setLogSaving] = useState(false)
  const [callScript, setCallScript] = useState<CallScript | null>(null)
  const [scriptExpanded, setScriptExpanded] = useState(false)

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback(() => {
    const p = new URLSearchParams()
    if (agentFilter) p.set('agent', agentFilter)
    if (outcome) p.set('outcome', outcome)
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    p.set('limit', '100')
    return p.toString()
  }, [agentFilter, outcome, dateFrom, dateTo])

  const load = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CallLog[]>(`/api/helpdesk/calls?${buildQS()}`, { signal: abortRef.current.signal })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load() }, [load])

  // Fetch call script when ticket type selected in Log Call modal
  useEffect(() => {
    if (!logOpen || !logForm.ticket_type) { setCallScript(null); return }
    apiFetch<CallScript | null>(`/api/helpdesk/call-scripts/by-type?ticket_type=${encodeURIComponent(logForm.ticket_type)}`)
      .then(r => { setCallScript(r && (r as any).id ? r : null); setScriptExpanded(true) })
      .catch(() => setCallScript(null))
  }, [logOpen, logForm.ticket_type])

  async function handleLogCall() {
    if (!logForm.phone.trim()) { toast.error('Phone number is required'); return }
    setLogSaving(true)
    try {
      await apiPost('/api/helpdesk/calls', {
        customer_name: logForm.customer_name || undefined,
        customer_phone: logForm.phone,
        direction: logForm.direction,
        outcome: logForm.outcome_val,
        ticket_type: logForm.ticket_type || undefined,
        notes: logForm.notes || undefined,
      })
      toast.success('Call logged')
      setLogOpen(false)
      setLogForm({ customer_name: '', phone: '', direction: 'Inbound', outcome_val: 'completed', ticket_type: '', notes: '' })
      setCallScript(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to log call')
    } finally {
      setLogSaving(false)
    }
  }

  function exportCallsCsv(data: CallLog[]) {
    const header = ['Agent', 'Customer', 'Phone', 'Direction', 'Duration (s)', 'Outcome', 'Ticket', 'Called At']
    const lines = data.map(r => [
      `"${String(r.agent_name ?? '').replace(/"/g, '""')}"`,
      `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.phone ?? '',
      r.direction ?? '',
      r.duration_seconds ?? 0,
      r.outcome ?? '',
      r.ticket_ref ?? '',
      r.called_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `call-log-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols = buildCols(navigate)

  const logInputStyle: React.CSSProperties = {
    width: '100%', height: 36, padding: '0 10px',
    border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box', fontFamily: SORA,
  }

  return (
    <Page title="Call Log" subtitle="All inbound and outbound calls"
      actions={
        <button onClick={() => setLogOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 15px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: SORA }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add_call</span>
          Log Call
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard padding={false} badge={rows.length} actions={<button onClick={() => exportCallsCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setAgentFilter(''); setOutcome(''); setDateFrom(monthStart()); setDateTo(today()) }}>
            <input
              placeholder="Agent name…"
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              style={{ ...filterInputStyle, minWidth: 160 }}
            />
            <select value={outcome} onChange={e => setOutcome(e.target.value)} style={filterInputStyle}>
              <option value="">All Outcomes</option>
              <option value="completed">Completed</option>
              <option value="missed">Missed</option>
              <option value="transferred">Transferred</option>
              <option value="escalated">Escalated</option>
            </select>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
            <button
              onClick={() => load()}
              style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Apply
            </button>
          </FilterBar>
        </div>
        <DataTable<CallLog>
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No call records found"
          searchKeys={['agent_name', 'customer_name', 'outcome', 'direction']}
          searchPlaceholder="Search agent, customer, outcome…"
          pageSize={20}

        />
      </SectionCard>

      {/* Log Call modal */}
      <Modal
        open={logOpen}
        onClose={() => { setLogOpen(false); setCallScript(null) }}
        title="Log Call"
        width={480}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setLogOpen(false); setCallScript(null) }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleLogCall} disabled={logSaving}
              style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: logSaving ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: logSaving ? 0.7 : 1 }}>
              {logSaving && <Spinner size={13} color="#fff" />}
              Log Call
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontFamily: SORA }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Customer Name</label>
              <input value={logForm.customer_name} onChange={e => setLogForm(f => ({ ...f, customer_name: e.target.value }))}
                placeholder="Full name" style={logInputStyle} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Phone Number *</label>
              <input value={logForm.phone} onChange={e => setLogForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="e.g. 08012345678" style={logInputStyle} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Direction</label>
              <select value={logForm.direction} onChange={e => setLogForm(f => ({ ...f, direction: e.target.value }))}
                style={{ ...logInputStyle }}>
                <option value="Inbound">Inbound</option>
                <option value="Outbound">Outbound</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Outcome</label>
              <select value={logForm.outcome_val} onChange={e => setLogForm(f => ({ ...f, outcome_val: e.target.value }))}
                style={{ ...logInputStyle }}>
                <option value="completed">Completed</option>
                <option value="missed">Missed</option>
                <option value="transferred">Transferred</option>
                <option value="escalated">Escalated</option>
              </select>
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Ticket Type</label>
            <select value={logForm.ticket_type} onChange={e => setLogForm(f => ({ ...f, ticket_type: e.target.value }))}
              style={{ ...logInputStyle }}>
              <option value="">— None —</option>
              {TICKET_TYPES_CALL.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5 }}>Notes</label>
            <textarea value={logForm.notes} onChange={e => setLogForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Call notes…"
              style={{ ...logInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }} />
          </div>

          {/* Call script panel */}
          {callScript && (
            <div style={{ border: `1px solid ${NAVY}25`, borderRadius: 8, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setScriptExpanded(x => !x)}
                style={{ width: '100%', padding: '9px 14px', background: `${NAVY}08`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: SORA }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600, color: NAVY, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>assignment</span>
                  Call Script: {callScript.name}
                </span>
                <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{scriptExpanded ? '▲ Collapse' : '▼ Expand'}</span>
              </button>
              {scriptExpanded && (
                <div style={{ padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {callScript.steps.sort((a, b) => a.order - b.order).map(step => (
                    <div key={step.order} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <div style={{ flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: NAVY, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                        {step.order}
                      </div>
                      <div>
                        <div style={{ fontSize: 13, color: 'var(--txt)', lineHeight: 1.5 }}>{step.prompt}</div>
                        {step.options && step.options.length > 0 && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                            {step.options.map((opt, i) => (
                              <span key={i} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>{opt}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </Page>
  )
}
