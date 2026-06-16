import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef,
  DateFilter, DonutCard, BarChartCard,
  ErrBanner, StatusBadge, NAVY, RED, GREEN,
} from '../../components/UI'

interface CardRow {
  cif: string
  name: string
  product: string
  status: string
  card_type: string
  account_manager: string
  created_date: string
  state: string
}

export default function CardManagement() {
  const [from, setFrom]           = useState(monthStart())
  const [to, setTo]               = useState(today())
  const [kpis, setKpis]           = useState<any>(null)
  const [byProduct, setByProduct] = useState<any[]>([])
  const [byStatus, setByStatus]   = useState<any[]>([])
  const [byType, setByType]       = useState<any[]>([])
  const [cards, setCards]         = useState<CardRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const [k, bp, bs, vt] = await Promise.all([
        apiFetch(`/api/cards/kpis?${qs}`),
        apiFetch(`/api/cards/by-product?${qs}`),
        apiFetch(`/api/cards/by-status?${qs}`),
        apiFetch(`/api/cards/volume-by-type?${qs}`),
      ])
      setKpis(k.data ?? k)
      setByProduct(bp.data ?? [])
      setByStatus(bs.data ?? [])
      setByType(vt.data ?? [])
      // cards table — load from sales cards endpoint
      const salesCards = await apiFetch(`/api/sales/cards?${qs}&limit=500`).catch(() => ({ data: [] }))
      setCards(salesCards.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const k = kpis ?? {}

  const filtered = cards.filter(c => {
    const matchSearch = !search ||
      c.name?.toLowerCase().includes(search.toLowerCase()) ||
      c.cif?.toLowerCase().includes(search.toLowerCase()) ||
      c.account_manager?.toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || c.status?.toLowerCase() === statusFilter
    return matchSearch && matchStatus
  })

  const statusOptions = ['all', ...Array.from(new Set(cards.map(c => (c.status || '').toLowerCase()).filter(Boolean)))]

  const cols: ColDef<CardRow>[] = [
    { key: 'cif',             label: 'CIF',       sortable: false },
    { key: 'name',            label: 'Customer' },
    { key: 'product',         label: 'Product' },
    { key: 'card_type',       label: 'Type',      render: r => (
        <span className="text-[12px] font-medium px-2 py-0.5 rounded"
          style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}>
          {r.card_type || '—'}
        </span>
      )},
    { key: 'status',          label: 'Status',    render: r => <StatusBadge status={r.status || 'inactive'} /> },
    { key: 'account_manager', label: 'Officer' },
    { key: 'state',           label: 'State' },
    { key: 'created_date',    label: 'Issued',    render: r => fmtDate(r.created_date) },
  ]

  return (
    <Page dept="Cards & Ops" title="Card Management" subtitle="Full card portfolio view"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />}>
      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Cards"    value={fmtNum(k.total_cards)}    icon="credit_card"  accent={NAVY}    />
        <KpiCard loading={loading} label="Active"         value={fmtNum(k.active_cards)}   icon="check_circle" accent={GREEN}   />
        <KpiCard loading={loading} label="Inactive"       value={fmtNum(k.inactive_cards)} icon="cancel"       accent="#64748B" />
        <KpiCard loading={loading} label="New This Period" value={fmtNum(k.new_cards)}     icon="add_card"     accent={RED}     />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <DonutCard title="By Product"  data={byProduct} nameKey="product" valueKey="count" loading={loading} />
        <DonutCard title="By Status"   data={byStatus}  nameKey="status"  valueKey="count" loading={loading} />
        <BarChartCard title="Volume by Card Type" data={byType} xKey="type" barKey="count" height={180} loading={loading} />
      </div>

      <SectionCard title="Card Portfolio" badge={filtered.length}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400">search</span>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] outline-none w-44"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
              {statusOptions.map(s => (
                <option key={s} value={s}>{s === 'all' ? 'All Statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </div>
        }>
        <DataTable cols={cols} rows={filtered} loading={loading}
          emptyMsg="No cards found" emptyIcon="credit_card_off" />
      </SectionCard>
    </Page>
  )
}
