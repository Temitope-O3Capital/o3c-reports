import { useState, useEffect } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, BarChartCard, DonutCard, ProgressList,
  ErrBanner, ExportBtn, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

interface IncomeSummary {
  interest: number
  fees: number
  total_charges: number
  outstanding_bal: number
  overdue: number
  overdue_accounts: number
  total_accounts: number
  loc_total: number
  loc_utilisation: number
}

export default function Overview() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [kpis,    setKpis]    = useState<any>(null)
  const [income,  setIncome]  = useState<IncomeSummary | null>(null)
  const [volume,  setVolume]  = useState<any[]>([])
  const [incTrend, setIncTrend] = useState<any[]>([])
  const [byProduct, setByProduct] = useState<any[]>([])
  const [byType,  setByType]  = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    async function load() {
      try {
        const [rK, rVol, rProd, rTyp, rInc, rIncTrend] = await Promise.allSettled([
          apiFetch('/api/overview/kpis'),
          apiFetch('/api/overview/monthly-volume'),
          apiFetch('/api/overview/cards-by-product'),
          apiFetch('/api/overview/txn-by-type'),
          apiFetch('/api/income/summary'),
          apiFetch('/api/income/trend'),
        ])
        if (!active) return
        if (rK.status       === 'fulfilled') setKpis(rK.value.data ?? rK.value)
        if (rVol.status     === 'fulfilled') setVolume(Array.isArray(rVol.value.data) ? rVol.value.data : (Array.isArray(rVol.value) ? rVol.value : []))
        if (rProd.status    === 'fulfilled') setByProduct(Array.isArray(rProd.value.data) ? rProd.value.data : (Array.isArray(rProd.value) ? rProd.value : []))
        if (rTyp.status     === 'fulfilled') setByType(Array.isArray(rTyp.value.data) ? rTyp.value.data : (Array.isArray(rTyp.value) ? rTyp.value : []))
        if (rInc.status     === 'fulfilled') setIncome(rInc.value)
        if (rIncTrend.status === 'fulfilled') {
          const rows = Array.isArray(rIncTrend.value) ? rIncTrend.value : []
          setIncTrend(rows.slice(-12))
        }
        if ([rK, rVol, rProd, rTyp].every(r => r.status === 'rejected')) {
          setError((rK as PromiseRejectedResult).reason?.message ?? 'Failed to load')
        }
      } catch (e: any) { if (active) setError(e.message) }
      finally { if (active) setLoading(false) }
    }
    load()
    return () => { active = false }
  }, [from, to])

  const d  = kpis   || {}
  const ic = income || {} as Partial<IncomeSummary>

  const nplPct = ic.outstanding_bal && ic.overdue
    ? ((n(ic.overdue) / n(ic.outstanding_bal)) * 100)
    : null

  const productDonut = byProduct.slice(0, 6).map((r: any) => ({
    name:  r['Product Name'] ?? r.Product_Name ?? r.product_name ?? 'Unknown',
    count: n(r.count),
  }))

  const txnTypeCols = [
    { key: 'Description', label: 'Type' },
    { key: 'count',  label: 'Count',  right: true, render: (r: any) => fmtNum(r.count) },
    { key: 'volume', label: 'Volume', right: true, render: (r: any) => fmt(r.volume) },
  ]

  return (
    <Page dept="Finance" title="Overview"
      subtitle="Credit income, card operations and transaction summary"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              await apiExport(`/api/transactions/export?date_from=${from}&date_to=${to}`, 'finance-overview')
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      {/* ── Credit Income ── */}
      <div className="mb-2">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Credit Income</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <KpiCard loading={loading} label="Interest Income"     value={fmt(n(ic.interest))}     icon="trending_up"           accent={GREEN} />
          <KpiCard loading={loading} label="Fees & Charges"      value={fmt(n(ic.total_charges))} icon="receipt_long"          accent={NAVY}  />
          <KpiCard loading={loading} label="Outstanding Balance" value={fmt(n(ic.outstanding_bal))} icon="account_balance_wallet" accent={BLUE}  />
          <KpiCard loading={loading} label="LOC Utilisation"
            value={ic.loc_utilisation != null ? `${n(ic.loc_utilisation).toFixed(1)}%` : '—'}
            icon="donut_large"
            accent={n(ic.loc_utilisation) > 80 ? RED : n(ic.loc_utilisation) > 60 ? AMBER : GREEN}
          />
        </div>
      </div>

      {/* ── Portfolio Health ── */}
      <div className="mb-5">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Portfolio Health</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard loading={loading} label="Overdue Balance"
            value={fmt(n(ic.overdue))}
            icon="warning"
            accent={n(ic.overdue) > 0 ? RED : GREEN}
          />
          <KpiCard loading={loading} label="NPL Rate"
            value={nplPct != null ? `${nplPct.toFixed(2)}%` : '—'}
            icon="trending_down"
            accent={nplPct != null ? (nplPct > 5 ? RED : nplPct > 2 ? AMBER : GREEN) : NAVY}
          />
          <KpiCard loading={loading} label="Overdue Accounts"   value={fmtNum(n(ic.overdue_accounts))} icon="people_alt"    accent={AMBER} />
          <KpiCard loading={loading} label="Active Accounts"    value={fmtNum(n(ic.total_accounts))}   icon="check_circle"  accent={GREEN} />
        </div>
      </div>

      {/* ── Income trend + Volume chart ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <AreaChartCard
          title="Interest Income Trend"
          subtitle="Monthly interest earned (last 12 cycles)"
          data={incTrend}
          xKey="label"
          areaKey="interest"
          color={GREEN}
          currency
          height={220}
          loading={loading}
        />
        <AreaChartCard
          title="Monthly Transaction Volume"
          subtitle="Card transaction value by month"
          data={volume}
          xKey="month"
          areaKey="volume"
          color={NAVY}
          currency
          height={220}
          loading={loading}
        />
      </div>

      {/* ── Card operations KPIs ── */}
      <div className="mb-5">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Card Operations</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard loading={loading} label="Total Cardholders"  value={fmtNum(d.total_cardholders)}  icon="groups"       accent={NAVY}  />
          <KpiCard loading={loading} label="Active Accounts"    value={fmtNum(d.active_accounts)}    icon="credit_card"  accent={GREEN} />
          <KpiCard loading={loading} label="Collections MTD"    value={fmt(d.collections_mtd)}       icon="payments"     accent={RED}   />
          <KpiCard loading={loading} label="New Accounts MTD"   value={fmtNum(d.new_accounts_mtd)}   icon="person_add"   accent={BLUE}  />
        </div>
      </div>

      {/* ── Product breakdown + Top transaction types ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <DonutCard
          title="Cards by Product"
          subtitle="Active portfolio breakdown"
          data={productDonut}
          nameKey="name"
          valueKey="count"
          loading={loading}
        />
        <ProgressList
          title="Top Transaction Types"
          subtitle="By count"
          data={byType.slice(0, 8).map((r: any) => ({ label: r.Description ?? r.description, count: n(r.count) }))}
          nameKey="label"
          valueKey="count"
          loading={loading}
        />
      </div>

      {/* ── Transaction types table ── */}
      <SectionCard title="Transaction Type Breakdown" badge={byType.length}>
        <DataTable
          cols={txnTypeCols}
          rows={byType}
          loading={loading}
          emptyIcon="receipt_long"
          emptyMsg="No transaction data"
        />
      </SectionCard>
    </Page>
  )
}
