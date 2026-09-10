import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP } from '../../lib/design'
import { EArea, EBar, EDonut } from '../../components/echarts'

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

const SOURCE_COLORS = [NAVY, BLUE, AMBER, GREEN, PURPLE, RED, '#5B7A94']

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
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const [k, p, s, a, t] = await Promise.all([
        apiFetch<OverviewKPIs>(`/api/crm/reports/overview?from=${dateFrom}&to=${dateTo}`),
        apiFetch<PipelineReport[]>(`/api/crm/reports/pipeline?from=${dateFrom}&to=${dateTo}`),
        apiFetch<SourceReport[]>(`/api/crm/reports/contacts-by-source?from=${dateFrom}&to=${dateTo}`),
        apiFetch<AgentReport[]>(`/api/crm/reports/agent-performance?days=30&from=${dateFrom}&to=${dateTo}`),
        apiFetch<TrendPoint[]>(`/api/crm/reports/new-contacts-trend?from=${dateFrom}&to=${dateTo}`),
      ])
      setKpis(k)
      setPipeline(Array.isArray(p) ? p : [])
      setSources(Array.isArray(s) ? s : [])
      setAgents(Array.isArray(a) ? a : [])
      setTrend(Array.isArray(t) ? t : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['deals','crm'] })

  const agentCols: TableCol<AgentReport>[] = [
    { key: 'full_name',      label: 'Agent',      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.full_name}</span> },
    { key: 'role',           label: 'Role',       render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', textTransform: 'capitalize' }}>{r.role}</span> },
    { key: 'contacts_owned', label: 'Contacts',   align: 'right', render: r => <span style={NUM}>{toN(r.contacts_owned)}</span> },
    { key: 'deals_owned',    label: 'Deals',      align: 'right', render: r => <span style={NUM}>{toN(r.deals_owned)}</span> },
    { key: 'deals_won',      label: 'Won',        align: 'right', render: r => <span style={{ ...NUM, color: toN(r.deals_won) > 0 ? GREEN : 'var(--txt3)', fontWeight: FW.bold }}>{toN(r.deals_won)}</span> },
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
    <Page title="Sales Reports" subtitle="Sales performance analytics"
      loading={loading && !kpis}
      skeletonKpis={6}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard label="Total Contacts" value={fmtNum(toN(kpis?.total_contacts))} loading={loading} />
        <KpiCard label="Leads"          value={fmtNum(toN(kpis?.total_leads))}    loading={loading} />
        <KpiCard label="Customers"      value={fmtNum(toN(kpis?.total_customers))} accent={GREEN} loading={loading} />
        <KpiCard label="Deals"          value={fmtNum(toN(kpis?.total_deals))}    loading={loading} />
        <KpiCard label="Won Deals"      value={fmtNum(toN(kpis?.won_deals))}      accent={GREEN} loading={loading} />
        <KpiCard label="Open Tasks"     value={fmtNum(toN(kpis?.open_tasks))}     accent={toN(kpis?.overdue_tasks) > 0 ? AMBER : NAVY} loading={loading} />
      </div>

      {/* Area + Source Pie */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="New Contacts: 12 Month Trend">
          <EArea
            data={trend.map(t => ({ month: t.month, new_contacts: Number(t.new_contacts), converted: Number(t.converted) }))}
            xKey="month"
            height={210}
            hideYAxis
            valueFmt={fmtNum}
            series={[
              { key: 'new_contacts', name: 'New Contacts', color: NAVY },
              { key: 'converted', name: 'Converted', color: GREEN },
            ]}
          />
        </SectionCard>

        <SectionCard title="Contacts by Source">
          {sources.length > 0 ? (
            <EDonut
              data={sources.map(s => ({ source: String(s.source).replace(/_/g, ' '), total: Number(s.total) }))}
              valueKey="total"
              nameKey="source"
              colorFn={(_, i) => SOURCE_COLORS[i % SOURCE_COLORS.length]}
              size={210}
              inner={52}
              outer={78}
              legend
              valueFmt={fmtNum}
            />
          ) : (
            <div style={{ height: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No source data
            </div>
          )}
        </SectionCard>
      </div>

      {/* Pipeline bar */}
      {pipeline.length > 0 && (
        <SectionCard title="Pipeline by Stage" subtitle="Deal count per stage" style={{ marginBottom: 14 }}>
          <EBar
            data={pipeline.map(p => ({ ...p, deal_count: Number(p.deal_count) }))}
            xKey="name"
            height={180}
            legend={false}
            valueFmt={fmtNum}
            axisFmt={fmtNum}
            series={[{ key: 'deal_count', name: 'Deals', colorFn: (row, i) => row.color || SOURCE_COLORS[i % SOURCE_COLORS.length] }]}
          />
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
