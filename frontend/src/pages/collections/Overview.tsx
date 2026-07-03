import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortfolioKPIs {
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
  total_outstanding_kobo: number
  total_accounts: number
  delinquent_accounts: number
  current_rate_pct: number
}

interface DPDTrendPoint {
  month: string
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
}

interface AgentRow {
  Agent: string
  total: number
  count: number
}

interface RollBucket {
  dpd_bucket: string
  account_count: number
  outstanding_kobo: number
}

// ── DPD colour ────────────────────────────────────────────────────────────────

function dpdColor(bucket: string): string {
  switch (bucket) {
    case '0':       return GREEN
    case '1-30':    return AMBER
    case '31-60':
    case '61-90':   return RED
    default:        return '#7F0000'
  }
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function KoboTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      borderRadius: 8, padding: '10px 14px', fontSize: 12,
    }}>
      <div style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: 600 }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Agent table columns ───────────────────────────────────────────────────────

const AGENT_COLS: TableCol<AgentRow>[] = [
  { key: 'Agent', label: 'Agent', sortable: true },
  {
    key: 'total', label: 'Collected', sortable: true, align: 'right',
    render: r => <span style={NUM}>{fmtKobo(r.total)}</span>,
  },
  {
    key: 'count', label: 'Transactions', sortable: true, align: 'right',
    render: r => <span style={NUM}>{fmtNum(r.count)}</span>,
  },
]

// ── DPD bucket bar chart ──────────────────────────────────────────────────────

function RollBars({ data }: { data: RollBucket[] }) {
  if (!data.length) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>
      No DPD data available
    </div>
  )
  const maxKobo = Math.max(...data.map(d => Number(d.outstanding_kobo)), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
      {data.map(d => {
        const pct = (Number(d.outstanding_kobo) / maxKobo) * 100
        const color = dpdColor(d.dpd_bucket)
        return (
          <div key={d.dpd_bucket}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color }}>DPD {d.dpd_bucket}</span>
              <span style={{ ...NUM, fontSize: 12, color: 'var(--txt)' }}>
                {fmtKobo(d.outstanding_kobo)}
                <span style={{ color: 'var(--txt2)', marginLeft: 6 }}>({fmtNum(d.account_count)} accts)</span>
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--bdr)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${pct}%`,
                background: color, borderRadius: 3, transition: 'width 0.4s',
              }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionsOverview() {
  const [kpis, setKpis]         = useState<PortfolioKPIs | null>(null)
  const [dpdTrend, setDpdTrend] = useState<DPDTrendPoint[]>([])
  const [agents, setAgents]     = useState<AgentRow[]>([])
  const [rollData, setRollData] = useState<RollBucket[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [kpisRes, trendRes, agentRes, rollRes] = await Promise.all([
        apiFetch<{ data: PortfolioKPIs }>('/api/collections/portfolio-kpis'),
        apiFetch<{ data: DPDTrendPoint[] }>('/api/collections/dpd-trend'),
        apiFetch<{ data: AgentRow[] }>('/api/collections/by-agent'),
        apiFetch<{ data: { current_distribution: RollBucket[] } }>('/api/collections/roll-rate'),
      ])
      setKpis(kpisRes.data)
      setDpdTrend(trendRes.data ?? [])
      setAgents(agentRes.data ?? [])
      setRollData(rollRes.data?.current_distribution ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load collections data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const kpiLoading = loading && !kpis
  const collectedMTD = agents.reduce((s, a) => s + Number(a.total ?? 0), 0)
  const avgRecoveryPct = kpis?.total_outstanding_kobo
    ? (collectedMTD / kpis.total_outstanding_kobo) * 100
    : null

  return (
    <Page
      title="Collections Overview"
      subtitle="Portfolio at risk, recovery performance, and agent activity"
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip — PAR30, PAR90, Total Outstanding, Current Rate */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard
          label="PAR30 Total"
          value={fmtKobo(kpis?.par30_kobo)}
          sub="1–30 days past due"
          icon="warning_amber"
          accent={AMBER}
          loading={kpiLoading}
        />
        <KpiCard
          label="PAR90 Total"
          value={fmtKobo(kpis?.par90_kobo)}
          sub="91–360 days past due"
          icon="error_outline"
          accent={RED}
          loading={kpiLoading}
        />
        <KpiCard
          label="Collected MTD"
          value={fmtKobo(collectedMTD)}
          sub={`${fmtNum(agents.length)} agents`}
          icon="payments"
          accent={BLUE}
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg Recovery Rate"
          value={avgRecoveryPct !== null ? fmtPct(avgRecoveryPct) : '—'}
          sub={`${fmtNum(kpis?.delinquent_accounts)} delinquent`}
          icon="trending_up"
          accent={GREEN}
          loading={kpiLoading}
        />
      </div>

      {/* Chart row: stacked DPD trend + DPD bucket distribution */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 20 }}>
        {/* Left: stacked area — 6-month PAR trend */}
        <SectionCard title="6-Month DPD Trend (PAR30 / PAR60 / PAR90)" padding={false}>
          <div style={{ padding: '16px 18px' }}>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={dpdTrend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="par30Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={AMBER}   stopOpacity={0.22} />
                    <stop offset="95%" stopColor={AMBER}   stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="par60Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={RED}     stopOpacity={0.18} />
                    <stop offset="95%" stopColor={RED}     stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="par90Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#7F0000" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#7F0000" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: '#9AA4B8' }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  tickFormatter={v => fmtKobo(v)}
                  tick={{ fontSize: 11, fill: '#9AA4B8' }}
                  axisLine={false} tickLine={false} width={74}
                />
                <Tooltip content={<KoboTooltip />} />
                <Area
                  type="monotone" dataKey="par30_kobo" name="PAR30"
                  stroke={AMBER} strokeWidth={2} fill="url(#par30Grad)"
                  stackId="par"
                />
                <Area
                  type="monotone" dataKey="par60_kobo" name="PAR60"
                  stroke={RED} strokeWidth={2} fill="url(#par60Grad)"
                  stackId="par"
                />
                <Area
                  type="monotone" dataKey="par90_kobo" name="PAR90"
                  stroke="#7F0000" strokeWidth={2} fill="url(#par90Grad)"
                  stackId="par"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        {/* Right: DPD bucket outstanding distribution */}
        <SectionCard title="Outstanding by DPD Bucket" padding={false}>
          <div style={{ padding: '16px 18px' }}>
            <RollBars data={rollData} />
          </div>
        </SectionCard>
      </div>

      {/* Agent performance table */}
      <SectionCard
        title="Agent Collection Performance"
        badge={agents.length}
        padding={false}
        subtitle="Top 15 agents by amount collected"
      >
        <DataTable
          cols={AGENT_COLS}
          rows={agents}
          keyFn={(r, i) => r.Agent ?? i}
          loading={loading}
          skeletonRows={8}
          emptyText="No agent data found"
        />
      </SectionCard>

      {/* Agent bar chart */}
      {agents.length > 0 && (
        <SectionCard title="Top 10 Agents — Collections Bar" padding={false} style={{ marginTop: 16 }}>
          <div style={{ padding: '16px 18px' }}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={agents.slice(0, 10)}
                margin={{ top: 4, right: 8, left: 0, bottom: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
                <XAxis
                  dataKey="Agent"
                  tick={{ fontSize: 10, fill: '#9AA4B8' }}
                  axisLine={false} tickLine={false}
                  angle={-35} textAnchor="end" interval={0}
                />
                <YAxis
                  tickFormatter={v => fmtKobo(v)}
                  tick={{ fontSize: 11, fill: '#9AA4B8' }}
                  axisLine={false} tickLine={false} width={74}
                />
                <Tooltip content={<KoboTooltip />} />
                <Bar dataKey="total" name="Collected" fill={BLUE} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
