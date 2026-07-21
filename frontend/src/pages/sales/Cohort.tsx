import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, NUM, TEXT, FW, SP } from '../../lib/design'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrendPoint { month: string; new_accounts: number }
interface FunnelData  { registered: number; card_issued: number; card_active: number; transacting: number }

// ── Main component ─────────────────────────────────────────────────────────────

export default function SalesCohort() {
  const [trend, setTrend]     = useState<TrendPoint[]>([])
  const [funnel, setFunnel]   = useState<FunnelData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [t, f] = await Promise.all([
        apiFetch<{ data: TrendPoint[] }>(`/api/sales/accounts-trend?from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: FunnelData }>(`/api/sales/funnel?from=${dateFrom}&to=${dateTo}`),
      ])
      setTrend(Array.isArray(t?.data) ? t.data : [])
      setFunnel(f?.data ?? null)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const reg    = Number(funnel?.registered  ?? 0)
  const issued = Number(funnel?.card_issued ?? 0)
  const active = Number(funnel?.card_active ?? 0)
  const trans  = Number(funnel?.transacting ?? 0)

  const funnelChart = [
    { stage: 'Registered',  value: reg,    fill: NAVY  },
    { stage: 'Card Issued', value: issued, fill: BLUE  },
    { stage: 'Card Active', value: active, fill: GREEN },
    { stage: 'Transacting', value: trans,  fill: AMBER },
  ]

  const trendCols: TableCol<TrendPoint>[] = [
    { key: 'month',        label: 'Month',        render: r => <span style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{r.month}</span> },
    { key: 'new_accounts', label: 'New Accounts', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.new_accounts)}</span> },
  ]

  return (
    <Page title="Cohort Analysis" subtitle="Customer acquisition and lifecycle progression"
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Registered"  value={fmtNum(reg)}    />
        <KpiCard label="Card Issued" value={fmtNum(issued)} accent={BLUE} />
        <KpiCard label="Card Active" value={fmtNum(active)} accent={GREEN} />
        <KpiCard label="Transacting" value={fmtNum(trans)}  accent={AMBER} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="New Accounts — Monthly Trend">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cohortGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Area type="monotone" dataKey="new_accounts" stroke={NAVY} strokeWidth={2} fill="url(#cohortGrad)" name="New Accounts" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Funnel Progression">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={funnelChart} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 68 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis type="category" dataKey="stage" tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} width={68} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} name="Count">
                {funnelChart.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {reg > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10, fontSize: TEXT.sm }}>
              {[
                { label: 'Card issue rate',   val: issued / reg * 100 },
                { label: 'Active rate',       val: active / reg * 100 },
                { label: 'Transacting rate',  val: trans  / reg * 100 },
              ].map(({ label, val }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--txt2)' }}>
                  <span>{label}</span>
                  <strong style={{ color: 'var(--txt)' }}>{fmtPct(val)}</strong>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Monthly Account Trend" badge={trend.length} padding={false}>
        <DataTable<TrendPoint>
          cols={trendCols}
          rows={trend}
          keyFn={(_, i) => i}
          emptyText="No trend data available."
          skeletonRows={loading ? 8 : 0}
        />
      </SectionCard>
    </Page>
  )
}
