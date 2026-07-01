import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, AreaChartCard,
  ErrBanner, Sk, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Retention colour ────────────────────────────────────────── */
function retentionStyle(rate: number | null | undefined) {
  if (rate == null) return { background: '#F1F5F9', color: '#CBD5E1' }
  const r = Number(rate)
  if (r >= 40) return { background: GREEN,   color: '#fff' }
  if (r >= 20) return { background: AMBER,   color: '#fff' }
  if (r > 0)   return { background: '#C00000', color: '#fff' }
  return { background: '#F1F5F9', color: '#CBD5E1' }
}

/* ── Cohort heatmap ──────────────────────────────────────────── */
function CohortHeatmap({ data, loading }: { data: Record<string, Record<string, number>> | null; loading: boolean }) {
  if (loading) {
    return (
      <SectionCard title="Cohort Retention Heatmap" subtitle="Monthly retention by acquisition cohort">
        <div className="px-5 py-6 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Sk w="w-20" h="h-5" />
              {Array.from({ length: 10 }).map((_, j) => <Sk key={j} w="w-10" h="h-7" />)}
            </div>
          ))}
        </div>
      </SectionCard>
    )
  }

  if (!data || Object.keys(data).length === 0) {
    return (
      <SectionCard title="Cohort Retention Heatmap" subtitle="Monthly retention by acquisition cohort">
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
          <span className="material-symbols-rounded text-[40px]">grid_on</span>
          <p className="text-[13px]">No cohort data available</p>
        </div>
      </SectionCard>
    )
  }

  const cohorts = Object.keys(data).sort()
  const maxAge  = Math.max(...cohorts.flatMap(c => Object.keys(data[c]).map(Number).filter(x => !isNaN(x))), 0)
  const ages    = Array.from({ length: maxAge + 1 }, (_, i) => i)

  return (
    <SectionCard title="Cohort Retention Heatmap" subtitle="% of cohort active in each subsequent month">
      <div className="px-5 py-4">
        <div className="overflow-x-auto">
          <table className="text-[11px] border-separate" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="text-left px-2 py-1 text-slate-400 font-semibold uppercase tracking-wider text-[11px] w-28">
                  Cohort
                </th>
                {ages.map(a => (
                  <th key={a}
                    className="text-center px-1 py-1 font-semibold uppercase tracking-wider text-[11px] text-slate-400 whitespace-nowrap"
                    style={{ minWidth: 40 }}>
                    M{a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map(cohort => (
                <tr key={cohort}>
                  <td className="px-2 py-1 font-semibold text-slate-700 whitespace-nowrap text-[11px]">
                    {cohort}
                  </td>
                  {ages.map(age => {
                    const rate  = data[cohort]?.[age]
                    const style = retentionStyle(rate)
                    return (
                      <td key={age} className="text-center p-0">
                        <div className="rounded flex items-center justify-center font-semibold transition-all"
                          style={{ ...style, minWidth: 40, height: 28, fontSize: 11 }}>
                          {rate != null ? `${Number(rate).toFixed(0)}%` : ''}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-5 mt-4 pt-4" style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
          {[
            { color: GREEN,    label: '≥ 60% retained' },
            { color: AMBER,    label: '30 – 60%' },
            { color: '#C00000', label: '< 30%' },
            { color: '#F1F5F9', label: 'No data', text: '#94A3B8' },
          ].map(l => (
            <span key={l.label} className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="w-3 h-3 rounded flex-shrink-0"
                style={{ background: l.color, border: l.color === '#F1F5F9' ? '1px solid #CBD5E1' : 'none' }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
    </SectionCard>
  )
}

/* ── Active Users Mini Chart ─────────────────────────────────── */
function ActiveUsersChart({ data, loading }: { data: any[]; loading: boolean }) {
  return (
    <AreaChartCard
      title="Monthly Active Users"
      subtitle="Unique transacting customers per month"
      data={data}
      xKey="month"
      areaKey="active_users"
      color={NAVY}
      height={220}
      loading={loading}
    />
  )
}

function AvgSpendChart({ data, loading }: { data: any[]; loading: boolean }) {
  return (
    <AreaChartCard
      title="Avg Monthly Spend per User"
      subtitle="Total spend ÷ active users"
      data={data}
      xKey="month"
      areaKey="avg_spend"
      color={RED}
      currency
      height={220}
      loading={loading}
    />
  )
}

/* ── Cohort strength indicator ───────────────────────────────── */
function CohortStrengthCard({ data }: { data: Record<string, Record<string, number>> | null }) {
  if (!data) return null
  const cohorts = Object.keys(data).sort().slice(-6) // last 6 cohorts
  return (
    <SectionCard title="Recent Cohort Strength" subtitle="Month-0 retention of last 6 cohorts">
      <div className="px-5 py-4 space-y-3">
        {cohorts.reverse().map(cohort => {
          const m0 = data[cohort]?.[0] ?? null
          const m1 = data[cohort]?.[1] ?? null
          const m2 = data[cohort]?.[2] ?? null
          const barColor = m0 != null ? (m0 >= 60 ? GREEN : m0 >= 30 ? AMBER : RED) : '#CBD5E1'
          return (
            <div key={cohort}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12px] font-semibold text-slate-700">{cohort}</span>
                <div className="flex items-center gap-3 text-[11px]">
                  {m0 != null && <span><span className="text-slate-400">M0 </span><span className="font-semibold kpi-number" style={{ color: barColor }}>{m0.toFixed(0)}%</span></span>}
                  {m1 != null && <span><span className="text-slate-400">M1 </span><span className="font-semibold kpi-number text-slate-600">{m1.toFixed(0)}%</span></span>}
                  {m2 != null && <span><span className="text-slate-400">M2 </span><span className="font-semibold kpi-number text-slate-600">{m2.toFixed(0)}%</span></span>}
                </div>
              </div>
              <div className="h-1.5 rounded-full" style={{ background: 'rgba(15,23,42,0.06)' }}>
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width: m0 != null ? `${Math.min(n(m0), 100)}%` : '0%', background: barColor }} />
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function Cohort() {
  const [kpis,     setKpis]     = useState<any>(null)
  const [heatmap,  setHeatmap]  = useState<any>(null)
  const [activity, setActivity] = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [rK, rH, rA] = await Promise.allSettled([
        apiFetch('/api/cohort/kpis'),
        apiFetch('/api/cohort/heatmap'),
        apiFetch('/api/cohort/monthly-activity'),
      ])
      if (rK.status === 'fulfilled') setKpis(rK.value.data || {})
      if (rH.status === 'fulfilled') setHeatmap(rH.value.data || null)
      if (rA.status === 'fulfilled') setActivity(rA.value.data || [])
      if ([rK, rH, rA].every(r => r.status === 'rejected')) setError((rK as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  return (
    <Page dept="Sales" title="Cohort Analysis"
      subtitle="Retention heatmap, monthly activity, and cohort health">
      <ErrBanner msg={error} />

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Cohort Size"       value={fmtNum(d.cohort_size)}      icon="groups"
          accent={NAVY}  loading={loading} />
        <KpiCard label="Activated Users"   value={fmtNum(d.activated_cohort)} icon="check_circle"
          accent={GREEN} loading={loading} />
        <KpiCard label="Activation Rate"   value={fmtPct(d.activation_rate)}  icon="percent"
          accent={n(d.activation_rate) >= 50 ? GREEN : AMBER} loading={loading} />
        <KpiCard label="Power Users (≥5×)" value={fmtNum(d.power_users)}      icon="bolt"
          accent={RED}   loading={loading}
          sub={`${d.cohort_size > 0 ? fmtPct((n(d.power_users) / n(d.cohort_size)) * 100) : '—'} of cohort`} />
      </div>

      {/* Cohort Heatmap */}
      <div className="mt-4">
        <CohortHeatmap data={heatmap} loading={loading} />
      </div>

      {/* Activity Charts + Cohort Strength */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 grid grid-cols-1 gap-4">
          <ActiveUsersChart data={activity} loading={loading} />
          <AvgSpendChart    data={activity} loading={loading} />
        </div>
        <CohortStrengthCard data={heatmap} />
      </div>

      {/* Activity data table */}
      {activity.length > 0 && (
        <div className="mt-4">
          <SectionCard title="Monthly Activity Detail" subtitle="Active users and spend by month">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr>
                    {['Month', 'Active Users', 'Total Spend', 'Avg Spend / User'].map((col, i) => (
                      <th key={col}
                        className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap ${i > 0 ? 'text-right' : 'text-left'}`}
                        style={{ background: NAVY, color: 'rgba(255,255,255,0.6)' }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50 transition-colors"
                      style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      <td className="px-5 py-3 font-semibold text-slate-700">{row.month}</td>
                      <td className="px-5 py-3 text-right kpi-number">{fmtNum(row.active_users)}</td>
                      <td className="px-5 py-3 text-right kpi-number">{fmt(row.total_spend)}</td>
                      <td className="px-5 py-3 text-right kpi-number">{fmt(row.avg_spend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}
    </Page>
  )
}
