import { useState, useEffect } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

// ── Mock data ────────────────────────────────────────────────────

const MONTHLY_TXN = [
  { month: 'Jan', volume: 1840 }, { month: 'Feb', volume: 1620 },
  { month: 'Mar', volume: 2100 }, { month: 'Apr', volume: 1950 },
  { month: 'May', volume: 2380 }, { month: 'Jun', volume: 2210 },
  { month: 'Jul', volume: 2640 }, { month: 'Aug', volume: 2480 },
  { month: 'Sep', volume: 2820 }, { month: 'Oct', volume: 2960 },
  { month: 'Nov', volume: 3140 }, { month: 'Dec', volume: 2400 },
]

const COLLECTIONS_MODE = [
  { mode: 'Direct Debit',  amount: 84.2 },
  { mode: 'Bank Transfer', amount: 61.4 },
  { mode: 'Cash',          amount: 28.6 },
  { mode: 'Card',          amount: 12.8 },
  { mode: 'USSD',          amount: 6.3  },
]

const CARD_TYPES = [
  { name: 'Prepaid',     value: 9840, color: '#0E2841' },
  { name: 'Credit',      value: 6280, color: '#C00000' },
  { name: 'USD Virtual', value: 2981, color: '#3B82F6' },
]

const RECENT_TXN = [
  { cif: 'CIF-00842', name: 'Adebayo Okafor', type: 'Purchase',   merchant: 'Shoprite Ikeja',  amount: -12400,  date: 'Today, 14:22' },
  { cif: 'CIF-01204', name: 'Chioma Eze',     type: 'Transfer',   merchant: 'GTBank',          amount: -45000,  date: 'Today, 13:07' },
  { cif: 'CIF-00391', name: 'Emeka Nwosu',    type: 'Top-up',     merchant: 'O3 Capital',      amount: 200000,  date: 'Today, 11:55' },
  { cif: 'CIF-02841', name: 'Fatima Aliyu',   type: 'Purchase',   merchant: 'Jumia',           amount: -8750,   date: 'Yesterday'    },
  { cif: 'CIF-00124', name: 'David Mensah',   type: 'Withdrawal', merchant: 'First Bank ATM',  amount: -50000,  date: 'Yesterday'    },
  { cif: 'CIF-03312', name: 'Ngozi Adeyemi',  type: 'Purchase',   merchant: 'EKEDC',           amount: -22000,  date: 'Yesterday'    },
]

// ── Helpers ──────────────────────────────────────────────────────

function fmt(n: number) {
  const abs = Math.abs(n)
  const s = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return s + '₦' + (abs / 1_000_000_000).toFixed(1) + 'B'
  if (abs >= 1_000_000)     return s + '₦' + (abs / 1_000_000).toFixed(1) + 'M'
  if (abs >= 1_000)         return s + '₦' + (abs / 1_000).toFixed(1) + 'K'
  return s + '₦' + abs.toLocaleString('en-NG')
}

function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

// ── Skeleton ─────────────────────────────────────────────────────

function Sk({ w = 'w-full', h = 'h-3' }: { w?: string; h?: string }) {
  return <div className={`skeleton ${w} ${h} rounded`} />
}

// ── Tooltip ──────────────────────────────────────────────────────

function ChartTip({ active, payload, label, fmtVal }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white dark:bg-[#1E293B] rounded-lg border px-3 py-2.5 shadow-lg text-[12px]"
      style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
      <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider mb-1.5">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.color ?? p.fill }} />
          <span className="font-semibold font-mono text-slate-800 dark:text-slate-100">
            {fmtVal ? fmtVal(p.value) : p.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── KPI Card ─────────────────────────────────────────────────────

interface KpiProps {
  label: string; value: string; sub?: string
  change?: number; icon: string; loading?: boolean
}

function KpiCard({ label, value, sub, change, icon, loading }: KpiProps) {
  if (loading) return (
    <div className="bg-white dark:bg-[#111827] rounded-xl border p-5" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
      <div className="flex justify-between mb-3"><Sk w="w-28" /><Sk w="w-8" h="h-8" /></div>
      <Sk w="w-32" h="h-7" />
      <div className="mt-3"><Sk w="w-24" /></div>
    </div>
  )
  const up = change == null || change >= 0
  return (
    <div className="bg-white dark:bg-[#111827] rounded-xl border p-5 animate-fadeIn"
      style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(14,40,65,0.06)' }}>
          <span className="material-symbols-rounded text-[16px]" style={{ color: '#0E2841' }}>{icon}</span>
        </div>
      </div>
      <p className="kpi-number text-[28px] leading-none text-slate-900 dark:text-white">
        {value}
      </p>
      <div className="flex items-center gap-2 mt-3">
        {change != null ? (
          <>
            <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded"
              style={{
                background: up ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.07)',
                color:      up ? '#059669' : '#DC2626',
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{up ? 'arrow_upward' : 'arrow_downward'}</span>
              {up ? '+' : ''}{Math.abs(change).toFixed(1)}%
            </span>
            <span className="text-[11px] text-slate-400">WoW</span>
          </>
        ) : sub ? (
          <span className="text-[12px] text-slate-400">{sub}</span>
        ) : null}
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────

export default function Overview() {
  const [loading, setLoading] = useState(true)
  const [live,    setLive]    = useState(true)

  useEffect(() => { const t = setTimeout(() => setLoading(false), 1000); return () => clearTimeout(t) }, [])

  const totalCards = CARD_TYPES.reduce((s, c) => s + c.value, 0)

  const [sortCol,    setSortCol]    = useState<string | null>(null)
  const [sortDir,    setSortDir]    = useState<'asc' | 'desc'>('asc')
  const [search,     setSearch]     = useState('')
  const [typeFilter, setTypeFilter] = useState('All')

  function toggleSort(col: string) {
    if (sortCol === col) {
      if (sortDir === 'asc') setSortDir('desc')
      else setSortCol(null)
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
  }

  let rows = RECENT_TXN.filter(t => {
    const q = search.toLowerCase()
    const matchSearch = !q || t.cif.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) || t.merchant.toLowerCase().includes(q)
    const matchType = typeFilter === 'All' || t.type === typeFilter
    return matchSearch && matchType
  })
  if (sortCol) {
    const key = sortCol as keyof typeof RECENT_TXN[0]
    rows = [...rows].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ?  1 : -1
      return 0
    })
  }

  return (
    <div className="px-8 py-7 max-w-[1440px] mx-auto">

      {/* ── Page header (Phoenix-style) ── */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <p className="text-[13px] text-slate-400 mb-1">
            <span className="hover:text-slate-600 cursor-pointer transition-colors">O3 Capital</span>
            <span className="mx-1.5 text-slate-300">›</span>
            <span className="text-slate-600 font-medium">Overview</span>
          </p>
          <h1 className="text-[28px] font-bold tracking-tight text-slate-900 dark:text-white leading-tight">
            Dashboard
          </h1>
          <p className="text-[13px] text-slate-400 mt-0.5">
            Portfolio snapshot · updated {new Date().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-2.5 mt-1">
          {/* Live/snapshot badge */}
          <button
            onClick={() => setLive(l => !l)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all"
            title="Click to toggle (demo)"
            style={{
              background:   live ? 'rgba(5,150,105,0.05)' : 'rgba(245,158,11,0.05)',
              borderColor:  live ? 'rgba(5,150,105,0.2)'  : 'rgba(245,158,11,0.2)',
              color:        live ? '#059669'               : '#D97706',
            }}>
            <span className="relative flex items-center justify-center w-2 h-2">
              <span className="w-1.5 h-1.5 rounded-full block flex-shrink-0"
                style={{ background: live ? '#10B981' : '#F59E0B' }} />
              {live && <span className="w-1.5 h-1.5 rounded-full block absolute animate-ping opacity-50"
                style={{ background: '#10B981' }} />}
            </span>
            {live ? 'Live · MSSQL' : 'Snapshot · 6h ago'}
          </button>

          <button className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[13px] font-semibold text-white transition-all"
            style={{ background: '#0E2841' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#16374F')}
            onMouseLeave={e => (e.currentTarget.style.background = '#0E2841')}>
            <span className="material-symbols-rounded text-[15px]">download</span>
            Export
          </button>
        </div>
      </div>

      {/* ── System status bar ── */}
      {!loading && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg mb-6 text-[13px] animate-fadeIn"
          style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.15)' }}>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
          <span className="text-emerald-700 font-medium">All systems operational.</span>
          <span className="text-emerald-600/70">MSSQL connected · Supabase standby · Sync last run 18:00 WAT</span>
        </div>
      )}

      {/* ── KPI grid ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-7">
        <KpiCard label="Total Cardholders" value="19,101"  change={2.4}  icon="group"                    loading={loading} />
        <KpiCard label="Active Cards"      value="14,832"  change={1.1}  icon="credit_card"              loading={loading} />
        <KpiCard label="Txn Volume (MTD)"  value="₦2.4B"   change={8.7}  icon="receipt_long"             loading={loading} />
        <KpiCard label="Collections MTD"   value="₦187.3M" change={3.1}  icon="account_balance_wallet"   loading={loading} />
        <KpiCard label="Recovery Rate"     value="68.4%"   change={-1.2} icon="health_and_safety"        loading={loading} />
        <KpiCard label="New Cards (MTD)"   value="342"     sub="21% of portfolio" icon="add_card"        loading={loading} />
      </div>

      {/* ── Transaction volume chart ── */}
      <div className="bg-white dark:bg-[#111827] rounded-xl border p-5 mb-5"
        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-800 dark:text-slate-100">Monthly Transaction Volume</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">₦ millions · Jan – Dec 2025</p>
          </div>
          <div className="flex items-center gap-1.5">
            {['3M', '6M', '1Y'].map((r, i) => (
              <button key={r} className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                style={{
                  background: i === 2 ? 'rgba(14,40,65,0.08)' : 'transparent',
                  color:      i === 2 ? '#0E2841'               : '#94A3B8',
                }}>
                {r}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="h-[200px] flex items-end gap-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${35 + (i % 5) * 12}%` }} />
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={MONTHLY_TXN} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#0E2841" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#0E2841" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'Plus Jakarta Sans' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'Plus Jakarta Sans' }} axisLine={false} tickLine={false}
                tickFormatter={v => `₦${v}M`} width={50} />
              <Tooltip content={<ChartTip fmtVal={(v: number) => `₦${v}M`} />} />
              <Area type="monotone" dataKey="volume" stroke="#0E2841" strokeWidth={1.5}
                fill="url(#volGrad)" dot={false} activeDot={{ r: 3.5, fill: '#0E2841', strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Collections + Donut row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-5">

        <div className="bg-white dark:bg-[#111827] rounded-xl border p-5 lg:col-span-3"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-semibold text-slate-800 dark:text-slate-100 mb-0.5">Collections by Mode</h2>
          <p className="text-[12px] text-slate-400 mb-4">₦ millions · month-to-date</p>
          {loading ? (
            <div className="h-[180px] flex items-end gap-4">
              {COLLECTIONS_MODE.map((_, i) => (
                <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${25 + i * 13}%` }} />
              ))}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={COLLECTIONS_MODE} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barSize={24}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="mode" tick={{ fontSize: 10, fill: '#94A3B8', fontFamily: 'Plus Jakarta Sans' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8', fontFamily: 'Plus Jakarta Sans' }} axisLine={false} tickLine={false}
                  tickFormatter={v => `₦${v}M`} width={46} />
                <Tooltip content={<ChartTip fmtVal={(v: number) => `₦${v}M`} />} />
                <Bar dataKey="amount" fill="#0E2841" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-white dark:bg-[#111827] rounded-xl border p-5 lg:col-span-2"
          style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h2 className="text-[14px] font-semibold text-slate-800 dark:text-slate-100 mb-0.5">Card Types</h2>
          <p className="text-[12px] text-slate-400 mb-2">Active portfolio breakdown</p>
          {loading ? (
            <div className="flex flex-col items-center gap-3 pt-4">
              <div className="w-32 h-32 skeleton rounded-full" />
              <div className="w-full space-y-2 pt-2">
                <Sk /><Sk w="w-3/4" /><Sk w="w-1/2" />
              </div>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={150}>
                <PieChart>
                  <Pie data={CARD_TYPES} cx="50%" cy="50%" innerRadius={46} outerRadius={68}
                    dataKey="value" paddingAngle={2} startAngle={90} endAngle={-270}>
                    {CARD_TYPES.map((c, i) => <Cell key={i} fill={c.color} stroke="none" />)}
                  </Pie>
                  <Tooltip content={<ChartTip fmtVal={(v: number) => fmtNum(v) + ' cards'} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 pt-1">
                {CARD_TYPES.map(c => (
                  <div key={c.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: c.color }} />
                      <span className="text-[12px] text-slate-500 dark:text-slate-400">{c.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-semibold font-mono text-slate-800 dark:text-slate-100">{fmtNum(c.value)}</span>
                      <span className="text-[11px] text-slate-400">({((c.value / totalCards) * 100).toFixed(0)}%)</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Recent transactions table ── */}
      <div className="bg-white dark:bg-[#111827] rounded-xl border overflow-hidden"
        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>

        {/* Card header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
          <div>
            <h2 className="text-[14px] font-semibold text-slate-800 dark:text-slate-100">Recent Transactions</h2>
            <p className="text-[12px] text-slate-400">
              Latest activity across all cards
              {(search || typeFilter !== 'All') && !loading &&
                <span className="ml-2 font-medium" style={{ color: '#0E2841' }}>· {rows.length} result{rows.length !== 1 ? 's' : ''}</span>
              }
            </p>
          </div>
          <button className="text-[12px] font-medium transition-colors flex items-center gap-1"
            style={{ color: '#0E2841' }}>
            Open Transactions
            <span className="material-symbols-rounded text-[14px]">arrow_forward</span>
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3 px-5 py-2.5 border-b flex-wrap"
          style={{ borderColor: 'rgba(15,23,42,0.06)', background: 'rgba(15,23,42,0.018)' }}>
          {/* Search */}
          <div className="relative">
            <span className="material-symbols-rounded absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-slate-400 pointer-events-none">
              search
            </span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search CIF, name, merchant…"
              className="pl-8 pr-3 py-1.5 text-[12px] rounded-lg border bg-white dark:bg-[#1E293B] outline-none transition-all w-56"
              style={{ borderColor: 'rgba(15,23,42,0.14)', color: '#334155' }}
              onFocus={e => (e.currentTarget.style.borderColor = '#0E2841')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(15,23,42,0.14)')}
            />
            {search && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <span className="material-symbols-rounded text-[14px]">close</span>
              </button>
            )}
          </div>

          {/* Type filter pills */}
          <div className="flex items-center gap-1.5">
            {['All', 'Purchase', 'Transfer', 'Top-up', 'Withdrawal'].map(t => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all whitespace-nowrap"
                style={{
                  background: typeFilter === t ? '#0E2841' : 'rgba(15,23,42,0.06)',
                  color:      typeFilter === t ? '#ffffff'  : '#64748B',
                }}>
                {t}
              </button>
            ))}
          </div>

          {/* Clear filters */}
          {(search || typeFilter !== 'All') && (
            <button onClick={() => { setSearch(''); setTypeFilter('All') }}
              className="ml-auto flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-slate-600 transition-colors">
              <span className="material-symbols-rounded text-[13px]">filter_alt_off</span>
              Clear
            </button>
          )}
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {([
                  { key: 'cif',      label: 'CIF',      right: false },
                  { key: 'name',     label: 'Borrower', right: false },
                  { key: 'type',     label: 'Type',     right: false },
                  { key: 'merchant', label: 'Merchant', right: false },
                  { key: 'date',     label: 'Date',     right: false },
                  { key: 'amount',   label: 'Amount',   right: true  },
                ] as const).map(col => {
                  const active = sortCol === col.key
                  const icon   = active ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'
                  return (
                    <th key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap cursor-pointer select-none transition-colors ${col.right ? 'text-right' : 'text-left'}`}
                      style={{ background: '#0E2841', color: active ? '#ffffff' : 'rgba(255,255,255,0.6)' }}>
                      <span className={`inline-flex items-center gap-1 ${col.right ? 'flex-row-reverse' : ''}`}>
                        {col.label}
                        <span className="material-symbols-rounded text-[13px]"
                          style={{ color: active ? '#ffffff' : 'rgba(255,255,255,0.32)' }}>
                          {icon}
                        </span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                      {[24, 32, 20, 28, 20, 16].map((w, j) => (
                        <td key={j} className="px-5 py-3.5"><Sk w={`w-${w}`} /></td>
                      ))}
                    </tr>
                  ))
                : rows.length === 0
                  ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-12 text-center">
                        <span className="material-symbols-rounded text-[32px] text-slate-300 block mb-2">search_off</span>
                        <p className="text-[13px] text-slate-400">No transactions match your filter.</p>
                        <button onClick={() => { setSearch(''); setTypeFilter('All') }}
                          className="mt-2 text-[12px] font-medium" style={{ color: '#0E2841' }}>
                          Clear filters
                        </button>
                      </td>
                    </tr>
                  )
                  : rows.map((t, i) => {
                      const credit = t.amount > 0
                      return (
                        <tr key={i}
                          className="transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.025] cursor-pointer"
                          style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                          <td className="px-5 py-3 font-mono text-[12px] text-slate-500">{t.cif}</td>
                          <td className="px-5 py-3 text-[13px] font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap">{t.name}</td>
                          <td className="px-5 py-3">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold"
                              style={{
                                background: credit ? 'rgba(5,150,105,0.08)' : 'rgba(15,23,42,0.06)',
                                color:      credit ? '#059669'               : '#475569',
                              }}>
                              {t.type}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-[13px] text-slate-500 whitespace-nowrap">{t.merchant}</td>
                          <td className="px-5 py-3 text-[12px] text-slate-400 whitespace-nowrap">{t.date}</td>
                          <td className="px-5 py-3 text-right font-mono text-[13px] font-semibold whitespace-nowrap"
                            style={{ color: credit ? '#059669' : '#0F172A' }}>
                            {credit ? '+' : ''}{fmt(t.amount)}
                          </td>
                        </tr>
                      )
                    })
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
