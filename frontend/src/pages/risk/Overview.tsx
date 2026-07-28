import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie,
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
  par60_rate_pct:             number
  avg_credit_score:           number
  total_book_kobo:            number
  total_active_loans:         number
  top_employer_exposure_kobo: number
}

interface EyeKPIs {
  scored_today:    number
  avg_score_month: number
  high_risk_count: number
  requests_month:  number
}

interface BandRow   { band: string; count: number; pct: number }
interface SectorRow { sector: string; book_pct: number }

interface EmployerRow {
  company:           string
  staff_loans_count: number
  book_kobo:         number
  pct_of_total:      number
  par30_count:       number
}

interface PARPoint {
  month:       string
  par30_kobo:  number
  par60_kobo:  number
  par90_kobo:  number
}

// ── Colour helpers ────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, string> = {
  'Prime':       '#16A34A',
  'Near-Prime':  '#2563EB',
  'Sub-Prime':   '#D97706',
  'High-Risk':   RED,
}
function bandColor(band: string) { return BAND_COLORS[band] ?? NAVY }

function scoreColor(score: number) {
  if (score >= 700) return GREEN
  if (score >= 500) return AMBER
  if (score > 0)    return RED
  return 'var(--txt3)'
}

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
    render: r => {
      const pct = Number(r.pct_of_total)
      const color = pct > 20 ? RED : pct > 10 ? AMBER : NAVY
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div style={{ width: 56, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(100, pct)}%`, background: color }} />
          </div>
          <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 38, textAlign: 'right', color, fontWeight: pct > 20 ? FW.bold : FW.normal }}>
            {fmtPct(pct)}
          </span>
        </div>
      )
    },
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

  const [reviewKPIs,    setReviewKPIs]    = useState<ReviewKPIs | null>(null)
  const [portfolioKPIs, setPortfolioKPIs] = useState<PortfolioKPIs | null>(null)
  const [eyeKPIs,       setEyeKPIs]       = useState<EyeKPIs | null>(null)
  const [bands,         setBands]          = useState<BandRow[]>([])
  const [sectors,       setSectors]        = useState<SectorRow[]>([])
  const [employers,     setEmployers]      = useState<EmployerRow[]>([])
  const [parTrend,      setParTrend]       = useState<PARPoint[]>([])
  const [loading,       setLoading]        = useState(true)
  const [error,         setError]          = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [rk, pk, ek, bd, sc, em, pt] = await Promise.all([
        apiFetch<{ data: ReviewKPIs    }>('/api/risk/review-kpis'),
        apiFetch<{ data: PortfolioKPIs }>('/api/risk/portfolio-kpis'),
        apiFetch<{ data: EyeKPIs       }>('/api/risk/eye-kpis'),
        apiFetch<{ data: BandRow[]     }>('/api/risk/band-distribution'),
        apiFetch<{ data: SectorRow[]   }>('/api/risk/sector-concentration'),
        apiFetch<{ data: EmployerRow[] }>('/api/risk/top-employers'),
        apiFetch<{ data: PARPoint[]    }>('/api/risk/par-trend').catch(() => ({ data: [] })),
      ])
      setReviewKPIs(rk.data)
      setPortfolioKPIs(pk.data)
      setEyeKPIs(ek.data)
      setBands(Array.isArray(bd.data) ? bd.data : [])
      setSectors(Array.isArray(sc.data) ? sc.data : [])
      setEmployers(Array.isArray(em.data) ? em.data : [])
      setParTrend(Array.isArray(pt.data) ? pt.data.slice(-6) : [])
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

  // Derive concentration alerts from existing data — no extra API call
  const concentrationAlerts = employers.filter(e => Number(e.pct_of_total) > 20)

  if (loading) return (
    <Page title="Overview">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  return (
    <Page
      title="Overview"
      subtitle="Risk dashboard — portfolio quality, delinquency, concentration and scoring"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Pending review alert */}
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
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>pending_actions</span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>
            {reviewKPIs?.pending} application{reviewKPIs?.pending !== 1 ? 's' : ''} awaiting risk review
          </span>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: AMBER, fontWeight: FW.semibold }}>
            Review now →
          </span>
        </div>
      )}

      {/* Concentration risk alert */}
      {concentrationAlerts.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[4],
          padding: `${SP[2]} ${SP[4]}`,
          background: `${RED}08`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED, flexShrink: 0, marginTop: 1 }}>
            corporate_fare
          </span>
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED }}>
              Employer concentration breach{concentrationAlerts.length > 1 ? 'es' : ''}
            </span>
            {concentrationAlerts.map(e => (
              <div key={e.company} style={{ fontSize: TEXT.xs, color: RED, marginTop: 3 }}>
                {e.company} — {fmtPct(e.pct_of_total)} of book ({fmtKobo(e.book_kobo)}) · Policy limit: 20%
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI strip — 4 per row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard
          label="Active Book"
          value={portfolioKPIs ? fmtKobo(portfolioKPIs.total_book_kobo) : '—'}
          sub={portfolioKPIs ? `${fmtNum(portfolioKPIs.total_active_loans)} loans` : undefined}
          icon="account_balance_wallet"
          accent={NAVY}
        />
        <KpiCard
          label="NPL Ratio"
          value={portfolioKPIs ? `${portfolioKPIs.npl_ratio_pct}%` : '—'}
          sub="DPD > 90 days"
          icon="trending_down"
          accent={(portfolioKPIs?.npl_ratio_pct ?? 0) > 5 ? RED : (portfolioKPIs?.npl_ratio_pct ?? 0) > 2 ? AMBER : GREEN}
        />
        <KpiCard
          label="PAR 30"
          value={portfolioKPIs ? `${portfolioKPIs.par30_rate_pct}%` : '—'}
          sub="DPD > 30 days"
          icon="schedule"
          accent={(portfolioKPIs?.par30_rate_pct ?? 0) > 10 ? RED : (portfolioKPIs?.par30_rate_pct ?? 0) > 5 ? AMBER : GREEN}
        />
        <KpiCard
          label="PAR 60"
          value={portfolioKPIs ? `${portfolioKPIs.par60_rate_pct}%` : '—'}
          sub="DPD > 60 days"
          icon="warning_amber"
          accent={(portfolioKPIs?.par60_rate_pct ?? 0) > 7 ? RED : (portfolioKPIs?.par60_rate_pct ?? 0) > 3 ? AMBER : GREEN}
        />
        <KpiCard
          label="Pending Review"
          value={String(reviewKPIs?.pending ?? '—')}
          sub="In queue"
          icon="pending_actions"
          accent={(reviewKPIs?.pending ?? 0) > 0 ? AMBER : GREEN}
        />
        <KpiCard
          label="Approval Rate"
          value={approvalRate !== null ? `${approvalRate}%` : '—'}
          sub={reviewKPIs ? `${reviewKPIs.approved} of ${(reviewKPIs.approved + reviewKPIs.declined)} decided` : undefined}
          icon="check_circle"
          accent={(approvalRate ?? 0) >= 70 ? GREEN : (approvalRate ?? 0) >= 50 ? AMBER : RED}
        />
        <KpiCard
          label="High-Risk Loans"
          value={String(eyeKPIs?.high_risk_count ?? '—')}
          sub="Eye band: High-Risk"
          icon="error_outline"
          accent={(eyeKPIs?.high_risk_count ?? 0) > 0 ? RED : GREEN}
        />
        <KpiCard
          label="Avg Eye Score"
          value={portfolioKPIs ? String(portfolioKPIs.avg_credit_score) : '—'}
          sub="Active book"
          icon="psychology"
          accent={scoreColor(portfolioKPIs?.avg_credit_score ?? 0)}
        />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>

        {/* PAR trend */}
        <SectionCard title="PAR Trend" subtitle="Last 6 months — outstanding balance in each delinquency bucket">
          {parTrend.length === 0 ? (
            <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              No trend data
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={parTrend} barCategoryGap="28%" barGap={3}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--txt3)' }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--txt3)' }}
                    axisLine={false} tickLine={false}
                    tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(1)}M` : v >= 100_000_00 ? `₦${(v / 100_000_00).toFixed(0)}L` : ''}
                  />
                  <Tooltip
                    formatter={(val: number, name: string) => [fmtKobo(val), name]}
                    contentStyle={{ fontSize: TEXT.xs, borderRadius: RADIUS.md, background: 'var(--card)', border: '1px solid var(--bdr)' }}
                  />
                  <Bar dataKey="par30_kobo" name="PAR30" fill={`${AMBER}99`} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="par60_kobo" name="PAR60" fill={`${RED}80`}   radius={[2, 2, 0, 0]} />
                  <Bar dataKey="par90_kobo" name="PAR90" fill={RED}          radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 10, justifyContent: 'flex-end' }}>
                {[['PAR30', `${AMBER}99`], ['PAR60', `${RED}80`], ['PAR90', RED]].map(([label, color]) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{label}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </SectionCard>

        {/* Risk band distribution */}
        <SectionCard title="Risk Band Distribution" subtitle="Active loan book scored by Eye rating">
          {pieData.length === 0 ? (
            <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
              No scored loans in active book
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <PieChart width={160} height={160}>
                <Pie
                  data={pieData} cx={75} cy={75}
                  innerRadius={48} outerRadius={72}
                  dataKey="value" strokeWidth={2} stroke="var(--card)"
                >
                  {pieData.map(entry => (
                    <Cell key={entry.name} fill={bandColor(entry.name)} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(val: number, _: string, props: { payload?: { pct?: number } }) =>
                    [`${val} loans (${props.payload?.pct ?? 0}%)`, 'Count']
                  }
                  contentStyle={{ fontSize: TEXT.xs, borderRadius: RADIUS.md, background: 'var(--card)', border: '1px solid var(--bdr)' }}
                />
              </PieChart>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pieData.map(b => (
                  <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: bandColor(b.name), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)' }}>{b.name}</span>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: bandColor(b.name) }}>{b.pct}%</span>
                    <div style={{ width: 60, height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${b.pct}%`, background: bandColor(b.name), borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Second charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>

        {/* Sector concentration */}
        <SectionCard title="Sector Concentration" subtitle="% of active book — flag sectors exceeding 30%">
          {sectors.length === 0 ? (
            <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No active loans</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sectors.slice(0, 8).map((s, i) => {
                const pct = Number(s.book_pct)
                const color = pct > 30 ? RED : pct > 20 ? AMBER : NAVY
                return (
                  <div key={s.sector} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', minWidth: 16, textAlign: 'right' }}>{i + 1}</span>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.sector}
                    </span>
                    <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden', flexShrink: 0 }}>
                      <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, borderRadius: 3 }} />
                    </div>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color, minWidth: 36, textAlign: 'right' }}>
                      {pct}%
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>

        {/* Eye score band breakdown */}
        <SectionCard title="Eye Score Utilisation" subtitle="How many loans were scored this month vs total">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { label: 'Scored this month', value: eyeKPIs?.scored_today ?? 0, color: NAVY },
              { label: 'Total requests (month)', value: eyeKPIs?.requests_month ?? 0, color: NAVY },
              { label: 'Monthly avg score', value: eyeKPIs?.avg_score_month ?? 0, color: scoreColor(eyeKPIs?.avg_score_month ?? 0), isScore: true },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{row.label}</span>
                <span style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: row.color }}>
                  {row.isScore ? (row.value > 0 ? row.value : '—') : fmtNum(row.value)}
                </span>
              </div>
            ))}
            <div style={{ height: 1, background: 'var(--bdr)', marginTop: 4 }} />
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6 }}>
              Score bands: Prime ≥ 700 · Near-Prime 500–699 · Sub-Prime 300–499 · High-Risk &lt; 300
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Top employers */}
      <SectionCard
        title="Top Employers by Exposure"
        subtitle="Concentration risk — policy limit: no single employer exceeds 20% of active book"
        badge={employers.length}
      >
        <DataTable
          cols={empCols}
          rows={employers}
          keyFn={r => r.company}
          emptyText="No active loans"
          pageSize={10}
        />
      </SectionCard>
    </Page>
  )
}
