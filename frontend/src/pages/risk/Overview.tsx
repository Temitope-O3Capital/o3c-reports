import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, ErrBanner, Spinner, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReviewKPIs {
  reviewed: number
  approved: number
  declined: number
  pending:  number
}

interface PortfolioKPIs {
  npl_ratio_pct:              number
  par30_rate_pct:             number
  avg_credit_score:           number
  top_employer_exposure_kobo: number
}

interface EyeKPIs {
  scored_today:    number
  avg_score_month: number
  high_risk_count: number
  requests_month:  number
}

interface BandRow  { band: string;   count: number; pct: number }
interface SectorRow { sector: string; book_pct: number }

interface EmployerRow {
  company:           string
  staff_loans_count: number
  book_kobo:         number
  pct_of_total:      number
  par30_count:       number
}

// ── Colour maps ───────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, string> = {
  'Prime':       '#16A34A',
  'Near-Prime':  '#2563EB',
  'Sub-Prime':   '#D97706',
  'High-Risk':   RED,
}

function bandColor(band: string) { return BAND_COLORS[band] ?? NAVY }

function eyeScoreColor(score: number) {
  if (score >= 700) return GREEN
  if (score >= 500) return AMBER
  if (score > 0)    return RED
  return 'var(--txt3)'
}

// ── Sub-page navigation cards ─────────────────────────────────────────────────

const NAV_ITEMS = [
  { label: 'App Review',       icon: 'rate_review',     to: '/operations/risk/applications', desc: 'Assess and score incoming loan applications' },
  { label: 'Portfolio Health', icon: 'health_metrics',  to: '/operations/risk/portfolio',    desc: 'PAR trends, concentration and sector breakdown' },
  { label: 'Eye Credit Score', icon: 'psychology',      to: '/operations/risk/eye',          desc: 'Individual borrower score history and distribution' },
  { label: 'Vintage Analysis', icon: 'timeline',        to: '/operations/risk/vintage',      desc: 'Cohort performance by booking month' },
  { label: 'Credit File',      icon: 'folder_open',     to: '/operations/risk/credit-file',  desc: 'Full credit file lookup by CIF' },
]

// ── Employer table cols ───────────────────────────────────────────────────────

const empCols: TableCol<EmployerRow>[] = [
  {
    key: 'company', label: 'Employer', sortable: true,
    render: r => (
      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
        {r.company}
      </span>
    ),
  },
  {
    key: 'staff_loans_count', label: 'Loans', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtNum(r.staff_loans_count)}</span>,
  },
  {
    key: 'book_kobo', label: 'Exposure', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtKobo(r.book_kobo)}</span>,
  },
  {
    key: 'pct_of_total', label: '% of Book', align: 'right', sortable: true,
    render: r => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
        <div style={{
          width: 56, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${Math.min(100, Number(r.pct_of_total))}%`,
            background: Number(r.pct_of_total) > 20 ? RED : Number(r.pct_of_total) > 10 ? AMBER : NAVY,
          }} />
        </div>
        <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 38, textAlign: 'right' }}>
          {fmtPct(r.pct_of_total)}
        </span>
      </div>
    ),
  },
  {
    key: 'par30_count', label: 'PAR30 Loans', align: 'right', sortable: true,
    render: r => (
      <span style={{ ...NUM, fontSize: TEXT.sm, color: r.par30_count > 0 ? AMBER : 'var(--txt3)' }}>
        {r.par30_count > 0 ? r.par30_count : '—'}
      </span>
    ),
  },
]

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RiskOverview() {
  const navigate = useNavigate()

  const [reviewKPIs,   setReviewKPIs]   = useState<ReviewKPIs | null>(null)
  const [portfolioKPIs,setPortfolioKPIs] = useState<PortfolioKPIs | null>(null)
  const [eyeKPIs,      setEyeKPIs]      = useState<EyeKPIs | null>(null)
  const [bands,        setBands]         = useState<BandRow[]>([])
  const [sectors,      setSectors]       = useState<SectorRow[]>([])
  const [employers,    setEmployers]     = useState<EmployerRow[]>([])
  const [loading,      setLoading]       = useState(true)
  const [error,        setError]         = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [rk, pk, ek, bd, sc, em] = await Promise.all([
        apiFetch<{ data: ReviewKPIs   }>('/api/risk/review-kpis'),
        apiFetch<{ data: PortfolioKPIs}>('/api/risk/portfolio-kpis'),
        apiFetch<{ data: EyeKPIs      }>('/api/risk/eye-kpis'),
        apiFetch<{ data: BandRow[]    }>('/api/risk/band-distribution'),
        apiFetch<{ data: SectorRow[]  }>('/api/risk/sector-concentration'),
        apiFetch<{ data: EmployerRow[]}>('/api/risk/top-employers'),
      ])
      setReviewKPIs(rk.data)
      setPortfolioKPIs(pk.data)
      setEyeKPIs(ek.data)
      setBands(Array.isArray(bd.data) ? bd.data : [])
      setSectors(Array.isArray(sc.data) ? sc.data : [])
      setEmployers(Array.isArray(em.data) ? em.data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const approvalRate = reviewKPIs
    ? reviewKPIs.approved + reviewKPIs.declined > 0
      ? Math.round(100 * reviewKPIs.approved / (reviewKPIs.approved + reviewKPIs.declined))
      : 0
    : null

  const pieData = bands.map(b => ({ name: b.band, value: b.count, pct: b.pct }))

  if (loading) return (
    <Page title="Risk Overview">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page
      title="Risk Overview"
      subtitle="Credit risk dashboard — applications, portfolio health, Eye scores, concentration"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Alert strip */}
      {(reviewKPIs?.pending ?? 0) > 0 && (
        <div
          onClick={() => navigate('/operations/risk/applications')}
          style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[4],
            padding: `${SP[2]} ${SP[4]}`,
            background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md,
            cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>
            pending_actions
          </span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>
            {reviewKPIs?.pending} application{reviewKPIs?.pending !== 1 ? 's' : ''} pending risk review
          </span>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: AMBER, fontWeight: FW.semibold }}>
            Review now →
          </span>
        </div>
      )}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard
          label="Pending Review"
          value={String(reviewKPIs?.pending ?? '—')}
          icon="pending_actions"
          accent={(reviewKPIs?.pending ?? 0) > 0 ? AMBER : GREEN}
        />
        <KpiCard
          label="Approval Rate"
          value={approvalRate !== null ? `${approvalRate}%` : '—'}
          icon="check_circle"
          accent={(approvalRate ?? 0) >= 70 ? GREEN : (approvalRate ?? 0) >= 50 ? AMBER : RED}
        />
        <KpiCard
          label="High-Risk Loans"
          value={String(eyeKPIs?.high_risk_count ?? '—')}
          icon="warning"
          accent={(eyeKPIs?.high_risk_count ?? 0) > 0 ? RED : GREEN}
        />
        <KpiCard
          label="NPL Ratio"
          value={portfolioKPIs ? `${portfolioKPIs.npl_ratio_pct}%` : '—'}
          icon="trending_down"
          accent={(portfolioKPIs?.npl_ratio_pct ?? 0) > 5 ? RED : (portfolioKPIs?.npl_ratio_pct ?? 0) > 2 ? AMBER : GREEN}
        />
        <KpiCard
          label="PAR 30 Rate"
          value={portfolioKPIs ? `${portfolioKPIs.par30_rate_pct}%` : '—'}
          icon="schedule"
          accent={(portfolioKPIs?.par30_rate_pct ?? 0) > 10 ? RED : (portfolioKPIs?.par30_rate_pct ?? 0) > 5 ? AMBER : GREEN}
        />
        <KpiCard
          label="Avg Eye Score"
          value={portfolioKPIs ? String(portfolioKPIs.avg_credit_score) : '—'}
          icon="psychology"
          accent={eyeScoreColor(portfolioKPIs?.avg_credit_score ?? 0)}
        />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>

        {/* Risk band distribution */}
        <SectionCard title="Risk Band Distribution" subtitle="Active loan book by Eye rating">
          {pieData.length === 0 ? (
            <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              No scored loans in active book
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <PieChart width={160} height={160}>
                <Pie
                  data={pieData}
                  cx={75}
                  cy={75}
                  innerRadius={48}
                  outerRadius={72}
                  dataKey="value"
                  strokeWidth={2}
                  stroke="var(--card)"
                >
                  {pieData.map((entry) => (
                    <Cell key={entry.name} fill={bandColor(entry.name)} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(val: number, _: string, props: { payload?: { pct?: number } }) =>
                    [`${val} loans (${props.payload?.pct ?? 0}%)`, 'Count']
                  }
                  contentStyle={{
                    fontSize: TEXT.xs, borderRadius: RADIUS.md,
                    background: 'var(--card)', border: '1px solid var(--bdr)',
                  }}
                />
              </PieChart>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pieData.map(b => (
                  <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: bandColor(b.name), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{b.name}</span>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: bandColor(b.name) }}>
                      {b.pct}%
                    </span>
                    <div style={{ width: 60, height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${b.pct}%`, background: bandColor(b.name), borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>

        {/* Sector concentration */}
        <SectionCard title="Sector Concentration" subtitle="% of active book by sector / employer">
          {sectors.length === 0 ? (
            <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              No active loans
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sectors.slice(0, 8).map((s, i) => {
                const pct = Number(s.book_pct)
                const barColor = pct > 25 ? RED : pct > 15 ? AMBER : NAVY
                return (
                  <div key={s.sector} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', minWidth: 16, textAlign: 'right',
                    }}>
                      {i + 1}
                    </span>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.sector}
                    </span>
                    <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden', flexShrink: 0 }}>
                      <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: barColor, borderRadius: 3 }} />
                    </div>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: barColor, minWidth: 36, textAlign: 'right' }}>
                      {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Top employers */}
      <SectionCard
        title="Top Employers by Exposure"
        subtitle="Active loan book concentration — flag any single employer exceeding 20% of book"
        badge={employers.length}
        style={{ marginBottom: SP[4] }}
      >
        <DataTable
          cols={empCols}
          rows={employers}
          keyFn={r => r.company}
          emptyText="No active loans"
          pageSize={10}
        />
      </SectionCard>

      {/* Quick navigation */}
      <SectionCard title="Risk Modules" subtitle="Navigate to detailed analysis tools">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], padding: `0 0 ${SP[1]} 0` }}>
          {NAV_ITEMS.map(n => (
            <button
              key={n.to}
              onClick={() => navigate(n.to)}
              style={{
                padding: SP[4], borderRadius: RADIUS.lg, cursor: 'pointer', textAlign: 'left',
                border: `1.5px solid var(--bdr)`, background: 'var(--card)',
                display: 'flex', alignItems: 'flex-start', gap: 12,
                transition: 'border-color 0.15s',
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = NAVY)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--bdr)')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 22, color: NAVY, flexShrink: 0, marginTop: 1 }}>
                {n.icon}
              </span>
              <div>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 3 }}>
                  {n.label}
                </div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.4 }}>
                  {n.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
