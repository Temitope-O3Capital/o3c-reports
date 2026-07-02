import { useState, useEffect, useCallback } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef,
  DateFilter, StatusBadge, ErrBanner, Spinner,
  NAVY, RED, GREEN, BLUE,
} from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmt, fmtNum, fmtDate, n, today, yearStart } from '../../lib/fmt'

/* ── Types ─────────────────────────────────────────────────────── */

interface FDTransaction {
  id: number
  transaction_date: string
  customer_name: string
  transaction_type: 'inflow' | 'liquidation'
  principal?: number
  interest_paid?: number
  gross_amount?: number
  usd_amount?: number
  ngn_amount?: number
  currency: string
  location?: string
  account_officer?: string
  maturity_date?: string
  tenor_days?: number
  rate?: number
  notes?: string
}

interface FDSummary {
  inflow_count: number
  liquidation_count: number
  total_inflow_ngn: number
  total_inflow_usd: number
  total_liquidated: number
  total_principal: number
  total_interest: number
  total_transactions: number
  net_position: number
}

interface TrendRow {
  label: string
  inflow: number
  liquidation: number
  inflow_count: number
  liquidation_count: number
}

interface LocationRow {
  location: string
  inflow_count: number
  liquidation_count: number
  total_inflow: number
  total_liquidated: number
}

interface OfficerRow {
  account_officer: string
  inflow_count: number
  liquidation_count: number
  total_inflow: number
  total_liquidated: number
}

/* ── Constants ─────────────────────────────────────────────────── */

const TABS      = ['Dashboard', 'Transactions', 'By Officer']
const LOCATIONS = ['Lagos', 'Abuja']

/* ── Transaction Drawer ─────────────────────────────────────────── */

type FormState = {
  transaction_date: string
  customer_name: string
  transaction_type: string
  principal: string
  interest_paid: string
  gross_amount: string
  usd_amount: string
  ngn_amount: string
  currency: string
  location: string
  account_officer: string
  maturity_date: string
  tenor_days: string
  rate: string
  notes: string
}

interface TxnDrawerProps {
  initial?: FDTransaction | null
  onClose: () => void
  onSaved: () => void
}

function TxnDrawer({ initial, onClose, onSaved }: TxnDrawerProps) {
  const blank: FormState = {
    transaction_date: today(),
    customer_name: '',
    transaction_type: 'inflow',
    principal: '',
    interest_paid: '',
    gross_amount: '',
    usd_amount: '',
    ngn_amount: '',
    currency: 'NGN',
    location: 'Lagos',
    account_officer: '',
    maturity_date: '',
    tenor_days: '',
    rate: '',
    notes: '',
  }

  const toForm = (t: FDTransaction): FormState => ({
    transaction_date: t.transaction_date ?? '',
    customer_name:    t.customer_name ?? '',
    transaction_type: t.transaction_type ?? 'inflow',
    principal:        t.principal != null    ? String(t.principal)     : '',
    interest_paid:    t.interest_paid != null ? String(t.interest_paid) : '',
    gross_amount:     t.gross_amount != null  ? String(t.gross_amount)  : '',
    usd_amount:       t.usd_amount != null    ? String(t.usd_amount)    : '',
    ngn_amount:       t.ngn_amount != null    ? String(t.ngn_amount)    : '',
    currency:         t.currency ?? 'NGN',
    location:         t.location ?? 'Lagos',
    account_officer:  t.account_officer ?? '',
    maturity_date:    t.maturity_date ?? '',
    tenor_days:       t.tenor_days != null ? String(t.tenor_days) : '',
    rate:             t.rate != null     ? String(t.rate)     : '',
    notes:            t.notes ?? '',
  })

  const [form, setForm]   = useState<FormState>(initial ? toForm(initial) : blank)
  const [saving, setSaving] = useState(false)
  const [err,    setErr]    = useState('')

  function setF(k: keyof FormState, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setErr('')
    try {
      const payload: Record<string, unknown> = { ...form }
      for (const k of ['principal', 'interest_paid', 'gross_amount', 'usd_amount', 'ngn_amount', 'rate']) {
        payload[k] = payload[k] !== '' ? Number(payload[k]) : null
      }
      payload.tenor_days = form.tenor_days !== '' ? Number(form.tenor_days) : null
      if (form.maturity_date === '') payload.maturity_date = null

      if (initial?.id) {
        await apiPut(`/api/fixed-deposit/transactions/${initial.id}`, payload)
      } else {
        await apiPost('/api/fixed-deposit/transactions', payload)
      }
      onSaved(); onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  const inp = (label: string, key: keyof FormState, type = 'text', opts: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={form[key]} onChange={e => setF(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} {...opts} />
    </div>
  )

  const selF = (label: string, key: keyof FormState, opts: { value: string; label: string }[]) => (
    <div>
      <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>{label}</label>
      <select value={form[key]} onChange={e => setF(key, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}>
        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )

  function Sec({ title }: { title: string }) {
    return (
      <div className="col-span-2 mt-4">
        <p className="text-[11px] font-bold uppercase tracking-widest pb-2"
          style={{ color: 'var(--txt2)', borderBottom: '1px solid var(--bdr)' }}>{title}</p>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-40" onClick={onClose} style={{ background: 'rgba(0,0,0,0.3)' }}>
      <div className="absolute right-0 top-0 h-full w-[480px] shadow-2xl overflow-y-auto flex flex-col" style={{ background: 'var(--card)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[15px] font-semibold" style={{ color: 'var(--txt)' }}>
                {initial?.id ? 'Edit Transaction' : 'Book FD Transaction'}
              </h3>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Fixed Deposit</p>
            </div>
            <button onClick={onClose}>
              <span className="material-symbols-rounded text-[20px]" style={{ color: 'var(--txt2)' }}>close</span>
            </button>
          </div>
        </div>

        <form className="flex-1 px-6 py-5 overflow-y-auto" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-4">
            <Sec title="Transaction Details" />
            {inp('Date', 'transaction_date', 'date')}
            {selF('Type', 'transaction_type', [
              { value: 'inflow',      label: 'Inflow (New Deposit)' },
              { value: 'liquidation', label: 'Liquidation (Matured)' },
            ])}
            <div className="col-span-2">
              {inp('Customer Name', 'customer_name', 'text', { required: true, placeholder: 'Full name or company' })}
            </div>
            {selF('Currency', 'currency', ['NGN', 'USD'].map(c => ({ value: c, label: c })))}
            {selF('Location', 'location', [{ value: '', label: '— Select —' }, ...LOCATIONS.map(l => ({ value: l, label: l }))])}
            {inp('Account Officer', 'account_officer')}
            {inp('Maturity Date', 'maturity_date', 'date')}

            <Sec title="Amounts" />
            {inp('Principal', 'principal', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {inp('Interest Paid', 'interest_paid', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {inp('Gross Amount', 'gross_amount', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {inp('NGN Amount', 'ngn_amount', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}
            {inp('USD Amount', 'usd_amount', 'number', { placeholder: '0.00', min: 0, step: 0.01 })}

            <Sec title="Terms" />
            {inp('Tenor (days)', 'tenor_days', 'number', { placeholder: '0', min: 1 })}
            {inp('Rate (% p.a.)', 'rate', 'number', { placeholder: '0.00', step: 0.01 })}

            <div className="col-span-2 mt-2">
              <label className="block text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--txt2)' }}>Notes</label>
              <textarea value={form.notes} onChange={e => setF('notes', e.target.value)}
                rows={3} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-y"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
            </div>
          </div>
          {err && <ErrBanner msg={err} />}
        </form>

        <div className="flex-shrink-0 px-6 py-4 flex justify-end gap-3"
          style={{ borderTop: '1px solid var(--bdr)' }}>
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-[13px] font-medium rounded-lg border"
            style={{ color: 'var(--txt2)', borderColor: 'var(--bdr)' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            className="px-4 py-2 text-[13px] font-semibold text-white rounded-lg flex items-center gap-1.5 disabled:opacity-60"
            style={{ background: NAVY }}>
            {saving ? <><Spinner size={14} />Saving…</> : <>{initial?.id ? 'Update' : 'Book Transaction'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Tab: Dashboard ─────────────────────────────────────────────── */

function DashboardTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [summary, setSummary]  = useState<FDSummary | null>(null)
  const [trend,   setTrend]    = useState<TrendRow[]>([])
  const [byLoc,   setByLoc]    = useState<LocationRow[]>([])
  const [loading, setLoading]  = useState(false)
  const [err,     setErr]      = useState('')

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = `date_from=${dateFrom}&date_to=${dateTo}`
      const [rSum, rTr, rLoc] = await Promise.allSettled([
        apiFetch<FDSummary>(`/api/fixed-deposit/summary?${p}`),
        apiFetch<TrendRow[]>(`/api/fixed-deposit/trend?${p}`),
        apiFetch<LocationRow[]>(`/api/fixed-deposit/by-location?${p}`),
      ])
      if (rSum.status === 'fulfilled') setSummary(rSum.value)
      if (rTr.status === 'fulfilled') setTrend(Array.isArray(rTr.value) ? rTr.value : [])
      if (rLoc.status === 'fulfilled') setByLoc(Array.isArray(rLoc.value) ? rLoc.value : [])
      if ([rSum, rTr, rLoc].every(r => r.status === 'rejected')) setErr('Failed to load')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="flex items-center gap-3 py-16" style={{ color: 'var(--txt2)' }}><Spinner />Loading dashboard…</div>

  const s         = summary
  const netPos    = n(s?.net_position)
  const maxTrend  = Math.max(...trend.flatMap(r => [n(r.inflow), n(r.liquidation)]), 1)

  return (
    <div className="space-y-5">
      <ErrBanner msg={err} />
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Inflows"      value={fmt(s?.total_inflow_ngn)}    icon="arrow_downward"       accent={GREEN}  loading={!s}
          sub={`${fmtNum(s?.inflow_count)} transactions`} />
        <KpiCard label="Total Liquidations" value={fmt(s?.total_liquidated)}    icon="arrow_upward"         accent={RED}    loading={!s}
          sub={`${fmtNum(s?.liquidation_count)} transactions`} />
        <KpiCard label="Total Interest"     value={fmt(s?.total_interest)}      icon="percent"              accent="#8B5CF6" loading={!s} />
        <KpiCard label="USD Inflows"        value={`$${fmtNum(s?.total_inflow_usd)}`} icon="currency_exchange" accent={BLUE}  loading={!s} />
        <KpiCard label="Net Position"       value={fmt(netPos)}                 icon="account_balance_wallet"
          accent={netPos >= 0 ? GREEN : RED} sub="Inflows minus liquidations" loading={!s} />
        <KpiCard label="All Transactions"   value={fmtNum(s?.total_transactions)} icon="receipt_long"       accent={NAVY}   loading={!s} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <SectionCard title="Monthly Trend" subtitle="Inflows vs Liquidations">
            <div className="px-5 py-4 space-y-3">
              {trend.length === 0
                ? <p className="text-[13px] text-center py-8" style={{ color: 'var(--txt2)' }}>No trend data in this period</p>
                : trend.map((row, i) => (
                    <div key={i}>
                      <div className="flex justify-between mb-1.5">
                        <span className="text-[12px] font-semibold" style={{ color: 'var(--txt2)' }}>{row.label}</span>
                        <div className="flex gap-4">
                          <span className="text-[11px] tabular-nums" style={{ color: GREEN }}>+{fmt(row.inflow)}</span>
                          <span className="text-[11px] tabular-nums" style={{ color: RED }}>−{fmt(row.liquidation)}</span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <div className="h-2 rounded-sm flex-1 overflow-hidden" style={{ background: 'rgba(5,150,105,0.12)' }}>
                          <div className="h-full rounded-sm" style={{ width: `${(n(row.inflow) / maxTrend) * 100}%`, background: GREEN }} />
                        </div>
                        <div className="h-2 rounded-sm flex-1 overflow-hidden" style={{ background: 'rgba(192,0,0,0.08)' }}>
                          <div className="h-full rounded-sm" style={{ width: `${(n(row.liquidation) / maxTrend) * 100}%`, background: RED }} />
                        </div>
                      </div>
                    </div>
                  ))
              }
              <div className="flex gap-5 pt-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ background: GREEN }} />
                  <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>Inflow</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ background: RED }} />
                  <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>Liquidation</span>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>

        <SectionCard title="By Location">
          <div className="px-5 py-4 space-y-5">
            {byLoc.length === 0
              ? <p className="text-[13px] text-center py-8" style={{ color: 'var(--txt2)' }}>No location data</p>
              : byLoc.map((loc, i) => {
                  const total = n(loc.total_inflow) + n(loc.total_liquidated)
                  return (
                    <div key={i}>
                      <div className="flex justify-between mb-1.5">
                        <span className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>{loc.location}</span>
                        <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{fmtNum(n(loc.inflow_count) + n(loc.liquidation_count))} txn</span>
                      </div>
                      {total > 0 && (
                        <div className="flex gap-1 h-2">
                          <div className="rounded-sm" style={{
                            flex: n(loc.total_inflow), background: GREEN, opacity: 0.85,
                          }} />
                          <div className="rounded-sm" style={{
                            flex: n(loc.total_liquidated), background: RED, opacity: 0.75,
                          }} />
                        </div>
                      )}
                      <div className="flex justify-between mt-1.5">
                        <span className="text-[11px]" style={{ color: GREEN }}>{fmt(loc.total_inflow)} in</span>
                        <span className="text-[11px]" style={{ color: RED }}>{fmt(loc.total_liquidated)} out</span>
                      </div>
                    </div>
                  )
                })
            }
          </div>
        </SectionCard>
      </div>
    </div>
  )
}

/* ── Tab: Transactions ──────────────────────────────────────────── */

function TransactionsTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [rows,     setRows]     = useState<FDTransaction[]>([])
  const [total,    setTotal]    = useState(0)
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')
  const [offset,   setOffset]   = useState(0)
  const [search,   setSearch]   = useState('')
  const [typeF,    setTypeF]    = useState('')
  const [locF,     setLocF]     = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editRow,    setEditRow]    = useState<FDTransaction | null>(null)
  const LIMIT = 200

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const p = new URLSearchParams({ limit: String(LIMIT), offset: String(offset), date_from: dateFrom, date_to: dateTo })
      if (typeF)  p.set('type', typeF)
      if (locF)   p.set('location', locF)
      if (search) p.set('q', search)
      const data = await apiFetch<{ data: FDTransaction[]; total: number }>(`/api/fixed-deposit/transactions?${p}`)
      setRows(Array.isArray(data.data) ? data.data : [])
      setTotal(Number(data.total ?? 0))
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Load failed')
    } finally { setLoading(false) }
  }, [typeF, locF, search, offset, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function deleteTxn(id: number) {
    if (!confirm('Delete this transaction?')) return
    await apiDelete(`/api/fixed-deposit/transactions/${id}`)
    load()
  }

  const cols: ColDef<FDTransaction>[] = [
    { key: 'transaction_date', label: 'Date', render: r => <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>{fmtDate(r.transaction_date)}</span> },
    { key: 'customer_name',    label: 'Customer', render: r => <span className="font-medium max-w-[140px] truncate block" style={{ color: 'var(--txt)' }}>{r.customer_name}</span> },
    { key: 'transaction_type', label: 'Type', render: r => <StatusBadge status={r.transaction_type} /> },
    { key: 'ngn_amount',       label: 'NGN Amount', right: true, render: r => <span className="tabular-nums font-semibold text-[13px]">{r.ngn_amount ? fmt(r.ngn_amount) : '—'}</span> },
    { key: 'principal',        label: 'Principal',  right: true, render: r => <span className="tabular-nums text-[13px]">{r.principal ? fmt(r.principal) : '—'}</span> },
    { key: 'interest_paid',    label: 'Interest',   right: true, render: r => <span className="tabular-nums text-[13px]" style={{ color: '#8B5CF6' }}>{r.interest_paid ? fmt(r.interest_paid) : '—'}</span> },
    { key: 'gross_amount',     label: 'Gross',      right: true, render: r => <span className="tabular-nums text-[13px]">{r.gross_amount ? fmt(r.gross_amount) : '—'}</span> },
    { key: 'currency',         label: 'CCY', render: r => (
      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
        style={{ background: r.currency === 'USD' ? '#EFF6FF' : '#F0FDF4', color: r.currency === 'USD' ? BLUE : GREEN }}>
        {r.currency || 'NGN'}
      </span>
    )},
    { key: 'rate',             label: 'Rate', render: r => <span className="text-[12px] tabular-nums" style={{ color: 'var(--txt2)' }}>{r.rate ? `${r.rate}%` : '—'}</span> },
    { key: 'tenor_days',       label: 'Tenor', render: r => <span className="text-[12px] tabular-nums" style={{ color: 'var(--txt2)' }}>{r.tenor_days ? `${r.tenor_days}d` : '—'}</span> },
    { key: 'maturity_date',    label: 'Maturity', render: r => <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>{r.maturity_date ? fmtDate(r.maturity_date) : '—'}</span> },
    { key: 'location',         label: 'Location', render: r => <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.location || '—'}</span> },
    { key: 'account_officer',  label: 'Officer',  render: r => <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.account_officer || '—'}</span> },
    { key: '_actions', label: '', sortable: false, render: r => (
      <div className="flex gap-1">
        <button onClick={() => { setEditRow(r); setDrawerOpen(true) }} className="p-1 rounded" style={{ color: 'var(--txt2)' }}>
          <span className="material-symbols-rounded text-[16px]">edit</span>
        </button>
        <button onClick={() => deleteTxn(r.id)} className="p-1 rounded" style={{ color: RED }}>
          <span className="material-symbols-rounded text-[16px]">delete</span>
        </button>
      </div>
    )},
  ]

  return (
    <div>
      <ErrBanner msg={err} />
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] pointer-events-none" style={{ color: 'var(--txt2)' }}>search</span>
            <input
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[13px] outline-none w-48"
              style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              placeholder="Customer name…"
              value={search}
              onChange={e => { setSearch(e.target.value); setOffset(0) }}
            />
          </div>
          <select value={typeF} onChange={e => { setTypeF(e.target.value); setOffset(0) }}
            className="px-3 py-1.5 rounded-lg border text-[13px] outline-none"
            style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: typeF ? NAVY : 'var(--txt2)' }}>
            <option value="">All Types</option>
            <option value="inflow">Inflow</option>
            <option value="liquidation">Liquidation</option>
          </select>
          <select value={locF} onChange={e => { setLocF(e.target.value); setOffset(0) }}
            className="px-3 py-1.5 rounded-lg border text-[13px] outline-none"
            style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: locF ? NAVY : 'var(--txt2)' }}>
            <option value="">All Locations</option>
            {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button onClick={() => { setEditRow(null); setDrawerOpen(true) }}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[17px]">add</span>
          Book Transaction
        </button>
      </div>

      <SectionCard title={`${total.toLocaleString()} transactions`}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="savings" emptyMsg="No transactions found" />
        {total > LIMIT && (
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
            <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}</p>
            <div className="flex gap-2">
              <button onClick={() => setOffset(o => Math.max(0, o - LIMIT))} disabled={offset === 0}
                className="p-1.5 rounded-lg border disabled:opacity-40" style={{ borderColor: 'var(--bdr)' }}>
                <span className="material-symbols-rounded text-[16px]">chevron_left</span>
              </button>
              <button onClick={() => setOffset(o => o + LIMIT)} disabled={offset + LIMIT >= total}
                className="p-1.5 rounded-lg border disabled:opacity-40" style={{ borderColor: 'var(--bdr)' }}>
                <span className="material-symbols-rounded text-[16px]">chevron_right</span>
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {drawerOpen && (
        <TxnDrawer
          initial={editRow}
          onClose={() => { setDrawerOpen(false); setEditRow(null) }}
          onSaved={load}
        />
      )}
    </div>
  )
}

/* ── Tab: By Officer ────────────────────────────────────────────── */

function ByOfficerTab({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const [rows,    setRows]    = useState<OfficerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState('')

  useEffect(() => {
    setLoading(true); setErr('')
    apiFetch<OfficerRow[]>(`/api/fixed-deposit/by-officer?date_from=${dateFrom}&date_to=${dateTo}`)
      .then(d => setRows(Array.isArray(d) ? d : []))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  const maxInflow = Math.max(...rows.map(r => n(r.total_inflow)), 1)

  const cols: ColDef<OfficerRow>[] = [
    { key: 'account_officer', label: 'Account Officer', render: r => <span className="font-medium" style={{ color: 'var(--txt)' }}>{r.account_officer || '—'}</span> },
    { key: 'inflow_count',      label: 'Inflows',         right: true, render: r => <span className="tabular-nums">{fmtNum(r.inflow_count)}</span> },
    { key: 'total_inflow',      label: 'Total Inflow',    right: true, render: r => <span className="tabular-nums font-semibold" style={{ color: GREEN }}>{fmt(r.total_inflow)}</span> },
    { key: 'liquidation_count', label: 'Liquidations',    right: true, render: r => <span className="tabular-nums">{fmtNum(r.liquidation_count)}</span> },
    { key: 'total_liquidated',  label: 'Total Liquidated',right: true, render: r => <span className="tabular-nums font-semibold" style={{ color: RED }}>{fmt(r.total_liquidated)}</span> },
    { key: '_share', label: 'Share', sortable: false, render: r => (
      <div className="w-32 h-1.5 rounded-full" style={{ background: 'var(--chip-bg)' }}>
        <div className="h-full rounded-full" style={{ width: `${(n(r.total_inflow) / maxInflow) * 100}%`, background: GREEN }} />
      </div>
    )},
  ]

  return (
    <div>
      <ErrBanner msg={err} />
      <SectionCard title="Performance by Account Officer">
        <DataTable cols={cols} rows={rows} loading={loading} emptyMsg="No officer data" />
      </SectionCard>
    </div>
  )
}

/* ── Main Page ──────────────────────────────────────────────────── */

export default function FixedDeposit() {
  const [tab,      setTab]      = useState(0)
  const [dateFrom, setDateFrom] = useState(yearStart())
  const [dateTo,   setDateTo]   = useState(today())

  return (
    <Page
      dept="Operations"
      title="Fixed Deposit"
      subtitle="Track inflows, liquidations, and FD portfolio performance"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
      }
    >
      <div className="flex gap-0 mb-5 border-b" style={{ borderColor: 'var(--bdr)' }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)}
            className="px-4 py-2.5 text-[13px] font-medium transition-colors"
            style={{
              borderBottom: tab === i ? `2px solid ${NAVY}` : '2px solid transparent',
              color: tab === i ? NAVY : '#64748B',
              marginBottom: '-1px',
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === 0 && <DashboardTab    dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 1 && <TransactionsTab dateFrom={dateFrom} dateTo={dateTo} />}
      {tab === 2 && <ByOfficerTab    dateFrom={dateFrom} dateTo={dateTo} />}
    </Page>
  )
}
