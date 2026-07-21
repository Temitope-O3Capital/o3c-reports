import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, KpiCard, ErrBanner, DateFilter, filterInputStyle } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar,
  Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FunnelData { registered: number; card_issued: number; card_active: number; transacting: number }
interface TrendPoint  { month: string; new_accounts: number }

interface CohortRow {
  cohort_month: string
  cohort_size: number
  ret_1m: number | null
  ret_3m: number | null
  ret_6m: number | null
  ret_9m: number | null
  ret_12m: number | null
  par30_current: number | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function retColor(val: number | null): { bg: string; color: string } {
  if (val === null) return { bg: 'transparent', color: 'var(--txt3)' }
  if (val >= 80)  return { bg: 'rgba(22,163,74,.12)',  color: GREEN }
  if (val >= 60)  return { bg: 'rgba(217,119,6,.12)',  color: AMBER }
  return               { bg: 'rgba(192,0,0,.12)',      color: RED }
}

function par30Color(val: number | null): { bg: string; color: string } {
  if (val === null) return { bg: 'transparent', color: 'var(--txt3)' }
  if (val < 5)   return { bg: 'rgba(22,163,74,.12)',  color: GREEN }
  if (val <= 15) return { bg: 'rgba(217,119,6,.12)',  color: AMBER }
  return              { bg: 'rgba(192,0,0,.12)',      color: RED }
}

function HeatCell({ value, colorFn, onClick }: {
  value: number | null
  colorFn: (v: number | null) => { bg: string; color: string }
  onClick?: () => void
}) {
  const s = colorFn(value)
  return (
    <td
      onClick={onClick}
      style={{
        padding: '10px 14px', textAlign: 'right', background: s.bg,
        borderBottom: '1px solid var(--bdr)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'filter 0.1s',
      }}
      onMouseEnter={e => onClick && ((e.currentTarget as HTMLTableCellElement).style.filter = 'brightness(0.9)')}
      onMouseLeave={e => onClick && ((e.currentTarget as HTMLTableCellElement).style.filter = 'brightness(1)')}
    >
      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: s.color }}>
        {value === null ? '—' : `${value}%`}
      </span>
    </td>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function SalesCohort() {
  const navigate = useNavigate()
  const [trend,    setTrend]    = useState<TrendPoint[]>([])
  const [funnel,   setFunnel]   = useState<FunnelData | null>(null)
  const [cohorts,  setCohorts]  = useState<CohortRow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [metric,   setMetric]   = useState<'retention' | 'par30'>('retention')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [t, f, c] = await Promise.all([
        apiFetch<{ data: TrendPoint[] }>(`/api/sales/accounts-trend?from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: FunnelData }>(`/api/sales/funnel?from=${dateFrom}&to=${dateTo}`),
        apiFetch<{ data: CohortRow[] }>(`/api/sales/cohort-matrix?from=${dateFrom}&to=${dateTo}`),
      ])
      setTrend(Array.isArray(t?.data) ? t.data : [])
      setFunnel(f?.data ?? null)
      setCohorts(Array.isArray(c?.data) ? c.data : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const reg    = Number(funnel?.registered  ?? 0)
  const issued = Number(funnel?.card_issued ?? 0)
  const active = Number(funnel?.card_active ?? 0)
  const trans  = Number(funnel?.transacting ?? 0)

  const funnelChart = [
    { stage: 'Registered',  value: reg,    fill: NAVY  },
    { stage: 'Card Issued', value: issued, fill: BLUE  },
    { stage: 'Card Active', value: active, fill: GREEN },
    { stage: 'Transacting', value: trans,  fill: AMBER },
  ]

  // Summary: best and worst cohort
  const validRetCohorts = cohorts.filter(c => c.ret_6m !== null)
  const bestCohort  = validRetCohorts.length
    ? validRetCohorts.reduce((a, b) => (b.ret_6m ?? 0) > (a.ret_6m ?? 0) ? b : a)
    : null
  const worstCohort = validRetCohorts.length
    ? validRetCohorts.reduce((a, b) => (b.ret_6m ?? 100) < (a.ret_6m ?? 100) ? b : a)
    : null

  const avgRet6m = validRetCohorts.length
    ? validRetCohorts.reduce((s, c) => s + (c.ret_6m ?? 0), 0) / validRetCohorts.length
    : null

  return (
    <Page
      title="Cohort Analysis"
      subtitle="Customer acquisition, lifecycle progression, and retention heatmap"
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Registered"      value={fmtNum(reg)}    />
        <KpiCard label="Card Issued"     value={fmtNum(issued)} accent={BLUE} />
        <KpiCard label="Card Active"     value={fmtNum(active)} accent={GREEN} />
        <KpiCard label="Avg 6m Retention" value={avgRet6m !== null ? fmtPct(avgRet6m) : '—'} accent={avgRet6m !== null && avgRet6m >= 70 ? GREEN : AMBER} />
      </div>

      {/* Trend + Funnel */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
        <SectionCard title="New Accounts — Monthly Trend">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cohortGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={NAVY} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Area type="monotone" dataKey="new_accounts" stroke={NAVY} strokeWidth={2} fill="url(#cohortGrad)" name="New Accounts" />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Lifecycle Funnel">
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={funnelChart} layout="vertical" margin={{ top: 4, right: 8, bottom: 4, left: 72 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: TEXT['2xs'], fill: 'var(--txt2)' }} />
              <YAxis type="category" dataKey="stage" tick={{ fontSize: TEXT.xs, fill: 'var(--txt2)' }} width={72} />
              <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]} name="Count">
                {funnelChart.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {reg > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, fontSize: TEXT.sm }}>
              {[
                { label: 'Card issue rate',  val: issued / reg * 100 },
                { label: 'Active rate',      val: active / reg * 100 },
                { label: 'Transacting rate', val: trans  / reg * 100 },
              ].map(({ label, val }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--txt2)' }}>
                  <span>{label}</span>
                  <strong style={{ color: 'var(--txt)' }}>{fmtPct(val)}</strong>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Best / Worst cohort summary */}
      {(bestCohort || worstCohort) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
          {bestCohort && (
            <div style={{
              background: 'var(--card)', borderRadius: RADIUS.xl, padding: '14px 18px',
              border: '1px solid var(--bdr)', borderLeft: `4px solid ${GREEN}`,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 28, color: GREEN }}>emoji_events</span>
              <div>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Best Performing Cohort (6m)</div>
                <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: GREEN }}>{bestCohort.cohort_month}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtPct(bestCohort.ret_6m ?? 0)} retention · {fmtNum(bestCohort.cohort_size)} accounts</div>
              </div>
            </div>
          )}
          {worstCohort && (
            <div style={{
              background: 'var(--card)', borderRadius: RADIUS.xl, padding: '14px 18px',
              border: '1px solid var(--bdr)', borderLeft: `4px solid ${RED}`,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 28, color: RED }}>warning</span>
              <div>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Needs Attention (6m)</div>
                <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: RED }}>{worstCohort.cohort_month}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{fmtPct(worstCohort.ret_6m ?? 0)} retention · {fmtNum(worstCohort.cohort_size)} accounts</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cohort Heatmap */}
      <SectionCard
        title="Cohort Retention Heatmap"
        badge={cohorts.length}
        padding={false}
        actions={
          <div style={{ display: 'flex', gap: 4 }}>
            {([
              { key: 'retention', label: 'Retention' },
              { key: 'par30',     label: 'PAR30' },
            ] as const).map(m => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                style={{
                  padding: '4px 12px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: '1.5px solid var(--input-bdr)', cursor: 'pointer',
                  background: metric === m.key ? NAVY : 'transparent',
                  color: metric === m.key ? '#fff' : 'var(--txt2)',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {[
                  { label: 'Cohort Month', align: 'left' },
                  { label: 'Size', align: 'right' },
                  ...(metric === 'retention'
                    ? [
                        { label: '1 Month',  align: 'right' },
                        { label: '3 Months', align: 'right' },
                        { label: '6 Months', align: 'right' },
                        { label: '9 Months', align: 'right' },
                        { label: '12 Months', align: 'right' },
                      ]
                    : [
                        { label: 'PAR30 Now', align: 'right' },
                      ]),
                  { label: '', align: 'right' },
                ].map((h, i) => (
                  <th key={i} style={{
                    padding: '10px 14px', textAlign: h.align as any,
                    fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
                    whiteSpace: 'nowrap', borderBottom: '1px solid var(--bdr)',
                  }}>{h.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    {Array.from({ length: metric === 'retention' ? 8 : 4 }, (_, j) => (
                      <td key={j} style={{ padding: '10px 14px', borderBottom: '1px solid var(--bdr)' }}>
                        <div style={{ height: 14, width: j === 0 ? 80 : 48, background: 'var(--bdr)', borderRadius: 3, animation: 'pulse 1.5s ease-in-out infinite' }} />
                      </td>
                    ))}
                  </tr>
                ))
              ) : cohorts.length === 0 ? (
                <tr>
                  <td colSpan={metric === 'retention' ? 8 : 4} style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
                    No cohort data available for this period
                  </td>
                </tr>
              ) : (
                cohorts.map(row => (
                  <tr
                    key={row.cohort_month}
                    onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = ''}
                  >
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: NAVY, fontFamily: SORA }}>{row.cohort_month}</span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', borderBottom: '1px solid var(--bdr)' }}>
                      <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(row.cohort_size)}</span>
                    </td>
                    {metric === 'retention' ? (
                      <>
                        <HeatCell value={row.ret_1m}  colorFn={retColor} onClick={() => navigate(`/sales/cohort/${row.cohort_month}?age=1m`)} />
                        <HeatCell value={row.ret_3m}  colorFn={retColor} onClick={() => navigate(`/sales/cohort/${row.cohort_month}?age=3m`)} />
                        <HeatCell value={row.ret_6m}  colorFn={retColor} onClick={() => navigate(`/sales/cohort/${row.cohort_month}?age=6m`)} />
                        <HeatCell value={row.ret_9m}  colorFn={retColor} onClick={() => navigate(`/sales/cohort/${row.cohort_month}?age=9m`)} />
                        <HeatCell value={row.ret_12m} colorFn={retColor} onClick={() => navigate(`/sales/cohort/${row.cohort_month}?age=12m`)} />
                      </>
                    ) : (
                      <HeatCell value={row.par30_current} colorFn={par30Color} onClick={() => navigate(`/sales/cohort/${row.cohort_month}`)} />
                    )}
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--bdr)', textAlign: 'right' }}>
                      <button
                        onClick={() => navigate(`/sales/cohort/${row.cohort_month}`)}
                        style={{
                          padding: '3px 10px', borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)',
                          background: 'transparent', color: 'var(--txt2)', fontSize: TEXT.xs,
                          fontWeight: FW.semibold, cursor: 'pointer', fontFamily: 'inherit',
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        Drill in
                        <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>chevron_right</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
            {metric === 'retention' ? 'Retention rate:' : 'PAR30 rate:'}
          </span>
          {(metric === 'retention' ? [
              { label: '≥ 80%', bg: 'rgba(22,163,74,.12)',  color: GREEN },
              { label: '60–80%', bg: 'rgba(217,119,6,.12)', color: AMBER },
              { label: '< 60%', bg: 'rgba(192,0,0,.12)',    color: RED },
              { label: 'N/A',       bg: 'transparent',           color: 'var(--txt3)' },
            ] : [
              { label: '< 5%',  bg: 'rgba(22,163,74,.12)',  color: GREEN },
              { label: '5–15%', bg: 'rgba(217,119,6,.12)',  color: AMBER },
              { label: '> 15%', bg: 'rgba(192,0,0,.12)',    color: RED },
              { label: 'N/A',        bg: 'transparent',          color: 'var(--txt3)' },
            ]).map(item => (
            <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 24, height: 14, borderRadius: RADIUS.xs, background: item.bg, border: '1px solid var(--bdr)' }} />
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: item.color }}>{item.label}</span>
            </div>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
            Click any cell or "Drill in" to see cohort details
          </span>
        </div>
      </SectionCard>
    </Page>
  )
}
