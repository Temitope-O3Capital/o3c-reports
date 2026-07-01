import { snake } from '../../lib/labels'
import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef,
  AreaChartCard, BarChartCard, DonutCard, ProgressList,
  ErrBanner, Sk, DateFilter, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Types ──────────────────────────────────────────────────────── */
interface Overview {
  total_contacts: number
  total_leads: number
  total_customers: number
  total_deals: number
  won_deals: number
  lost_deals: number
  activities_30d: number
  open_tasks: number
  overdue_tasks: number
  open_requests: number
  sla_breached: number
  avg_resolution_hrs: number | null
}

interface PipelineStage {
  name: string
  color: string
  deal_count: number
  pipeline_value: number
  avg_probability: number
  is_won: boolean
  is_lost: boolean
}

interface AgentRow {
  id: number
  full_name: string
  role: string
  activities: number
  deals_owned: number
  deals_won: number
  tasks_assigned: number
  tasks_done: number
  contacts_owned: number
}

interface SourceRow {
  source: string
  total: number
  converted: number
}

interface SLARow {
  request_type: string
  total: number
  resolved: number
  sla_breached: number
  avg_resolution_hrs: number | null
}

interface TrendPoint {
  month: string
  new_contacts: number
  converted: number
}

interface ActivityDay {
  day: string
  type: string
  count: number
}

/* ── Helpers ────────────────────────────────────────────────────── */
function pct(a: number, b: number): string {
  if (!b) return '0%'
  return (a / b * 100).toFixed(0) + '%'
}

function prevPeriod(from: string, to: string): [string, string] {
  const f = new Date(from), t = new Date(to)
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1
  const prevTo = new Date(f.getTime() - 86400000)
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000)
  return [prevFrom.toISOString().slice(0, 10), prevTo.toISOString().slice(0, 10)]
}

function delta(curr: number, prev: number): number | null {
  if (!prev) return null
  return Math.round((curr - prev) / prev * 100)
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function CrmReports() {
  const [overview,    setOverview]    = useState<Overview | null>(null)
  const [prevOverview,setPrevOverview] = useState<Overview | null>(null)
  const [pipeline, setPipeline] = useState<PipelineStage[]>([])
  const [agents,   setAgents]   = useState<AgentRow[]>([])
  const [sources,  setSources]  = useState<SourceRow[]>([])
  const [sla,      setSLA]      = useState<SLARow[]>([])
  const [trend,    setTrend]    = useState<TrendPoint[]>([])
  const [actTrend, setActTrend] = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState('')
  const [from,     setFrom]     = useState(monthStart)
  const [to,       setTo]       = useState(today)

  useEffect(() => {
    let active = true
    setLoading(true); setErr('')
    const qs = `date_from=${from}&date_to=${to}`
    const [pf, pt] = prevPeriod(from, to)
    const prevQs = `date_from=${pf}&date_to=${pt}`
    async function load() {
      try {
        const [ov, pip, ag, src, sl, tr, at, prevOv] = await Promise.allSettled([
          apiFetch<Overview>(`/api/crm/reports/overview?${qs}`),
          apiFetch<PipelineStage[]>(`/api/crm/reports/pipeline?${qs}`),
          apiFetch<AgentRow[]>(`/api/crm/reports/agent-performance?${qs}`),
          apiFetch<SourceRow[]>(`/api/crm/reports/contacts-by-source?${qs}`),
          apiFetch<SLARow[]>(`/api/crm/reports/requests-sla?${qs}`),
          apiFetch<TrendPoint[]>(`/api/crm/reports/new-contacts-trend?${qs}`),
          apiFetch<ActivityDay[]>(`/api/crm/reports/activity-trend?${qs}`),
          apiFetch<Overview>(`/api/crm/reports/overview?${prevQs}`),
        ])
        if (ov.status === 'fulfilled' && active) setOverview(ov.value)
        if (prevOv.status === 'fulfilled' && active) setPrevOverview(prevOv.value)
        if (pip.status === 'fulfilled' && active) setPipeline(pip.value ?? [])
        if (ag.status === 'fulfilled' && active) setAgents(ag.value ?? [])
        if (src.status === 'fulfilled' && active) setSources(src.value ?? [])
        if (sl.status === 'fulfilled' && active) setSLA(sl.value ?? [])
        if (tr.status === 'fulfilled' && active) setTrend(tr.value ?? [])
        if (at.status === 'fulfilled' && active) {
          const dayMap: Record<string, number> = {}
          for (const r of at.value ?? []) {
            dayMap[r.day] = (dayMap[r.day] ?? 0) + n(r.count)
          }
          setActTrend(Object.entries(dayMap).map(([day, count]) => ({ day: fmtDate(day, { day: '2-digit', month: 'short' }), count })))
        }
        if ([ov, pip, ag, src, sl, tr, at].every(r => r.status === 'rejected')) {
          if (active) setErr((ov as PromiseRejectedResult).reason?.message ?? 'Failed to load')
        }
      } catch (ex: any) {
        if (active) setErr(ex.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => { active = false }
  }, [from, to])

  const ov = overview
  const pov = prevOverview
  const chg = (key: keyof Overview) =>
    ov && pov ? delta(n(ov[key] as number), n(pov[key] as number)) : null

  /* Agent table cols */
  const agentCols: ColDef<AgentRow>[] = [
    { key: 'full_name', label: 'Agent', render: r => <span className="font-semibold text-slate-800 text-[13px]">{r.full_name}</span> },
    { key: 'role', label: 'Role', render: r => (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded"
        style={{ background: 'rgba(14,40,65,0.06)', color: '#475569' }}>
        {r.role}
      </span>
    )},
    { key: 'activities',    label: 'Activities (30d)', right: true, render: r => <span className="kpi-number text-[12px]">{fmtNum(r.activities)}</span> },
    { key: 'deals_owned',   label: 'Deals',            right: true, render: r => <span className="kpi-number text-[12px]">{r.deals_owned}</span> },
    { key: 'deals_won',     label: 'Won',              right: true, render: r => <span className="kpi-number text-[12px] text-green-600">{r.deals_won}</span> },
    { key: 'contacts_owned',label: 'Contacts',         right: true, render: r => <span className="kpi-number text-[12px]">{r.contacts_owned}</span> },
    {
      key: 'tasks_done', label: 'Task Rate', right: true,
      render: r => (
        <div className="flex items-center gap-2 justify-end">
          <div className="w-16 h-1.5 rounded-full" style={{ background: 'rgba(14,40,65,0.08)' }}>
            <div className="h-full rounded-full" style={{ width: pct(r.tasks_done, r.tasks_assigned), background: GREEN }} />
          </div>
          <span className="text-[12px] text-slate-500">{pct(r.tasks_done, r.tasks_assigned)}</span>
        </div>
      ),
    },
  ]

  /* SLA table cols */
  const slaCols: ColDef<SLARow>[] = [
    { key: 'request_type', label: 'Request Type', render: r => <span className="font-medium text-slate-700 capitalize">{snake(r.request_type)}</span> },
    { key: 'total',    label: 'Total',    right: true, render: r => <span className="kpi-number text-[12px]">{r.total}</span> },
    { key: 'resolved', label: 'Resolved', right: true, render: r => <span className="kpi-number text-[12px] text-green-600">{r.resolved}</span> },
    {
      key: 'sla_breached', label: 'SLA Breached', right: true,
      render: r => (
        <span className={`kpi-number text-[12px] font-semibold ${r.sla_breached > 0 ? 'text-red-600' : 'text-slate-400'}`}>
          {r.sla_breached}
        </span>
      ),
    },
    {
      key: 'avg_resolution_hrs', label: 'Avg Resolution', right: true,
      render: r => <span className="text-[12px] text-slate-500">{r.avg_resolution_hrs != null ? r.avg_resolution_hrs.toFixed(1) + 'h' : '—'}</span>,
    },
    {
      key: '_rate', label: 'Resolve Rate', right: true,
      render: r => (
        <div className="flex items-center gap-2 justify-end">
          <div className="w-14 h-1.5 rounded-full" style={{ background: 'rgba(14,40,65,0.08)' }}>
            <div className="h-full rounded-full" style={{ width: pct(r.resolved, r.total), background: NAVY }} />
          </div>
          <span className="text-[11px] text-slate-500">{pct(r.resolved, r.total)}</span>
        </div>
      ),
    },
  ]

  return (
    <Page dept="CRM" title="CRM Reports" subtitle="Activity, pipeline, and team performance analytics"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />}>
      <ErrBanner msg={err} />

      {/* Overview KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Total Contacts" value={fmtNum(n(ov?.total_contacts))} icon="contacts" loading={loading} change={chg('total_contacts')} changePeriod="vs prev period" />
        <KpiCard label="Total Leads"    value={fmtNum(n(ov?.total_leads))}    icon="person_search" loading={loading} change={chg('total_leads')} changePeriod="vs prev period" />
        <KpiCard label="Customers"      value={fmtNum(n(ov?.total_customers))} icon="verified_user" accent={GREEN} loading={loading} change={chg('total_customers')} changePeriod="vs prev period" />
        <KpiCard label="Conversion"
          value={ov ? pct(n(ov.total_customers), n(ov.total_contacts)) : '—'}
          icon="trending_up" accent={GREEN}
          sub="contacts → customers"
          loading={loading} />
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Active Deals"  value={String(n(ov?.total_deals))}  icon="handshake"    loading={loading} change={chg('total_deals')} changePeriod="vs prev period" />
        <KpiCard label="Won Deals"     value={String(n(ov?.won_deals))}    icon="check_circle" accent={GREEN} loading={loading} change={chg('won_deals')} changePeriod="vs prev period" />
        <KpiCard label="Open Tasks"    value={String(n(ov?.open_tasks))}   icon="task_alt"     loading={loading} />
        <KpiCard label="Overdue Tasks" value={String(n(ov?.overdue_tasks))} icon="schedule"    accent={RED} loading={loading} />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Activities (30d)"   value={fmtNum(n(ov?.activities_30d))} icon="local_activity" loading={loading} change={chg('activities_30d')} changePeriod="vs prev period" />
        <KpiCard label="SLA Breaches"       value={String(n(ov?.sla_breached))}   icon="gpp_bad"        accent={RED}   loading={loading} />
        <KpiCard label="Avg Resolution"
          value={ov?.avg_resolution_hrs != null ? ov.avg_resolution_hrs.toFixed(1) + 'h' : '—'}
          icon="avg_pace"
          sub="hours per request"
          loading={loading} />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-3 gap-5 mb-5">
        <div className="col-span-2">
          <AreaChartCard
            title="New Contacts Trend"
            subtitle="Monthly new contacts over last 12 months"
            data={trend} xKey="month" areaKey="new_contacts"
            height={200} loading={loading} />
        </div>
        <DonutCard
          title="Contacts by Source"
          subtitle="Acquisition channel breakdown"
          data={sources} nameKey="source" valueKey="total"
          loading={loading} />
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-3 gap-5 mb-5">
        <div className="col-span-2">
          <BarChartCard
            title="Daily Activity Trend"
            subtitle="Activities logged per day (last 30 days)"
            data={actTrend} xKey="day" barKey="count"
            height={200} loading={loading} />
        </div>
        <div>
          {/* Pipeline value by stage */}
          {loading ? (
            <SectionCard title="Pipeline by Stage">
              <div className="p-5 space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="space-y-1.5"><Sk w="w-32" /><Sk h="h-1.5" /></div>)}</div>
            </SectionCard>
          ) : (
            <ProgressList
              title="Pipeline by Stage"
              subtitle="Active deal counts per stage"
              data={pipeline.filter(s => !s.is_won && !s.is_lost).map(s => ({ name: s.name, value: s.deal_count }))}
              nameKey="name" valueKey="value" />
          )}
        </div>
      </div>

      {/* Stage conversion funnel */}
      {!loading && pipeline.length > 0 && (
        <SectionCard title="Stage Conversion Funnel" subtitle="Deal distribution across pipeline stages" className="mb-5">
          <div className="p-5 space-y-3">
            {pipeline.map((s, i) => {
              const first = n(pipeline[0]?.deal_count)
              const pctVal = first > 0 ? Math.round(n(s.deal_count) / first * 100) : 0
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: s.color || NAVY }} />
                      <span className="text-[12px] text-slate-600">{s.name}</span>
                      {s.is_won && <span className="text-[11px] font-semibold text-green-600 bg-green-50 px-1.5 py-0.5 rounded">WON</span>}
                      {s.is_lost && <span className="text-[11px] font-semibold text-red-600 bg-red-50 px-1.5 py-0.5 rounded">LOST</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-mono font-semibold text-slate-800">{s.deal_count} deals</span>
                      <span className="text-[11px] text-slate-400 w-8 text-right">{pctVal}%</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full" style={{ background: 'rgba(14,40,65,0.07)' }}>
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${pctVal}%`, background: s.color || NAVY }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      {/* Agent performance table */}
      <SectionCard title="Agent Performance" subtitle="Team activity and deal metrics (last 30 days)" className="mb-5">
        <DataTable<AgentRow>
          cols={agentCols} rows={agents} loading={loading}
          emptyIcon="group" emptyMsg="No agent data available" />
      </SectionCard>

      {/* SLA table */}
      <SectionCard title="Requests SLA Breakdown" subtitle="Service request resolution metrics by type">
        <DataTable<SLARow>
          cols={slaCols} rows={sla} loading={loading}
          emptyIcon="support_agent" emptyMsg="No SLA data available" />
      </SectionCard>
    </Page>
  )
}
