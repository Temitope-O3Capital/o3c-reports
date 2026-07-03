import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, today, monthStart } from '../../lib/fmt'
import { NAVY, BLUE, PURPLE, GREEN, RED, AMBER, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallLog {
  id: number
  agent_name: string
  customer_name: string | null
  phone: string        // aliased from customer_phone in backend
  direction: string    // 'Inbound' | 'Outbound' (INITCAP'd by backend)
  duration_seconds: number
  outcome: string
  ticket_id: number | null
  ticket_ref: string | null
  called_at: string    // aliased from started_at in backend
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
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

  return (
    <Page title="Call Log" subtitle="All inbound and outbound calls">
      <ErrBanner error={error} onRetry={load} />

      <SectionCard padding={false} badge={rows.length}>
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
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={filterInputStyle} />
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={filterInputStyle} />
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
          onExport={() => exportCallsCsv(rows)}
        />
      </SectionCard>
    </Page>
  )
}
