import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, LineChartCard, fmtNum, fmt, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

function retentionColor(rate) {
  if (rate == null || rate === '') return { background: '#F4F6F8', color: '#94A3B8' }
  const r = Number(rate)
  if (r >= 60) return { background: '#166534', color: '#fff' }
  if (r >= 30) return { background: '#F59E0B', color: '#fff' }
  if (r > 0)   return { background: '#C00000', color: '#fff' }
  return { background: '#F4F6F8', color: '#94A3B8' }
}

function CohortHeatmap({ data }) {
  if (!data || Object.keys(data).length === 0) {
    return <div className="loading">No cohort data available</div>
  }

  const cohorts = Object.keys(data).sort()
  const maxAge  = Math.max(...cohorts.flatMap(c => Object.keys(data[c]).map(Number)))
  const ages    = Array.from({ length: maxAge + 1 }, (_, i) => i)

  return (
    <div className="card section-gap">
      <div className="card-title">Cohort Retention Heatmap</div>
      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', minWidth: 100 }}>Cohort</th>
              {ages.map(a => (
                <th key={a}>M{a}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map(cohort => (
              <tr key={cohort}>
                <td className="cohort-label">{cohort}</td>
                {ages.map(age => {
                  const rate = data[cohort][age]
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
      <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: '#64748B' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, background: '#166534', borderRadius: 2, display: 'inline-block' }} /> ≥60% retained
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, background: '#F59E0B', borderRadius: 2, display: 'inline-block' }} /> 30–60%
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 12, height: 12, background: '#C00000', borderRadius: 2, display: 'inline-block' }} /> &lt;30%
        </span>
      </div>
    </div>
  )
}

export default function Cohort({ setDs }) {
  const kpis     = useApi('/api/cohort/kpis')
  const heatmap  = useApi('/api/cohort/heatmap')
  const activity = useApi('/api/cohort/monthly-activity')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Cohort Analysis</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Cohort Size"       value={fmtNum(d.cohort_size)}       accent="navy" />
        <KpiCard label="Activated Users"   value={fmtNum(d.activated_cohort)}  accent="green" />
        <KpiCard label="Activation Rate"   value={pct(d.activation_rate)}      accent="green" />
        <KpiCard label="Power Users (≥5x)" value={fmtNum(d.power_users)}       accent="accent" />
      </div>

      <CohortHeatmap data={heatmap.data} />

      <div className="chart-grid">
        <LineChartCard
          title="Monthly Active Users"
          data={activity.data || []}
          xKey="month"
          lines={[{ key: 'active_users', label: 'Active Users', color: '#0E2841' }]}
        />
        <CurrencyLineCard
          title="Monthly Average Spend per User"
          data={activity.data || []}
          xKey="month"
          lines={[{ key: 'avg_spend', label: 'Avg Spend', color: '#C00000' }]}
        />
      </div>
    </div>
  )
}
