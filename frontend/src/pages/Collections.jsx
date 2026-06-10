import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, ProgressListCard, fmt, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, toISO, presetRange } from '../components/FilterBar.jsx'
import PageShell from '../components/PageShell.jsx'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function initRange() {
  const [f, t] = presetRange('month', toISO(new Date()))
  return { dateFrom: f, dateTo: t, preset: 'month' }
}

function ModeBadge({ mode }) {
  const m = (mode || '').toUpperCase()
  if (m === 'NDD')      return <span className="badge badge-blue">NDD</span>
  if (m === 'TRANSFER') return <span className="badge badge-green">Transfer</span>
  return <span className="badge badge-grey">{mode || '—'}</span>
}

export default function Collections({ setDs }) {
  const init = initRange()
  const [dateFrom, setDateFrom] = useState(init.dateFrom)
  const [dateTo,   setDateTo]   = useState(init.dateTo)
  const [preset,   setPreset]   = useState(init.preset)
  const [agent,    setAgent]    = useState('')

  const [kpis,      setKpis]      = useState(null)
  const [agents,    setAgents]    = useState([])
  const [modes,     setModes]     = useState([])
  const [trend,     setTrend]     = useState([])
  const [log,       setLog]       = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [source,    setSource]    = useState(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, ...(agent ? { agent } : {}) }).toString()
      const [k, ag, mo, tr, lg] = await Promise.all([
        apiFetch(`/api/collections/kpis?${qs}`),
        apiFetch(`/api/collections/by-agent?date_from=${dateFrom}&date_to=${dateTo}`),
        apiFetch('/api/collections/by-mode'),
        apiFetch('/api/collections/monthly-trend'),
        apiFetch(`/api/collections/log?${qs}`),
      ])
      setKpis(k.data || {}); setSource(k.data_source); setDs?.(k.data_source)
      setAgents(ag.data || [])
      setModes(mo.data || [])
      setTrend(tr.data || [])
      setLog(lg.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, agent])

  useEffect(() => { load() }, [load])

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  // Unique agent list from agents data for the filter chip
  const agentList = agents.map(a => a.Agent).filter(Boolean)

  async function exportCSV() {
    setExporting(true)
    try {
      const token = localStorage.getItem('o3c_token')
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, ...(agent ? { agent } : {}) }).toString()
      const res = await fetch(`${API}/api/collections/export?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `collections_${dateFrom}_${dateTo}.csv`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  const d = kpis || {}

  return (
    <PageShell
      title="Collections"
      subtitle="Agent performance, payment modes, and monthly trends"
      source={source}
      error={error}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} preset={preset} onChange={handleDateChange} />
          <FilterChip label={agent || 'Agent'} active={!!agent} onClear={() => setAgent('')}>
            <DropItem label="All Agents" selected={!agent} onClick={() => setAgent('')} />
            {agentList.map(a => (
              <DropItem key={a} label={a} selected={agent === a} onClick={() => setAgent(a)} />
            ))}
          </FilterChip>
          <button onClick={exportCSV} disabled={exporting}
            className="btn btn-ghost gap-1.5 text-sm disabled:opacity-60">
            {exporting
              ? <><div className="spinner" style={{ width: 14, height: 14 }} />Exporting…</>
              : <><span className="material-symbols-rounded text-[17px]">download</span>Export CSV</>}
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Total Collected"   value={fmt(d.total_collected)}      icon="account_balance_wallet" accent="green"  tooltip="Cumulative amount collected in the selected period" />
        <KpiCard label="Collections (MTD)" value={fmt(d.collections_mtd)}      icon="calendar_month"         accent="accent" tooltip="Collections received in the current calendar month" />
        <KpiCard label="Collection Count"  value={fmtNum(d.collection_count)}  icon="tag"                    accent="navy"   tooltip="Number of individual collection events in the selected period" />
        <KpiCard label="NDD Collections"   value={fmt(d.ndd_collections)}      icon="schedule"               accent="amber"  tooltip="Near-due-date collections" />
        <KpiCard label="Transfer"          value={fmt(d.transfer_collections)} icon="swap_horiz"             accent="blue"   tooltip="Collections received via bank transfer" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Collections Trend"
            data={trend}
            xKey="month"
            areas={[{ key: 'total', label: 'Collections', color: '#10B981' }]}
            height={260} currency
          />
        </div>
        <ProgressListCard title="Collections by Mode" data={modes} nameKey="Mode Of Payment" valueKey="total" currency maxItems={6} />
      </div>

      <div className="mt-4">
        <ProgressListCard title="Top Agents by Collections" data={agents} nameKey="Agent" valueKey="total" currency maxItems={15} />
      </div>

      {log.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Collections Log</p>
            <span className="badge badge-grey">{log.length} entries</span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>{['Date','CIF','Customer','Agent','Mode','Amount','Receipt'].map(h => <th key={h}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {log.map((row, i) => (
                  <tr key={i}>
                    <td className="text-slate-500 whitespace-nowrap text-xs">
                      {row.Date ? new Date(row.Date).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="font-mono text-xs text-slate-500">{row.CIF}</td>
                    <td className="font-medium text-slate-800 dark:text-slate-200">
                      {[row['First Name'], row['Last Name']].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="text-slate-600 dark:text-slate-400">{row.Agent || '—'}</td>
                    <td><ModeBadge mode={row['Mode Of Payment']} /></td>
                    <td className="font-mono tabular-nums text-slate-800 dark:text-slate-200 whitespace-nowrap font-semibold">{fmt(row.Amount)}</td>
                    <td className="text-slate-400 text-xs">{row['Payment Receipt'] || '—'}</td>
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
