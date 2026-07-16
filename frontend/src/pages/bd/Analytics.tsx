import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BDStats {
  pipeline: { stage: string; count: number; total_value_kobo: number }[]
  employers: { active: number; mou_signed: number; mou_expiring: number }
}

interface BDLead {
  id: number
  stage: string
  lead_type?: string
  potential_value_kobo?: number
  assigned_name?: string
  created_at: string
}

interface Employer {
  id: number
  name: string
  sector?: string
  staff_count?: number
  monthly_payroll_kobo?: number
  mou_status?: string
  lead_count?: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SOURCE_COLORS = [NAVY, BLUE, AMBER, GREEN, PURPLE, RED, '#6B7280']

function getMonthlyTrend(leads: BDLead[]): { month: string; leads: number }[] {
  const slots: { month: string; leads: number; key: string }[] = []
  const now = new Date()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const month = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    slots.push({ month, leads: 0, key })
  }
  for (const l of leads) {
    const key = l.created_at?.slice(0, 7) ?? ''
    const slot = slots.find(s => s.key === key)
    if (slot) slot.leads++
  }
  return slots.map(({ month, leads }) => ({ month, leads }))
}

function getSourceBreakdown(leads: BDLead[]) {
  const counts: Record<string, number> = {}
  for (const l of leads) {
    const src = l.lead_type ?? 'Other'
    counts[src] = (counts[src] ?? 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
}

function getOfficerPerf(leads: BDLead[]) {
  const map: Record<string, { name: string; total: number; won: number }> = {}
  for (const l of leads) {
    const name = l.assigned_name ?? 'Unassigned'
    if (!map[name]) map[name] = { name, total: 0, won: 0 }
    map[name].total++
    if (l.stage === 'won') map[name].won++
  }
  return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10)
}

function MouPill({ status }: { status?: string }) {
  const s = status?.toLowerCase()
  const color = s === 'signed' ? GREEN : s === 'pending' ? AMBER : s === 'expired' ? RED : '#6B7280'
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: `2px ${SP[2]}`, borderRadius: RADIUS['2xl'], background: `${color}18`, color }}>
      {status ?? '—'}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function BDAnalytics() {
  const [stats, setStats]         = useState<BDStats | null>(null)
  const [leads, setLeads]         = useState<BDLead[]>([])
  const [employers, setEmployers] = useState<Employer[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [s, l, e] = await Promise.all([
        apiFetch<BDStats>('/api/bd/stats'),
        apiFetch<BDLead[]>('/api/bd/leads?limit=500'),
        apiFetch<Employer[]>('/api/bd/employers?limit=100'),
      ])
      setStats(s)
      setLeads(Array.isArray(l) ? l : [])
      setEmployers(Array.isArray(e) ? e : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const totalLeads    = leads.length
  const wonLeads      = leads.filter(l => l.stage === 'won').length
  const activeEmpl    = Number(stats?.employers?.active ?? 0)
  const pipelineValue = (stats?.pipeline ?? []).reduce((s, p) => s + Number(p.total_value_kobo || 0), 0)

  const monthlyTrend = getMonthlyTrend(leads)
  const sourceBreak  = getSourceBreakdown(leads)
  const officerPerf  = getOfficerPerf(leads)
  const topEmpl      = [...employers].sort((a, b) => Number(b.lead_count ?? 0) - Number(a.lead_count ?? 0))

  const empCols: TableCol<Employer>[] = [
    { key: 'name',   label: 'Employer', render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name}</span> },
    { key: 'sector', label: 'Sector',   render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.sector ?? '—'}</span> },
    { key: 'staff_count',         label: 'Staff',   align: 'right', render: r => <span style={NUM}>{fmtNum(r.staff_count ?? 0)}</span> },
    { key: 'lead_count',          label: 'Leads',   align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{Number(r.lead_count ?? 0)}</span> },
    { key: 'monthly_payroll_kobo',label: 'Payroll', align: 'right', render: r => <span style={NUM}>{r.monthly_payroll_kobo ? fmtKobo(r.monthly_payroll_kobo) : '—'}</span> },
    { key: 'mou_status',          label: 'MOU',     render: r => <MouPill status={r.mou_status} /> },
  ]

  return (
    <Page title="BD Analytics" subtitle="Business development performance and pipeline overview">
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Total Leads"      value={fmtNum(totalLeads)}     />
        <KpiCard label="Won"              value={fmtNum(wonLeads)}       accent={GREEN} />
        <KpiCard label="Active Employers" value={fmtNum(activeEmpl)}     />
        <KpiCard label="Pipeline Value"   value={fmtKobo(pipelineValue)} />
      </div>

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
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No lead source data
            </div>
          )}
        </SectionCard>
      </div>

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

      <SectionCard title="Employer Ranking" badge={topEmpl.length} subtitle="By lead count" padding={false}>
        <DataTable<Employer>
          cols={empCols}
          rows={topEmpl}
          keyFn={r => r.id}
          emptyText="No employer data."
          skeletonRows={loading ? 5 : 0}
        />
      </SectionCard>
    </Page>
  )
}
