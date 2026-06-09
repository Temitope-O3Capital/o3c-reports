import { useApi } from '../../hooks/useApi.js'
import { KpiCard, AreaChartCard, BarChartCard, ProgressListCard, fmtNum, pct } from '../../components/Charts.jsx'
import PageShell from '../../components/PageShell.jsx'

const ACTIVITY_COLORS = {
  call: '#3B82F6', email: '#8B5CF6', visit: '#10B981',
  note: '#F59E0B', whatsapp: '#25D366', sms: '#94A3B8',
}

function PipelineFunnelCard({ data = [] }) {
  const max = Math.max(...data.map(d => Number(d.deal_count || 0)), 1)
  return (
    <div className="card p-6">
      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-5">Pipeline by Stage</p>
      <div className="space-y-3">
        {data.filter(s => !s.is_lost).map((s, i) => {
          const count = Number(s.deal_count || 0)
          const value = Number(s.pipeline_value || 0)
          return (
            <div key={s.name}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-[13px] font-medium text-slate-700 dark:text-slate-300">{s.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  {value > 0 && <span className="text-[11px] text-slate-400">₦{value.toLocaleString()}</span>}
                  <span className="text-[13px] font-bold tabular-nums text-slate-800 dark:text-slate-100">{count}</span>
                </div>
              </div>
              <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${(count / max) * 100}%`, background: s.color }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AgentTable({ data = [] }) {
  if (!data.length) return (
    <div className="card p-8 flex flex-col items-center text-slate-400">
      <span className="material-symbols-rounded text-[36px] opacity-30 mb-2">leaderboard</span>
      <p className="text-sm">No agent data yet</p>
    </div>
  )
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/50">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Agent Performance (30 days)</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="text-right">Activities</th>
              <th className="text-right">Contacts</th>
              <th className="text-right">Deals</th>
              <th className="text-right">Won</th>
              <th className="text-right">Tasks Done</th>
            </tr>
          </thead>
          <tbody>
            {data.map((a, i) => (
              <tr key={a.id}>
                <td>
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                      style={{ background: `hsl(${(i * 47) % 360} 55% 45%)` }}>
                      {(a.full_name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
                    </div>
                    <div>
                      <p className="text-[13px] font-medium text-slate-800 dark:text-slate-100">{a.full_name}</p>
                      <p className="text-[11px] text-slate-400 capitalize">{a.role?.replace(/_/g,' ')}</p>
                    </div>
                  </div>
                </td>
                <td className="text-right font-mono tabular-nums text-slate-700">{fmtNum(a.activities)}</td>
                <td className="text-right font-mono tabular-nums text-slate-700">{fmtNum(a.contacts_owned)}</td>
                <td className="text-right font-mono tabular-nums text-slate-700">{fmtNum(a.deals_owned)}</td>
                <td className="text-right">
                  <span className={`badge ${Number(a.deals_won) > 0 ? 'badge-green' : 'badge-grey'}`}>{a.deals_won || 0}</span>
                </td>
                <td className="text-right">
                  {Number(a.tasks_assigned) > 0 ? (
                    <span className="text-[12px] font-semibold text-slate-600">
                      {a.tasks_done}/{a.tasks_assigned}
                      <span className="text-slate-400 font-normal ml-1">
                        ({a.tasks_assigned > 0 ? Math.round((a.tasks_done / a.tasks_assigned) * 100) : 0}%)
                      </span>
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function CrmReports() {
  const overview  = useApi('/api/crm/reports/overview')
  const pipeline  = useApi('/api/crm/reports/pipeline')
  const agents    = useApi('/api/crm/reports/agent-performance?days=30')
  const bySource  = useApi('/api/crm/reports/contacts-by-source')
  const sla       = useApi('/api/crm/reports/requests-sla')
  const trend     = useApi('/api/crm/reports/new-contacts-trend')
  const actTrend  = useApi('/api/crm/reports/activity-trend?days=30')

  const ov = overview.data || {}

  // Pivot activity trend into chart-friendly format
  const actByDay = {}
  ;(actTrend.data || []).forEach(r => {
    if (!actByDay[r.day]) actByDay[r.day] = { day: r.day }
    actByDay[r.day][r.type] = Number(r.count)
  })
  const actChartData = Object.values(actByDay).sort((a, b) => a.day < b.day ? -1 : 1)
  const actTypes = [...new Set((actTrend.data || []).map(r => r.type))]

  const wonDeals  = Number(ov.won_deals || 0)
  const totalDeals = Number(ov.total_deals || 0)
  const convRate  = totalDeals > 0 ? (wonDeals / totalDeals) * 100 : 0

  return (
    <PageShell title="CRM Reports" subtitle="Pipeline health, agent performance, and conversion analytics" error={overview.error}>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Contacts"   value={fmtNum(ov.total_contacts)}  icon="contacts"       accent="navy"   tooltip="Total contacts in the CRM — includes active leads and converted customers" />
        <KpiCard label="Active Leads"     value={fmtNum(ov.total_leads)}     icon="person_search"  accent="amber"  tooltip="Contacts with status 'lead' who have not yet been converted to cardholders" />
        <KpiCard label="Customers"        value={fmtNum(ov.total_customers)} icon="verified_user"  accent="green"  tooltip="Contacts who have been successfully converted to active cardholders" />
        <KpiCard label="Win Rate"         value={pct(convRate)}              icon="emoji_events"   accent={convRate >= 20 ? 'green' : 'accent'} sub={`${wonDeals} of ${totalDeals} deals`} tooltip="Percentage of closed deals that resulted in a card being issued (won)" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <KpiCard label="Activities (30d)" value={fmtNum(ov.activities_30d)}  icon="timeline"       accent="navy"   tooltip="Total calls, emails, meetings and notes logged across all contacts in the last 30 days" />
        <KpiCard label="Open Tasks"       value={fmtNum(ov.open_tasks)}      icon="task_alt"       accent={Number(ov.overdue_tasks) > 0 ? 'accent' : 'navy'} sub={ov.overdue_tasks > 0 ? `${ov.overdue_tasks} overdue` : undefined} tooltip="Tasks assigned across contacts and deals that have not yet been completed" />
        <KpiCard label="Open Requests"    value={fmtNum(ov.open_requests)}   icon="support_agent"  accent="amber"  tooltip="Customer service requests currently open and pending resolution" />
        <KpiCard label="SLA Breached"     value={fmtNum(ov.sla_breached)}    icon="alarm"          accent={Number(ov.sla_breached) > 0 ? 'accent' : 'green'} sub={ov.avg_resolution_hrs ? `Avg ${ov.avg_resolution_hrs}h to resolve` : undefined} tooltip="Requests that exceeded their SLA target time without being resolved" />
      </div>

      {/* Pipeline + Activity trend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
        <PipelineFunnelCard data={pipeline.data || []} />
        <div className="lg:col-span-2">
          <AreaChartCard
            title="New Contacts Trend"
            data={trend.data || []}
            xKey="month"
            areas={[
              { key: 'new_contacts', label: 'New Contacts', color: '#0E2841' },
              { key: 'converted',    label: 'Converted',    color: '#10B981' },
            ]}
            height={260}
          />
        </div>
      </div>

      {/* Activity by type + Source breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        {actTypes.length > 0 ? (
          <BarChartCard
            title="Activity Volume by Type (30 days)"
            data={actChartData}
            xKey="day"
            bars={actTypes.map(t => ({ key: t, label: t, color: ACTIVITY_COLORS[t] || '#94A3B8' }))}
            height={240}
          />
        ) : (
          <div className="card p-6 flex flex-col items-center justify-center text-slate-400 min-h-[240px]">
            <span className="material-symbols-rounded text-[36px] opacity-30 mb-2">timeline</span>
            <p className="text-sm">No activity logged yet</p>
          </div>
        )}
        <ProgressListCard
          title="Contacts by Source"
          data={bySource.data || []}
          nameKey="source"
          valueKey="total"
          maxItems={8}
        />
      </div>

      {/* SLA table */}
      {sla.data?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/50">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Request SLA by Type</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Request Type</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Resolved</th>
                  <th className="text-right">Resolution Rate</th>
                  <th className="text-right">SLA Breached</th>
                  <th className="text-right">Avg Resolution</th>
                </tr>
              </thead>
              <tbody>
                {sla.data.map((r, i) => {
                  const resRate = r.total > 0 ? (r.resolved / r.total) * 100 : 0
                  return (
                    <tr key={i}>
                      <td className="font-medium text-slate-800 dark:text-slate-100">{r.request_type?.replace(/_/g,' ')}</td>
                      <td className="text-right tabular-nums">{fmtNum(r.total)}</td>
                      <td className="text-right tabular-nums">{fmtNum(r.resolved)}</td>
                      <td className="text-right">
                        <span className={`badge ${resRate >= 80 ? 'badge-green' : resRate >= 50 ? 'badge-amber' : 'badge-red'}`}>
                          {resRate.toFixed(0)}%
                        </span>
                      </td>
                      <td className="text-right">
                        <span className={r.sla_breached > 0 ? 'text-red-500 font-semibold' : 'text-slate-400'}>
                          {r.sla_breached || 0}
                        </span>
                      </td>
                      <td className="text-right text-slate-500">{r.avg_resolution_hrs ? `${r.avg_resolution_hrs}h` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Agent performance */}
      <div className="mt-4">
        <AgentTable data={agents.data || []} />
      </div>
    </PageShell>
  )
}
