import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, DonutCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function LegalBadge({ stage }) {
  if (!stage) return <span className="badge badge-grey">—</span>
  return <span className="badge badge-red">{stage}</span>
}

function StatusBadge({ status }) {
  const v = (status || '').toLowerCase()
  if (v === 'recovered' || v === 'paid') return <span className="badge badge-green">{status}</span>
  if (v === 'pending')                   return <span className="badge badge-amber">{status}</span>
  return <span className="badge badge-grey">{status || '—'}</span>
}

export default function Recovery({ setDs }) {
  const kpis   = useApi('/api/recovery/kpis')
  const byMeth = useApi('/api/recovery/by-method')
  const trend  = useApi('/api/recovery/monthly-trend')
  const cases  = useApi('/api/recovery/cases')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Recovery & Legal" subtitle="Written-off accounts, legal proceedings and recovery performance" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard label="Total Recovered"   value={fmt(d.total_recovered)}      accent="green"  icon="payments" />
        <KpiCard label="Recovery (MTD)"    value={fmt(d.recovery_mtd)}         accent="accent" icon="calendar_month" />
        <KpiCard label="Recovery Rate"     value={pct(d.recovery_rate)}        accent="green"  icon="percent" />
        <KpiCard label="Accounts in Legal" value={fmtNum(d.accounts_in_legal)} accent="amber"  icon="gavel" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
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

      {cases.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700">
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Active Recovery Cases</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  {['Date','CIF','Customer','Agent','Method','Legal Stage','Status','Amount'].map(h => (
                    <th key={h} className="px-5 py-3 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {cases.data.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">
                      {row['Recovery Date'] ? new Date(row['Recovery Date']).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600 dark:text-slate-400">{row['CIF Number']}</td>
                    <td className="px-5 py-3 font-semibold text-slate-800 dark:text-slate-200">
                      {[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-400">{row.Agent || '—'}</td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-400">{row['Recovery Method'] || '—'}</td>
                    <td className="px-5 py-3"><LegalBadge stage={row['Legal Stage']} /></td>
                    <td className="px-5 py-3"><StatusBadge status={row.Status} /></td>
                    <td className="px-5 py-3 font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">{fmt(row['Recovery Amount'])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageShell>
  )
}
