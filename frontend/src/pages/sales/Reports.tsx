import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM } from '../../lib/design'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface OverviewKPIs {
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
}

interface PipelineReport {
  name: string
  color?: string
  deal_count: number
  pipeline_value: number
  avg_probability: number
}

interface SourceReport {
  source: string
  total: number
  converted: number
}

interface AgentReport {
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

interface TrendPoint {
  month: string
  new_contacts: number
  converted: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SOURCE_COLORS = [NAVY, BLUE, AMBER, GREEN, PURPLE, RED, '#6B7280']

function toN(v: any): number { return Number(v) || 0 }

// ── Main component ─────────────────────────────────────────────────────────────

export default function SalesReports() {
  const [kpis,     setKpis]     = useState<OverviewKPIs | null>(null)
  const [pipeline, setPipeline] = useState<PipelineReport[]>([])
  const [sources,  setSources]  = useState<SourceReport[]>([])
  const [agents,   setAgents]   = useState<AgentReport[]>([])
  const [trend,    setTrend]    = useState<TrendPoint[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [k, p, s, a, t] = await Promise.all([
        apiFetch<OverviewKPIs>('/api/crm/reports/overview'),
        apiFetch<PipelineReport[]>('/api/crm/reports/pipeline'),
        apiFetch<SourceReport[]>('/api/crm/reports/contacts-by-source'),
        apiFetch<AgentReport[]>('/api/crm/reports/agent-performance?days=30'),
        apiFetch<TrendPoint[]>('/api/crm/reports/new-contacts-trend'),
      ])
      setKpis(k)
      setPipeline(Array.isArray(p) ? p : [])
      setSources(Array.isArray(s) ? s : [])
      setAgents(Array.isArray(a) ? a : [])
      setTrend(Array.isArray(t) ? t : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const agentCols: TableCol<AgentReport>[] = [
    { key: 'full_name',      label: 'Agent',      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.full_name}</span> },
    { key: 'role',           label: 'Role',       render: r => <span style={{ fontSize: 12, color: 'var(--txt2)', textTransform: 'capitalize' }}>{r.role}</span> },
    { key: 'contacts_owned', label: 'Contacts',   align: 'right', render: r => <span style={NUM}>{toN(r.contacts_owned)}</span> },
    { key: 'deals_owned',    label: 'Deals',      align: 'right', render: r => <span style={NUM}>{toN(r.deals_owned)}</span> },
    { key: 'deals_won',      label: 'Won',        align: 'right', render: r => <span style={{ ...NUM, color: toN(r.deals_won) > 0 ? GREEN : 'var(--txt3)', fontWeight: 700 }}>{toN(r.deals_won)}</span> },
    { key: 'activities',     label: 'Activities (30d)', align: 'right', render: r => <span style={NUM}>{toN(r.activities)}</span> },
    {
      key: 'tasks_done', label: 'Tasks Done', align: 'right',
      render: r => {
        const total = toN(r.tasks_assigned)
        const done  = toN(r.tasks_done)
        return total > 0
          ? <span style={NUM}>{done}/{total}</span>
          : <span style={{ color: 'var(--txt3)' }}>—</span>
      },
    },
  ]

  return (
    <Page title="CRM Reports" subtitle="Sales and CRM performance analytics">
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Total Contacts" value={fmtNum(toN(kpis?.total_contacts))} loading={loading} />
        <KpiCard label="Leads"          value={fmtNum(toN(kpis?.total_leads))}    loading={loading} />
        <KpiCard label="Customers"      value={fmtNum(toN(kpis?.total_customers))} accent={GREEN} loading={loading} />
        <KpiCard label="Deals"          value={fmtNum(toN(kpis?.total_deals))}    loading={loading} />
        <KpiCard label="Won Deals"      value={fmtNum(toN(kpis?.won_deals))}      accent={GREEN} loading={loading} />
        <KpiCard label="Open Tasks"     value={fmtNum(toN(kpis?.open_tasks))}     accent={toN(kpis?.overdue_tasks) > 0 ? AMBER : NAVY} loading={loading} />
      </div>

      {/* Area + Source Pie */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="New Contacts — 12 Month Trend">
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="repContactGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={NAVY}  stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY}  stopOpacity={0} />
                </linearGradient>
                <linearGradient id="repConvGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="new_contacts" stroke={NAVY}  strokeWidth={2} fill="url(#repContactGrad)" name="New Contacts" />
              <Area type="monotone" dataKey="converted"    stroke={GREEN} strokeWidth={2} fill="url(#repConvGrad)"    name="Converted" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Contacts by Source">
          {sources.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie data={sources} cx="50%" cy="44%" innerRadius={48} outerRadius={75} dataKey="total" nameKey="source">
                  {sources.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={9} wrapperStyle={{ fontSize: 11 }} formatter={(v) => String(v).replace(/_/g, ' ')} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>
              No source data
            </div>
          )}
        </SectionCard>
      </div>

      {/* Pipeline bar */}
      {pipeline.length > 0 && (
        <SectionCard title="Pipeline by Stage" subtitle="Deal count per stage" style={{ marginBottom: 14 }}>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={pipeline} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: 10.5, fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Bar dataKey="deal_count" fill={NAVY} radius={[4, 4, 0, 0]} name="Deals">
                {pipeline.map((entry, i) => (
                  <Cell key={i} fill={entry.color || SOURCE_COLORS[i % SOURCE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* Agent table */}
      <SectionCard title="Agent Performance" subtitle="Last 30 days" badge={agents.length} padding={false}>
        <DataTable<AgentReport>
          cols={agentCols}
          rows={agents}
          keyFn={r => r.id}
          emptyText="No agent data available."
          skeletonRows={loading ? 5 : 0}
        />
      </SectionCard>
    </Page>
  )
}
