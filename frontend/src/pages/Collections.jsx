import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, HBarCard, DonutCard, fmt, fmtNum } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

function statusBadge(mode) {
  const m = (mode || '').toUpperCase()
  if (m === 'NDD')      return <span className="badge badge-navy">NDD</span>
  if (m === 'TRANSFER') return <span className="badge badge-green">Transfer</span>
  return <span className="badge badge-grey">{mode || '—'}</span>
}

export default function Collections({ setDs }) {
  const kpis   = useApi('/api/collections/kpis')
  const agents = useApi('/api/collections/by-agent')
  const modes  = useApi('/api/collections/by-mode')
  const trend  = useApi('/api/collections/monthly-trend')
  const log    = useApi('/api/collections/log')

  useEffect(() => {
    if (kpis.dataSource) setDs(kpis.dataSource)
  }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <div>
      <div className="page-header">
        <h1>Collections</h1>
        <DataBanner source={kpis.dataSource} />
      </div>

      {kpis.error && <div className="error-msg">Failed to load KPIs: {kpis.error}</div>}

      <div className="kpi-grid">
        <KpiCard label="Total Collected"   value={fmt(d.total_collected)}   accent="green" />
        <KpiCard label="Collections (MTD)" value={fmt(d.collections_mtd)}   accent="accent" />
        <KpiCard label="Collection Count"  value={fmtNum(d.collection_count)} accent="navy" />
        <KpiCard label="NDD Collections"   value={fmt(d.ndd_collections)}   accent="amber" />
        <KpiCard label="Transfer"          value={fmt(d.transfer_collections)} accent="navy" />
      </div>

      <div className="chart-grid">
        <CurrencyLineCard
          title="Monthly Collections Trend"
          data={trend.data || []}
          xKey="month"
          lines={[{ key: 'total', label: 'Collections', color: '#166534' }]}
        />
        <DonutCard
          title="Collections by Mode"
          data={modes.data || []}
          nameKey="Mode Of Payment"
          valueKey="total"
          currency
        />
      </div>

      <div className="section-gap">
        <HBarCard
          title="Top 15 Agents by Collections"
          data={agents.data || []}
          nameKey="Agent"
          valueKey="total"
          currency
        />
      </div>

      {/* Collections log table */}
      {log.data && log.data.length > 0 && (
        <div className="table-wrap mt-4">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>CIF</th>
                <th>Customer</th>
                <th>Agent</th>
                <th>Mode</th>
                <th>Amount</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((row, i) => (
                <tr key={i}>
                  <td>{row.Date ? new Date(row.Date).toLocaleDateString('en-GB') : '—'}</td>
                  <td className="mono">{row.CIF}</td>
                  <td>{[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}</td>
                  <td>{row.Agent || '—'}</td>
                  <td>{statusBadge(row['Mode Of Payment'])}</td>
                  <td className="mono">{fmt(row.Amount)}</td>
                  <td>{row['Payment Receipt'] || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
