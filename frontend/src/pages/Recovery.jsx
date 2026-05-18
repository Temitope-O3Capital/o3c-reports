import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, DonutCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

function legalBadge(stage) {
  if (!stage) return <span className="badge badge-grey">—</span>
  return <span className="badge badge-red">{stage}</span>
}

function statusBadge(s) {
  const v = (s || '').toLowerCase()
  if (v === 'recovered' || v === 'paid') return <span className="badge badge-green">{s}</span>
  if (v === 'pending')                   return <span className="badge badge-amber">{s}</span>
  return <span className="badge badge-grey">{s || '—'}</span>
}

export default function Recovery({ setDs }) {
  const kpis   = useApi('/api/recovery/kpis')
  const byMeth = useApi('/api/recovery/by-method')
  const trend  = useApi('/api/recovery/monthly-trend')
  const cases  = useApi('/api/recovery/cases')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Recovery</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Recovered"     value={fmt(d.total_recovered)}       accent="green" />
        <KpiCard label="Recovery (MTD)"      value={fmt(d.recovery_mtd)}          accent="accent" />
        <KpiCard label="Recovery Rate"       value={pct(d.recovery_rate)}         accent="green" />
        <KpiCard label="Accounts in Legal"   value={fmtNum(d.accounts_in_legal)}  accent="amber" />
      </div>

      <div className="chart-grid">
        <CurrencyLineCard
          title="Monthly Recovery Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'total', label: 'Recovered', color: '#166534' }]}
        />
        <DonutCard
          title="Recovery by Method"
          data={byMeth.data || []}
          nameKey="Recovery Method"
          valueKey="total"
          currency
        />
      </div>

      {cases.data && cases.data.length > 0 && (
        <div className="table-wrap mt-4">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>CIF</th>
                <th>Customer</th>
                <th>Agent</th>
                <th>Method</th>
                <th>Legal Stage</th>
                <th>Status</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {cases.data.map((row, i) => (
                <tr key={i}>
                  <td>{row['Recovery Date'] ? new Date(row['Recovery Date']).toLocaleDateString('en-GB') : '—'}</td>
                  <td className="mono">{row['CIF Number']}</td>
                  <td>{[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}</td>
                  <td>{row.Agent || '—'}</td>
                  <td>{row['Recovery Method'] || '—'}</td>
                  <td>{legalBadge(row['Legal Stage'])}</td>
                  <td>{statusBadge(row.Status)}</td>
                  <td className="mono">{fmt(row['Recovery Amount'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
