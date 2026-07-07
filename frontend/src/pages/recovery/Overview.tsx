import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryKPIs {
  total_in_recovery_kobo: number
  recovered_mtd_kobo: number
  success_rate_pct: number
  avg_days_in_recovery: number
}

interface MonthlyPoint {
  month: string
  amount_kobo: number
}

interface ChannelRow {
  channel: string
  amount_kobo: number
  pct: number
}

interface AgentRow {
  agent_name: string
  case_count: number
  recovered_kobo: number
  success_rate_pct: number
}

// ── Custom dark tooltip ───────────────────────────────────────────────────────

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{
          fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER,
          marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase',
        }}>
          {label}
        </div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>
            {fmtKobo(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Channel progress bars ─────────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = {
  TPA:        '#2563EB',
  'Field Visit': '#D97706',
  Legal:      '#C00000',
  'Self-Cure': '#16A34A',
}

function ChannelBars({ data }: { data: ChannelRow[] }) {
  if (!data.length) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>
        No channel data available
      </div>
    )
  }
  const maxKobo = Math.max(...data.map(d => d.amount_kobo), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' }}>
      {data.map(d => {
        const barPct = (d.amount_kobo / maxKobo) * 100
        const color = CHANNEL_COLORS[d.channel] ?? '#6B7280'
        return (
          <div key={d.channel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)', width: 90, flexShrink: 0 }}>
                {d.channel}
              </span>
              <div style={{ flex: 1, height: 6, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  width: `${barPct}%`, height: '100%',
                  background: color, borderRadius: 99, transition: 'width 0.4s',
                }} />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: 130, flexShrink: 0, justifyContent: 'flex-end' }}>
                <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>
                  {fmtKobo(d.amount_kobo)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>
                  {fmtPct(d.pct)}
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Agent performance table columns ──────────────────────────────────────────

const AGENT_COLS: TableCol<AgentRow>[] = [
  {
    key: 'agent_name',
    label: 'Agent',
    sortable: true,
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.agent_name || '—'}</span>,
  },
  {
    key: 'case_count',
    label: 'Cases Assigned',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontSize: 13 }}>{fmtNum(r.case_count)}</span>,
  },
  {
    key: 'recovered_kobo',
    label: 'Recovered ₦',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.recovered_kobo)}</span>,
  },
  {
    key: 'success_rate_pct',
    label: 'Success Rate %',
    sortable: true,
    align: 'right',
    render: r => {
      const col = r.success_rate_pct >= 60 ? '#16A34A' : r.success_rate_pct >= 30 ? '#D97706' : '#C00000'
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div style={{ width: 52, height: 4, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(r.success_rate_pct, 100)}%`, height: '100%', background: col, borderRadius: 99 }} />
          </div>
          <span style={{ ...NUM, fontSize: 12, fontWeight: 600, color: col, width: 36, textAlign: 'right' }}>
            {fmtPct(r.success_rate_pct)}
          </span>
        </div>
      )
    },
  },
]

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryOverview() {
  const [kpis, setKpis]           = useState<RecoveryKPIs | null>(null)
  const [trend, setTrend]         = useState<MonthlyPoint[]>([])
  const [channels, setChannels]   = useState<ChannelRow[]>([])
  const [agents, setAgents]       = useState<AgentRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [kpisRes, trendRes, channelRes, agentRes] = await Promise.all([
        apiFetch<{ data: RecoveryKPIs }>('/api/recovery/kpis'),
        apiFetch<{ data: MonthlyPoint[] }>('/api/recovery/monthly-trend'),
        apiFetch<{ data: ChannelRow[] }>('/api/recovery/by-channel'),
        apiFetch<{ data: AgentRow[] }>('/api/recovery/by-agent'),
      ])
      setKpis(kpisRes.data)
      setTrend(trendRes.data ?? [])
      setChannels(channelRes.data ?? [])
      setAgents(agentRes.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load recovery data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="Recovery Overview"
      subtitle="Recovery performance, channel analysis, and agent activity"
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard
          label="Total in Recovery"
          value={fmtKobo(kpis?.total_in_recovery_kobo)}
          sub="active recovery accounts"
          icon="gavel"
          loading={kpiLoading}
        />
        <KpiCard
          label="Recovered MTD"
          value={fmtKobo(kpis?.recovered_mtd_kobo)}
          sub="month to date"
          icon="payments"
          accent={GREEN}
          loading={kpiLoading}
        />
        <KpiCard
          label="Success Rate"
          value={fmtPct(kpis?.success_rate_pct)}
          sub="cases resolved"
          icon="check_circle"
          accent={GREEN}
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg Days in Recovery"
          value={kpis ? `${Math.round(kpis.avg_days_in_recovery)} days` : '—'}
          sub="average case age"
          icon="schedule"
          loading={kpiLoading}
        />
      </div>

      {/* Chart row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
        {/* Left: Area chart — monthly recovery trend */}
        <SectionCard title="Monthly Recovery Trend" subtitle="12-month recovery amounts" padding={false}>
          <div style={{ padding: '16px 18px' }}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="recoveryGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={GREEN} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  tickFormatter={v => fmtKobo(v)}
                  tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                  axisLine={false} tickLine={false}
                />
                <Tooltip content={(p: any) => <Tip {...p} />} />
                <Area
                  type="monotone"
                  dataKey="amount_kobo"
                  stroke={GREEN}
                  strokeWidth={2.2}
                  fill="url(#recoveryGrad)"
                  dot={{ r: 3, fill: '#16A34A', strokeWidth: 0 }}
                  activeDot={{ r: 5, fill: '#16A34A', stroke: '#fff', strokeWidth: 2 }}
                  name="Recovered"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        {/* Right: recovery by channel */}
        <SectionCard title="Recovery by Channel" subtitle="Amount recovered per channel" padding={false}>
          <div style={{ padding: '16px 18px' }}>
            <ChannelBars data={channels} />
          </div>
        </SectionCard>
      </div>

      {/* Agent performance table */}
      <SectionCard
        title="Agent Performance"
        badge={agents.length}
        subtitle="Sorted by recovered amount"
        padding={false}
      >
        <DataTable
          cols={AGENT_COLS}
          rows={agents}
          keyFn={(r, i) => r.agent_name ?? i}
          loading={loading}
          skeletonRows={8}
          emptyText="No agent data found"
        />
      </SectionCard>
    </Page>
  )
}
