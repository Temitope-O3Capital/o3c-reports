import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtDate, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, BarChartCard, ProgressList, ChangeBadge,
  ErrBanner, ExportBtn, Sk, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

/* ── Lifecycle funnel stages ─────────────────────────────────── */
const FUNNEL_STAGES = [
  { key: 'registered',  label: 'Registered',  icon: 'person_add',   desc: 'Created account', color: NAVY },
  { key: 'card_issued', label: 'Card Issued',  icon: 'credit_card',  desc: 'Received a card', color: BLUE },
  { key: 'card_active', label: 'Activated',    icon: 'check_circle', desc: 'Card Open status', color: GREEN },
  { key: 'transacting', label: 'Transacting',  icon: 'payments',     desc: 'Made ≥1 txn',    color: '#0891B2' },
]

/* ── LifecycleFunnel ─────────────────────────────────────────── */
function LifecycleFunnel({ data, loading }: { data: Record<string, number> | null; loading: boolean }) {
  return (
    <SectionCard title="Customer Lifecycle Funnel" subtitle="Acquisition → activation pipeline">
      <div className="px-5 py-4 space-y-4">
        {loading || !data
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Sk w="w-36" />
                <Sk h="h-8" w={`w-${['full', '4/5', '3/5', '2/5'][i]}`} />
              </div>
            ))
          : (() => {
              const top = n(data[FUNNEL_STAGES[0].key]) || 1
              return FUNNEL_STAGES.map((stage, i) => {
                const value = n(data[stage.key])
                const widthPct = (value / top) * 100
                const convRate = i === 0 ? 100 : (value / top) * 100
                const dropOff  = i === 0 ? null : n(data[FUNNEL_STAGES[i - 1].key]) - value
                return (
                  <div key={stage.key}>
                    {dropOff != null && dropOff > 0 && (
                      <div className="flex items-center gap-2 ml-10 mb-1.5 -mt-1">
                        <div className="w-px h-3 bg-slate-200 ml-3" />
                        <span className="text-[11px] font-medium" style={{ color: RED }}>
                          −{fmtNum(dropOff)} dropped
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0"
                        style={{ background: stage.color }}>
                        {i + 1}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                          <div>
                            <span className="text-[13px] font-semibold text-slate-700">{stage.label}</span>
                            <span className="text-[11px] text-slate-400 ml-2">{stage.desc}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                              style={{
                                background: i === 0 ? `${NAVY}10` : convRate >= 70 ? 'rgba(5,150,105,0.08)' : 'rgba(245,158,11,0.10)',
                                color: i === 0 ? NAVY : convRate >= 70 ? GREEN : AMBER,
                              }}>
                              {convRate.toFixed(1)}%
                            </span>
                            <span className="kpi-number text-[14px] font-bold text-slate-800 w-16 text-right">
                              {fmtNum(value)}
                            </span>
                          </div>
                        </div>
                        <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                          <div className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${widthPct}%`, background: stage.color }} />
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })
            })()}
      </div>
    </SectionCard>
  )
}

/* ── Manager Leaderboard ─────────────────────────────────────── */
function ManagerLeaderboard({ data, loading }: { data: any[] | null; loading: boolean }) {
  const MEDAL = [
    { icon: 'workspace_premium', cls: 'text-amber-400' },
    { icon: 'military_tech',     cls: 'text-slate-400' },
    { icon: 'emoji_events',      cls: 'text-amber-700' },
  ]
  function initials(name: string) {
    return (name || '?').split(' ').slice(0, 2).map((w: string) => w[0]?.toUpperCase()).join('')
  }
  return (
    <SectionCard title="Manager Leaderboard" subtitle="Ranked by total accounts issued">
      {loading
        ? <div className="px-5 py-4 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Sk key={i} />)}</div>
        : !data?.length
        ? (
          <div className="flex flex-col items-center justify-center py-14 gap-3 text-slate-400">
            <span className="material-symbols-rounded text-[36px]">leaderboard</span>
            <p className="text-[13px]">No manager data</p>
          </div>
        )
        : (
          <div>
            {data.map((mgr, i) => {
              const rate = Number(mgr.activation_rate || 0)
              return (
                <div key={i} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                  style={{ borderTop: i > 0 ? '1px solid rgba(15,23,42,0.05)' : undefined }}>
                  <div className="w-6 flex-shrink-0 flex items-center justify-center">
                    {i < 3
                      ? <span className={`material-symbols-rounded text-[20px] ${MEDAL[i].cls}`}>{MEDAL[i].icon}</span>
                      : <span className="text-[11px] font-semibold text-slate-400">{i + 1}</span>}
                  </div>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0"
                    style={{ background: `hsl(${(i * 47) % 360} 55% 45%)` }}>
                    {initials(mgr['Account Manager'] || '')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{mgr['Account Manager'] || '—'}</p>
                    <p className="text-[11px] text-slate-400">{fmtNum(mgr.active_accounts)} active</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="kpi-number text-[15px] font-bold text-slate-800">{fmtNum(mgr.total_accounts)}</p>
                    <span className="text-[10px] font-semibold"
                      style={{ color: rate >= 70 ? GREEN : rate >= 40 ? AMBER : RED }}>
                      {rate.toFixed(0)}% activated
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
    </SectionCard>
  )
}

/* ── Product Mix ─────────────────────────────────────────────── */
function ProductMix({ data, loading }: { data: any[] | null; loading: boolean }) {
  const COLORS = [NAVY, RED, BLUE, GREEN, AMBER, '#8B5CF6']
  const total = (data || []).reduce((s, r) => s + Number(r.total || 0), 0)
  return (
    <SectionCard title="Product Mix" subtitle="All-time issuance by product">
      <div className="px-5 py-4 space-y-4">
        {loading || !data
          ? Array.from({ length: 4 }).map((_, i) => <div key={i} className="space-y-2"><Sk w="w-32" /><Sk h="h-2" /></div>)
          : data.map((row, i) => {
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
                      <span className="text-[13px] font-semibold text-slate-700">{row['Product Name'] || '—'}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] font-medium" style={{ color: GREEN }}>{actRate.toFixed(0)}% active</span>
                      <span className="kpi-number text-[13px] font-bold text-slate-800">{fmtNum(totalN)}</span>
                      <span className="text-[11px] text-slate-400 w-8 text-right">{share.toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${share}%`, background: color }} />
                  </div>
                </div>
              )
            })}
        {!loading && data && (
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2"
            style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
            <span>Total issued</span>
            <span className="font-semibold text-slate-600 kpi-number">{fmtNum(total)}</span>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ───────────────────────────────────────────────── */
export default function SalesOverview() {
  const [from, setFrom] = useState(monthStart())
  const [to,   setTo]   = useState(today())

  const [kpis,      setKpis]      = useState<any>(null)
  const [funnel,    setFunnel]    = useState<any>(null)
  const [trend,     setTrend]     = useState<any[]>([])
  const [managers,  setManagers]  = useState<any[] | null>(null)
  const [states,    setStates]    = useState<any[]>([])
  const [products,  setProducts]  = useState<any[] | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [k, fn, tr, mg, st, pr] = await Promise.all([
        apiFetch('/api/sales/kpis'),
        apiFetch('/api/sales/funnel'),
        apiFetch('/api/sales/accounts-trend'),
        apiFetch('/api/sales/manager-performance'),
        apiFetch('/api/sales/by-state'),
        apiFetch('/api/sales/product-mix'),
      ])
      setKpis(k.data || {})
      setFunnel(fn.data || null)
      setTrend(tr.data || [])
      setManagers(mg.data || [])
      setStates(st.data || [])
      setProducts(pr.data || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  async function doExport() {
    setExporting(true)
    try {
      const { apiExport } = await import('../../lib/api')
      await apiExport('/api/sales/customers?limit=500', 'sales_customers')
    } finally { setExporting(false) }
  }

  /* MoM change from trend data */
  function momFromTrend() {
    if (trend.length < 2) return null
    const prev = n(trend[trend.length - 2]?.new_accounts)
    const curr = n(trend[trend.length - 1]?.new_accounts)
    if (prev === 0) return null
    return ((curr - prev) / prev) * 100
  }

  return (
    <Page dept="Sales" title="Sales Overview"
      subtitle="Customer acquisition, team performance, and market penetration"
      actions={
        <div className="flex items-center gap-2">
          <ExportBtn onClick={doExport} loading={exporting} />
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
        </div>
      }>
      <ErrBanner msg={error} />

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KpiCard label="Total Customers" value={fmtNum(d.total_customers)} icon="groups"
          accent={NAVY} loading={loading} change={momFromTrend()} />
        <KpiCard label="New This Month" value={fmtNum(d.new_mtd)} icon="person_add"
          accent={RED} sub={`${fmtNum(d.prev_month)} last month`} loading={loading} />
        <KpiCard label="MoM Growth"
          value={d.mom_growth != null ? `${d.mom_growth >= 0 ? '+' : ''}${d.mom_growth}%` : '—'}
          icon="trending_up" accent={n(d.mom_growth) >= 0 ? GREEN : RED}
          sub="vs previous month" loading={loading} />
        <KpiCard label="YTD New Accounts" value={fmtNum(d.ytd_new)} icon="calendar_today"
          accent={NAVY} loading={loading} />
        <KpiCard label="Activation Rate" value={fmtPct(d.activation_rate)}
          icon="check_circle" accent={n(d.activation_rate) >= 70 ? GREEN : AMBER}
          sub={`${fmtNum(d.active_cards)} active cards`} loading={loading} />
        <KpiCard label="States Reached" value={fmtNum(d.states_reached)} icon="location_on"
          accent={BLUE} sub="active regions" loading={loading} />
      </div>

      {/* Lifecycle Funnel */}
      <div className="mt-4">
        <LifecycleFunnel data={funnel} loading={loading} />
      </div>

      {/* Acquisition Trend + Product Mix */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Acquisition Trend"
            subtitle="New customer accounts over time"
            data={trend}
            xKey="month"
            areaKey="new_accounts"
            color={RED}
            height={260}
            loading={loading}
          />
        </div>
        <ProductMix data={products} loading={loading} />
      </div>

      {/* Manager Leaderboard + Geographic */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <ManagerLeaderboard data={managers} loading={loading} />
        <ProgressList
          title="Top States by Customers"
          subtitle="Geographic market penetration"
          data={states.slice(0, 10)}
          nameKey="State"
          valueKey="count"
          loading={loading}
        />
      </div>
    </Page>
  )
}
