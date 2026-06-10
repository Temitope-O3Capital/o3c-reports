import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, ProgressListCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

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
  const [exporting, setExporting] = useState(false)

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}

  async function exportCSV() {
    setExporting(true)
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/recovery/export`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = 'recovery_cases.csv'; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  return (
    <PageShell
      title="Recovery & Legal"
      subtitle="Written-off accounts, legal proceedings, and recovery performance"
      source={kpis.dataSource}
      error={kpis.error}
      actions={
        <button onClick={exportCSV} disabled={exporting}
          className="btn btn-ghost gap-1.5 text-sm disabled:opacity-60">
          {exporting
            ? <><div className="spinner" style={{ width: 14, height: 14 }} />Exporting…</>
            : <><span className="material-symbols-rounded text-[17px]">download</span>Export CSV</>}
        </button>
      }
    >

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Recovered"   value={fmt(d.total_recovered)}      icon="payments"        accent="green"  tooltip="Total amount recovered from accounts in the recovery portfolio across all time" />
        <KpiCard label="Recovery (MTD)"    value={fmt(d.recovery_mtd)}         icon="calendar_month"  accent="accent" tooltip="Amount recovered from bad-debt accounts in the current calendar month" />
        <KpiCard label="Recovery Rate"     value={pct(d.recovery_rate)}        icon="percent"         accent="green"  tooltip="Total recovered as a percentage of the total outstanding recovery portfolio" />
        <KpiCard label="Accounts in Legal" value={fmtNum(d.accounts_in_legal)} icon="gavel"           accent="amber"  tooltip="Accounts that have been escalated to legal proceedings for debt recovery" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Recovery Trend"
            data={trend.data || []}
            xKey="month"
            areas={[{ key: 'total', label: 'Recovered', color: '#10B981' }]}
            height={260}
            currency
          />
        </div>
        <ProgressListCard
          title="Recovery by Method"
          data={byMeth.data || []}
          nameKey="Recovery Method"
          valueKey="total"
          currency
          maxItems={8}
        />
      </div>

      {(cases.data || []).length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Active Recovery Cases</p>
            <span className="badge badge-grey">{cases.data.length} cases</span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {['Date','CIF','Customer','Agent','Method','Legal Stage','Status','Amount'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cases.data.map((row, i) => (
                  <tr key={i}>
                    <td className="text-slate-500 whitespace-nowrap text-xs">
                      {row['Recovery Date'] ? new Date(row['Recovery Date']).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="font-mono text-xs text-slate-500">{row['CIF Number']}</td>
                    <td className="font-medium text-slate-800 dark:text-slate-200">
                      {[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">{row.Agent || '—'}</td>
                    <td className="text-slate-600 dark:text-slate-400">{row['Recovery Method'] || '—'}</td>
                    <td><LegalBadge stage={row['Legal Stage']} /></td>
                    <td><StatusBadge status={row.Status} /></td>
                    <td className="font-mono tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap">{fmt(row['Recovery Amount'])}</td>
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
