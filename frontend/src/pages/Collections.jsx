import { useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, CurrencyLineCard, HBarCard, DonutCard, fmt, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

function ModeBadge({ mode }) {
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

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  return (
    <PageShell title="Collections" subtitle="Agent performance, collection modes and aging buckets" source={kpis.dataSource} error={kpis.error}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
        <KpiCard label="Total Collected"   value={fmt(d.total_collected)}       accent="green"  icon="account_balance" />
        <KpiCard label="Collections (MTD)" value={fmt(d.collections_mtd)}       accent="accent" icon="calendar_month" />
        <KpiCard label="Collection Count"  value={fmtNum(d.collection_count)}   accent="navy"   icon="tag" />
        <KpiCard label="NDD Collections"   value={fmt(d.ndd_collections)}       accent="amber"  icon="schedule" />
        <KpiCard label="Transfer"          value={fmt(d.transfer_collections)}   accent="navy"   icon="swap_horiz" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
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

      <div className="mt-4">
        <HBarCard
          title="Top 15 Agents by Collections"
          data={agents.data || []}
          nameKey="Agent"
          valueKey="total"
          currency
        />
      </div>

      {log.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700">
            <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Collections Log</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-800/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                <tr>
                  {['Date','CIF','Customer','Agent','Mode','Amount','Receipt'].map(h => (
                    <th key={h} className="px-5 py-3 text-left whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {log.data.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">
                      {row.Date ? new Date(row.Date).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-600 dark:text-slate-400">{row.CIF}</td>
                    <td className="px-5 py-3 font-semibold text-slate-800 dark:text-slate-200">
                      {[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-400">{row.Agent || '—'}</td>
                    <td className="px-5 py-3"><ModeBadge mode={row['Mode Of Payment']} /></td>
                    <td className="px-5 py-3 font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">{fmt(row.Amount)}</td>
                    <td className="px-5 py-3 text-slate-500 text-xs">{row['Payment Receipt'] || '—'}</td>
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
