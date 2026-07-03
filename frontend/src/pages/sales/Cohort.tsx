import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
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

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [t, f] = await Promise.all([
        apiFetch<{ data: TrendPoint[] }>('/api/sales/accounts-trend'),
        apiFetch<{ data: FunnelData }>('/api/sales/funnel'),
      ])
      setTrend(Array.isArray(t?.data) ? t.data : [])
      setFunnel(f?.data ?? null)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

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
    { key: 'month',        label: 'Month',        render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.month}</span> },
    { key: 'new_accounts', label: 'New Accounts', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 700 }}>{fmtNum(r.new_accounts)}</span> },
  ]

  return (
    <Page title="Cohort Analysis" subtitle="Customer acquisition and lifecycle progression">
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
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
              <XAxis dataKey="month" tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Area type="monotone" dataKey="new_accounts" stroke={NAVY} strokeWidth={2} fill="url(#cohortGrad)" name="New Accounts" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Funnel Progression">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={funnelChart} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 68 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} />
              <YAxis type="category" dataKey="stage" tick={{ fontSize: 11, fill: 'var(--txt2)' }} width={68} />
              <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} name="Count">
                {funnelChart.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {reg > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10, fontSize: 12 }}>
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
