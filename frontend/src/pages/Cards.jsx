import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, ProgressListCard, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

export default function Cards({ setDs }) {
  const kpis     = useApi('/api/cards/kpis')
  const byProd   = useApi('/api/cards/by-product')
  const byStatus = useApi('/api/cards/by-status')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  const total = (byProd.data || []).reduce((s, r) => s + Number(r.count || 0), 0)

  return (
    <PageShell title="Card Production" subtitle="Issuance pipeline, product mix, and activation rates" source={kpis.dataSource} error={kpis.error}>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Issued"      value={fmtNum(d.total_issued)}  icon="credit_card"  accent="navy" />
        <KpiCard label="Active Cards"      value={fmtNum(d.active)}        icon="check_circle" accent="green" />
        <KpiCard label="Activation Rate"   value={pct(d.activation_rate)}  icon="percent"      accent="green" />
        <KpiCard label="Prepaid Cards"     value={fmtNum(d.prepaid)}       icon="wallet"       accent="navy" />
        <KpiCard label="Credit Cards"      value={fmtNum(d.credit)}        icon="payments"     accent="accent" />
        <KpiCard label="International USD" value={fmtNum(d.international)} icon="language"     accent="amber" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <ProgressListCard
          title="Cards by Product Type"
          data={byProd.data || []}
          nameKey="Product Name"
          valueKey="count"
          maxItems={8}
        />
        <ProgressListCard
          title="Cards by Account Status"
          data={byStatus.data || []}
          nameKey="Account Status"
          valueKey="count"
          maxItems={8}
        />
      </div>

      {byProd.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Product Breakdown</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Count</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {byProd.data.map((row, i) => {
                  const share = total > 0 ? (row.count / total * 100).toFixed(1) : '0.0'
                  return (
                    <tr key={i}>
                      <td className="font-medium text-slate-800 dark:text-slate-200">{row['Product Name']}</td>
                      <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{fmtNum(row.count)}</td>
                      <td className="text-right">
                        <span className="badge badge-grey">{share}%</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageShell>
  )
}
