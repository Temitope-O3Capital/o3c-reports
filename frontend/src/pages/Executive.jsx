import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { AreaChartCard, BarChartCard, ProgressListCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import DataBanner from '../components/DataBanner.jsx'

/* ── Period config ─────────────────────────────────────────────────────────── */
const PERIODS = [
  { key: 'month',   label: 'This Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'year',    label: 'This Year' },
  { key: 'custom',  label: 'Custom Range' },
]

/* ── Metric card with trend badge ──────────────────────────────────────────── */
function Metric({ label, value, change, changeSuffix = 'vs prior period', icon, loading }) {
  const up  = change != null && change >= 0
  const hasChange = change != null

  if (loading) {
    return (
      <div className="card p-5">
        <div className="skeleton h-3 w-24 rounded mb-4" />
        <div className="skeleton h-8 w-28 rounded mb-3" />
        <div className="skeleton h-3 w-20 rounded" />
      </div>
    )
  }

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-4">
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>
          {label}
        </p>
        {icon && (
          <span className="material-symbols-rounded text-[18px] text-slate-300 dark:text-slate-600">{icon}</span>
        )}
      </div>
      <p className="text-[28px] font-bold tracking-tight leading-none font-mono tabular-nums text-slate-900 dark:text-white mb-3">
        {value ?? '—'}
      </p>
      {hasChange ? (
        <div className="flex items-center gap-1.5">
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 2,
            fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 20,
            background: up ? 'rgb(5 150 105 / 0.08)' : 'rgb(220 38 38 / 0.07)',
            color: up ? '#059669' : '#DC2626',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 11 }}>
              {up ? 'trending_up' : 'trending_down'}
            </span>
            {up ? '+' : ''}{Math.abs(change).toFixed(1)}%
          </span>
          <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{changeSuffix}</span>
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>All time</p>
      )}
    </div>
  )
}

/* ── Section header ────────────────────────────────────────────────────────── */
function Section({ icon, title, color = '#0E2841', children }) {
  return (
    <div className="mb-6 print:mb-4">
      <div className="flex items-center gap-2.5 mb-4 print:mb-3">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${color}12` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color }}>{icon}</span>
        </div>
        <p className="text-[13px] font-bold uppercase tracking-widest" style={{ color }}>{title}</p>
        <div className="flex-1 h-px" style={{ background: `${color}18` }} />
      </div>
      {children}
    </div>
  )
}

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function Executive() {
  const [period,    setPeriod]    = useState('month')
  const [custStart, setCustStart] = useState('')
  const [custEnd,   setCustEnd]   = useState('')
  const [data,      setData]      = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ period })
      if (period === 'custom') {
        if (!custStart || !custEnd) { setLoading(false); return }
        params.set('start', custStart)
        params.set('end', custEnd)
      }
      const res = await apiFetch(`/api/executive/summary?${params}`)
      setData(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [period, custStart, custEnd])

  useEffect(() => { load() }, [load])

  const f  = data?.financial  || {}
  const g  = data?.growth     || {}
  const t  = data?.trends     || {}
  const br = data?.breakdowns || {}
  const pr = data?.period     || {}

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in print:px-4 print:py-4">

      {/* ── Report header ── */}
      <div className="flex items-start justify-between mb-7 print:mb-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="text-2xl font-bold text-primary dark:text-white">
              O3<span className="text-accent">C</span>
            </span>
            <div className="w-px h-6 bg-slate-200 dark:bg-slate-700" />
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Executive Dashboard</h1>
          </div>
          <div className="flex items-center gap-3 mt-1">
            {pr.label && (
              <p className="text-sm font-semibold text-primary dark:text-primary-100">
                {pr.label}
                {pr.start && pr.type !== 'custom' && (
                  <span className="font-normal text-slate-400 ml-1.5">
                    ({new Date(pr.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {' – '}{new Date(pr.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})
                  </span>
                )}
              </p>
            )}
            {data?.data_source && <DataBanner source={data.data_source} compact />}
          </div>
          <p className="text-xs text-slate-400 mt-1">Generated {today}</p>
        </div>

        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => window.print()}
            className="btn btn-ghost gap-1.5 text-sm"
          >
            <span className="material-symbols-rounded text-[17px]">print</span>
            Print / PDF
          </button>
        </div>
      </div>

      {/* ── Period selector ── */}
      <div className="flex items-center gap-3 mb-7 flex-wrap no-print">
        <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700">
          {PERIODS.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                period === p.key
                  ? 'bg-primary text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="form-input w-auto text-sm"
              value={custStart}
              onChange={e => setCustStart(e.target.value)}
            />
            <span className="text-slate-400 text-sm">to</span>
            <input
              type="date"
              className="form-input w-auto text-sm"
              value={custEnd}
              onChange={e => setCustEnd(e.target.value)}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/15 border border-red-100 text-red-600 text-sm rounded-xl px-4 py-3 mb-6">
          <span className="material-symbols-rounded text-[16px]">error</span>{error}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          SECTION 1 — FINANCIAL PERFORMANCE (CFO)
          ══════════════════════════════════════════════════════════════ */}
      <Section icon="account_balance" title="Financial Performance" color="#0E2841">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <Metric label="Transaction Volume"  value={fmt(f.txn_volume)}     change={f.txn_volume_change}   icon="receipt_long"        loading={loading} />
          <Metric label="Transaction Count"   value={fmtNum(f.txn_count)}   change={f.txn_count_change}    icon="tag"                 loading={loading} />
          <Metric label="Collections"         value={fmt(f.collections)}    change={f.collections_change}  icon="account_balance_wallet" loading={loading} />
          <Metric label="Recovery"            value={fmt(f.recovery)}       change={f.recovery_change}     icon="gavel"               loading={loading} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <Metric label="Avg Transaction"     value={fmt(f.avg_txn_value)}  icon="calculate"               loading={loading} />
          <Metric label="Collection Count"    value={fmtNum(f.collections_count)} icon="format_list_numbered" loading={loading} />
          <Metric label="Total Collected (All‑Time)" value={fmt(f.total_collected_all)} icon="savings" loading={loading} />
          <Metric label="Recovery Rate"       value={pct(f.recovery_rate)}  icon="percent" loading={loading}
            change={null} />
        </div>

        <AreaChartCard
          title="Collections & Recovery — Monthly Trend"
          subtitle="Last 12 months"
          data={t.monthly || []}
          xKey="month"
          areas={[
            { key: 'collections', label: 'Collections', color: '#10B981' },
            { key: 'recovery',    label: 'Recovery',    color: '#3B82F6' },
          ]}
          height={220}
          currency
        />
      </Section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 2 — GROWTH & ACQUISITION (MD)
          ══════════════════════════════════════════════════════════════ */}
      <Section icon="trending_up" title="Growth & Acquisition" color="#C00000">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <Metric label="New Customers"      value={fmtNum(g.new_customers)}  change={g.new_customers_change} icon="person_add"    loading={loading} />
          <Metric label="Total Customer Base" value={fmtNum(g.total_customers)} icon="groups"                  loading={loading} />
          <Metric label="Active Cards"       value={fmtNum(g.active_cards)}   icon="credit_card"              loading={loading} />
          <Metric label="Activation Rate"    value={pct(g.activation_rate)}   icon="bolt"                     loading={loading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <AreaChartCard
              title="New Customer Acquisition — Monthly Trend"
              subtitle="Last 12 months"
              data={t.acquisition || []}
              xKey="month"
              areas={[{ key: 'new_accounts', label: 'New Customers', color: '#C00000' }]}
              height={220}
            />
          </div>
          <ProgressListCard
            title="Top Regions"
            subtitle="Customers by state"
            data={br.top_states || []}
            nameKey="State"
            valueKey="count"
            maxItems={8}
          />
        </div>
      </Section>

      {/* ══════════════════════════════════════════════════════════════
          SECTION 3 — OPERATIONS (COO)
          ══════════════════════════════════════════════════════════════ */}
      <Section icon="settings" title="Operations" color="#8B5CF6">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
          <Metric label="Transaction Volume (Period)" value={fmt(f.txn_volume)}  change={f.txn_volume_change}  icon="payments"    loading={loading} />
          <Metric label="States Covered"              value={fmtNum(g.states_covered)} icon="location_on"     loading={loading} />
          <Metric label="Total Cards Issued"          value={fmtNum(g.total_cards)}   icon="credit_card"      loading={loading} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ProgressListCard
            title="Product Mix"
            subtitle="Cards by product type"
            data={br.product_mix || []}
            nameKey="Product Name"
            valueKey="count"
            maxItems={6}
          />
          <ProgressListCard
            title={`Top Collections Agents — ${pr.label || 'Period'}`}
            subtitle="By amount collected"
            data={br.top_agents || []}
            nameKey="Agent"
            valueKey="total"
            currency
            maxItems={8}
          />
        </div>
      </Section>

      {/* ── Volume trend (full width) ── */}
      <div className="mt-2 print:mt-2">
        <AreaChartCard
          title="Transaction Volume — Monthly Trend"
          subtitle="Last 12 months · all card products"
          data={t.monthly || []}
          xKey="month"
          areas={[{ key: 'volume', label: 'Volume', color: '#0E2841' }]}
          height={200}
          currency
        />
      </div>

      {/* ── Print footer ── */}
      <div className="hidden print:block mt-8 pt-4 border-t border-slate-200 text-[10px] text-slate-400 flex items-center justify-between">
        <span>O3 Capital — Central Reporting System · Confidential</span>
        <span>Generated {today} · {pr.label}</span>
      </div>

    </div>
  )
}
