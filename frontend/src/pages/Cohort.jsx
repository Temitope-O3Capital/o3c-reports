import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, LineChartCard, fmtNum, fmt, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function retentionColor(rate) {
  if (rate == null || rate === '') return { background: '#F1F5F9', color: '#94A3B8' }
  const r = Number(rate)
  if (r >= 60) return { background: '#166534', color: '#fff' }
  if (r >= 30) return { background: '#F59E0B', color: '#fff' }
  if (r > 0)   return { background: '#C00000', color: '#fff' }
  return { background: '#F1F5F9', color: '#94A3B8' }
}

function CohortHeatmap({ data }) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="card p-10 flex items-center justify-center text-slate-400 text-sm">
        No cohort data available
      </div>
    )
  }

  const cohorts = Object.keys(data).sort()
  const maxAge  = Math.max(...cohorts.flatMap(c => Object.keys(data[c]).map(Number)))
  const ages    = Array.from({ length: maxAge + 1 }, (_, i) => i)

  return (
    <div className="card p-5">
      <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">Cohort Retention Heatmap</p>
      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', minWidth: 100 }}>Cohort</th>
              {ages.map(a => <th key={a}>M{a}</th>)}
            </tr>
          </thead>
          <tbody>
            {cohorts.map(cohort => (
              <tr key={cohort}>
                <td className="cohort-label">{cohort}</td>
                {ages.map(age => {
                  const rate  = data[cohort][age]
                  const style = retentionColor(rate)
                  return (
                    <td key={age}>
                      <div className="heatmap-cell" style={{ ...style, padding: '4px 6px', borderRadius: 4 }}>
                        {rate != null ? `${rate}%` : ''}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-5 mt-4 text-xs text-slate-500">
        {[
          { color: '#166534', label: '≥ 60% retained' },
          { color: '#F59E0B', label: '30 – 60%' },
          { color: '#C00000', label: '< 30%' },
        ].map(l => (
          <span key={l.label} className="flex items-center gap-1.5">
            <span style={{ background: l.color }} className="w-3 h-3 rounded inline-block" />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function Cohort({ setDs }) {
  const kpis     = useApi('/api/cohort/kpis')
  const heatmap  = useApi('/api/cohort/heatmap')
  const activity = useApi('/api/cohort/monthly-activity')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Cohort Analysis" subtitle="Retention heatmap and monthly activity per cohort" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard label="Cohort Size"       value={fmtNum(d.cohort_size)}      accent="navy"   icon="groups" />
        <KpiCard label="Activated Users"   value={fmtNum(d.activated_cohort)} accent="green"  icon="check_circle" />
        <KpiCard label="Activation Rate"   value={pct(d.activation_rate)}     accent="green"  icon="percent" />
        <KpiCard label="Power Users (≥5×)" value={fmtNum(d.power_users)}      accent="accent" icon="bolt" />
      </div>

      <div className="mt-4">
        <CohortHeatmap data={heatmap.data} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <LineChartCard
          title="Monthly Active Users"
          data={activity.data || []}
          xKey="month"
          lines={[{ key: 'active_users', label: 'Active Users', color: '#0E2841' }]}
        />
        <CurrencyLineCard
          title="Monthly Avg Spend per User"
          data={activity.data || []}
          xKey="month"
          lines={[{ key: 'avg_spend', label: 'Avg Spend', color: '#C00000' }]}
        />
      </div>
    </PageShell>
  )
}
