import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DateFilter, BarChartCard,
  DataTable, ColDef, ErrBanner, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Types ── */
interface CollectionsKpi {
  total_queue: number
  contacted_today: number
  ptps_today: number
  collected_today_kobo: number
  target_kobo: number
  target_achievement_pct: number
}

interface DpdBucket {
  dpd_bucket: string
  count: number
  outstanding_kobo: number
}

/* ── DPD colour map ── */
const DPD_COLOR: Record<string, string> = {
  current: GREEN,
  '1-30':  AMBER,
  '31-60': '#EA580C',
  '61-90': RED,
  '91+':   '#7F1D1D',
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

/* ── DPD Bucket Summary ── */
function DpdSummary({ data, loading }: { data: DpdBucket[]; loading: boolean }) {
  const total = data.reduce((s, r) => s + n(r.count), 0)
  return (
    <SectionCard title="DPD Bucket Summary" subtitle="Queue distribution by days-past-due">
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between">
                  <div className="h-3 skeleton w-16 rounded" />
                  <div className="h-3 skeleton w-20 rounded" />
                </div>
                <div className="h-2 skeleton w-full rounded-full" />
              </div>
            ))
          : data.length === 0
          ? <p className="text-[13px] text-slate-400 py-8 text-center">No bucket data</p>
          : data.map((row, i) => {
              const share = total > 0 ? (n(row.count) / total) * 100 : 0
              const color = DPD_COLOR[row.dpd_bucket] ?? '#94A3B8'
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                      <span className="text-[12px] font-semibold text-slate-700">
                        DPD {row.dpd_bucket}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] text-slate-400">{fmt(n(row.outstanding_kobo) / 100)}</span>
                      <span className="kpi-number text-[13px] font-bold text-slate-800">
                        {n(row.count).toLocaleString()}
                      </span>
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
        {!loading && total > 0 && (
          <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2"
            style={{ borderTop: '1px solid rgba(15,23,42,0.06)' }}>
            <span>Total in queue</span>
            <span className="kpi-number font-semibold text-slate-600">{total.toLocaleString()}</span>
          </div>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ── */
export default function CollectionsOverview() {
  const [from, setFrom] = useState(monthStart())
  const [to,   setTo]   = useState(today())

  const [kpis,    setKpis]    = useState<CollectionsKpi | null>(null)
  const [buckets, setBuckets] = useState<DpdBucket[]>([])
  const [activity, setActivity] = useState<any[]>([])
  const [loading, setLoading]  = useState(true)
  const [error,   setError]    = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // Dashboard endpoint returns: total_assigned, contacts_today, honoured_today,
      // collected_today_kobo, overdue_promises
      const res = await apiFetch('/api/collections-ops/dashboard')
      const d   = res.data ?? res
      const kpiData: CollectionsKpi = {
        total_queue:            n(d.total_assigned ?? 0),
        contacted_today:        n(d.contacts_today ?? 0),
        ptps_today:             n(d.honoured_today ?? 0),
        collected_today_kobo:   n(d.collected_today_kobo ?? 0),
        target_kobo:            0,
        target_achievement_pct: 0,
      }
      setKpis(kpiData)

      // Activity trend for the date range
      try {
        const res = await apiFetch(`/api/collections-ops/activity?date_from=${from}&date_to=${to}`)
        setActivity((res.data ?? res) as any[])
      } catch {
        setActivity([])
      }

      // DPD bucket breakdown
      try {
        const res = await apiFetch('/api/collections-ops/dpd-buckets')
        setBuckets((res.data ?? res) as DpdBucket[])
      } catch {
        // Derive buckets from queue if dedicated endpoint unavailable
        try {
          const qRes = await apiFetch('/api/collections-ops/queue?limit=500')
          const rows: any[] = qRes.data ?? qRes ?? []
          const map: Record<string, { count: number; outstanding_kobo: number }> = {}
          rows.forEach(r => {
            const b = r.dpd_bucket ?? 'unknown'
            if (!map[b]) map[b] = { count: 0, outstanding_kobo: 0 }
            map[b].count++
            map[b].outstanding_kobo += n(r.outstanding_kobo)
          })
          setBuckets(Object.entries(map).map(([dpd_bucket, v]) => ({ dpd_bucket, ...v })))
        } catch {
          setBuckets([])
        }
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const d = kpis ?? {} as Partial<CollectionsKpi>
  const achievePct = n(d.target_achievement_pct)

  /* Activity bar-chart data */
  const activityCols: ColDef<any>[] = [
    { key: 'agent_name',    label: 'Agent' },
    { key: 'contacts',      label: 'Contacts',  right: true, render: r => n(r.contacts).toLocaleString() },
    { key: 'ptps',          label: 'PTPs',       right: true, render: r => n(r.ptps).toLocaleString() },
    { key: 'collected_kobo',label: 'Collected',  right: true,
      render: r => <span className="font-mono font-semibold">{fmt(n(r.collected_kobo) / 100)}</span> },
  ]

  return (
    <Page
      dept="Collections"
      title="Collections Overview"
      subtitle="Agent activity, targets and daily recovery"
      actions={
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      }>
      <ErrBanner msg={error} />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Active Queue"
          value={fmtNum(d.total_queue)}
          icon="assignment"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Contacted Today"
          value={fmtNum(d.contacted_today)}
          icon="phone_in_talk"
          accent={AMBER}
          loading={loading}
        />
        <KpiCard
          label="PTPs Today"
          value={fmtNum(d.ptps_today)}
          icon="handshake"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Collected Today"
          value={fmt(n(d.collected_today_kobo) / 100)}
          icon="payments"
          accent={GREEN}
          sub={d.target_kobo ? `Target: ${fmt(n(d.target_kobo) / 100)}` : undefined}
          loading={loading}
        />
      </div>

      {/* Target achievement banner */}
      {!loading && n(d.target_kobo) > 0 && (
        <div className="mt-4 card px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-semibold text-slate-700">Daily Target Achievement</span>
            <span className="kpi-number text-[15px] font-bold" style={{ color: achievePct >= 100 ? GREEN : achievePct >= 70 ? AMBER : RED }}>
              {achievePct.toFixed(1)}%
            </span>
          </div>
          <div className="h-3 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
            <div className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.min(achievePct, 100)}%`,
                background: achievePct >= 100 ? GREEN : achievePct >= 70 ? AMBER : RED,
              }} />
          </div>
          <p className="text-[11px] text-slate-400 mt-1.5">
            {fmt(n(d.collected_today_kobo) / 100)} collected of {fmt(n(d.target_kobo) / 100)} target
          </p>
        </div>
      )}

      {/* Today's activity + DPD summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <SectionCard title="Today's Activity" subtitle={`Agent performance ${from} – ${to}`}>
          {activity.length > 0
            ? <DataTable cols={activityCols} rows={activity} loading={loading} emptyMsg="No activity data" />
            : (
              <div className="px-5 py-10 flex flex-col items-center gap-2 text-slate-400">
                <span className="material-symbols-rounded text-[36px]">bar_chart</span>
                <p className="text-[13px]">No activity data for this period</p>
              </div>
            )}
        </SectionCard>

        <DpdSummary data={buckets} loading={loading} />
      </div>

      {/* Bar chart of activity trend if data has a date key */}
      {activity.length > 0 && (activity[0]?.date || activity[0]?.activity_date) && (
        <div className="mt-4">
          <BarChartCard
            title="Collections Trend"
            subtitle={`Daily collected amount ${from} – ${to}`}
            data={activity.map(r => ({
              ...r,
              date: (r.date ?? r.activity_date ?? '').slice(5),
              collected: n(r.collected_kobo) / 100,
            }))}
            xKey="date"
            barKey="collected"
            color={GREEN}
            currency
            height={220}
            loading={loading}
          />
        </div>
      )}

      {/* Quick links */}
      <div className="mt-4 flex flex-wrap gap-3">
        <QuickLink label="Agent Queue"      to="/collections/queue"    icon="assignment" />
        <QuickLink label="Targets"          to="/collections/targets"  icon="flag" />
        <QuickLink label="Promise-to-Pay"   to="/collections/promises" icon="handshake" />
      </div>
    </Page>
  )
}
