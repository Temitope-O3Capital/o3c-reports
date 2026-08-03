import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

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

function targetColor(pct: number) { return pct >= 100 ? GREEN : pct >= 70 ? AMBER : RED }

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
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: SalesAgentDash }>('/api/sales/my-dashboard')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals','crm'] })

  if (loading) return (
    <Page title="My Sales Dashboard" back={{ label: 'Sales', to: '/sales/overview' }}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title="My Sales Dashboard" back={{ label: 'Sales', to: '/sales/overview' }}>
      <ErrBanner error={error} onRetry={load} />
    </Page>
  )
  if (!data) return null

  const tColor = targetColor(data.target_pct)
  const achievedPct = Math.min(100, data.target_pct)

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
    <Page title="My Sales Dashboard" subtitle="Your pipeline, leads and monthly performance" back={{ label: 'Sales', to: '/sales/overview' }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="My Leads" value={fmtNum(data.my_leads)} icon="contacts" />
        <KpiCard label="Won MTD" value={fmtNum(data.won_mtd)} icon="emoji_events" accent={GREEN} />
        <KpiCard label="Conversion Rate" value={fmtPct(data.conversion_rate_pct)} icon="trending_up" accent={BLUE} />
        <KpiCard
          label="Target Achievement"
          value={fmtPct(data.target_pct)}
          icon="flag"
          accent={tColor}
        />
      </div>

      {/* Target progress bar */}
      <SectionCard title="Target Progress" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: SP[2] }}>
          <span>Achieved: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.achieved_kobo)}</strong></span>
          <span>Target: <strong style={{ color: 'var(--txt)' }}>{fmtKobo(data.target_kobo)}</strong></span>
        </div>
        <div style={{ height: 12, background: 'var(--th-bg)', borderRadius: RADIUS.full, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${achievedPct}%`,
            background: tColor, borderRadius: RADIUS.full,
            transition: 'width 0.4s ease',
          }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: TEXT.xs, color: tColor, fontWeight: FW.semibold, marginTop: SP[1] }}>
          {fmtPct(data.target_pct)} of target
        </div>
      </SectionCard>

      {/* Pipeline + Trend charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
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
      <SectionCard title="Recent Leads" badge={data.recent_leads.length}>
        <DataTable
          cols={leadCols}
          rows={data.recent_leads}
          keyFn={r => r.id}
          onRowClick={r => navigate("/sales/crm")}
          searchKeys={['company_name', 'contact_name', 'stage']}
          searchPlaceholder="Search leads…"
          pageSize={10}
          emptyText="No leads found"
        />
      </SectionCard>
    </Page>
  )
}
