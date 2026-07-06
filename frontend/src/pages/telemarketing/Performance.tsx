import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'
import {
  Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, DateFilter,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PerfKPIs {
  total_calls: number
  connected: number
  ptp_count: number
  conversion_rate_pct: number
}

interface DispositionCount {
  disposition: string
  count: number
}

interface HourlyCount {
  hour: string
  count: number
}

interface AgentPerf {
  agent_name: string
  calls: number
  connected: number
  ptp_count: number
  conversion_pct: number
  avg_handle_seconds: number
}

// ── Duration helper ───────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function Tip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{
          fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER,
          marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>
            {p.value}
          </span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Chart card ────────────────────────────────────────────────────────────────

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      borderRadius: 14, boxShadow: 'var(--card-shadow)', padding: '18px 20px',
    }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 2, fontFamily: INTER }}>{sub}</div>
      </div>
      {children}
    </div>
  )
}

// ── Disposition colors ────────────────────────────────────────────────────────

const DISP_FILL: Record<string, string> = {
  'Answered-Interested':     '#16A34A',
  'Answered-Not Interested': '#C00000',
  'No Answer':               '#D97706',
  'PTP':                     '#2563EB',
  'Callback':                '#7C3AED',
  'Wrong Number':            '#9CA3AF',
}

function dispositionFill(d: string): string {
  return DISP_FILL[d] ?? '#9CA3AF'
}

// ── Agent table columns ───────────────────────────────────────────────────────

const AGENT_COLS: TableCol<AgentPerf>[] = [
  {
    key: 'agent_name',
    label: 'Agent',
    sortable: true,
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.agent_name || '—'}</span>,
  },
  {
    key: 'calls',
    label: 'Calls',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontSize: 13 }}>{fmtNum(r.calls)}</span>,
  },
  {
    key: 'connected',
    label: 'Connected %',
    sortable: true,
    align: 'right',
    render: r => {
      const pct = r.calls > 0 ? (r.connected / r.calls) * 100 : 0
      return (
        <span style={{ ...NUM, fontSize: 13 }}>{pct.toFixed(1)}%</span>
      )
    },
  },
  {
    key: 'ptp_count',
    label: 'PTPs',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontSize: 13 }}>{r.ptp_count}</span>,
  },
  {
    key: 'conversion_pct',
    label: 'Conversion %',
    sortable: true,
    align: 'right',
    render: r => {
      const col = r.conversion_pct >= 10 ? GREEN : r.conversion_pct >= 5 ? AMBER : RED
      return <span style={{ ...NUM, fontSize: 13, fontWeight: 600, color: col }}>{r.conversion_pct.toFixed(1)}%</span>
    },
  },
  {
    key: 'avg_handle_seconds',
    label: 'Avg Handle Time',
    sortable: true,
    align: 'right',
    render: r => (
      <span style={{ ...NUM, fontSize: 12.5, color: 'var(--txt2)' }}>{fmtDuration(r.avg_handle_seconds)}</span>
    ),
  },
]

// ── Main component ────────────────────────────────────────────────────────────

export default function TelemarketingPerformance() {
  const [kpis, setKpis] = useState<PerfKPIs | null>(null)
  const [byDisposition, setByDisposition] = useState<DispositionCount[]>([])
  const [hourly, setHourly] = useState<HourlyCount[]>([])
  const [agents, setAgents] = useState<AgentPerf[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Filters
  const [agent, setAgent] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const baseParams = new URLSearchParams()
    if (agent.trim()) baseParams.set('agent', agent.trim())
    if (dateFrom) baseParams.set('date_from', dateFrom)
    if (dateTo) baseParams.set('date_to', dateTo)

    const dispParams = new URLSearchParams()
    if (dateFrom) dispParams.set('date_from', dateFrom)
    if (dateTo) dispParams.set('date_to', dateTo)

    try {
      const [kpisRes, dispRes, hourlyRes, agentRes] = await Promise.all([
        apiFetch<{ data: PerfKPIs }>(`/api/telemarketing/performance-kpis?${baseParams}`),
        apiFetch<{ data: DispositionCount[] }>(`/api/telemarketing/by-disposition?${dispParams}`),
        apiFetch<{ data: HourlyCount[] }>(`/api/telemarketing/hourly-volume?date=${today()}`),
        apiFetch<{ data: AgentPerf[] }>(`/api/telemarketing/agent-performance?${baseParams}`),
      ])
      setKpis(kpisRes.data)
      setByDisposition(dispRes.data ?? [])
      setHourly(hourlyRes.data ?? [])
      setAgents(agentRes.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load performance data')
    } finally {
      setLoading(false)
    }
  }, [agent, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const kpiLoading = loading && !kpis

  function exportAgentPerfCsv(data: AgentPerf[]) {
    const header = ['Agent', 'Calls', 'Connected', 'PTPs', 'Conversion %', 'Avg Handle (s)']
    const lines = data.map(r => [
      `"${String(r.agent_name ?? '').replace(/"/g, '""')}"`,
      r.calls ?? 0,
      r.connected ?? 0,
      r.ptp_count ?? 0,
      r.conversion_pct != null ? r.conversion_pct.toFixed(1) : '',
      r.avg_handle_seconds ?? 0,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `agent-performance-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Telemarketing Performance"
      subtitle="Agent performance, call volumes, and conversion analytics"
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Filters */}
      <FilterBar onReset={() => { setAgent(''); setDateFrom(monthStart()); setDateTo(today()) }}>
        <input
          placeholder="Agent name…"
          value={agent}
          onChange={e => setAgent(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
          style={{ ...filterInputStyle, minWidth: 180 }}
        />
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
        <button
          onClick={() => load()}
          style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
        >
          Apply
        </button>
      </FilterBar>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard
          label="Total Calls"
          value={kpis ? fmtNum(kpis.total_calls) : '—'}
          icon="call"
          loading={kpiLoading}
        />
        <KpiCard
          label="Connected"
          value={kpis ? fmtNum(kpis.connected) : '—'}
          sub="answered calls"
          icon="call_received"
          accent={GREEN}
          loading={kpiLoading}
        />
        <KpiCard
          label="PTP Count"
          value={kpis ? fmtNum(kpis.ptp_count) : '—'}
          sub="promises to pay"
          icon="handshake"
          accent={BLUE}
          loading={kpiLoading}
        />
        <KpiCard
          label="Conversion Rate"
          value={kpis ? `${kpis.conversion_rate_pct.toFixed(1)}%` : '—'}
          sub="calls to conversion"
          icon="trending_up"
          accent={GREEN}
          loading={kpiLoading}
        />
      </div>

      {/* Chart row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
        {/* Calls by disposition */}
        <ChartCard title="Calls by Disposition" sub="All agents, selected date range">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={byDisposition}
              margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
              barCategoryGap="30%"
            >
              <CartesianGrid stroke="#E8EBF2" strokeDasharray="0" vertical={false} strokeWidth={1} />
              <XAxis
                dataKey="disposition"
                tick={{ fontSize: 8.5, fill: '#9AA4B8', fontFamily: INTER }}
                axisLine={false}
                tickLine={false}
                interval={0}
                textAnchor="middle"
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={(p: any) => <Tip {...p} />} />
              <Bar dataKey="count" radius={[5, 5, 0, 0]} name="Calls">
                {byDisposition.map((entry, i) => (
                  <Cell key={i} fill={dispositionFill(entry.disposition)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {byDisposition.map(d => (
              <div key={d.disposition} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: dispositionFill(d.disposition), flexShrink: 0 }} />
                {d.disposition}
              </div>
            ))}
          </div>
        </ChartCard>

        {/* Hourly call volume today */}
        <ChartCard title="Hourly Volume Today" sub={`Call activity on ${fmtDate(today())}`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={hourly}
              margin={{ top: 4, right: 8, bottom: 0, left: -18 }}
              barCategoryGap="20%"
            >
              <CartesianGrid stroke="#E8EBF2" strokeDasharray="0" vertical={false} strokeWidth={1} />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 9.5, fill: '#9AA4B8', fontFamily: INTER }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={(p: any) => <Tip {...p} />} />
              <Bar dataKey="count" fill={NAVY} radius={[5, 5, 0, 0]} name="Calls" />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Agent performance table */}
      <SectionCard
        title="Agent Performance"
        badge={agents.length}
        subtitle="Sorted by calls — conversion % colour: ≥10% green · 5–9% amber · <5% red"
        padding={false}
        actions={<button onClick={() => exportAgentPerfCsv(agents)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}
      >
        <DataTable
          cols={AGENT_COLS}
          rows={agents}
          keyFn={(r, i) => r.agent_name ?? i}
          loading={loading}
          skeletonRows={8}
          emptyText="No agent data found"
          searchKeys={['agent_name']}
          searchPlaceholder="Search agents…"
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
