import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  BarChartCard, DonutCard, StatusBadge,
  ErrBanner, ExportBtn, Sk, ColDef, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

const CARD_TYPES = ['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts']

/* Status colour map for progress bars */
const STATUS_COLOR: Record<string, string> = {
  open:         GREEN,
  active:       GREEN,
  terminated:   RED,
  'legal acti': '#7C3AED',
  inactive:     '#94A3B8',
  suspended:    AMBER,
  closed:       '#475569',
}
function statusBarColor(s: string) {
  return STATUS_COLOR[(s || '').toLowerCase()] ?? '#94A3B8'
}

/* Status breakdown panel */
function StatusBreakdown({ data, loading }: { data: any[]; loading: boolean }) {
  const total = data.reduce((s, r) => s + n(r.count), 0)
  return (
    <SectionCard title="Cards by Account Status" subtitle="Current portfolio composition">
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="space-y-1.5"><Sk w="w-24" /><Sk h="h-1.5" /></div>)
          : data.length === 0
          ? <p className="text-[13px] text-slate-400 py-8 text-center">No data</p>
          : data.map((row, i) => {
              const status = row['Account Status'] || row.status || ''
              const count  = n(row.count)
              const share  = total > 0 ? (count / total) * 100 : 0
              const color  = statusBarColor(status)
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <StatusBadge status={status.toLowerCase() === 'open' ? 'active' : status} />
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400">{share.toFixed(1)}%</span>
                      <span className="kpi-number text-[14px] font-bold text-slate-800">{count.toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${share}%`, background: color }} />
                  </div>
                </div>
              )
            })}
      </div>
    </SectionCard>
  )
}

export default function CardsIssuance() {
  const [from,      setFrom]      = useState(monthStart())
  const [to,        setTo]        = useState(today())
  const [cardType,  setCardType]  = useState('')

  const [kpis,      setKpis]      = useState<any>(null)
  const [byStatus,  setByStatus]  = useState<any[]>([])
  const [byProd,    setByProd]    = useState<any[]>([])
  const [volByType, setVolByType] = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams()
      p.set('date_from', from); p.set('date_to', to)
      if (cardType) p.set('card_type', cardType)
      const qs = `?${p}`
      const dqs = `?date_from=${from}&date_to=${to}`

      const [rK, rBs, rBp, rVt] = await Promise.allSettled([
        apiFetch(`/api/cards/kpis${qs}`),
        apiFetch('/api/cards/by-status'),
        apiFetch('/api/cards/by-product'),
        apiFetch(`/api/cards/volume-by-type${qs}`),
      ])
      if (rK.status === 'fulfilled') setKpis(rK.value.data || {})
      if (rBs.status === 'fulfilled') setByStatus(rBs.value.data || [])
      if (rBp.status === 'fulfilled') setByProd(rBp.value.data || [])
      if (rVt.status === 'fulfilled') setVolByType(rVt.value.data || [])
      if ([rK, rBs, rBp, rVt].every(r => r.status === 'rejected')) setError((rK as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to, cardType])

  useEffect(() => { load() }, [load])

  const d = kpis || {}
  const prodTotal = byProd.reduce((s, r) => s + n(r.count), 0)
  const volTotal  = volByType.reduce((s, r) => s + n(r.volume), 0)

  const PRODUCT_KPI = [
    { key: 'prep',             label: 'PREP',        icon: 'wallet',      color: NAVY },
    { key: 'amex_naira',       label: 'Amex Naira',  icon: 'payments',    color: RED },
    { key: 'amex_usd',         label: 'Amex USD',    icon: 'language',    color: AMBER },
    { key: 'classic_accounts', label: 'Classic',     icon: 'credit_card', color: '#6366F1' },
  ]

  const volTableCols: ColDef<any>[] = [
    { key: 'Product Name', label: 'Card Type' },
    { key: 'txn_count', label: 'Transactions', right: true, render: r => fmtNum(r.txn_count) },
    { key: 'volume', label: 'Volume', right: true, render: r => fmt(r.volume) },
    { key: '_share', label: 'Share', right: true, sortable: false,
      render: r => (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded"
          style={{ background: 'rgba(15,23,42,0.06)', color: '#475569' }}>
          {volTotal > 0 ? ((n(r.volume) / volTotal) * 100).toFixed(1) : '0.0'}%
        </span>
      )
    },
  ]

  const prodTableCols: ColDef<any>[] = [
    { key: 'Product Name', label: 'Product' },
    { key: 'count', label: 'Cards Issued', right: true, render: r => fmtNum(r.count) },
    { key: '_share', label: 'Share', right: true, sortable: false,
      render: r => (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded"
          style={{ background: 'rgba(15,23,42,0.06)', color: '#475569' }}>
          {prodTotal > 0 ? ((n(r.count) / prodTotal) * 100).toFixed(1) : '0.0'}%
        </span>
      )
    },
  ]

  async function doExport() {
    setExporting(true)
    try {
      const { apiExport } = await import('../../lib/api')
      const qs = `?date_from=${from}&date_to=${to}${cardType ? `&card_type=${cardType}` : ''}`
      await apiExport(`/api/cards/volume-by-type${qs}`, 'cards_volume')
    } finally { setExporting(false) }
  }

  return (
    <Page dept="Sales" title="Card Issuance"
      subtitle="Issuance pipeline, product mix, and cardholder activity"
      actions={
        <div className="flex items-center gap-2 flex-wrap">
          <ExportBtn onClick={doExport} loading={exporting} />
          {/* Card type filter */}
          <div className="flex rounded-lg overflow-hidden text-[11px] font-semibold"
            style={{ border: '1px solid rgba(15,23,42,0.15)' }}>
            <button
              onClick={() => setCardType('')}
              className="px-3 py-1.5 transition-colors"
              style={{ background: !cardType ? NAVY : 'white', color: !cardType ? '#fff' : '#64748B' }}>
              All
            </button>
            {CARD_TYPES.map(t => (
              <button key={t}
                onClick={() => setCardType(cardType === t ? '' : t)}
                className="px-3 py-1.5 transition-colors border-l"
                style={{
                  borderColor: 'rgba(15,23,42,0.12)',
                  background: cardType === t ? NAVY : 'white',
                  color: cardType === t ? '#fff' : '#64748B',
                }}>
                {t}
              </button>
            ))}
          </div>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
        </div>
      }>
      <ErrBanner msg={error} />

      {/* KPI Row 1 — portfolio health */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Issued"      value={fmtNum(d.total_issued)}   icon="credit_card"  accent={NAVY} loading={loading} />
        <KpiCard label="Active"            value={fmtNum(d.active)}         icon="check_circle" accent={GREEN}
          sub={`${fmtPct(d.activation_rate)} activation rate`} loading={loading} />
        <KpiCard label="Inactive"          value={fmtNum(d.inactive)}       icon="cancel"       accent={RED} loading={loading} />
        <KpiCard label="Unique Merchants"  value={fmtNum(d.unique_merchants)} icon="storefront" accent={AMBER} loading={loading} />
      </div>

      {/* KPI Row 2 — per-product */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        {PRODUCT_KPI.map(p => (
          <KpiCard key={p.key} label={p.label} value={fmtNum(d[p.key])} icon={p.icon}
            accent={p.color} loading={loading} />
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <StatusBreakdown data={byStatus} loading={loading} />
        <BarChartCard
          title="Transaction Volume by Card Type"
          subtitle={`${from} – ${to}`}
          data={volByType}
          xKey="Product Name"
          barKey="volume"
          color={NAVY}
          currency
          height={240}
          loading={loading}
        />
      </div>

      {/* Volume by type table */}
      {(volByType.length > 0 || loading) && (
        <div className="mt-4">
          <SectionCard title="Spend by Card Type" subtitle={`${from} – ${to}`}>
            <DataTable cols={volTableCols} rows={volByType} loading={loading}
              emptyIcon="credit_card" emptyMsg="No volume data" />
          </SectionCard>
        </div>
      )}

      {/* Product breakdown table */}
      <div className="mt-4">
        <SectionCard title="Product Breakdown" subtitle="All-time issuance by product">
          <DataTable cols={prodTableCols} rows={byProd} loading={loading}
            emptyIcon="inventory_2" emptyMsg="No product data" />
        </SectionCard>
      </div>
    </Page>
  )
}
