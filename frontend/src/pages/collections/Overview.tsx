import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct, fmtNum, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, DARKRED, AMBER, GREEN, BLUE, NUM, TEXT, FW, SP } from '../../lib/design'
import { EArea, EBar } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortfolioKPIs {
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
  total_outstanding_kobo: number
  total_accounts: number
  delinquent_accounts: number
  current_rate_pct: number
  collected_kobo: number
  collected_count: number
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
    default:        return DARKRED
  }
}

// ── Agent table columns ───────────────────────────────────────────────────────

const AGENT_COLS: TableCol<AgentRow>[] = [
  { key: 'Agent', label: 'Agent', sortable: true },
  {
    key: 'total', label: 'Collected', sortable: true, align: 'right',
    render: r => <span style={NUM}>{fmtKoboExact(r.total)}</span>,
  },
  {
    key: 'count', label: 'Transactions', sortable: true, align: 'right',
    render: r => <span style={NUM}>{fmtNum(r.count)}</span>,
  },
]

// ── DPD bucket bar chart ──────────────────────────────────────────────────────

function RollBars({ data }: { data: RollBucket[] }) {
  if (!data.length) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
      No DPD data available
    </div>
  )
  const maxKobo = Math.max(...data.map(d => Number(d.outstanding_kobo)), 1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], padding: '4px 0' }}>
      {data.map(d => {
        const pct = (Number(d.outstanding_kobo) / maxKobo) * 100
        const color = dpdColor(d.dpd_bucket)
        return (
          <div key={d.dpd_bucket}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color }}>DPD {d.dpd_bucket}</span>
              <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>
                {fmtKoboExact(d.outstanding_kobo)}
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

  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const qs = `?from=${dateFrom}&to=${dateTo}`
    // by-agent reads date_from/date_to (not from/to); send both spellings so the
    // agent table + Collected-MTD actually respect the date picker.
    const agentQs = `?date_from=${dateFrom}&date_to=${dateTo}&from=${dateFrom}&to=${dateTo}`
    try {
      const [kpisRes, trendRes, agentRes, rollRes] = await Promise.all([
        apiFetch<{ data: PortfolioKPIs }>(`/api/collections/portfolio-kpis${qs}`),
        apiFetch<{ data: DPDTrendPoint[] }>(`/api/collections/dpd-trend${qs}`),
        apiFetch<{ data: AgentRow[] }>(`/api/collections/by-agent${agentQs}`),
        apiFetch<{ data: { current_distribution: RollBucket[] } }>(`/api/collections/roll-rate${qs}`),
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
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections','loans'] })

  const kpiLoading = loading && !kpis
  // Collected in the selected period from the real payments ledger (not summed off the
  // agent table, which is sparse until agents are attributed to payments).
  const collectedMTD = Number(kpis?.collected_kobo ?? 0)
  const avgRecoveryPct = kpis?.total_outstanding_kobo
    ? (collectedMTD / kpis.total_outstanding_kobo) * 100
    : null

  return (
    <Page
      title="Collections Overview"
      subtitle="Portfolio at risk, recovery performance, and agent activity"
      loading={loading && !kpis}
      skeletonKpis={4}
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip — PAR30, PAR90, Total Outstanding, Current Rate */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard
          label="PAR30 Total"
          value={fmtKoboExact(kpis?.par30_kobo)}
          sub="31+ days past due"
          icon="warning_amber"
          accent={AMBER}
          loading={kpiLoading}
        />
        <KpiCard
          label="PAR90 Total"
          value={fmtKoboExact(kpis?.par90_kobo)}
          sub="90+ days past due"
          icon="error_outline"
          accent={RED}
          loading={kpiLoading}
        />
        <KpiCard
          label="Collected (period)"
          value={fmtKoboExact(collectedMTD)}
          sub={`${fmtNum(kpis?.collected_count ?? 0)} payments`}
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
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        {/* Left: current PAR bands. (A real 6-month PAR trend needs point-in-time
            balance snapshots the book doesn't retain — the old time-series was an
            artefact of assignment updated_at months, showing 5 empty months + a spike.
            This shows the true current cumulative PAR exposure instead.) */}
        <SectionCard title="PAR Exposure (current)" subtitle="Cumulative outstanding past each DPD threshold" padding={false}>
          <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(() => {
              const bands = [
                { label: 'PAR30', hint: '31+ days', kobo: Number(kpis?.par30_kobo ?? 0), color: AMBER },
                { label: 'PAR60', hint: '61+ days', kobo: Number(kpis?.par60_kobo ?? 0), color: RED },
                { label: 'PAR90', hint: '91+ days', kobo: Number(kpis?.par90_kobo ?? 0), color: DARKRED },
              ]
              const max = Math.max(1, ...bands.map(b => b.kobo))
              return bands.map(b => (
                <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {b.label} <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.normal }}>{b.hint}</span>
                    </span>
                    <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: b.color }}>{fmtKoboExact(b.kobo)}</span>
                  </div>
                  <div style={{ height: 10, borderRadius: 5, background: 'var(--bg2)', overflow: 'hidden' }}>
                    <div style={{ width: `${(b.kobo / max) * 100}%`, height: '100%', background: b.color, borderRadius: 5, transition: 'width .3s' }} />
                  </div>
                </div>
              ))
            })()}
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
              PAR bands are cumulative — every PAR90 balance is also inside PAR60 and PAR30.
            </div>
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
        <SectionCard title="Top 10 Agents: Collections Bar" padding={false} style={{ marginTop: SP[4] }}>
          <div style={{ padding: '16px 18px' }}>
            <EBar
              data={agents.slice(0, 10).map(a => ({ Agent: a.Agent, total: Number(a.total) }))}
              xKey="Agent"
              height={200}
              legend={false}
              xTickSize={10}
              valueFmt={fmtKobo}
              axisFmt={fmtKobo}
              series={[{ key: 'total', name: 'Collected', color: NAVY }]}
            />
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
