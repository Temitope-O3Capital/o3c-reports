import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, DonutCard, ProgressListCard, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

export default function Cards({ setDs }) {
  const kpis     = useApi('/api/cards/kpis')
  const byProd   = useApi('/api/cards/by-product')
  const byStatus = useApi('/api/cards/by-status')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Card Production" subtitle="Issuance pipeline, product mix, and activation rates" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Issued"      value={fmtNum(d.total_issued)}   accent="navy"   icon="credit_card" />
        <KpiCard label="Active Cards"      value={fmtNum(d.active)}         accent="green"  icon="check_circle" />
        <KpiCard label="Activation Rate"   value={pct(d.activation_rate)}   accent="green"  icon="percent" />
        <KpiCard label="Prepaid Cards"     value={fmtNum(d.prepaid)}        accent="navy"   icon="wallet" />
        <KpiCard label="Credit Cards"      value={fmtNum(d.credit)}         accent="accent" icon="payments" />
        <KpiCard label="International USD" value={fmtNum(d.international)}  accent="amber"  icon="language" />
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
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700">
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Product Breakdown</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3 text-left">Product</th>
                  <th className="px-5 py-3 text-right">Count</th>
                  <th className="px-5 py-3 text-right">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {byProd.data.map((row, i) => {
                  const total = byProd.data.reduce((s, r) => s + (r.count || 0), 0)
                  const share = total > 0 ? (row.count / total * 100).toFixed(1) : '0.0'
                  return (
                    <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                      <td className="px-5 py-3 font-semibold text-slate-800 dark:text-slate-200">{row['Product Name']}</td>
                      <td className="px-5 py-3 text-right font-mono text-slate-700 dark:text-slate-300">{fmtNum(row.count)}</td>
                      <td className="px-5 py-3 text-right font-mono text-slate-700 dark:text-slate-300">{share}%</td>
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
