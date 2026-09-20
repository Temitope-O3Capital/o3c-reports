import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { fmtUsdCents } from '../../lib/currency'
import { EBar } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthRow {
  month: string
  atm: number; pos: number; web: number; bills: number; repayment: number; fees: number; other: number
  // total is naira. usd is dollar-card volume in cents — CCS posts those cards in
  // dollars, so it is shown beside the total and never added to it.
  total: number; usd: number
}

interface ReportData {
  period_label: string
  generated_at: string
  // 'live' when the figures came from the ledger, 'static' when the API fell back
  // to its hardcoded sample months. That fallback was previously indistinguishable
  // from real data on this page.
  source?: string
  months: MonthRow[]
  // For each CH key: <key>, <key>_pct and <key>_avg; plus total, usd and usd_avg.
  totals: Record<string, number>
}

const YEARS  = ['2024', '2025', '2026']
const PERIODS = [
  { id: 'H1', label: 'H1 (Jan–Jun)'  },
  { id: 'H2', label: 'H2 (Jul–Dec)'  },
  { id: 'Q1', label: 'Q1'            },
  { id: 'Q2', label: 'Q2'            },
  { id: 'Q3', label: 'Q3'            },
  { id: 'Q4', label: 'Q4'            },
  { id: 'FY', label: 'Full Year'     },
]

// Buckets follow app.card_txn_codes.category — the same classification as the
// Interswitch summary page. The report used to have four columns tested against
// codes ('01'..'15') that do not exist in this feed, so every month read 100% in
// its last column. 'other' is codes the category table does not know yet.
const CH = [
  { key: 'atm',       label: 'ATM / Cash',      color: NAVY      },
  { key: 'pos',       label: 'POS / Purchase',  color: BLUE      },
  { key: 'web',       label: 'Web Transfer',    color: AMBER     },
  { key: 'bills',     label: 'Bill Payment',    color: GREEN     },
  { key: 'repayment', label: 'Repayment',       color: PURPLE    },
  { key: 'fees',      label: 'Fees & Interest', color: RED       },
  { key: 'other',     label: 'Other',           color: '#94A3B8' },
] as const

export default function InterswitchReport() {
  const [year, setYear]   = useState('2026')
  const [period, setPer]  = useState('H1')
  const [data, setData]   = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (y: string, p: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ReportData }>(`/api/cards/interswitch/half-year?year=${y}&period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(year, period) }, [load, year, period])

  // Values are kobo: ₦1 = 100 kobo, so ₦1K = 1e5, ₦1M = 1e8, ₦1B = 1e11 kobo. The old
  // divisors (1e4/1e7/1e10) were 10x off, labelling a ₦1M gridline as "₦10M".
  const fmtAxis = (v: number) => {
    if (v >= 1e11) return `₦${(v / 1e11).toFixed(0)}B`
    if (v >= 1e8)  return `₦${(v / 1e8).toFixed(0)}M`
    if (v >= 1e5)  return `₦${(v / 1e5).toFixed(0)}K`
    return ''
  }

  const Th = ({ children, right }: { children: string; right?: boolean }) => (
    <th style={{ padding: '9px 14px', textAlign: right ? 'right' : 'left', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>
      {children}
    </th>
  )

  const peakMonth = data?.months.reduce((a, b) => b.total > a.total ? b : a, data.months[0])

  const filterBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--chip-bg)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)' }}>
        {YEARS.map(y => (
          <button key={y} onClick={() => setYear(y)} style={{
            padding: '4px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
            background: y === year ? 'var(--card)' : 'transparent',
            color: y === year ? 'var(--txt)' : 'var(--txt2)',
            fontSize: TEXT.sm, fontFamily: INTER, fontWeight: y === year ? FW.bold : FW.normal,
            boxShadow: y === year ? '0 1px 3px rgba(0,0,0,.1)' : 'none', transition: 'all 130ms',
          }}>{y}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
        {PERIODS.map(p => (
          <button key={p.id} onClick={() => setPer(p.id)} style={{
            padding: '5px 12px', borderRadius: RADIUS.full, fontSize: TEXT.sm, fontFamily: INTER, cursor: 'pointer',
            border: p.id === period ? 'none' : '1px solid var(--bdr)',
            background: p.id === period ? NAVY : 'transparent',
            color: p.id === period ? '#fff' : 'var(--txt2)',
            fontWeight: p.id === period ? FW.semibold : FW.normal, transition: 'all 130ms',
          }}>{p.label}</button>
        ))}
      </div>
    </div>
  )

  return (
    <Page
      title="Card Transaction Report"
      subtitle="Interswitch CCS: channel volume by period"
      back={{ label: 'Interswitch', to: '/settlements/interswitch' }}
      actions={filterBar}
      loading={loading && !data}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={() => load(year, period)} />

      {data && data.source && data.source !== 'live' && (
        <div style={{
          padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[4], borderRadius: RADIUS.lg,
          background: `${AMBER}0F`, border: `1px solid ${AMBER}33`,
          fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER,
        }}>
          <strong>Sample figures, not live data.</strong> No transactions were found in the
          ledger for this period, so the report is showing the API's built-in example
          months. Do not use these numbers.
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : !data ? null : (
        <>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: SP[3], marginBottom: SP[5] }}>
            <KpiCard label="Total Volume (₦)"      value={fmtKoboExact(data.totals.total)}                                      accent={NAVY}  />
            <KpiCard label="Web Transfer Share" value={fmtPct(data.totals.web_pct)}                              accent={AMBER} sub="of total volume" />
            <KpiCard label="Monthly Average"   value={fmtKoboExact(Math.round(data.totals.total / data.months.length))}     accent={BLUE}  />
            <KpiCard label="Peak Month"        value={peakMonth?.month ?? '—'}                                         accent={RED}   sub={peakMonth ? fmtKoboExact(peakMonth.total) : undefined} />
            <KpiCard label="USD Cards" value={fmtUsdCents(data.totals.usd ?? 0)} accent={GREEN} sub="in dollars · not in the total" />
          </div>

          {/* Stacked bar */}
          <SectionCard
            title="Monthly Volume by Channel"
            subtitle={`${year} · ${PERIODS.find(p => p.id === period)?.label} · stacked by channel`}
            style={{ marginBottom: SP[4] }}
          >
            <EBar<MonthRow>
              data={data.months.map(m => ({ ...m, month: m.month.slice(0, 3) }))}
              xKey="month"
              series={CH.map(c => ({ key: c.key, name: c.label, color: c.color }))}
              stack
              height={280}
              valueFmt={(v) => fmtKoboExact(v)}
              axisFmt={fmtAxis}
            />
          </SectionCard>

          {/* Monthly table */}
          <SectionCard title="Monthly Breakdown" subtitle="Naira cards in naira. USD cards are posted in dollars, so they have their own column outside the total." style={{ marginBottom: SP[4] }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    <Th>Month</Th>
                    {CH.map(c => <Th key={c.key} right>{c.label}</Th>)}<Th right>Total</Th><Th right>USD Cards ($)</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map(row => {
                    const isPeak = peakMonth?.month === row.month
                    return (
                      <tr key={row.month} style={{ borderBottom: '1px solid var(--bdr)' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                        <td style={{ padding: '11px 14px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>
                          {row.month} {year}
                        </td>
                        {CH.map(({ key: ch }) => (
                          <td key={ch} style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>
                            {fmtKoboExact(row[ch])}
                          </td>
                        ))}
                        <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: isPeak ? RED : 'var(--txt)' }}>
                          {fmtKoboExact(row.total)}
                          {isPeak && <span style={{ fontSize: TEXT.xs, color: RED, marginLeft: 6 }}>peak</span>}
                        </td>
                        <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                          {fmtUsdCents(row.usd ?? 0)}
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ background: 'var(--th-bg)', borderTop: '2px solid var(--bdr)' }}>
                    <td style={{ padding: '11px 14px', fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Total</td>
                    {CH.map(({ key: ch }) => (
                      <td key={ch} style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>
                        {fmtKoboExact(data.totals[ch])}
                      </td>
                    ))}
                    <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.extrabold, color: NAVY }}>
                      {fmtKoboExact(data.totals.total)}
                    </td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt2)' }}>
                      {fmtUsdCents(data.totals.usd ?? 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* Channel cards */}
          <SectionCard title="Channel Summary" subtitle="Volume share and monthly average for selected period">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: SP[3] }}>
              {CH.map(c => {
                const vol = data.totals[c.key] ?? 0
                const pct = data.totals[`${c.key}_pct`] ?? 0
                const avg = data.totals[`${c.key}_avg`] ?? 0
                return (
                  <div key={c.key} style={{ padding: SP[4], borderRadius: RADIUS.lg, border: `1px solid ${c.color}20`, background: `${c.color}08` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[2] }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: c.color }} />
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: INTER }}>{c.label}</span>
                    </div>
                    <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', ...NUM, lineHeight: 1.1, marginBottom: SP[1] }}>{fmtKoboExact(vol)}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                      <span style={{ fontWeight: FW.bold, color: c.color }}>{pct.toFixed(2)}%</span> of period total
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>
                      Avg/month: {fmtKoboExact(avg)}
                    </div>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        </>
      )}
    </Page>
  )
}
