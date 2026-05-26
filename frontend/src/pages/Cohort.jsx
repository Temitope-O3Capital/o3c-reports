import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, LineChartCard, fmtNum, fmt, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function retentionColor(rate) {
  if (rate == null || rate === '') return { background: '#F1F5F9', color: '#CBD5E1' }
  const r = Number(rate)
  if (r >= 60) return { background: '#059669', color: '#fff' }
  if (r >= 30) return { background: '#D97706', color: '#fff' }
  if (r > 0)   return { background: '#DC2626', color: '#fff' }
  return { background: '#F1F5F9', color: '#CBD5E1' }
}

function CohortHeatmap({ data }) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="card p-12 flex flex-col items-center justify-center gap-3 text-slate-400">
        <span className="material-symbols-rounded text-[40px] opacity-30">grid_on</span>
        <p className="text-sm">No cohort data available</p>
      </div>
    )
  }

  const cohorts = Object.keys(data).sort()
  const maxAge  = Math.max(...cohorts.flatMap(c => Object.keys(data[c]).map(Number)))
  const ages    = Array.from({ length: maxAge + 1 }, (_, i) => i)

  return (
    <div className="card p-6">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-5">Cohort Retention Heatmap</p>
      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', minWidth: 110 }}>Cohort</th>
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
                      <div className="heatmap-cell" style={{ ...style, padding: '4px 6px' }}>
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
      <div className="flex items-center gap-5 mt-5">
        {[
          { color: '#059669', label: '≥ 60% retained' },
          { color: '#D97706', label: '30 – 60%' },
          { color: '#DC2626', label: '< 30%' },
        ].map(l => (
          <span key={l.label} className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="w-2.5 h-2.5 rounded flex-shrink-0" style={{ background: l.color }} />
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Cohort Size"       value={fmtNum(d.cohort_size)}      icon="groups"        accent="navy" />
        <KpiCard label="Activated Users"   value={fmtNum(d.activated_cohort)} icon="check_circle"  accent="green" />
        <KpiCard label="Activation Rate"   value={pct(d.activation_rate)}     icon="percent"       accent="green" />
        <KpiCard label="Power Users (≥5×)" value={fmtNum(d.power_users)}      icon="bolt"          accent="accent" />
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
          height={240}
        />
        <AreaChartCard
          title="Monthly Avg Spend per User"
          data={activity.data || []}
          xKey="month"
          areas={[{ key: 'avg_spend', label: 'Avg Spend', color: '#C00000' }]}
          height={240}
          currency
        />
      </div>
    </PageShell>
  )
}
