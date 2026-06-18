import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, BarChartCard, DonutCard, ProgressList,
  ErrBanner, ExportBtn, Sk, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

export default function Overview() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [kpis, setKpis] = useState<any>(null)
  const [volume, setVolume] = useState<any[]>([])
  const [accounts, setAccounts] = useState<any[]>([])
  const [byProduct, setByProduct] = useState<any[]>([])
  const [byType, setByType] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const [k, vol, acct, prod, typ] = await Promise.all([
        apiFetch(`/api/overview/kpis?${qs}`),
        apiFetch(`/api/overview/monthly-volume?${qs}`),
        apiFetch(`/api/overview/new-accounts-trend?${qs}`),
        apiFetch(`/api/overview/cards-by-product?${qs}`),
        apiFetch(`/api/overview/txn-by-type?${qs}`),
      ])
      setKpis(k.data ?? k)
      setVolume(vol.data ?? vol)
      setAccounts(acct.data ?? acct)
      setByProduct(prod.data ?? prod)
      setByType(typ.data ?? typ)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  const txnTypeCols = [
    { key: 'Description', label: 'Type' },
    { key: 'count', label: 'Count', right: true, render: (r: any) => fmtNum(r.count) },
    { key: 'volume', label: 'Volume', right: true, render: (r: any) => fmt(r.volume) },
  ]

  const productDonut = byProduct.slice(0, 6).map((r: any) => ({
    name: r['Product Name'] ?? r.Product_Name ?? r.product_name ?? 'Unknown',
    count: n(r.count),
  }))

  return (
    <Page dept="Finance" title="Overview"
      subtitle="Executive dashboard — all O3 Capital business units"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              await apiExport(`/api/transactions/export?date_from=${from}&date_to=${to}`, 'overview')
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      {/* ── Financial KPIs ── */}
      <div className="mb-2">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Financial Performance</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <KpiCard loading={loading} label="Total Txn Volume" value={fmt(d.total_txn_volume)} icon="payments" accent={NAVY} />
          <KpiCard loading={loading} label="Total Collected" value={fmt(d.total_collected)} icon="account_balance_wallet" accent={GREEN} />
          <KpiCard loading={loading} label="Collections MTD" value={fmt(d.collections_mtd)} icon="calendar_month" accent={RED} />
          <KpiCard loading={loading} label="Total Recovered" value={fmt(d.total_recovered)} icon="gavel" accent={AMBER} />
        </div>
      </div>

      {/* ── Growth KPIs ── */}
      <div className="mb-5">
        <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">Growth & Acquisition</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard loading={loading} label="Total Cardholders" value={fmtNum(d.total_cardholders)} icon="groups" accent={NAVY} />
          <KpiCard loading={loading} label="Active Accounts" value={fmtNum(d.active_accounts)} icon="credit_card" accent={GREEN} />
          <KpiCard loading={loading} label="Total Cards Issued" value={fmtNum(d.total_cards_issued)} icon="style" accent={BLUE} />
          <KpiCard loading={loading} label="New Accounts MTD" value={fmtNum(d.new_accounts_mtd)} icon="person_add" accent={RED} />
        </div>
      </div>

      {/* ── Charts row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Transaction Volume"
            subtitle="Last 12 months"
            data={volume}
            xKey="month"
            areaKey="volume"
            color={NAVY}
            currency
            height={220}
            loading={loading}
          />
        </div>
        <DonutCard
          title="Cards by Product"
          subtitle="All time"
          data={productDonut}
          nameKey="name"
          valueKey="count"
          loading={loading}
        />
      </div>

      {/* ── New Accounts trend + Transaction types ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="New Account Acquisition"
            subtitle="Monthly trend"
            data={accounts}
            xKey="month"
            areaKey="new_accounts"
            color={RED}
            height={200}
            loading={loading}
          />
        </div>
        <ProgressList
          title="Top Transaction Types"
          subtitle="By count"
          data={byType.slice(0, 8).map((r: any) => ({ label: r.Description, count: n(r.count) }))}
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
