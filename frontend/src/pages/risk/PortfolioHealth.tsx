import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  PieChart, Pie, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct, fmtNum } from '../../lib/fmt'
import { NAVY, RED, DARKRED, AMBER, GREEN, BLUE, INTER, SORA, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortfolioKPIs {
  npl_ratio_pct: number
  par30_rate_pct: number
  avg_credit_score: number
  top_employer_exposure_kobo: number
}

interface PARTrendPoint {
  month: string
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
}

interface BandDist {
  band: string
  count: number
  pct: number
}

interface SectorConc {
  sector: string
  book_pct: number
}

interface EmployerRow {
  company: string
  staff_loans_count: number
  book_kobo: number
  pct_of_total: number
  par30_count: number
}

// ── Band donut colours ────────────────────────────────────────────────────────

const BAND_DONUT_COLORS: Record<string, string> = {
  Prime:        GREEN,
  'Near-Prime': BLUE,
  'Sub-Prime':  AMBER,
  'High-Risk':  RED,
}

// ── Sector bar opacity ramp from NAVY ────────────────────────────────────────

function sectorFill(index: number, total: number): string {
  const opacity = 0.95 - (index / Math.max(total - 1, 1)) * 0.55
  return `rgba(14,40,65,${opacity.toFixed(2)})`
}

// ── Custom tooltip (dark navy, per FRONTEND_AGENT) ────────────────────────────

function Tip({ active, payload, label, fmt }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  fmt?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  const f = fmt ?? ((v: number) => String(v))
  return (
    <div style={{
      background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase' }}>{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER, ...NUM }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Employer table columns ────────────────────────────────────────────────────

const EMPLOYER_COLS: TableCol<EmployerRow>[] = [
  {
    key: 'company', label: 'Company',
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.company}</span>,
  },
  {
    key: 'staff_loans_count', label: 'Staff Loans', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtNum(r.staff_loans_count)}</span>,
  },
  {
    key: 'book_kobo', label: 'Book ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.book_kobo)}</span>,
  },
  {
    key: 'pct_of_total', label: '% of Book', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: 600, color: r.pct_of_total > 10 ? RED : 'var(--txt)' }}>{fmtPct(r.pct_of_total)}</span>,
  },
  {
    key: 'par30_count', label: 'PAR30 Count', align: 'right',
    render: r => (
      <span style={{ ...NUM, fontWeight: 600, color: r.par30_count > 0 ? AMBER : GREEN }}>
        {fmtNum(r.par30_count)}
      </span>
    ),
  },
]

// ── ChartCard wrapper ─────────────────────────────────────────────────────────

function ChartCard({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 14, boxShadow: 'var(--card-shadow)', padding: '18px 20px' }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 2, fontFamily: INTER }}>{sub}</div>
      </div>
      {children}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PortfolioHealth() {
  const [kpis,      setKpis]      = useState<PortfolioKPIs | null>(null)
  const [parTrend,  setParTrend]  = useState<PARTrendPoint[]>([])
  const [bandDist,  setBandDist]  = useState<BandDist[]>([])
  const [sectors,   setSectors]   = useState<SectorConc[]>([])
  const [employers, setEmployers] = useState<EmployerRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [kpisRes, trendRes, bandRes, sectorRes, empRes] = await Promise.all([
        apiFetch<{ data: PortfolioKPIs }>('/api/risk/portfolio-kpis'),
        apiFetch<{ data: PARTrendPoint[] }>('/api/risk/par-trend'),
        apiFetch<{ data: BandDist[] }>('/api/risk/band-distribution'),
        apiFetch<{ data: SectorConc[] }>('/api/risk/sector-concentration'),
        apiFetch<{ data: EmployerRow[] }>('/api/risk/top-employers'),
      ])
      setKpis(kpisRes.data)
      setParTrend(trendRes.data ?? [])
      setBandDist(bandRes.data ?? [])
      setSectors(sectorRes.data ?? [])
      setEmployers(empRes.data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load portfolio data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const kpiLoading = loading && !kpis
  const totalBandCount = bandDist.reduce((acc, d) => acc + d.count, 0)

  function exportEmployersCsv(data: EmployerRow[]) {
    const header = ['Company', 'Staff Loans', 'Book ₦', '% of Book', 'PAR30 Count']
    const lines = data.map(r => [
      `"${String(r.company ?? '').replace(/"/g, '""')}"`,
      r.staff_loans_count ?? 0,
      (r.book_kobo / 100).toFixed(2),
      r.pct_of_total != null ? r.pct_of_total.toFixed(2) + '%' : '',
      r.par30_count ?? 0,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `employer-exposure-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Portfolio Health"
      subtitle="NPL, PAR rates, credit score distribution, and employer concentration"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard
          label="NPL Ratio"
          value={kpis ? fmtPct(kpis.npl_ratio_pct) : '—'}
          sub="Non-performing loans"
          icon="warning_amber"
          accent={RED}
          loading={kpiLoading}
        />
        <KpiCard
          label="PAR30 Rate"
          value={kpis ? fmtPct(kpis.par30_rate_pct) : '—'}
          sub="Portfolio at risk 30+"
          icon="monitoring"
          accent={AMBER}
          loading={kpiLoading}
        />
        <KpiCard
          label="Avg Credit Score"
          value={kpis ? Math.round(kpis.avg_credit_score).toLocaleString() : '—'}
          sub="Eye score, active loans"
          icon="grade"
          accent={BLUE}
          loading={kpiLoading}
        />
        <KpiCard
          label="Top Employer Exposure"
          value={kpis ? fmtKobo(kpis.top_employer_exposure_kobo) : '—'}
          sub="Largest single employer"
          icon="business"
          accent={NAVY}
          loading={kpiLoading}
        />
      </div>

      {/* Charts row 1 — PAR trend + band donut */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>

        {/* Left: PAR30/60/90 area trend */}
        <ChartCard title="PAR Trend — 12 Months" sub="Portfolio at risk by DPD band">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={parTrend} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <defs>
                <linearGradient id="par30Grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={AMBER} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={AMBER} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="par60Grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={RED} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={RED} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="par90Grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={DARKRED} stopOpacity={0.22} />
                  <stop offset="95%" stopColor={DARKRED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickFormatter={v => fmtKobo(v)} width={70} />
              <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => fmtKobo(v)} />} />
              <Area type="monotone" dataKey="par30_kobo" name="PAR30" stroke={AMBER} strokeWidth={2.2} fill="url(#par30Grad)" stackId="par" dot={false} />
              <Area type="monotone" dataKey="par60_kobo" name="PAR60" stroke={RED} strokeWidth={2.2} fill="url(#par60Grad)" stackId="par" dot={false} />
              <Area type="monotone" dataKey="par90_kobo" name="PAR90" stroke={DARKRED} strokeWidth={2.2} fill="url(#par90Grad)" stackId="par" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, justifyContent: 'flex-end' }}>
            {([[AMBER, 'PAR30'], [RED, 'PAR60'], [DARKRED, 'PAR90']] as const).map(([c, l]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>
                <div style={{ width: 16, height: 2.5, borderRadius: 2, background: c }} />{l}
              </div>
            ))}
          </div>
        </ChartCard>

        {/* Right: risk band donut */}
        <ChartCard title="Risk Band Distribution" sub="Active loan book by credit band">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <PieChart width={148} height={148}>
                <Pie
                  data={bandDist}
                  cx={70} cy={70}
                  innerRadius={42} outerRadius={66}
                  dataKey="count"
                  nameKey="band"
                  stroke="none"
                  paddingAngle={3}
                  startAngle={90} endAngle={-270}
                >
                  {bandDist.map((d, i) => (
                    <Cell key={i} fill={BAND_DONUT_COLORS[d.band] ?? 'var(--chart-lbl)'} />
                  ))}
                </Pie>
                <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => fmtNum(v)} />} />
              </PieChart>
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none',
              }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--txt)', ...NUM, lineHeight: 1 }}>
                  {fmtNum(totalBandCount)}
                </div>
                <div style={{ fontSize: 9, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>loans</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 9 }}>
              {bandDist.map(d => (
                <div key={d.band} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: BAND_DONUT_COLORS[d.band] ?? 'var(--chart-lbl)', flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--txt)', fontWeight: 500 }}>{d.band}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', ...NUM }}>{fmtPct(d.pct)}</span>
                </div>
              ))}
            </div>
          </div>
        </ChartCard>
      </div>

      {/* Charts row 2 — sector concentration bar */}
      <ChartCard title="Sector Concentration" sub="Top 8 sectors by share of loan book">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={sectors.slice(0, 8)} margin={{ top: 4, right: 8, bottom: 4, left: -18 }} barCategoryGap="28%">
            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="0" vertical={false} strokeWidth={1} />
            <XAxis
              dataKey="sector"
              tick={{ fontSize: 9.5, fill: 'var(--chart-lbl)', fontFamily: INTER }}
              axisLine={false} tickLine={false}
              interval={0} textAnchor="middle"
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }}
              axisLine={false} tickLine={false}
              tickFormatter={v => `${v}%`}
            />
            <Tooltip content={(p: any) => <Tip {...p} fmt={(v: number) => `${v.toFixed(1)}%`} />} />
            <Bar dataKey="book_pct" name="% of Book" radius={[5, 5, 0, 0]}>
              {sectors.slice(0, 8).map((_, i) => (
                <Cell key={i} fill={sectorFill(i, Math.min(sectors.length, 8))} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Top employers table */}
      <SectionCard
        title="Top Employers by Exposure"
        badge={employers.length}
        subtitle="Sorted by book value — flag concentrations above 10%"
        padding={false}
        style={{ marginTop: 16 }}
        actions={<button onClick={() => exportEmployersCsv(employers)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}
      >
        <DataTable
          cols={EMPLOYER_COLS}
          rows={employers}
          keyFn={(r, i) => r.company ?? i}
          loading={loading}
          skeletonRows={8}
          emptyText="No employer data found"
          searchKeys={['company']}
          searchPlaceholder="Search employers…"
          pageSize={20}
        />
      </SectionCard>
    </Page>
  )
}
