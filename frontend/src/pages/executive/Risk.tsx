import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { PeriodFilter, Tip, Stat, Note, ytick, share, type Period } from './shared'

interface ExecRisk {
  period: { type: string; start: string; end: string }

  // CBS loan book.
  portfolio_outstanding_kobo: number
  npl_rate_pct: number
  concentration_top10_pct: number
  avg_loan_size_kobo: number
  product_concentration: { product: string; count: number; outstanding_kobo: number }[]

  // Card book — the larger credit asset.
  card_exposure_kobo: number
  card_accounts: number
  card_overdue_kobo: number
  card_npl_pct: number
  card_top10_pct: number
  card_top50_pct: number
  card_products: { product: string; count: number; outstanding_kobo: number; overdue_kobo: number; delinquency_pct: number }[]

  // Funding.
  credit_assets_kobo: number
  fd_liability_kobo: number
  fd_count: number
  fd_maturing_30d_kobo: number
  fd_maturing_90d_kobo: number
  asset_coverage_pct: number
}

export default function ExecRisk() {
  const [data, setData] = useState<ExecRisk | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecRisk }>(`/api/executive/risk?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Risk: Executive View'
  const back = { label: 'Executive Overview', to: '/' }
  const actions = <PeriodFilter period={period} onChange={p => { setPeriod(p); load(p) }} />

  if (loading) return (
    <Page title={title} back={back} actions={actions}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back} actions={actions}>
      <ErrBanner error={error} onRetry={() => load(period)} />
    </Page>
  )
  if (!data) return null

  const totalOverdue = data.card_overdue_kobo
  const blendedNpl = share(totalOverdue, data.credit_assets_kobo)
  const cardShare = share(data.card_exposure_kobo, data.credit_assets_kobo)

  // Exposure by product line, as one comparable bar set.
  const exposure = [
    { line: 'Cards', value_kobo: data.card_exposure_kobo, tone: NAVY },
    { line: 'Loans', value_kobo: data.portfolio_outstanding_kobo, tone: BLUE },
    { line: 'FD (liability)', value_kobo: data.fd_liability_kobo, tone: AMBER },
  ]

  return (
    <Page title={title} back={back} actions={actions}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Credit Assets" value={fmtKobo(data.credit_assets_kobo)} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="FD Liability" value={fmtKobo(data.fd_liability_kobo)} icon="savings" accent={AMBER} />
        <KpiCard label="Blended NPL" value={fmtPct(blendedNpl)} icon="warning" accent={blendedNpl > 10 ? RED : GREEN} />
        <KpiCard label="Top 10 Concentration" value={fmtPct(data.card_top10_pct)} icon="donut_large" accent={data.card_top10_pct > 25 ? AMBER : GREEN} />
      </div>

      {/* ── Balance sheet shape ───────────────────────────────────────────── */}
      <SectionCard title="Exposure by Product Line" subtitle="Credit assets against deposit funding" style={{ marginBottom: 14 }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={exposure} margin={{ top: 4, right: 8, bottom: 4, left: 8 }} layout="vertical">
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
            <XAxis type="number" tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="line" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} width={104} />
            <Tooltip content={<Tip fmt={fmtKobo} />} cursor={{ fill: 'var(--row-hvr)' }} />
            <Bar dataKey="value_kobo" name="Value" radius={[0, 4, 4, 0]} barSize={30}>
              {exposure.map(e => <Cell key={e.line} fill={e.tone} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {data.asset_coverage_pct < 50 && data.fd_liability_kobo > 0 && (
          <Note tone={AMBER}>
            <b>Credit assets cover {fmtPct(data.asset_coverage_pct)} of deposit liabilities.</b>{' '}
            {fmtKobo(data.fd_liability_kobo)} is owed to {fmtNum(data.fd_count)} depositors against{' '}
            {fmtKobo(data.credit_assets_kobo)} of card and loan receivables. The difference is not necessarily a
            gap. Deposit funds may be held in treasury, investments or bank balances that this workspace does
            not yet mirror, but nothing in the data here accounts for it, so it cannot be confirmed from this
            page. {fmtKobo(data.fd_maturing_90d_kobo)} of it matures within 90 days.
          </Note>
        )}
      </SectionCard>

      {/* ── Where the credit risk sits ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Card Product Risk" subtitle="Delinquency by product code, worst value first">
          {data.card_products.length === 0 ? (
            <Note>No billing cycle loaded.</Note>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Product', 'Accounts', 'Outstanding', 'Overdue', 'Delinquency'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Product' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.card_products.map(p => (
                  <tr key={p.product} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{p.product}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(p.count)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.outstanding_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(p.overdue_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{
                        ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, fontFamily: INTER,
                        padding: '2px 8px', borderRadius: 99,
                        background: p.delinquency_pct >= 95 ? `${RED}1A` : p.delinquency_pct >= 50 ? `${AMBER}1A` : 'var(--chip-bg)',
                        color: p.delinquency_pct >= 95 ? RED : p.delinquency_pct >= 50 ? AMBER : 'var(--txt2)',
                      }}>{fmtPct(p.delinquency_pct)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.card_products.some(p => p.delinquency_pct >= 99) && (
            <div style={{ marginTop: SP[3] }}>
              <Note tone={RED}>
                Several product codes show <b>100% delinquency</b>: every naira outstanding is also flagged
                overdue. That is possible for a closed or written-off product line, but it is equally consistent
                with the cycle file setting overdue equal to the balance where no ageing was supplied. Worth
                confirming against the card system before this drives a provisioning decision.
              </Note>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Concentration">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <Stat label="Top 10 Card Accounts" value={fmtPct(data.card_top10_pct)} sub="of card receivables" tone={data.card_top10_pct > 25 ? AMBER : 'var(--txt)'} />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Top 50 Card Accounts" value={fmtPct(data.card_top50_pct)} sub="of card receivables" />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Top 10 Loans" value={fmtPct(data.concentration_top10_pct)} sub="of the loan book" tone={data.concentration_top10_pct > 50 ? RED : 'var(--txt)'} />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Cards as Share of Credit" value={fmtPct(cardShare)} sub={`${fmtNum(data.card_accounts)} card accounts owing`} />
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ── Loan book ─────────────────────────────────────────────────────── */}
      <SectionCard title="Loan Book" subtitle="CBS open book by product">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[5], marginBottom: SP[4] }}>
          <Stat label="Outstanding" value={fmtKobo(data.portfolio_outstanding_kobo)} />
          <Stat label="NPL Rate" value={fmtPct(data.npl_rate_pct)} tone={data.npl_rate_pct > 10 ? RED : 'var(--txt)'} />
          <Stat label="Average Loan" value={fmtKobo(data.avg_loan_size_kobo)} />
          <Stat label="FD Maturing 30d" value={fmtKobo(data.fd_maturing_30d_kobo)} sub="cash due to depositors" tone={AMBER} />
        </div>
        {data.product_concentration.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            {data.product_concentration.slice(0, 6).map(p => (
              <div key={p.product}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{p.product}</span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(p.outstanding_kobo)} · {fmtNum(p.count)}</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${share(p.outstanding_kobo, data.portfolio_outstanding_kobo)}%`, height: '100%', borderRadius: 3, background: BLUE }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
