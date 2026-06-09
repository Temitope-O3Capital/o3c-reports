import { useState, useMemo, useEffect } from 'react'
import { useApi } from '../hooks/useApi.js'
import {
  KpiCard, AreaChartCard, ProgressListCard,
  fmt, fmtNum, pct
} from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */

const NAVY  = '#0E2841'
const RED   = '#C00000'

const FUNNEL_COLORS = [
  'rgb(var(--navy))',
  '#2563EB',
  '#0891B2',
  '#059669',
]

const FUNNEL_STAGES = [
  { key: 'registered',  label: 'Registered',   icon: 'person_add',      desc: 'Created an account' },
  { key: 'card_issued', label: 'Card Issued',   icon: 'credit_card',     desc: 'Received a card' },
  { key: 'card_active', label: 'Activated',     icon: 'check_circle',    desc: 'Card status Open' },
  { key: 'transacting', label: 'Transacting',   icon: 'payments',        desc: 'Made ≥1 transaction' },
]

const MEDAL_CLS = [
  'text-amber-400',   // gold
  'text-slate-400',   // silver
  'text-amber-700',   // bronze
]
const MEDAL_ICON = ['workspace_premium', 'military_tech', 'emoji_events']

/* ═══════════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════════ */

/* ── Lifecycle Funnel ───────────────────────────────────────── */
function LifecycleFunnel({ data }) {
  if (!data) {
    return (
      <div className="card p-6">
        <div className="skeleton h-4 w-40 rounded mb-6" />
        {[100, 90, 75, 55].map((w, i) => (
          <div key={i} className="mb-3">
            <div className="skeleton h-3 w-24 rounded mb-2" />
            <div className="skeleton h-10 rounded-lg" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    )
  }

  const top = data[FUNNEL_STAGES[0].key] || 1

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Customer Lifecycle</p>
          <p className="text-xs text-slate-400 mt-0.5">Acquisition → activation funnel</p>
        </div>
      </div>

      <div className="space-y-3">
        {FUNNEL_STAGES.map((stage, i) => {
          const value  = data[stage.key] || 0
          const widthPct = (value / top) * 100
          const convRate = i === 0 ? 100 : (value / top) * 100
          const dropOff  = i === 0 ? null : (data[FUNNEL_STAGES[i - 1].key] || 0) - value

          return (
            <div key={stage.key}>
              {/* Drop-off connector */}
              {dropOff !== null && dropOff > 0 && (
                <div className="flex items-center gap-2 ml-10 mb-2 -mt-1">
                  <div className="w-px h-3 bg-slate-200 dark:bg-slate-700 ml-3" />
                  <span className="text-[10px] text-red-400 font-medium">
                    −{fmtNum(dropOff)} dropped
                  </span>
                </div>
              )}

              <div className="flex items-center gap-3">
                {/* Step number */}
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                  style={{ background: FUNNEL_COLORS[i] }}
                >
                  {i + 1}
                </div>

                {/* Bar */}
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <div>
                      <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                        {stage.label}
                      </span>
                      <span className="text-xs text-slate-400 ml-2">{stage.desc}</span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                        style={{
                          background: i === 0 ? 'rgb(var(--navy) / 0.08)' : convRate >= 70 ? 'rgb(5 150 105 / 0.08)' : 'rgb(245 158 11 / 0.1)',
                          color: i === 0 ? 'rgb(var(--navy))' : convRate >= 70 ? '#059669' : '#D97706',
                        }}>
                        {convRate.toFixed(1)}%
                      </span>
                      <span className="text-sm font-bold tabular-nums text-slate-800 dark:text-slate-100 w-16 text-right">
                        {fmtNum(value)}
                      </span>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="h-2.5 rounded-full overflow-hidden"
                    style={{ background: 'rgb(var(--bg-muted))' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${widthPct}%`,
                        background: FUNNEL_COLORS[i],
                        transition: 'width 0.9s ease',
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Manager Leaderboard ────────────────────────────────────── */
function ManagerLeaderboard({ data }) {
  if (!data?.length) return (
    <div className="card p-6 flex flex-col items-center justify-center min-h-[240px]"
      style={{ color: 'rgb(var(--fg-3))' }}>
      <span className="material-symbols-rounded text-[36px] opacity-30 mb-2">leaderboard</span>
      <p className="text-sm">No manager data</p>
    </div>
  )

  function initials(name) {
    return (name || '?').split(' ').slice(0, 2).map(w => w[0]?.toUpperCase()).join('')
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Manager Leaderboard</p>
        <p className="text-xs text-slate-400 mt-0.5">Ranked by total accounts issued</p>
      </div>

      <div className="divide-y" style={{ borderColor: 'rgb(var(--border) / 0.06)' }}>
        {data.map((mgr, i) => {
          const rate = Number(mgr.activation_rate || 0)
          return (
            <div key={i} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/60 dark:hover:bg-slate-800/40 transition-colors">
              {/* Rank */}
              <div className="w-6 flex-shrink-0 flex items-center justify-center">
                {i < 3 ? (
                  <span className={`material-symbols-rounded text-[20px] ${MEDAL_CLS[i]}`}>
                    {MEDAL_ICON[i]}
                  </span>
                ) : (
                  <span className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-3))' }}>
                    {i + 1}
                  </span>
                )}
              </div>

              {/* Avatar */}
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                style={{ background: `hsl(${(i * 47) % 360} 55% 45%)` }}>
                {initials(mgr['Account Manager'])}
              </div>

              {/* Name + sub */}
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-200 truncate">
                  {mgr['Account Manager']}
                </p>
                <p className="text-[11px]" style={{ color: 'rgb(var(--fg-3))' }}>
                  {fmtNum(mgr.active_accounts)} active
                </p>
              </div>

              {/* Metrics */}
              <div className="text-right flex-shrink-0">
                <p className="text-[14px] font-bold tabular-nums text-slate-800 dark:text-slate-100">
                  {fmtNum(mgr.total_accounts)}
                </p>
                <span className={`text-[10px] font-semibold ${
                  rate >= 70 ? 'text-emerald-600 dark:text-emerald-400'
                  : rate >= 40 ? 'text-amber-600 dark:text-amber-400'
                  : 'text-red-500'
                }`}>
                  {rate}% activated
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Product Mix ────────────────────────────────────────────── */
function ProductMixCard({ data }) {
  if (!data?.length) return null
  const total = data.reduce((s, r) => s + Number(r.total || 0), 0)
  const COLORS = [NAVY, RED, '#2563EB', '#059669', '#F59E0B']

  return (
    <div className="card p-6">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-5">Product Mix</p>
      <div className="space-y-4">
        {data.map((row, i) => {
          const totalN  = Number(row.total || 0)
          const activeN = Number(row.active || 0)
          const share   = total > 0 ? (totalN / total) * 100 : 0
          const actRate = totalN > 0 ? (activeN / totalN) * 100 : 0
          const color   = COLORS[i % COLORS.length]

          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
                  <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">
                    {row['Product Name']}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                    {actRate.toFixed(0)}% active
                  </span>
                  <span className="text-[13px] font-bold tabular-nums text-slate-800 dark:text-slate-100">
                    {fmtNum(totalN)}
                  </span>
                  <span className="text-[11px] w-8 text-right" style={{ color: 'rgb(var(--fg-3))' }}>
                    {share.toFixed(1)}%
                  </span>
                </div>
              </div>
              {/* Stacked bar: active (solid) + inactive (muted) */}
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgb(var(--bg-muted))' }}>
                <div className="h-full flex">
                  <div className="h-full rounded-l-full" style={{ width: `${share}%`, background: color, transition: 'width 0.8s ease' }}>
                    <div className="h-full rounded-full" style={{ width: `${actRate}%`, background: color }} />
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Legend totals */}
      <div className="mt-5 pt-4" style={{ borderTop: '1px solid rgb(var(--border) / 0.06)' }}>
        <div className="flex items-center justify-between text-xs" style={{ color: 'rgb(var(--fg-3))' }}>
          <span>Total issued</span>
          <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-300">
            {fmtNum(total)}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── Customer Directory ─────────────────────────────────────── */
function CustomerDirectory({ data }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const filtered = useMemo(() => {
    if (!data?.length) return []
    return data.filter(c => {
      const q = search.toLowerCase()
      const matchSearch = !q || [
        c['First Name'], c['Last Name'], c['CIF Number'],
        c['State'], c['City'], c['Account Manager'],
      ].some(v => v?.toLowerCase().includes(q))

      const matchStatus = statusFilter === 'all'
        || (statusFilter === 'active'   && c['Account Status'] === 'Open')
        || (statusFilter === 'inactive' && c['Account Status'] !== 'Open')
      return matchSearch && matchStatus
    })
  }, [data, search, statusFilter])

  function StatusBadge({ status }) {
    const v = (status || '').toLowerCase()
    if (v === 'open' || v === 'active') return <span className="badge badge-green">Active</span>
    if (v === 'closed') return <span className="badge badge-red">Closed</span>
    return <span className="badge badge-grey">{status || '—'}</span>
  }

  return (
    <div className="card overflow-hidden mt-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Customer Directory</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {filtered.length} of {data?.length || 0} customers
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Status filter */}
          <div className="flex items-center rounded-lg overflow-hidden text-xs font-semibold"
            style={{ border: '1px solid rgb(var(--border) / 0.12)' }}>
            {[
              { value: 'all',      label: 'All' },
              { value: 'active',   label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ].map(f => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className="px-3 py-1.5 transition-colors"
                style={{
                  background: statusFilter === f.value ? 'rgb(var(--navy))' : 'transparent',
                  color: statusFilter === f.value ? 'white' : 'rgb(var(--fg-2))',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <span className="material-symbols-rounded text-[15px] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'rgb(var(--fg-3))' }}>search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Name, CIF, state…"
              className="form-input pl-8 py-1.5 text-xs w-44"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      {!data ? (
        <div className="flex items-center justify-center gap-3 py-12" style={{ color: 'rgb(var(--fg-3))' }}>
          <div className="spinner" /> Loading customers…
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Location</th>
                <th>Product</th>
                <th>Status</th>
                <th>Manager</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="flex flex-col items-center justify-center py-12 gap-2" style={{ color: 'rgb(var(--fg-3))' }}>
                      <span className="material-symbols-rounded text-[36px] opacity-30">person_search</span>
                      <p className="text-sm">No customers match your filters</p>
                    </div>
                  </td>
                </tr>
              ) : filtered.map((c, i) => (
                <tr key={i}>
                  {/* Customer */}
                  <td>
                    <div className="flex items-center gap-3">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                        style={{ background: `hsl(${(parseInt(c['CIF Number'] || '0') * 37) % 360} 50% 45%)` }}
                      >
                        {([c['First Name'], c['Last Name']].filter(Boolean).join('') || '?')[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-200 truncate">
                          {[c['First Name'], c['Last Name']].filter(Boolean).join(' ') || '—'}
                        </p>
                        <p className="text-[11px] font-mono" style={{ color: 'rgb(var(--fg-3))' }}>
                          {c['CIF Number']}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Location */}
                  <td>
                    <p className="text-[13px] text-slate-700 dark:text-slate-300">{c['State'] || '—'}</p>
                    {c['City'] && c['City'] !== c['State'] && (
                      <p className="text-[11px]" style={{ color: 'rgb(var(--fg-3))' }}>{c['City']}</p>
                    )}
                  </td>

                  {/* Product */}
                  <td>
                    <span className="badge badge-navy">{c['Product Name'] || '—'}</span>
                  </td>

                  {/* Status */}
                  <td><StatusBadge status={c['Account Status']} /></td>

                  {/* Manager */}
                  <td className="text-[13px]" style={{ color: 'rgb(var(--fg-2))' }}>
                    {c['Account Manager'] || '—'}
                  </td>

                  {/* Joined */}
                  <td className="text-[12px] whitespace-nowrap tabular-nums" style={{ color: 'rgb(var(--fg-3))' }}>
                    {c['Account Created Date']
                      ? new Date(c['Account Created Date']).toLocaleDateString('en-GB', {
                          day: 'numeric', month: 'short', year: 'numeric'
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && filtered.length > 0 && (
        <div className="px-5 py-3 text-xs flex items-center justify-between"
          style={{
            borderTop: '1px solid rgb(var(--border) / 0.06)',
            color: 'rgb(var(--fg-3))',
            background: 'rgb(var(--bg-subtle))',
          }}>
          <span>Showing {filtered.length} customers</span>
          {data.length >= 200 && (
            <span className="flex items-center gap-1">
              <span className="material-symbols-rounded text-[14px]">info</span>
              Limited to 200 most recent. Use filters to narrow results.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════ */

export default function Sales({ setDs }) {
  const kpis       = useApi('/api/sales/kpis')
  const funnel     = useApi('/api/sales/funnel')
  const trend      = useApi('/api/sales/accounts-trend')
  const managers   = useApi('/api/sales/manager-performance')
  const states     = useApi('/api/sales/by-state')
  const products   = useApi('/api/sales/product-mix')
  const customers  = useApi('/api/sales/customers')

  useEffect(() => { if (kpis.dataSource) setDs(kpis.dataSource) }, [kpis.dataSource])

  const d = kpis.data || {}
  const momUp = (d.mom_growth ?? 0) >= 0

  function calcMoM(arr, key) {
    if (!arr || arr.length < 2) return null
    const prev = Number(arr[arr.length - 2]?.[key] ?? 0)
    const curr = Number(arr[arr.length - 1]?.[key] ?? 0)
    if (prev === 0) return null
    return ((curr - prev) / prev) * 100
  }

  return (
    <PageShell
      title="Sales & Growth"
      subtitle="Customer acquisition, team performance, and market penetration"
      source={kpis.dataSource}
      error={kpis.error}
    >

      {/* ── KPI Row ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard
          label="Total Customers"
          value={fmtNum(d.total_customers)}
          icon="groups"
          accent="navy"
          trend={calcMoM(trend.data, 'new_accounts')}
          tooltip="Total registered cardholders on the platform across all products"
        />
        <KpiCard
          label="New This Month"
          value={fmtNum(d.new_mtd)}
          icon="person_add"
          accent="accent"
          sub={`${fmtNum(d.prev_month)} last month`}
          tooltip="New cardholder accounts opened in the current calendar month"
        />
        <KpiCard
          label="MoM Growth"
          value={d.mom_growth != null ? `${d.mom_growth >= 0 ? '+' : ''}${d.mom_growth}%` : '—'}
          icon="trending_up"
          accent={momUp ? 'green' : 'accent'}
          sub="vs previous month"
          tooltip="Month-over-month percentage change in new customer acquisitions"
        />
        <KpiCard
          label="YTD New Accounts"
          value={fmtNum(d.ytd_new)}
          icon="calendar_today"
          accent="navy"
          tooltip="Total new accounts opened from January 1st to today"
        />
        <KpiCard
          label="Activation Rate"
          value={pct(d.activation_rate)}
          icon="check_circle"
          accent={d.activation_rate >= 70 ? 'green' : 'amber'}
          sub={`${fmtNum(d.active_cards)} active cards`}
          tooltip="Percentage of issued cards that have been activated and used at least once"
        />
        <KpiCard
          label="States Reached"
          value={fmtNum(d.states_reached)}
          icon="location_on"
          accent="blue"
          sub="active regions"
          tooltip="Number of Nigerian states with at least one active cardholder"
        />
      </div>

      {/* ── Lifecycle Funnel ── */}
      <div className="mt-4">
        <LifecycleFunnel data={funnel.data} />
      </div>

      {/* ── Acquisition Trend + Product Mix ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Acquisition Trend"
            subtitle="New customer accounts over time"
            data={trend.data || []}
            xKey="month"
            areas={[{ key: 'new_accounts', label: 'New Accounts', color: RED }]}
            height={260}
          />
        </div>
        <ProductMixCard data={products.data} />
      </div>

      {/* ── Manager Leaderboard + Geographic ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <ManagerLeaderboard data={managers.data} />
        <ProgressListCard
          title="Top States by Customers"
          subtitle="Geographic market penetration"
          data={states.data || []}
          nameKey="State"
          valueKey="count"
          maxItems={10}
        />
      </div>

      {/* ── Customer Directory ── */}
      <CustomerDirectory data={customers.data} />

    </PageShell>
  )
}
