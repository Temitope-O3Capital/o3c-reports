import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, BLUE, PURPLE, AMBER, NAVY, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { CHART, CHART_SERIES } from '../../components/charts'
import { EBar } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RecoveryKPIs {
  total_handoff_kobo: number
  total_in_recovery_kobo: number
  recovered_mtd_kobo: number
  success_rate_pct: number
  avg_days_in_recovery: number
  by_product?: { product: string; open_cases: number; in_recovery_kobo: number; recovered_kobo: number }[]
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

// ── Channel progress bars ─────────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = {
  TPA:        CHART.blue,
  'Field Visit': CHART.amber,
  Legal:      CHART.red,
  'Self-Cure': CHART.green,
}
// Fallback palette so channels not in the map above (e.g. loan repayment / TRANSFER /
// REMITA) still get distinct colours instead of all rendering grey.
const CHANNEL_PALETTE = CHART_SERIES

function ChannelBars({ data }: { data: ChannelRow[] }) {
  if (!data.length) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
        No channel data available
      </div>
    )
  }
  const maxKobo = Math.max(...data.map(d => d.amount_kobo), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: `${SP[1]} 0` }}>
      {data.map((d, i) => {
        const barPct = (d.amount_kobo / maxKobo) * 100
        const color = CHANNEL_COLORS[d.channel] ?? CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]
        return (
          <div key={d.channel}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', width: 90, flexShrink: 0 }}>
                {d.channel}
              </span>
              <div style={{ flex: 1, height: 6, background: 'var(--bdr)', borderRadius: RADIUS.full, overflow: 'hidden' }}>
                <div style={{
                  width: `${barPct}%`, height: '100%',
                  background: color, borderRadius: RADIUS.full, transition: 'width 0.4s',
                }} />
              </div>
              <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', width: 130, flexShrink: 0, justifyContent: 'flex-end' }}>
                <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                  {fmtKoboExact(d.amount_kobo)}
                </span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
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
    render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.agent_name || '—'}</span>,
  },
  {
    key: 'case_count',
    label: 'Cases Assigned',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontSize: TEXT.base }}>{fmtNum(r.case_count)}</span>,
  },
  {
    key: 'recovered_kobo',
    label: 'Recovered ₦',
    sortable: true,
    align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.recovered_kobo)}</span>,
  },
  {
    key: 'success_rate_pct',
    label: 'Success Rate %',
    sortable: true,
    align: 'right',
    render: r => {
      const col = r.success_rate_pct >= 60 ? '#16A34A' : r.success_rate_pct >= 30 ? '#D97706' : '#C00000'
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], justifyContent: 'flex-end' }}>
          <div style={{ width: 52, height: 4, background: 'var(--bdr)', borderRadius: RADIUS.full, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(r.success_rate_pct, 100)}%`, height: '100%', background: col, borderRadius: RADIUS.full }} />
          </div>
          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: col, width: 36, textAlign: 'right' }}>
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
  // Recovery is a long game — default to a trailing 12 months so the trend, channels
  // and agent activity show real history rather than an empty "this month".
  const [dateFrom, setDateFrom]   = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 11); d.setDate(1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [dateTo, setDateTo]       = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const qs = `from=${dateFrom}&to=${dateTo}`
    try {
      const [kpisRes, trendRes, channelRes, agentRes] = await Promise.all([
        apiFetch<{ data: RecoveryKPIs }>(`/api/recovery/kpis?${qs}`),
        apiFetch<{ data: MonthlyPoint[] }>(`/api/recovery/monthly-trend?${qs}`),
        apiFetch<{ data: ChannelRow[] }>(`/api/recovery/by-channel?${qs}`),
        apiFetch<{ data: AgentRow[] }>(`/api/recovery/by-agent?${qs}`),
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
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery'] })

  const kpiLoading = loading && !kpis
  const totalRecovered = trend.reduce((s, p) => s + (p.amount_kobo || 0), 0)
  const peakKobo = trend.length ? Math.max(...trend.map(p => p.amount_kobo || 0)) : 0

  return (
    <Page
      title="Recovery Overview"
      subtitle="Recovery performance, channel analysis, and agent activity"
      loading={loading && !kpis}
      skeletonKpis={5}
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard
          label="Opening Portfolio"
          value={fmtKoboExact(kpis?.total_handoff_kobo)}
          sub="balance handed to recovery"
          icon="account_balance"
          accent={NAVY}
          loading={kpiLoading}
        />
        <KpiCard
          label="Total in Recovery"
          value={fmtKoboExact(kpis?.total_in_recovery_kobo)}
          sub="outstanding, net of recovered"
          icon="gavel"
          accent={AMBER}
          loading={kpiLoading}
        />
        <KpiCard
          label="Recovered (period)"
          value={fmtKoboExact(kpis?.recovered_mtd_kobo)}
          sub="collected in selected range"
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
          accent={BLUE}
          loading={kpiLoading}
        />
      </div>

      {/* Card vs Loan split of the open recovery book */}
      {kpis?.by_product && kpis.by_product.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: SP[5] }}>
          {kpis.by_product.map(p => {
            const isLoan = p.product === 'loan'
            const c = isLoan ? NAVY : PURPLE
            const total = p.in_recovery_kobo + p.recovered_kobo
            const recPct = total > 0 ? Math.round(100 * p.recovered_kobo / total) : 0
            return (
              <div key={p.product} style={{ padding: '16px 18px', borderRadius: RADIUS.lg, background: 'var(--card)', border: '1px solid var(--bdr)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: RADIUS.md, background: `${c}14`, color: c, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 19 }}>{isLoan ? 'account_balance' : 'credit_card'}</span>
                    </div>
                    <div>
                      <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{isLoan ? 'Loans' : 'Cards'}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtNum(p.open_cases)} open case{p.open_cases === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)', letterSpacing: '-0.4px' }}>{fmtKoboExact(p.in_recovery_kobo)}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>in recovery</div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: TEXT.xs, marginBottom: 5 }}>
                  <span style={{ color: 'var(--txt3)' }}>Recovered</span>
                  <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtKoboExact(p.recovered_kobo)} · {recPct}%</span>
                </div>
                <div style={{ height: 6, borderRadius: RADIUS.full, background: 'var(--bdr)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${recPct}%`, background: GREEN, borderRadius: RADIUS.full, transition: 'width 0.4s' }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Monthly recovery trend — full-width labelled bar chart. Recovery amounts swing
          from ~₦400M to ₦40bn+ month to month, so a bar-per-month with a value label on
          each reads cleanly where an area chart collapsed into a single spike. */}
      <SectionCard
        title="Monthly Recovery Trend"
        subtitle={`Recovered per month · ${fmtKoboExact(totalRecovered)} over the selected range`}
        padding={false}
      >
        <div style={{ padding: '20px 20px 14px' }}>
          {trend.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
              No recovery activity in the selected range
            </div>
          ) : (
            <EBar
              data={trend}
              xKey="month"
              height={300}
              legend={false}
              valueFmt={(v) => fmtKoboExact(v)}
              axisFmt={(v) => fmtKobo(v)}
              series={[{
                key: 'amount_kobo',
                name: 'Recovered',
                color: GREEN,
                colorFn: (p) => Number(p.amount_kobo) === peakKobo ? GREEN : 'rgba(22,163,74,0.55)',
              }]}
            />
          )}
        </div>
      </SectionCard>

      {/* Recovery by channel — full width */}
      <div style={{ marginTop: SP[5] }}>
        <SectionCard title="Recovery by Channel" subtitle="Amount recovered per channel over the selected range" padding={false}>
          <div style={{ padding: '16px 20px' }}>
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
        style={{ marginTop: SP[5] }}
      >
        <DataTable
          cols={AGENT_COLS}
          rows={agents}
          keyFn={(r, i) => r.agent_name ?? i}
          loading={loading}
          skeletonRows={8}
          emptyText="No agent data found"
          searchKeys={['agent_name']}
          searchPlaceholder="Search by agent name…"
        />
      </SectionCard>
    </Page>
  )
}
