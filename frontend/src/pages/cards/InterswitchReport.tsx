import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { EBar } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthRow {
  month: string
  atm: number; pos: number; web: number; transfer: number; total: number
}

interface ReportData {
  period_label: string
  generated_at: string
  months: MonthRow[]
  totals: {
    atm: number; pos: number; web: number; transfer: number; total: number
    atm_pct: number; pos_pct: number; web_pct: number; transfer_pct: number
    atm_avg: number; pos_avg: number; web_avg: number; transfer_avg: number
  }
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

const CH = [
  { key: 'atm',      label: 'ATM',      color: NAVY   },
  { key: 'pos',      label: 'POS',      color: BLUE   },
  { key: 'web',      label: 'WEB',      color: AMBER  },
  { key: 'transfer', label: 'Transfer', color: GREEN  },
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

  const fmtAxis = (v: number) => {
    if (v >= 1e10) return `₦${(v / 1e10).toFixed(0)}B`
    if (v >= 1e7)  return `₦${(v / 1e7).toFixed(0)}M`
    if (v >= 1e4)  return `₦${(v / 1e4).toFixed(0)}K`
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

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div>
      ) : !data ? null : (
        <>
          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[5] }}>
            <KpiCard label="Total Volume"      value={fmtKoboExact(data.totals.total)}                                      accent={NAVY}  />
            <KpiCard label="Transfer Share"    value={fmtPct(data.totals.transfer_pct / 100)}                          accent={GREEN} sub="of total volume" />
            <KpiCard label="Monthly Average"   value={fmtKoboExact(Math.round(data.totals.total / data.months.length))}     accent={BLUE}  />
            <KpiCard label="Peak Month"        value={peakMonth?.month ?? '—'}                                         accent={RED}   sub={peakMonth ? fmtKoboExact(peakMonth.total) : undefined} />
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
          <SectionCard title="Monthly Breakdown" subtitle="All amounts in Naira" style={{ marginBottom: SP[4] }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    <Th>Month</Th>
                    <Th right>ATM</Th><Th right>POS</Th><Th right>WEB</Th><Th right>Transfer</Th><Th right>Total</Th>
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
                        {(['atm','pos','web','transfer'] as const).map(ch => (
                          <td key={ch} style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }}>
                            {fmtKoboExact(row[ch])}
                          </td>
                        ))}
                        <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: isPeak ? RED : 'var(--txt)' }}>
                          {fmtKoboExact(row.total)}
                          {isPeak && <span style={{ fontSize: TEXT.xs, color: RED, marginLeft: 6 }}>peak</span>}
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ background: 'var(--th-bg)', borderTop: '2px solid var(--bdr)' }}>
                    <td style={{ padding: '11px 14px', fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Total</td>
                    {(['atm','pos','web','transfer'] as const).map(ch => (
                      <td key={ch} style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>
                        {fmtKoboExact(data.totals[ch])}
                      </td>
                    ))}
                    <td style={{ padding: '11px 14px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.extrabold, color: NAVY }}>
                      {fmtKoboExact(data.totals.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* Channel cards */}
          <SectionCard title="Channel Summary" subtitle="Volume share and monthly average for selected period">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3] }}>
              {CH.map(c => {
                const vol = data.totals[c.key]
                const pct = data.totals[`${c.key}_pct` as keyof typeof data.totals] as number
                const avg = data.totals[`${c.key}_avg` as keyof typeof data.totals] as number
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
