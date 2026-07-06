import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum, fmtDatetime } from '../../lib/fmt'
import { RED, GREEN, BLUE, AMBER, NAVY, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LoanKPIs {
  submitted_mtd: number
  disbursed_mtd_kobo: number
  pipeline_kobo: number
  win_rate_pct: number
}

interface MonthlyPoint { month: string; disbursements_kobo: number; count: number }
interface TopPerformer  { name: string; role: string; amount_kobo: number; count: number }
interface LeadSourceItem { lead_source: string; total_applications: number; approved: number; disbursement_kobo: number }

interface RecentApp {
  id: number
  stage: string
  status: string
  amount_requested_kobo: number
  amount_approved_kobo: number
  created_at: string
  updated_at: string
  officer_name: string
  applicant_name?: string | null
  product_type?: string | null
}

// ── Stage pill ────────────────────────────────────────────────────────────────

const STAGE_COLORS: Record<string, { bg: string; txt: string }> = {
  draft:               { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  submitted:           { bg: 'rgba(37,99,235,.1)',   txt: '#2563EB' },
  document_collection: { bg: 'rgba(217,119,6,.1)',   txt: '#D97706' },
  risk_review:         { bg: 'rgba(124,58,237,.1)',  txt: '#7C3AED' },
  risk_head_review:    { bg: 'rgba(124,58,237,.1)',  txt: '#7C3AED' },
  pending_conditions:  { bg: 'rgba(217,119,6,.1)',   txt: '#D97706' },
  finance_approval:    { bg: 'rgba(37,99,235,.1)',   txt: '#2563EB' },
  booking:             { bg: 'rgba(14,40,65,.1)',    txt: '#0E2841' },
  active:              { bg: 'rgba(22,163,74,.1)',   txt: '#16A34A' },
  declined:            { bg: 'rgba(192,0,0,.1)',     txt: '#C00000' },
}

function StagePill({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>
      {stage.replace(/_/g, ' ')}
    </span>
  )
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, kobo }: {
  active?: boolean; payload?: any[]; label?: string; kobo?: boolean
}) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: 8, padding: '8px 12px', fontSize: 12,
      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    }}>
      <p style={{ fontWeight: 600, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: {kobo ? fmtKobo(p.value) : p.value}
        </p>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const LEAD_SOURCE_COLORS = [RED, NAVY, BLUE, AMBER, GREEN, '#8B5CF6', '#EC4899']

export default function SalesOverview() {
  const navigate = useNavigate()
  const [kpis,      setKpis]      = useState<LoanKPIs | null>(null)
  const [monthly,   setMonthly]   = useState<MonthlyPoint[]>([])
  const [perfs,     setPerfs]     = useState<TopPerformer[]>([])
  const [apps,      setApps]      = useState<RecentApp[]>([])
  const [leadSrc,   setLeadSrc]   = useState<LeadSourceItem[]>([])
  const [loading,   setLoading]   = useState(true)

  async function load() {
    setLoading(true)
    try {
      const [k, m, p, a, ls] = await Promise.all([
        apiFetch<{data: LoanKPIs}>('/api/sales/loan-kpis'),
        apiFetch<{data: MonthlyPoint[]}>('/api/sales/monthly-disbursements'),
        apiFetch<{data: TopPerformer[]}>('/api/sales/top-performers'),
        apiFetch<{data: RecentApp[]}>('/api/sales/recent-applications'),
        apiFetch<{data: LeadSourceItem[]}>('/api/sales/by-lead-source'),
      ])
      setKpis(k.data)
      setMonthly(m.data ?? [])
      setPerfs(p.data ?? [])
      setApps(a.data ?? [])
      setLeadSrc(ls.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const appCols: TableCol<RecentApp>[] = [
    {
      key: 'id', label: 'App#', sortable: false, width: 80,
      render: row => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>APP-{row.id}</span>,
    },
    {
      key: 'applicant_name', label: 'Applicant', sortable: true,
      render: row => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{row.applicant_name ?? '—'}</span>,
    },
    {
      key: 'stage', label: 'Stage', sortable: true,
      render: row => <StagePill stage={row.stage} />,
    },
    {
      key: 'product_type', label: 'Product', sortable: true,
      render: row => row.product_type
        ? <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap' }}>{row.product_type}</span>
        : <span style={{ color: 'var(--txt3)', fontSize: 12 }}>—</span>,
    },
    {
      key: 'amount_requested_kobo', label: 'Amount', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtKobo(row.amount_requested_kobo)}</span>,
    },
    {
      key: 'officer_name', label: 'Officer', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)' }}>{row.officer_name ?? '—'}</span>,
    },
    {
      key: 'updated_at', label: 'Last Updated', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)', fontSize: 12 }}>{fmtDatetime(row.updated_at)}</span>,
    },
  ]

  const perfCols: TableCol<TopPerformer>[] = [
    {
      key: 'name', label: 'Officer', sortable: true,
      render: row => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
            background: `${NAVY}14`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: NAVY,
          }}>
            {(row.name ?? '?').split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          <span style={{ fontSize: 13 }}>{row.name}</span>
        </div>
      ),
    },
    {
      key: 'amount_kobo', label: 'Disbursed MTD', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtKobo(row.amount_kobo)}</span>,
    },
    {
      key: 'count', label: 'Loans', sortable: true, align: 'right',
      render: row => <span style={NUM}>{row.count}</span>,
    },
  ]

  return (
    <Page
      title="Sales Overview"
      subtitle="Credit origination performance"
      actions={
        <button
          onClick={() => navigate('/sales/applications/new')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
            border: 'none', background: RED, color: '#fff', cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Application
        </button>
      }
    >
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 16 }}>
        <KpiCard label="Submitted MTD"   value={kpis ? fmtNum(kpis.submitted_mtd) : '—'}         icon="description"       accent={BLUE}  loading={loading} />
        <KpiCard label="Disbursed MTD"   value={kpis ? fmtKobo(kpis.disbursed_mtd_kobo) : '—'}   icon="payments"          accent={RED}   loading={loading} />
        <KpiCard label="Pipeline Value"  value={kpis ? fmtKobo(kpis.pipeline_kobo) : '—'}        icon="account_balance"   accent={NAVY}  loading={loading} />
        <KpiCard label="Win Rate"        value={kpis ? fmtPct(kpis.win_rate_pct) : '—'}          icon="trophy"            accent={GREEN} loading={loading} />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Monthly Disbursements" subtitle="Last 12 months">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={RED} stopOpacity={0.16} />
                  <stop offset="95%" stopColor={RED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} width={72} />
              <Tooltip content={<ChartTooltip kobo />} />
              <Area type="monotone" dataKey="disbursements_kobo" name="Disbursements"
                stroke={RED} strokeWidth={2} fill="url(#salesGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Top Performers" subtitle="Disbursements MTD">
          {perfs.length === 0 ? (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: 13 }}>No data</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={perfs} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" horizontal={false} />
                <XAxis type="number" tickFormatter={v => fmtKobo(v)} tick={{ fontSize: 10, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} width={80} />
                <Tooltip content={<ChartTooltip kobo />} />
                <Bar dataKey="amount_kobo" name="Disbursed" fill={AMBER} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* Lead source breakdown */}
      {leadSrc.length > 0 && (
        <SectionCard title="Origination by Lead Source" subtitle="Applications by acquisition channel" padding={false}
          actions={<span style={{ fontSize: 11, color: 'var(--txt3)' }}>All time</span>}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={leadSrc} layout="vertical" margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="lead_source" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} width={90} />
                <Tooltip formatter={(v: any) => [fmtNum(v as number), 'Applications']} />
                <Bar dataKey="total_applications" name="Applications" radius={[0, 4, 4, 0]}>
                  {leadSrc.map((_, i) => <Cell key={i} fill={LEAD_SOURCE_COLORS[i % LEAD_SOURCE_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr>
                    {['Source', 'Applications', 'Approved', 'Disbursed'].map(h => (
                      <th key={h} style={{ textAlign: h === 'Source' ? 'left' : 'right', padding: '8px 12px',
                        fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px',
                        color: 'var(--txt2)', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leadSrc.map((row, i) => (
                    <tr key={row.lead_source}
                      style={{ background: 'transparent' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '8px 12px', borderBottom: '1px solid var(--bdr)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: LEAD_SOURCE_COLORS[i % LEAD_SOURCE_COLORS.length], flexShrink: 0 }} />
                          <span style={{ textTransform: 'capitalize' }}>{row.lead_source}</span>
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--bdr)', ...NUM }}>{fmtNum(row.total_applications)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--bdr)', ...NUM, color: GREEN }}>{fmtNum(row.approved)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--bdr)', ...NUM }}>{fmtKobo(row.disbursement_kobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </SectionCard>
      )}

      {/* Recent applications table */}
      <SectionCard
        title="Recent Applications"
        subtitle="Latest activity"
        actions={
          <button
            onClick={() => navigate('/sales/applications')}
            style={{
              fontSize: 12, fontWeight: 500, color: RED,
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            View all
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_forward</span>
          </button>
        }
      >
        <DataTable<RecentApp>
          cols={appCols}
          rows={apps}
          loading={loading}
          skeletonRows={5}
          emptyText="No applications yet"
          keyFn={(r) => r.id}
          onRowClick={(row) => navigate(`/sales/applications/${row.id}`)}
        />
      </SectionCard>
    </Page>
  )
}
