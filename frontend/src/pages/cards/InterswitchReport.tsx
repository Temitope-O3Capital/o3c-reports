import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, KpiCard, ErrBanner, DataTable, EmptyState,
  SegmentedToggle, Select, Badge, Button,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { EBar } from '../../components/echarts'

/*
  HALF-YEAR TRANSACTION REPORT

  This reproduces the report Card Operations actually publishes — four channels
  (ATM, POS, WEB, TRANSFER), a month per row, then a second table giving each
  channel's share and monthly average. H1 2026 came to ₦1,152,328,603.86 with
  TRANSFER at 71.37%. Column for column, that is the document below.

  TRANSFER is the column that was never sourced correctly. It is not a card
  transaction at all — it is mobile app transfers, from Paystack — and the match is
  exact: January ₦55,154,030.00, February ₦63,714,686.92 and April ₦95,336,116.55
  agree with the published report to the kobo. Earlier versions carried it as
  "Other" because nothing in the card ledger could produce it.

  THE CRASH THIS FIXES. The page read `data?.months.reduce(...)`, where the `?.`
  guarded `data` but not `months`. For H1 2026 the API returned `months: null` —
  six stray CCS rows dated 2026-09-23 made the year look live, which skipped the
  static fallback, and then the H1 filter removed September and left nothing — so
  the page died on `null.reduce`. The API now always returns one row per month in
  the period, and this page treats an empty period as a state rather than a bug.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface MonthRow {
  month: string
  short: string
  atm: number; pos: number; web: number; transfer: number
  total: number
  ccs_rows: number
  ps_rows: number
}

interface ChannelRow {
  key: string
  label: string
  total_kobo: number
  pct: number
  avg_kobo: number
  source: string
  note: string
  sourced: boolean
}

interface CoverageRow {
  src: string
  rows_in_period: number
  days_in_period: number
  last_day: string | null
}

interface ReportData {
  period_label: string
  period: string
  year: string
  from: string
  to: string
  generated_at: string
  months: MonthRow[]
  channels: ChannelRow[]
  totals: {
    total_kobo: number; avg_monthly_kobo: number; months_n: number
    atm: number; pos: number; web: number; transfer: number
  }
  coverage: CoverageRow[]
  complete: boolean
  note: string
}

const PERIODS = [
  { value: 'H1', label: 'H1' }, { value: 'H2', label: 'H2' },
  { value: 'Q1', label: 'Q1' }, { value: 'Q2', label: 'Q2' },
  { value: 'Q3', label: 'Q3' }, { value: 'Q4', label: 'Q4' },
  { value: 'FY', label: 'Full Year' },
]

const PERIOD_NAME: Record<string, string> = {
  H1: 'January – June', H2: 'July – December',
  Q1: 'January – March', Q2: 'April – June',
  Q3: 'July – September', Q4: 'October – December',
  FY: 'January – December',
}

const CH_COLOR: Record<string, string> = {
  atm: NAVY, pos: BLUE, web: AMBER, transfer: GREEN,
}

const SOURCE_LABEL: Record<string, string> = {
  ccs: 'CCS card system', paystack: 'Paystack (mobile app)',
}

function nairaAxis(v: number) {
  if (v >= 1e11) return `₦${(v / 1e11).toFixed(1)}B`
  if (v >= 1e8)  return `₦${(v / 1e8).toFixed(0)}M`
  if (v >= 1e5)  return `₦${(v / 1e5).toFixed(0)}K`
  return v === 0 ? '0' : ''
}

/*
  The narrative, generated from the figures on screen.

  Card Operations writes this paragraph by hand every half-year. It is entirely
  derivable from the table above it — the ranking, the shares, the monthly spread
  and the outlier month — so it is generated, and the numbers in the prose can
  never drift from the numbers in the table the way a hand-typed summary does.
*/
function Narrative({ d }: { d: ReportData }) {
  const ranked = [...(d.channels ?? [])].sort((a, b) => Number(b.total_kobo) - Number(a.total_kobo))
  const months = d.months ?? []
  if (!ranked.length || !months.length) return null

  const top = ranked[0]
  const second = ranked[1]
  const last = ranked[ranked.length - 1]

  // The outlier month: furthest above the median, which is what their own
  // narrative calls out ("May recorded a significant increase … because of LIRS").
  const totals = months.map(m => Number(m.total)).sort((a, b) => a - b)
  const median = totals[Math.floor(totals.length / 2)] || 0
  const peak = months.reduce((a, b) => Number(b.total) > Number(a.total) ? b : a, months[0])
  const peakIsOutlier = median > 0 && Number(peak.total) > median * 1.8

  const ordinary = months.filter(m => m !== peak).map(m => Number(m.total))
  const lo = ordinary.length ? Math.min(...ordinary) : 0
  const hi = ordinary.length ? Math.max(...ordinary) : 0

  return (
    <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', lineHeight: 1.75 }}>
      <p style={{ margin: `0 0 ${SP[3]}` }}>
        The {d.period === 'FY' ? 'Full Year' : d.period} Transaction Report for{' '}
        <strong style={{ color: 'var(--txt)' }}>{PERIOD_NAME[d.period] ?? d.period} {d.year}</strong>{' '}
        indicates a total transaction value of{' '}
        <strong style={{ color: 'var(--txt)' }}>{fmtKoboExact(d.totals.total_kobo)}</strong> across{' '}
        {ranked.length} channels, with an average monthly value of{' '}
        <strong style={{ color: 'var(--txt)' }}>{fmtKoboExact(d.totals.avg_monthly_kobo)}</strong>.
      </p>
      <p style={{ margin: `0 0 ${SP[3]}` }}>
        <strong style={{ color: 'var(--txt)' }}>{top.label}</strong> recorded the highest performance at{' '}
        {fmtKoboExact(top.total_kobo)}, representing{' '}
        <strong style={{ color: 'var(--txt)' }}>{Number(top.pct).toFixed(2)}%</strong> of all transactions.
        {second && <> {second.label} ranked second, contributing {fmtKoboExact(second.total_kobo)}{' '}
          ({Number(second.pct).toFixed(2)}%).</>}
        {last && last !== top && <> {last.label} recorded the lowest value at {fmtKoboExact(last.total_kobo)},{' '}
          representing {Number(last.pct).toFixed(2)}% of the total.</>}
      </p>
      {peakIsOutlier ? (
        <p style={{ margin: 0 }}>
          Monthly performance stayed between {fmtKoboExact(lo)} and {fmtKoboExact(hi)} for most of the
          period, but <strong style={{ color: 'var(--txt)' }}>{peak.month}</strong> rose sharply to{' '}
          <strong style={{ color: 'var(--txt)' }}>{fmtKoboExact(peak.total)}</strong> — worth a note on
          the cause when this is circulated.
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          Monthly performance ranged from {fmtKoboExact(Math.min(...months.map(m => Number(m.total))))} to{' '}
          {fmtKoboExact(Math.max(...months.map(m => Number(m.total))))}, with{' '}
          <strong style={{ color: 'var(--txt)' }}>{peak.month}</strong> the strongest month.
        </p>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InterswitchReport() {
  const thisYear = new Date().getFullYear()
  const YEARS = useMemo(
    () => Array.from({ length: 4 }, (_, i) => String(thisYear - i)), [thisYear])

  const [year, setYear]   = useState(String(thisYear))
  const [period, setPer]  = useState('H1')
  const [data, setData]   = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (y: string, p: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ReportData }>(
        `/api/cards/interswitch/half-year?year=${y}&period=${p}`)
      setData(r.data)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the transaction report')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load(year, period) }, [load, year, period])

  // Every derived value tolerates a missing or empty months array. See the note
  // at the top of the file — this is exactly where the page used to crash.
  const months   = data?.months ?? []
  const channels = data?.channels ?? []
  const totals   = data?.totals
  const hasRows  = months.length > 0
  const anyValue = Number(totals?.total_kobo ?? 0) > 0

  const topChannel = useMemo(() => {
    if (!channels.length) return null
    return [...channels].sort((a, b) => Number(b.total_kobo) - Number(a.total_kobo))[0]
  }, [channels])

  const peakMonth = useMemo(() => {
    if (!hasRows) return null
    return months.reduce((a, b) => Number(b.total) > Number(a.total) ? b : a, months[0])
  }, [months, hasRows])

  // ── Table 1: the monthly matrix, exactly as published ───────────────────────
  const monthCols: TableCol<MonthRow & { sn: number }>[] = [
    { key: 'sn', label: 'SN', width: 54,
      render: m => <span style={{ ...NUM, color: 'var(--txt3)' }}>{m.sn}</span> },
    { key: 'month', label: 'Month', width: 120,
      render: m => <span style={{ fontWeight: FW.semibold }}>{m.month}</span> },
    { key: 'atm', label: 'ATM', align: 'right', sortable: true,
      render: m => <span style={NUM}>{fmtKoboExact(m.atm)}</span> },
    { key: 'pos', label: 'POS', align: 'right', sortable: true,
      render: m => <span style={NUM}>{fmtKoboExact(m.pos)}</span> },
    { key: 'web', label: 'WEB', align: 'right', sortable: true,
      render: m => <span style={NUM}>{fmtKoboExact(m.web)}</span> },
    { key: 'transfer', label: 'TRANSFER', align: 'right', sortable: true,
      render: m => <span style={NUM}>{fmtKoboExact(m.transfer)}</span> },
    { key: 'total', label: 'TOTAL', align: 'right', sortable: true,
      render: m => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKoboExact(m.total)}</span> },
  ]

  const monthRows = useMemo(
    () => months.map((m, i) => ({ ...m, sn: i + 1 })), [months])

  // ── Table 2: per channel, with share and monthly average ────────────────────
  const channelCols: TableCol<ChannelRow>[] = [
    { key: 'label', label: 'Transaction Type', render: c => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <span aria-hidden="true" style={{
          width: 9, height: 9, borderRadius: 2, background: CH_COLOR[c.key] ?? 'var(--txt3)',
        }} />
        <span style={{ fontWeight: FW.semibold }}>{c.label}</span>
        {!c.sourced && <Badge variant="warning">no source</Badge>}
      </span>
    ) },
    { key: 'total_kobo', label: 'Total Amount', align: 'right', sortable: true,
      render: c => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(c.total_kobo)}</span> },
    { key: 'pct', label: 'Percentage (%)', align: 'right', sortable: true, width: 140,
      render: c => {
        const p = Number(c.pct ?? 0)
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2], justifyContent: 'flex-end' }}>
            <span aria-hidden="true" style={{
              width: 44, height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden',
            }}>
              <span style={{
                display: 'block', height: '100%', width: `${Math.min(p, 100)}%`,
                background: CH_COLOR[c.key] ?? 'var(--txt3)',
              }} />
            </span>
            <span style={{ ...NUM, fontWeight: FW.semibold, minWidth: 48, textAlign: 'right' }}>
              {p.toFixed(2)}
            </span>
          </span>
        )
      } },
    { key: 'avg_kobo', label: 'Average (Monthly)', align: 'right', sortable: true,
      render: c => <span style={NUM}>{fmtKoboExact(c.avg_kobo)}</span> },
    { key: 'source', label: 'Source', width: 185, render: c => (
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }} title={c.note}>
        {SOURCE_LABEL[c.source] ?? c.source}
      </span>
    ) },
  ]

  return (
    <Page
      title="Transaction Report"
      subtitle="ATM, POS, WEB and app transfers by month — the published half-year report"
      loading={loading && !data}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          <SegmentedToggle<string> value={period} onChange={setPer} options={PERIODS} />
          <Select value={year} onChange={e => setYear(e.target.value)} style={{ width: 104 }}>
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </Select>
          <Button size="sm" variant="secondary" icon="print" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load(year, period)} />

      {/* Coverage honesty. A total that silently omits three of four channels is
          not a smaller total, it is a wrong one — so this sits above the figures,
          not in a footnote. */}
      {data && !data.complete && data.note && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>warning</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              This period is not fully sourced
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              {data.note}
            </div>
            {data.coverage?.length > 0 && (
              <div style={{ display: 'flex', gap: SP[5], flexWrap: 'wrap', marginTop: SP[3] }}>
                {data.coverage.map(c => (
                  <div key={c.src}>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      {SOURCE_LABEL[c.src] ?? c.src}
                    </div>
                    <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {fmtNum(c.rows_in_period)} rows · {fmtNum(c.days_in_period)} days
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      {c.last_day ? `last sent ${fmtDate(c.last_day)}` : 'never sent'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        <KpiCard label="Total Transaction Value" value={fmtKoboExact(totals?.total_kobo)}
          sub={`${PERIOD_NAME[period] ?? period} ${year} · ${fmtNum(totals?.months_n)} months`}
          icon="payments" accent={NAVY} loading={loading && !data} />
        <KpiCard label="Monthly Average" value={fmtKoboExact(totals?.avg_monthly_kobo)}
          sub="across the period" icon="timeline" accent={BLUE} loading={loading && !data} />
        <KpiCard label="Leading Channel" value={topChannel?.label ?? '—'}
          sub={topChannel ? `${fmtKoboExact(topChannel.total_kobo)} · ${Number(topChannel.pct).toFixed(2)}%` : 'no data'}
          icon="leaderboard" accent={topChannel ? (CH_COLOR[topChannel.key] ?? PURPLE) : NAVY}
          loading={loading && !data} />
        <KpiCard label="Strongest Month" value={peakMonth?.month ?? '—'}
          sub={peakMonth ? fmtKoboExact(peakMonth.total) : 'no data'}
          icon="trending_up" accent={GREEN} loading={loading && !data} />
      </div>

      {!hasRows && !loading ? (
        <SectionCard>
          <EmptyState icon="event_busy"
            title={`No months in ${period} ${year}`}
            description="Pick a different period or year." />
        </SectionCard>
      ) : !anyValue && !loading ? (
        <SectionCard>
          <EmptyState icon="database"
            title={`Nothing recorded for ${PERIOD_NAME[period] ?? period} ${year}`}
            description={data?.note || 'Neither the card system nor Paystack holds transactions for these dates.'} />
        </SectionCard>
      ) : (
        <>
          <SectionCard title="Monthly Transactions" padding={false} style={{ marginBottom: SP[4] }}
            subtitle={`${PERIOD_NAME[period] ?? period} ${year} · every figure is a naira debit total`}>
            <DataTable
              cols={monthCols} rows={monthRows} keyFn={m => m.month}
              loading={loading && !data} skeletonRows={6}
              emptyText={<EmptyState icon="event_busy" title="No months in this period" />}
            />
            {/* Totals row, rendered outside the table so sorting can never move it
                away from the bottom. */}
            {totals && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '54px 120px repeat(5, minmax(0, 1fr))',
                gap: 0, padding: '12px 14px', borderTop: '2px solid var(--bdr)',
                background: 'var(--th-bg)', fontWeight: FW.bold,
              }}>
                <span />
                <span style={{ fontSize: TEXT.sm }}>TOTAL</span>
                {([totals.atm, totals.pos, totals.web, totals.transfer, totals.total_kobo]).map((v, i) => (
                  <span key={i} style={{ ...NUM, textAlign: 'right', fontSize: TEXT.sm, paddingRight: 14 }}>
                    {fmtKoboExact(v)}
                  </span>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Channel Mix by Month" style={{ marginBottom: SP[4] }}
            subtitle="Stacked so the month total reads directly, and the channel driving it is visible">
            <EBar
              data={months.map(m => ({ ...m, label: m.short }))}
              xKey="label"
              stack
              height={280}
              valueFmt={fmtKoboExact}
              axisFmt={nairaAxis}
              series={[
                { key: 'atm',      name: 'ATM',      color: CH_COLOR.atm },
                { key: 'pos',      name: 'POS',      color: CH_COLOR.pos },
                { key: 'web',      name: 'WEB',      color: CH_COLOR.web },
                { key: 'transfer', name: 'TRANSFER', color: CH_COLOR.transfer },
              ] as any}
            />
          </SectionCard>

          <SectionCard title="Total per Channel, Share and Monthly Average" padding={false}
            style={{ marginBottom: SP[4] }}
            subtitle="The second table of the published report, with the feed each channel is read from">
            <DataTable
              cols={channelCols} rows={channels} keyFn={c => c.key}
              loading={loading && !data} skeletonRows={4}
              emptyText={<EmptyState icon="category" title="No channel data" />}
            />
            {totals && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: SP[4],
                padding: '12px 18px', borderTop: '2px solid var(--bdr)',
                background: 'var(--th-bg)', fontWeight: FW.bold, flexWrap: 'wrap',
              }}>
                <span style={{ fontSize: TEXT.sm }}>TOTAL</span>
                <span style={{ ...NUM, fontSize: TEXT.sm, marginLeft: 'auto' }}>
                  {fmtKoboExact(totals.total_kobo)}
                </span>
                <span style={{ ...NUM, fontSize: TEXT.sm }}>100.00</span>
                <span style={{ ...NUM, fontSize: TEXT.sm }}>
                  {fmtKoboExact(totals.avg_monthly_kobo)}
                </span>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Summary"
            subtitle="Generated from the figures above, so the prose and the tables can never disagree">
            {data && <Narrative d={data} />}
          </SectionCard>
        </>
      )}
    </Page>
  )
}
