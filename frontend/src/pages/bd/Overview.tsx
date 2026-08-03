import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NAVY, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PipelineStage { stage: string; count: number; total_value_kobo: number }
interface EmployerStats { active: number; mou_signed: number; mou_expiring: number }
interface BDStats { pipeline: PipelineStage[]; employers: EmployerStats }

interface Lead {
  id: number; title: string; company_name: string; stage: string
  potential_value_kobo: number; contact_name: string; assigned_name: string
  updated_at: string; lead_score?: number | null; lead_type?: string; created_at: string
}

interface Employer {
  id: number; name: string; sector?: string; staff_count?: number
  monthly_payroll_kobo?: number; mou_status?: string; lead_count?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, string> = {
  prospect: '#6B7280', qualified: BLUE, proposal: AMBER,
  negotiation: '#7C3AED', won: GREEN, lost: RED,
}
const SOURCE_COLORS = [NAVY, BLUE, AMBER, GREEN, PURPLE, RED, '#6B7280']

function StagePill({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? '#6B7280'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
      background: `${c}18`, color: c, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{stage}</span>
  )
}

function MouPill({ status }: { status?: string }) {
  const s = status?.toLowerCase()
  const color = s === 'signed' ? GREEN : s === 'pending' ? AMBER : s === 'expired' ? RED : '#6B7280'
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${color}18`, color }}>
      {status ?? '—'}
    </span>
  )
}

function getMonthlyTrend(leads: Lead[]) {
  const slots: { month: string; leads: number; key: string }[] = []
  const now = new Date()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    slots.push({ month: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), leads: 0, key })
  }
  for (const l of leads) {
    const slot = slots.find(s => s.key === (l.created_at?.slice(0, 7) ?? ''))
    if (slot) slot.leads++
  }
  return slots.map(({ month, leads }) => ({ month, leads }))
}

function getSourceBreakdown(leads: Lead[]) {
  const counts: Record<string, number> = {}
  for (const l of leads) { const src = l.lead_type ?? 'Other'; counts[src] = (counts[src] ?? 0) + 1 }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
}

function getOfficerPerf(leads: Lead[]) {
  const map: Record<string, { name: string; total: number; won: number }> = {}
  for (const l of leads) {
    const name = l.assigned_name ?? 'Unassigned'
    if (!map[name]) map[name] = { name, total: 0, won: 0 }
    map[name].total++
    if (l.stage === 'won') map[name].won++
  }
  return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BDOverview() {
  const navigate = useNavigate()
  const [stats,     setStats]     = useState<BDStats | null>(null)
  const [leads,     setLeads]     = useState<Lead[]>([])
  const [employers, setEmployers] = useState<Employer[]>([])
  const [loading,   setLoading]   = useState(true)
  const [err,       setErr]       = useState<string | null>(null)
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [s, l, e] = await Promise.all([
        apiFetch<{ data: BDStats }>(`/api/bd/stats?from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: Lead[] }>(`/api/bd/leads?limit=500&from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: Employer[] }>(`/api/bd/employers?limit=100`),
      ])
      setStats((s?.data ?? s) ?? null)
      setLeads(Array.isArray(l) ? l : (l?.data ?? []))
      setEmployers(Array.isArray(e) ? e : (e?.data ?? []))
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['deals','crm'] })

  const pipeline      = stats?.pipeline ?? []
  const totalLeads    = leads.length
  const wonCount      = leads.filter(l => l.stage === 'won').length
  const lostCount     = leads.filter(l => l.stage === 'lost').length
  const hotLeads      = pipeline.find(r => r.stage === 'negotiation')?.count ?? 0
  const conversionRate = (wonCount + lostCount) > 0 ? wonCount / (wonCount + lostCount) * 100 : 0
  const pipelineValue = pipeline.reduce((s, p) => s + Number(p.total_value_kobo || 0), 0)

  const monthlyTrend = getMonthlyTrend(leads)
  const sourceBreak  = getSourceBreakdown(leads)
  const officerPerf  = getOfficerPerf(leads)
  const topEmpl      = [...employers].sort((a, b) => Number(b.lead_count ?? 0) - Number(a.lead_count ?? 0))
  const recentLeads  = [...leads].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 15)

  const leadCols: TableCol<Lead>[] = [
    {
      key: 'company_name', label: 'Company', sortable: true,
      render: row => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{row.company_name ?? row.title}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{row.contact_name ?? '—'}</div>
        </div>
      ),
    },
    { key: 'stage', label: 'Stage', sortable: true, render: row => <StagePill stage={row.stage} /> },
    {
      key: 'lead_score', label: 'Score', sortable: true, align: 'right',
      render: row => row.lead_score != null
        ? <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: row.lead_score >= 70 ? GREEN : row.lead_score >= 40 ? AMBER : RED }}>{row.lead_score}</span>
        : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'potential_value_kobo', label: 'Est. Value', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtKobo(row.potential_value_kobo)}</span>,
    },
    {
      key: 'assigned_name', label: 'Officer', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)' }}>{row.assigned_name ?? '—'}</span>,
    },
    {
      key: 'updated_at', label: 'Last Updated', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>{fmtDate(row.updated_at)}</span>,
    },
  ]

  const empCols: TableCol<Employer>[] = [
    { key: 'name',   label: 'Employer', render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</span> },
    { key: 'sector', label: 'Sector',   render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.sector ?? '—'}</span> },
    { key: 'staff_count',          label: 'Staff',   align: 'right', render: r => <span style={NUM}>{fmtNum(r.staff_count ?? 0)}</span> },
    { key: 'lead_count',           label: 'Leads',   align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{Number(r.lead_count ?? 0)}</span> },
    { key: 'monthly_payroll_kobo', label: 'Payroll', align: 'right', render: r => <span style={NUM}>{r.monthly_payroll_kobo ? fmtKobo(r.monthly_payroll_kobo) : '—'}</span> },
    { key: 'mou_status',           label: 'MOU',     render: r => <MouPill status={r.mou_status} /> },
  ]

  return (
    <Page
      title="Business Development"
      subtitle="Pipeline, performance and employer overview"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => navigate('/bd/employers')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.medium,
              border: '1px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>corporate_fare</span>
            Employers
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Total Leads"     value={fmtNum(totalLeads)}     icon="contacts"              accent={NAVY}  loading={loading} />
        <KpiCard label="Hot Leads"       value={fmtNum(hotLeads)}       icon="local_fire_department" accent={RED}   loading={loading} />
        <KpiCard label="Won Deals"       value={fmtNum(wonCount)}       icon="handshake"             accent={GREEN} loading={loading} />
        <KpiCard label="Pipeline Value"  value={fmtKobo(pipelineValue)} icon="attach_money"          accent={AMBER} loading={loading} />
      </div>

      {/* ── Current pipeline state ─────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Pipeline by Stage" subtitle="Lead count per stage">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={pipeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="stage" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as PipelineStage
                  return (
                    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'capitalize', marginBottom: 4 }}>{label}</p>
                      <p style={{ color: 'var(--txt2)', marginBottom: 2 }}>Leads: {d.count}</p>
                      <p style={{ color: 'var(--txt2)' }}>Value: {fmtKobo(d.total_value_kobo)}</p>
                    </div>
                  )
                }}
              />
              <Bar dataKey="count" name="Leads" fill={AMBER} radius={[4, 4, 0, 0]}
                label={({ x, y, width, value }) => (
                  <text x={Number(x) + Number(width) / 2} y={Number(y) - 4} textAnchor="middle"
                    style={{ fontSize: TEXT.xs, fill: '#6B7280' }}>{value > 0 ? value : ''}</text>
                )}
              />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Employer Partners" subtitle="MOU status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
            {[
              { label: 'Active Employers', value: stats?.employers?.active     ?? 0, icon: 'corporate_fare', color: NAVY  },
              { label: 'MOU Signed',       value: stats?.employers?.mou_signed ?? 0, icon: 'handshake',      color: GREEN },
              { label: 'MOU Expiring',     value: stats?.employers?.mou_expiring ?? 0, icon: 'warning',      color: AMBER },
            ].map(item => (
              <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: `${SP[3]} 14px`, borderRadius: RADIUS.lg, background: `${item.color}08`, border: `1px solid ${item.color}18` }}>
                <div style={{ width: 36, height: 36, borderRadius: RADIUS.md, background: `${item.color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: item.color }}>{item.icon}</span>
                </div>
                <div>
                  <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1 }}>{item.value}</div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{item.label}</div>
                </div>
              </div>
            ))}
            <div style={{ marginTop: 4, display: 'flex', justifyContent: 'flex-end' }}>
              <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: BLUE }}>
                {fmtPct(conversionRate)} conversion rate
              </span>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ── Trends ────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Lead Volume — Last 12 Months">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={monthlyTrend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="bdAreaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Area type="monotone" dataKey="leads" stroke={NAVY} strokeWidth={2} fill="url(#bdAreaGrad)" name="Leads" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Lead Source">
          {sourceBreak.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={sourceBreak} cx="50%" cy="44%" innerRadius={46} outerRadius={72} dataKey="value" nameKey="name">
                  {sourceBreak.map((_, i) => <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                <Legend iconSize={9} wrapperStyle={{ fontSize: TEXT.xs }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No lead source data</div>
          )}
        </SectionCard>
      </div>

      {/* ── Officer performance ───────────────────────────────────────────────── */}
      {officerPerf.length > 0 && (
        <SectionCard title="Conversion by Officer" subtitle="Total leads vs won" style={{ marginBottom: 14 }}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={officerPerf} margin={{ top: 4, right: 8, bottom: 20, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} interval={0} textAnchor="middle" />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: TEXT.xs }} />
              <Bar dataKey="total" fill={NAVY}  radius={[4, 4, 0, 0]} name="Total Leads" />
              <Bar dataKey="won"   fill={GREEN} radius={[4, 4, 0, 0]} name="Won" />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      {/* ── Tables ────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <SectionCard
          title="Recent Leads"
          subtitle="Latest pipeline activity"
          padding={false}
          actions={
            <button onClick={() => navigate('/bd/pipeline')} style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
              View all <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>arrow_forward</span>
            </button>
          }
        >
          <DataTable<Lead>
            cols={leadCols}
            rows={recentLeads}
            loading={loading}
            skeletonRows={5}
            emptyText="No leads yet"
            keyFn={r => r.id}
            onRowClick={() => navigate('/bd/pipeline')}
            searchKeys={['company_name', 'contact_name', 'stage']}
            searchPlaceholder="Search leads…"
          />
        </SectionCard>

        <SectionCard title="Employer Ranking" badge={topEmpl.length} subtitle="By lead count" padding={false}>
          <DataTable<Employer>
            cols={empCols}
            rows={topEmpl}
            keyFn={r => r.id}
            emptyText="No employer data"
            skeletonRows={loading ? 5 : 0}
          />
        </SectionCard>
      </div>
    </Page>
  )
}
