import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, StatusPill, HeroButton } from '../../components/MyWorkspace'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PipelineStage { stage: string; count: number; value_kobo: number }

interface Lead {
  id: number; company_name: string; contact_name: string
  stage: string; potential_value_kobo: number; updated_at: string; lead_score: number
}

interface SalesAgentDash {
  my_leads: number; won_mtd: number; conversion_rate_pct: number
  target_kobo: number; achieved_kobo: number; target_pct: number
  pipeline: PipelineStage[]
  recent_leads: Lead[]
  monthly_trend: { month: string; leads: number; won: number }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  Prospect: BLUE, Qualified: AMBER, Proposal: NAVY, Negotiation: PURPLE, Won: GREEN,
}
function stageColor(s: string) { return STAGE_COLORS[s] ?? NAVY }
function targetColor(pct: number) { return pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED }

// Charts sit on white cards, so keep the light tooltip variant here.
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

export default function SalesMyDashboard() {
  const navigate = useNavigate()
  const [data, setData] = useState<SalesAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<{ data: SalesAgentDash }>('/api/sales/my-dashboard')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals', 'crm'] })
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id) }, [load])

  if (loading && !data) return (
    <Page title="My Workspace"><div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div></Page>
  )
  if (error && !data) return <Page title="My Workspace"><ErrBanner error={error} onRetry={load} /></Page>
  if (!data) return null

  const tColor = targetColor(data.target_pct)
  const achievedPct = Math.min(100, data.target_pct)
  const remaining = Math.max(0, data.target_kobo - data.achieved_kobo)
  const stageCount = (name: string) => data.pipeline.find(p => p.stage.toLowerCase() === name)?.count ?? 0
  const openPipelineValue = data.pipeline.filter(p => p.stage.toLowerCase() !== 'won').reduce((s, p) => s + Number(p.value_kobo), 0)
  const toProgress = stageCount('prospect') + stageCount('qualified')

  const leadCols: TableCol<Lead>[] = [
    { key: 'company_name', label: 'Company', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.company_name}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{r.contact_name}</div>
      </div>
    )},
    { key: 'stage', label: 'Stage', render: r => <StatusPill label={r.stage} color={stageColor(r.stage)} /> },
    { key: 'lead_score', label: 'Score', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{r.lead_score}</span> },
    { key: 'potential_value_kobo', label: 'Est. Value', render: r => <span style={NUM}>{fmtKobo(r.potential_value_kobo)}</span> },
    { key: 'updated_at', label: 'Last Updated', render: r => fmtDate(r.updated_at) },
  ]

  return (
    <Page title="My Workspace" subtitle="Your sales station — pipeline, targets and leads">
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={data.target_pct >= 100
          ? <>Target smashed — <strong style={{ color: '#fff' }}>{fmtPct(data.target_pct)}</strong> of your monthly goal 🎉</>
          : <>You're at <strong style={{ color: '#fff' }}>{fmtPct(data.target_pct)}</strong> of your monthly target · {fmtKobo(remaining)} to go</>}
        ring={{ value: Math.round(data.target_pct), max: 100, unit: '% target' }}
        stats={[
          { label: 'Won MTD', value: fmtNum(data.won_mtd), color: '#4ADE80' },
          { label: 'My Leads', value: fmtNum(data.my_leads) },
          { label: 'Conversion', value: fmtPct(data.conversion_rate_pct) },
          { label: 'Achieved', value: fmtKobo(data.achieved_kobo), color: '#4ADE80' },
          { label: 'Target', value: fmtKobo(data.target_kobo) },
          { label: 'Open Pipeline', value: fmtKobo(openPipelineValue) },
        ]}
        actions={<>
          <HeroButton icon="view_kanban" label="Pipeline" primary onClick={() => navigate('/sales/crm')} />
          <HeroButton icon="contacts" label="My Leads" onClick={() => navigate('/sales/leads')} />
          <HeroButton icon="account_balance_wallet" label="My Book" onClick={() => navigate('/sales/book')} />
          <HeroButton icon="note_add" label="New Application" onClick={() => navigate('/sales/applications')} />
          <HeroButton icon="checklist" label="Tasks" onClick={() => navigate('/sales/tasks')} />
          <HeroButton icon="flag" label="Targets" onClick={() => navigate('/sales/targets')} />
        </>}
      />

      {/* ── My Day ─────────────────────────────────────────────────────────── */}
      <MyDaySection hint="deals to move today">
        <MyDayTile icon="handshake" count={fmtNum(stageCount('negotiation'))} label="In negotiation"
          sub={stageCount('negotiation') > 0 ? 'close these to win' : 'nothing in negotiation'}
          color={PURPLE} urgent={stageCount('negotiation') > 0} onClick={() => navigate('/sales/crm')} />
        <MyDayTile icon="description" count={fmtNum(stageCount('proposal'))} label="Proposals out"
          sub="awaiting a decision" color={BLUE} onClick={() => navigate('/sales/crm')} />
        <MyDayTile icon="person_search" count={fmtNum(toProgress)} label="To progress"
          sub="qualify & advance" color={AMBER} onClick={() => navigate('/sales/leads')} />
        <MyDayTile icon="flag" count={data.target_pct >= 100 ? 'Met' : fmtKobo(remaining)} label="Gap to target"
          sub={data.target_pct >= 100 ? 'target achieved' : 'still to book this month'}
          color={tColor} urgent={data.target_pct < 70} onClick={() => navigate('/sales/targets')} />
      </MyDaySection>

      {/* Target progress bar */}
      <SectionCard title="Target Progress" style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[2] }}>
          <span>Achieved: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.achieved_kobo)}</strong></span>
          <span>Target: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.target_kobo)}</strong></span>
        </div>
        <div style={{ height: 12, background: 'var(--th-bg)', borderRadius: RADIUS.full, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${achievedPct}%`, background: tColor, borderRadius: RADIUS.full, transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: TEXT.xs, color: tColor, fontWeight: FW.semibold, marginTop: SP[1] }}>
          {fmtPct(data.target_pct)} of target
        </div>
      </SectionCard>

      {/* Pipeline + Trend charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
        <SectionCard title="Pipeline by Stage">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.pipeline} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="stage" tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="count" name="Leads" fill={NAVY} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Monthly Trend">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sLeads" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sWon" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="leads" name="Leads" stroke={NAVY} fill="url(#sLeads)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="won" name="Won" stroke={GREEN} fill="url(#sWon)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>

      {/* Recent leads */}
      <SectionCard title="My Recent Leads" badge={data.recent_leads.length}>
        <DataTable
          cols={leadCols}
          rows={data.recent_leads}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/sales/customers/${r.id}`)}
          searchKeys={['company_name', 'contact_name', 'stage']}
          searchPlaceholder="Search leads…"
          pageSize={10}
          emptyText="No leads found"
        />
      </SectionCard>
    </Page>
  )
}
