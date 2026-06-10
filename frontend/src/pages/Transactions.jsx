import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { KpiCard, AreaChartCard, ProgressListCard, fmt, fmtNum } from '../components/Charts.jsx'
import { DateRangePicker, toISO, presetRange } from '../components/FilterBar.jsx'
import PageShell from '../components/PageShell.jsx'

function initRange() {
  const [f, t] = presetRange('month', toISO(new Date()))
  return { dateFrom: f, dateTo: t, preset: 'month' }
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export default function Transactions({ setDs }) {
  const init = initRange()
  const [dateFrom, setDateFrom] = useState(init.dateFrom)
  const [dateTo,   setDateTo]   = useState(init.dateTo)
  const [preset,   setPreset]   = useState(init.preset)

  const [kpis,      setKpis]      = useState(null)
  const [trend,     setTrend]     = useState([])
  const [merchants, setMerchants] = useState([])
  const [byType,    setByType]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [source,    setSource]    = useState(null)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString()
      const [k, tr, me, bt] = await Promise.all([
        apiFetch(`/api/transactions/kpis?${qs}`),
        apiFetch('/api/transactions/monthly-trend'),
        apiFetch(`/api/transactions/top-merchants?${qs}`),
        apiFetch(`/api/transactions/by-type?${qs}`),
      ])
      setKpis(k.data || {}); setSource(k.data_source)
      setDs?.(k.data_source)
      setTrend(tr.data || [])
      setMerchants(me.data || [])
      setByType(bt.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  function handleDateChange(f, t, p) { setDateFrom(f); setDateTo(t); setPreset(p) }

  async function exportCSV() {
    setExporting(true)
    try {
      const token = localStorage.getItem('o3c_token')
      const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo }).toString()
      const res = await fetch(`${API}/api/transactions/export?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = `transactions_${dateFrom}_${dateTo}.csv`; a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  const d = kpis || {}

  return (
    <PageShell
      title="Transactions"
      subtitle="Volume, trends, and merchant breakdown"
      source={source}
      error={error}
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangePicker dateFrom={dateFrom} dateTo={dateTo} preset={preset} onChange={handleDateChange} />
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
        <KpiCard label="Total Volume"      value={fmt(d.total_volume)}         icon="payments"       accent="accent" tooltip="Total naira value of transactions in the selected period" />
        <KpiCard label="Transaction Count" value={fmtNum(d.transaction_count)} icon="receipt_long"   accent="navy"   tooltip="Number of individual card transactions in the selected period" />
        <KpiCard label="Volume (MTD)"      value={fmt(d.volume_mtd)}           icon="calendar_month" accent="green"  tooltip="Total transaction value in the current calendar month" />
        <KpiCard label="Avg Txn Value"     value={fmt(d.avg_txn_value)}        icon="calculate"      accent="amber"  tooltip="Average value per transaction" />
        <KpiCard label="Unique Merchants"  value={fmtNum(d.unique_merchants)}  icon="storefront"     accent="navy"   tooltip="Distinct merchant locations in the selected period" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Volume Trend"
            data={trend}
            xKey="month"
            areas={[{ key: 'volume', label: 'Volume', color: '#C00000' }]}
            height={260} currency
          />
        </div>
        <ProgressListCard
          title="Transaction Types"
          data={byType.slice(0, 8)}
          nameKey="Description" valueKey="count" maxItems={8}
        />
      </div>

      {merchants.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700/60 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Top Merchants by Volume</p>
            <span className="badge badge-grey">{merchants.length} merchants</span>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Merchant</th>
                  <th className="text-right">Volume</th>
                  <th className="text-right">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {merchants.map((row, i) => (
                  <tr key={i}>
                    <td className="text-slate-300 dark:text-slate-600 text-xs tabular-nums">{i + 1}</td>
                    <td className="font-medium text-slate-800 dark:text-slate-200">{row.Merchant_Name}</td>
                    <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{fmt(row.volume)}</td>
                    <td className="text-right font-mono tabular-nums text-slate-500">{fmtNum(row.count)}</td>
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
