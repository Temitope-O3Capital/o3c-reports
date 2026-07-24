import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, RED, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PipelineStage { stage: string; count: number; value_kobo: number }

interface BDLead {
  id: number; company_name: string; contact_name: string
  stage: string; potential_value_kobo: number
  lead_score: number; updated_at: string
}

interface BDEmployer {
  id: number; name: string; sector: string
  staff_count: number; mou_status: string; lead_count: number
}

interface BDAgentDash {
  my_leads: number; won_mtd: number; pipeline_value_kobo: number
  employers_managed: number; calls_made_mtd: number; meetings_mtd: number
  my_pipeline: PipelineStage[]
  my_leads_list: BDLead[]
  my_employers: BDEmployer[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

const STAGE_COLORS: Record<string, string> = {
  Prospect: BLUE, Qualified: AMBER, Proposal: NAVY, Negotiation: '#7C3AED', Won: GREEN,
}
function stageColor(s: string) { return STAGE_COLORS[s] ?? NAVY }

const MOU_COLORS: Record<string, string> = {
  signed: GREEN, pending: AMBER, expired: RED, draft: BLUE,
}
function mouColor(s: string) { return MOU_COLORS[s?.toLowerCase()] ?? NAVY }

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, marginBottom: 2 }}>{p.name}: {p.value}</p>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BDMyDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<BDAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: BDAgentDash }>('/api/bd/my-dashboard')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <Page title="My BD Dashboard" back={{ label: 'Business Dev', to: '/bd' }}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title="My BD Dashboard" back={{ label: 'Business Dev', to: '/bd' }}>
      <ErrBanner error={error} onRetry={load} />
    </Page>
  )
  if (!data) return null

  const leadCols: TableCol<BDLead>[] = [
    { key: 'company_name', label: 'Company', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.company_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{r.contact_name}</div>
      </div>
    )},
    { key: 'stage', label: 'Stage', render: r => <StatusPill label={r.stage} color={stageColor(r.stage)} /> },
    { key: 'lead_score', label: 'Score', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{r.lead_score}</span> },
    { key: 'potential_value_kobo', label: 'Est. Value', render: r => <span style={NUM}>{fmtKobo(r.potential_value_kobo)}</span> },
    { key: 'updated_at', label: 'Updated', render: r => fmtDate(r.updated_at) },
  ]

  const employerCols: TableCol<BDEmployer>[] = [
    { key: 'name', label: 'Employer', render: r => <span style={{ fontWeight: FW.semibold }}>{r.name}</span> },
    { key: 'sector', label: 'Sector' },
    { key: 'staff_count', label: 'Staff', render: r => <span style={NUM}>{fmtNum(r.staff_count)}</span> },
    { key: 'lead_count', label: 'Leads', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{r.lead_count}</span> },
    { key: 'mou_status', label: 'MOU', render: r => <StatusPill label={r.mou_status} color={mouColor(r.mou_status)} /> },
  ]

  return (
    <Page title="My BD Dashboard" subtitle="Your pipeline, leads and employer accounts" back={{ label: 'Business Dev', to: '/bd' }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="My Leads" value={fmtNum(data.my_leads)} icon="contacts" />
        <KpiCard label="Won MTD" value={fmtNum(data.won_mtd)} icon="emoji_events" accent={GREEN} />
        <KpiCard label="Pipeline Value" value={fmtKobo(data.pipeline_value_kobo)} icon="trending_up" accent={NAVY} />
        <KpiCard label="Employers Managed" value={fmtNum(data.employers_managed)} icon="business" accent={BLUE} />
      </div>

      {/* Pipeline funnel */}
      <SectionCard title="My Pipeline by Stage" style={{ marginBottom: 14 }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.my_pipeline} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="stage" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="count" name="Leads" fill={NAVY} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        {/* Stage value summary */}
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap', marginTop: SP[2], paddingTop: SP[2], borderTop: '1px solid var(--bdr)' }}>
          {data.my_pipeline.map(s => (
            <div key={s.stage} style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
              <span style={{ color: stageColor(s.stage), fontWeight: FW.semibold }}>{s.stage}</span>
              {': '}
              <span style={NUM}>{fmtKobo(s.value_kobo)}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Leads + Employers tables */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <SectionCard title="My Leads" badge={data.my_leads_list.length}>
          <DataTable
            cols={leadCols}
            rows={data.my_leads_list}
            keyFn={r => r.id}
            onRowClick={r => navigate(`/bd/leads/${r.id}`)}
            searchKeys={['company_name', 'contact_name', 'stage']}
            searchPlaceholder="Search leads…"
            pageSize={8}
            emptyText="No leads"
          />
        </SectionCard>

        <SectionCard title="My Employers" badge={data.my_employers.length}>
          <DataTable
            cols={employerCols}
            rows={data.my_employers}
            keyFn={r => r.id}
            onRowClick={r => navigate(`/bd/employers/${r.id}`)}
            searchKeys={['name', 'sector', 'mou_status']}
            searchPlaceholder="Search employers…"
            pageSize={8}
            emptyText="No employers"
          />
        </SectionCard>
      </div>
    </Page>
  )
}
