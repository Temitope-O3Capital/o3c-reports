import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DateFilter, BarChartCard, ErrBanner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'

/* ── Types ── */
interface SettlementRow {
  settlement_date: string
  credits: number
  debits: number
  net_position: number
  txn_count: number
}

interface ReconSummary {
  processor: string
  total_credits: number
  total_debits: number
  matched_count: number
  exception_count: number
  last_run_at?: string
}

/* ── Quick-link button ── */
function QuickLink({ label, to, icon }: { label: string; to: string; icon: string }) {
  const nav = useNavigate()
  return (
    <button
      onClick={() => nav(to)}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-[13px] font-semibold transition-all hover:shadow-sm bg-white"
      style={{ borderColor: 'rgba(15,23,42,0.12)', color: NAVY }}>
      <span className="material-symbols-rounded text-[17px]">{icon}</span>
      {label}
    </button>
  )
}

/* ── Recon panel (one per processor) ── */
function ReconPanel({ data, loading }: { data: ReconSummary | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        <div className="h-4 skeleton w-24 rounded" />
        <div className="h-3 skeleton w-full rounded" />
        <div className="h-3 skeleton w-3/4 rounded" />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="rounded-xl border p-4 flex items-center justify-center gap-2 text-slate-400"
        style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
        <span className="material-symbols-rounded text-[18px]">sync_disabled</span>
        <span className="text-[13px]">No data available</span>
      </div>
    )
  }

  const exceptionColor = data.exception_count > 0 ? RED : GREEN
  return (
    <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-slate-800">{data.processor}</span>
        {data.last_run_at && (
          <span className="text-[11px] text-slate-400">
            Live · as of {new Date(data.last_run_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">Credits</p>
          <p className="kpi-number text-[15px] font-bold text-slate-800">{fmt(data.total_credits)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">Debits</p>
          <p className="kpi-number text-[15px] font-bold text-slate-800">{fmt(data.total_debits)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">Matched</p>
          <p className="kpi-number text-[15px] font-bold" style={{ color: GREEN }}>
            {n(data.matched_count).toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">Exceptions</p>
          <p className="kpi-number text-[15px] font-bold" style={{ color: exceptionColor }}>
            {n(data.exception_count).toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ── Credits vs Debits grouped bar chart ── */
function SettlementByDayChart({ data, loading }: { data: SettlementRow[]; loading: boolean }) {
  const chartData = data.map(r => ({
    date: (r.settlement_date ?? '').slice(5),
    credits: r.credits,
    debits:  r.debits,
  }))
  return (
    <SectionCard title="Settlement by Day" subtitle="Credits vs Debits per day">
      <div className="px-5 py-4">
        {loading
          ? (
            <div className="flex items-end gap-2" style={{ height: 220 }}>
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex gap-1 flex-1">
                  <div className="flex-1 skeleton rounded-t" style={{ height: `${30 + (i % 4) * 15}%` }} />
                  <div className="flex-1 skeleton rounded-t" style={{ height: `${25 + (i % 3) * 12}%` }} />
                </div>
              ))}
            </div>
          )
          : chartData.length === 0
          ? (
            <div className="flex flex-col items-center py-10 gap-2 text-slate-400" style={{ height: 220 }}>
              <span className="material-symbols-rounded text-[36px]">bar_chart</span>
              <p className="text-[13px]">No settlement data for this period</p>
            </div>
          )
          : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 20, right: 12, left: 0, bottom: 4 }} barSize={16} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                  tickFormatter={v => fmt(v)} width={72}
                  domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
                <Tooltip
                  formatter={(value: number, name: string) => [fmt(value), name === 'credits' ? 'Credits' : 'Debits']}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid rgba(15,23,42,0.1)' }}
                />
                <Legend formatter={(v: string) => v === 'credits' ? 'Credits' : 'Debits'} />
                <Bar dataKey="credits" fill={GREEN}  radius={[3, 3, 0, 0]} />
                <Bar dataKey="debits"  fill={RED}    radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ── */
export default function SettlementsOverview() {
  const [from, setFrom] = useState(monthStart())
  const [to,   setTo]   = useState(today())

  const [settlements, setSettlements] = useState<SettlementRow[]>([])
  const [paystackRecon, setPaystackRecon]       = useState<ReconSummary | null>(null)
  const [interswitchRecon, setInterswitchRecon] = useState<ReconSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [settRes, psRes, isRes] = await Promise.allSettled([
        apiFetch(`/api/settlement/summary?date_from=${from}&date_to=${to}`),
        apiFetch(`/api/reconciliation/paystack/summary?date_from=${from}&date_to=${to}`),
        apiFetch(`/api/reconciliation/interswitch/summary?date_from=${from}&date_to=${to}`),
      ])

      if (settRes.status === 'fulfilled') {
        const v = settRes.value
        const raw: any[] = Array.isArray(v?.data) ? v.data : Array.isArray(v) ? v : []
        setSettlements(raw.map(r => ({
          settlement_date: r.settlement_date ?? r.date ?? '',
          credits:         n(r.credits ?? r.total_credits ?? 0),
          debits:          n(r.debits  ?? r.total_debits  ?? 0),
          net_position:    n(r.net_position ?? r.net ?? 0),
          txn_count:       n(r.txn_count ?? r.count ?? 0),
        })))
      } else {
        setSettlements([])
      }

      if (psRes.status === 'fulfilled') {
        const d = psRes.value.data ?? psRes.value
        setPaystackRecon({
          processor:       'Paystack',
          total_credits:   n(d.total_credits ?? d.credits ?? 0),
          total_debits:    n(d.total_debits  ?? d.debits  ?? 0),
          matched_count:   n(d.matched_count ?? d.matched ?? 0),
          exception_count: n(d.exception_count ?? d.exceptions ?? 0),
          last_run_at:     d.fetched_at ?? d.last_run_at ?? d.updated_at,
        })
      } else {
        setPaystackRecon(null)
      }

      if (isRes.status === 'fulfilled') {
        const d = isRes.value.data ?? isRes.value
        setInterswitchRecon({
          processor:       'Interswitch',
          total_credits:   n(d.total_credits ?? d.credits ?? 0),
          total_debits:    n(d.total_debits  ?? d.debits  ?? 0),
          matched_count:   n(d.matched_count ?? d.matched ?? 0),
          exception_count: n(d.exception_count ?? d.exceptions ?? 0),
          last_run_at:     d.fetched_at ?? d.last_run_at ?? d.updated_at,
        })
      } else {
        setInterswitchRecon(null)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  /* Aggregate KPIs from settlement rows */
  const totalCredits    = settlements.reduce((s, r) => s + r.credits, 0)
  const totalDebits     = settlements.reduce((s, r) => s + r.debits,  0)
  const netPosition     = settlements.reduce((s, r) => s + r.net_position, 0)
  const exceptionsCount = (paystackRecon?.exception_count ?? 0) + (interswitchRecon?.exception_count ?? 0)

  return (
    <Page
      dept="Finance"
      title="Settlements & Reconciliation"
      subtitle="Processor settlement and daily reconciliation"
      actions={
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }>
      <ErrBanner msg={error} />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Total Credits"
          value={fmt(totalCredits)}
          icon="trending_up"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Total Debits"
          value={fmt(totalDebits)}
          icon="trending_down"
          accent={RED}
          loading={loading}
        />
        <KpiCard
          label="Net Position"
          value={fmt(netPosition)}
          icon="account_balance"
          accent={netPosition >= 0 ? GREEN : RED}
          sub={netPosition >= 0 ? 'Positive' : 'Negative'}
          loading={loading}
        />
        <KpiCard
          label="Exceptions"
          value={fmtNum(exceptionsCount)}
          icon="warning"
          accent={exceptionsCount > 0 ? AMBER : GREEN}
          sub={exceptionsCount === 0 ? 'All clear' : 'Needs review'}
          loading={loading}
        />
      </div>

      {/* Settlement by Day */}
      <div className="mt-4">
        <SettlementByDayChart data={settlements} loading={loading} />
      </div>

      {/* Processor Reconciliation */}
      <div className="mt-4">
        <SectionCard
          title="Processor Reconciliation"
          subtitle="Side-by-side recon summary for each payment processor">
          <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <ReconPanel data={paystackRecon}      loading={loading} />
            <ReconPanel data={interswitchRecon}   loading={loading} />
          </div>
        </SectionCard>
      </div>

      {/* Quick links */}
      <div className="mt-4 flex flex-wrap gap-3">
        <QuickLink label="Detailed Reconciliation" to="/finance/reconciliation" icon="receipt_long" />
        <QuickLink label="EOD Reports"             to="/finance/eod"            icon="today" />
        <QuickLink label="Transactions"            to="/finance/transactions"   icon="payments" />
      </div>
    </Page>
  )
}
