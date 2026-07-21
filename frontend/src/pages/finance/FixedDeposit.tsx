import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, filterInputStyle, SearchInput, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtPct, today, monthStart } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM, INTER, SORA, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FDRecord {
  id: number
  transaction_date: string
  customer_name: string
  transaction_type: 'inflow' | 'liquidation'
  principal: number
  interest_paid: number
  gross_amount: number
  usd_amount: number
  ngn_amount: number
  currency: string
  location: string
  account_officer: string
  maturity_date: string
  tenor_days: number
  rate: number
  notes: string
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

interface FDKPIs {
  total_fds: number
  total_principal_kobo: number
  avg_rate_pct: number
  maturing_this_month: number
}

interface TrendPoint { month: string; inflow: number; liquidation: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysToMaturity(maturity: string): number {
  const diff = new Date(maturity).getTime() - Date.now()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

function daysColor(days: number): string {
  if (days < 0) return RED
  if (days <= 7) return AMBER
  return GREEN
}

// ── Table columns ─────────────────────────────────────────────────────────────

const COLS: TableCol<FDRecord>[] = [
  { key: 'id', label: 'FD#', width: 90, render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>FD-{String(r.id).padStart(5, '0')}</span> },
  { key: 'customer_name', label: 'Investor', sortable: true,
    render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.customer_name || '—'}</span> },
  { key: 'principal', label: 'Amount ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{r.currency === 'USD' ? `$${(r.usd_amount / 100).toLocaleString()}` : fmtKobo(r.ngn_amount || r.principal)}</span> },
  { key: 'rate', label: 'Rate %', align: 'right', render: r => <span style={NUM}>{fmtPct(r.rate)}</span> },
  { key: 'transaction_date', label: 'Start', sortable: true, width: 100,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.transaction_date)}</span> },
  { key: 'maturity_date', label: 'Maturity', sortable: true, width: 100,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.maturity_date)}</span> },
  { key: 'transaction_type', label: 'Status', render: r => (
    <StatusBadge status={r.transaction_type === 'inflow' ? 'Active' : 'Liquidated'} />
  )},
  { key: '_days', label: 'Days to Mat.', align: 'right', render: r => {
    const d = daysToMaturity(r.maturity_date)
    return <span style={{ ...NUM, fontWeight: FW.semibold, color: daysColor(d) }}>{d < 0 ? 'Matured' : `${d}d`}</span>
  }},
]

// ── New FD modal ───────────────────────────────────────────────────────────────

interface NewFDModal {
  customer_name: string
  principal: string
  rate: string
  tenor_days: string
  transaction_date: string
  maturity_date: string
  currency: string
  location: string
  account_officer: string
  notes: string
}

const EMPTY_FORM: NewFDModal = {
  customer_name: '', principal: '', rate: '', tenor_days: '',
  transaction_date: today(), maturity_date: '',
  currency: 'NGN', location: '', account_officer: '', notes: '',
}

function NewFDDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<NewFDModal>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  function updateField(k: keyof NewFDModal, v: string) {
    setForm(f => {
      const next = { ...f, [k]: v }
      // Auto-compute maturity date from start + tenor
      if ((k === 'transaction_date' || k === 'tenor_days') && next.transaction_date && next.tenor_days) {
        const start = new Date(next.transaction_date)
        start.setDate(start.getDate() + Number(next.tenor_days))
        next.maturity_date = start.toISOString().split('T')[0]
      }
      return next
    })
  }

  async function submit() {
    if (!form.customer_name || !form.principal || !form.rate || !form.tenor_days) {
      toast.error('Fill in all required fields')
      return
    }
    setSaving(true)
    try {
      await apiPost('/api/fixed-deposit/transactions', {
        ...form,
        transaction_type: 'inflow',
        principal: Math.round(Number(form.principal) * 100),
        rate: Number(form.rate),
        tenor_days: Number(form.tenor_days),
      })
      toast.success('Fixed deposit created')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const field = (label: string, key: keyof NewFDModal, type = 'text', required = false) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}{required && ' *'}</label>
      <input type={type} value={form[key]} onChange={e => updateField(key, e.target.value)}
        style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: RADIUS.xl, padding: SP[6], width: 520, maxHeight: '90vh', overflow: 'auto', zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>New Fixed Deposit</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.xl }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div style={{ gridColumn: '1/-1' }}>{field('Investor Name', 'customer_name', 'text', true)}</div>
          {field('Principal (₦)', 'principal', 'number', true)}
          {field('Rate (%)', 'rate', 'number', true)}
          {field('Tenor (days)', 'tenor_days', 'number', true)}
          <div>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Currency</label>
            <select value={form.currency} onChange={e => updateField('currency', e.target.value)} style={{ ...filterInputStyle, height: 36, marginTop: 4 }}>
              <option value="NGN">NGN</option>
              <option value="USD">USD</option>
            </select>
          </div>
          {field('Start Date', 'transaction_date', 'date', true)}
          {field('Maturity Date', 'maturity_date', 'date')}
          {field('Location', 'location')}
          <div style={{ gridColumn: '1/-1' }}>{field('Account Officer', 'account_officer')}</div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Notes</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.notes} onChange={e => updateField('notes', e.target.value)}
              rows={2} style={{ ...filterInputStyle, height: 'auto', width: '100%', marginTop: 4, resize: 'vertical', padding: '8px 10px' }} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[5] }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Create FD'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Tooltip ────────────────────────────────────────────────────────────────────

function FDTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md, padding: '10px 14px', fontSize: TEXT.sm }}>
      <div style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 6 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtKobo(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: RADIUS.sm,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

const PER_PAGE = 25

export default function FinanceFixedDeposit() {
  const [rows, setRows] = useState<FDRecord[]>([])
  const [summary, setSummary] = useState<FDSummary | null>(null)
  const [fdKpis, setFdKpis] = useState<FDKPIs | null>(null)
  const [trend, setTrend] = useState<TrendPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'inflow' | 'liquidation'>('all')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [matFrom, setMatFrom] = useState('')
  const [matTo, setMatTo] = useState('')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = `date_from=${dateFrom}&date_to=${dateTo}`
      const [txRes, sumRes, trendRes, kpiRes] = await Promise.allSettled([
        apiFetch<{ data: FDRecord[] }>(`/api/fixed-deposit/transactions?${qs}`),
        apiFetch<{ data: FDSummary }>(`/api/fixed-deposit/summary?${qs}`),
        apiFetch<{ data: TrendPoint[] }>('/api/fixed-deposit/trend'),
        apiFetch<{ data: FDKPIs }>('/api/finance/fd-kpis'),
      ])
      if (txRes.status === 'fulfilled') setRows(txRes.value?.data ?? [])
      if (sumRes.status === 'fulfilled') setSummary(sumRes.value?.data ?? null)
      if (trendRes.status === 'fulfilled') setTrend(trendRes.value?.data ?? [])
      if (kpiRes.status === 'fulfilled') setFdKpis(kpiRes.value?.data ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const activeFilterCount = (statusFilter !== 'all' ? 1 : 0) + ((matFrom || matTo) ? 1 : 0)

  const filtered = useMemo(() => rows.filter(r => {
    if (statusFilter !== 'all' && r.transaction_type !== statusFilter) return false
    if (matFrom && r.maturity_date < matFrom) return false
    if (matTo && r.maturity_date.slice(0, 10) > matTo) return false
    if (search) {
      const q = search.toLowerCase()
      if (!r.customer_name.toLowerCase().includes(q)) return false
    }
    return true
  }), [rows, statusFilter, matFrom, matTo, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)
  const showStart  = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1
  const showEnd    = Math.min(safePage * PER_PAGE, filtered.length)

  function resetFilters() {
    setSearch(''); setStatusFilter('all'); setDateFrom(monthStart()); setDateTo(today()); setMatFrom(''); setMatTo('')
  }

  function exportFDRecordsCsv(data: FDRecord[]) {
    const header = ['FD#', 'Investor', 'Currency', 'Principal ₦', 'Interest Paid ₦', 'Rate %', 'Start Date', 'Maturity Date', 'Tenor Days', 'Location', 'Officer', 'Status', 'Notes']
    const lines = data.map(r => [
      `FD-${String(r.id).padStart(5, '0')}`,
      `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.currency ?? '',
      ((r.ngn_amount || r.principal) / 100).toFixed(2),
      (r.interest_paid / 100).toFixed(2),
      r.rate ?? 0,
      r.transaction_date ?? '',
      r.maturity_date ?? '',
      r.tenor_days ?? 0,
      `"${String(r.location ?? '').replace(/"/g, '""')}"`,
      `"${String(r.account_officer ?? '').replace(/"/g, '""')}"`,
      r.transaction_type === 'inflow' ? 'Active' : 'Liquidated',
      `"${String(r.notes ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `fixed-deposits-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const kpiLoading = loading && !fdKpis

  return (
    <Page
      title="Fixed Deposits"
      subtitle={summary ? `${summary.inflow_count} active · ${summary.liquidation_count} liquidated` : undefined}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>Txn Date:</span>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>Maturity:</span>
            <DateFilter from={matFrom} to={matTo} onChange={(f, t) => { setMatFrom(f); setMatTo(t) }} align="right" />
          </div>
          <button onClick={() => setShowNew(true)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: RADIUS.md, border: 'none',
            background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>New FD
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total FDs" value={fdKpis ? String(fdKpis.total_fds) : '—'} icon="savings" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Total Principal ₦" value={fdKpis ? fmtKobo(fdKpis.total_principal_kobo) : '—'} icon="account_balance" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Avg Rate %" value={fdKpis ? `${fdKpis.avg_rate_pct.toFixed(1)}%` : '—'} icon="percent" accent={BLUE} loading={kpiLoading} />
        <KpiCard label="Maturing This Month" value={fdKpis ? String(fdKpis.maturing_this_month) : '—'} icon="event" accent={AMBER} loading={kpiLoading} />
      </div>

      {/* Trend chart */}
      <SectionCard title="FD Activity Trend" subtitle="Monthly inflow vs liquidation" style={{ marginBottom: SP[4] }}>
        {loading ? <div style={{ height: 160 }} /> : trend.length === 0 ? (
          <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No trend data</div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="inflowGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="liqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={AMBER} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={AMBER} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: TEXT['2xs'], fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} width={72} />
              <Tooltip content={<FDTooltip />} />
              <Area type="monotone" dataKey="inflow" name="Inflow" stroke={GREEN} strokeWidth={2} fill="url(#inflowGrad)" dot={false} />
              <Area type="monotone" dataKey="liquidation" name="Liquidation" stroke={AMBER} strokeWidth={2} fill="url(#liqGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      <SectionCard title="FD Records" badge={filtered.length} padding={false} actions={
        <button onClick={() => exportFDRecordsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
          Export CSV
        </button>
      }>

        {/* Filter bar */}
        <div style={{
          padding: '12px 18px',
          borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap',
        }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
              border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
              background: 'transparent',
              color: activeFilterCount > 0 ? RED : 'var(--txt2)',
              cursor: 'pointer', fontFamily: SORA, position: 'relative',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                width: 16, height: 16, borderRadius: '50%',
                background: RED, color: '#fff',
                fontSize: 9, fontWeight: FW.bold, fontFamily: INTER,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{activeFilterCount}</span>
            )}
          </button>

          <div style={{ marginLeft: 'auto', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length} of {rows.length}
          </div>
        </div>

        {/* Expandable filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '20px 20px 0' }}>

              {/* Status */}
              <div style={{ paddingRight: SP[5], borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>STATUS</div>
                {([
                  { value: 'all',         label: 'All records',     color: NAVY },
                  { value: 'inflow',      label: 'Active (Inflow)', color: '#16A34A' },
                  { value: 'liquidation', label: 'Liquidated',      color: AMBER },
                ] as const).map(opt => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                    <input type="radio" name="fd_status" value={opt.value} checked={statusFilter === opt.value} onChange={() => setStatusFilter(opt.value)}
                      style={{ accentColor: opt.color, width: 14, height: 14, cursor: 'pointer' }} />
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{opt.label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
                      {opt.value === 'all' ? rows.length : rows.filter(r => r.transaction_type === opt.value).length}
                    </span>
                  </label>
                ))}
              </div>

              {/* Quick stats */}
              <div style={{ paddingLeft: SP[5] }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>QUICK STATS</div>
                {[
                  { label: 'Active FDs',   value: rows.filter(r => r.transaction_type === 'inflow').length,      color: '#16A34A' },
                  { label: 'Liquidated',   value: rows.filter(r => r.transaction_type === 'liquidation').length, color: AMBER },
                ].map(s => (
                  <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SP[2] }}>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA }}>{s.label}</span>
                    <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: s.color, fontFamily: INTER }}>{s.value}</span>
                  </div>
                ))}
              </div>

            </div>

            <div style={{
              padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
              display: 'flex', alignItems: 'center', gap: SP[3],
            }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: SORA }}>
                {activeFilterCount === 0
                  ? `No filters — showing all ${rows.length} records`
                  : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
              </span>
              <button onClick={resetFilters} style={{
                padding: '5px 12px', borderRadius: 7, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>Reset</button>
              <button onClick={() => { load(); setFilterOpen(false) }} style={{
                marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                fontSize: TEXT.sm, fontWeight: FW.semibold, border: 'none', background: RED, color: '#fff',
                cursor: 'pointer', fontFamily: SORA,
              }}>Apply · {filtered.length} results</button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && activeFilterCount > 0 && (
          <div style={{
            padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          }}>
            {statusFilter !== 'all' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: SP[1], padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: statusFilter === 'inflow' ? 'rgba(22,163,74,.12)' : `${AMBER}18`, color: statusFilter === 'inflow' ? '#16A34A' : AMBER }}>
                {statusFilter === 'inflow' ? 'Active' : 'Liquidated'}
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setStatusFilter('all')}>close</span>
              </span>
            )}
            <button onClick={resetFilters} style={{ marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

        <DataTable
          cols={COLS}
          rows={pageRows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No fixed deposit records found"
        />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {filtered.length === 0 ? 'No records' : `Showing ${showStart}–${showEnd} of ${filtered.length} FDs`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[1] }}>
              <PageBtn icon="chevron_left" disabled={safePage === 1} onClick={() => setPage(p => p - 1)} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (safePage <= 4) pg = i + 1
                else if (safePage >= totalPages - 3) pg = totalPages - 6 + i
                else pg = safePage - 3 + i
                return <PageBtn key={pg} active={pg === safePage} onClick={() => setPage(pg)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)} />
            </div>
          )}
        </div>

      </SectionCard>

      {showNew && <NewFDDialog onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load() }} />}
    </Page>
  )
}
