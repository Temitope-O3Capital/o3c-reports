import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { PeriodFilter, Tip, Stat, Note, ytick, type Period } from './shared'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecCards {
  period: { type: string; start: string; end: string }
  total_cards: number
  active_cards: number
  activation_rate_pct: number

  // Billing-cycle position. Gross and net are distinct facts — see the note on the
  // book section below.
  cycle_date: string
  cycle_accounts: number
  credit_book_kobo: number        // net
  gross_receivable_kobo: number
  debit_accounts: number
  credit_balance_kobo: number     // negative
  credit_accounts: number
  credit_limit_kobo: number
  utilisation_pct: number
  overdue_kobo: number
  overdue_accounts: number
  over_limit_accounts: number
  delinquency_pct: number
  min_payment_kobo: number
  cycle_interest_kobo: number
  cycle_fees_kobo: number

  // Period activity.
  spend_kobo: number
  spend_change_pct: number
  repayments_kobo: number
  interest_kobo: number
  fees_kobo: number
  revenue_kobo: number
  txn_count: number

  category_mix: { category: string; volume_kobo: number; count: number }[]
  monthly_trend: { month: string; spend_kobo: number; repayments_kobo: number; interest_kobo: number; txn_count: number }[]
  top_merchants: { name: string; volume_kobo: number; count: number }[]
  disputes_open: number
  disputes_resolved_mtd: number
}

// Categorical hues assigned in fixed order and never cycled, so a category keeps its
// colour when the mix changes shape between periods.
const CAT_COLOR: Record<string, string> = {
  Spend: NAVY, Repayments: GREEN, Interest: AMBER, Fees: BLUE, Other: '#94A3B8',
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ExecCards() {
  const [data, setData] = useState<ExecCards | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecCards }>(`/api/executive/cards?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Cards — Executive View'
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

  const totalMerchantVol = data.top_merchants.reduce((s, m) => s + m.volume_kobo, 0) || 1
  const netSpend = data.spend_kobo - data.repayments_kobo
  // Feed gaps are relative, not absolute. Nov 25 loaded 1 transaction and May 26
  // loaded 5 against a ~4,000/month norm — testing for exactly zero would call those
  // months real and let a missing feed read as a collapse in card activity. Anything
  // under a tenth of the median month is a gap.
  const counts = data.monthly_trend.map(m => m.txn_count).sort((a, b) => a - b)
  const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0
  const gapMonths = median > 0
    ? data.monthly_trend.filter(m => m.txn_count < median * 0.1).map(m => m.month)
    : []

  return (
    <Page title={title} back={back} actions={actions}>

      {/* ── What it earned ─────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Revenue (interest + fees)" value={fmtKobo(data.revenue_kobo)} icon="payments" accent={GREEN} />
        <KpiCard label="Card Spend" value={fmtKobo(data.spend_kobo)} change={data.spend_change_pct} icon="shopping_bag" accent={NAVY} />
        <KpiCard label="Repayments" value={fmtKobo(data.repayments_kobo)} icon="savings" accent={BLUE} />
        <KpiCard label="Active Cards" value={fmtNum(data.active_cards)} icon="credit_card" accent={AMBER} />
      </div>

      {/* ── The book ───────────────────────────────────────────────────────── */}
      <SectionCard
        title="Credit Book"
        subtitle={data.cycle_date ? `Billing cycle ${data.cycle_date} · ${fmtNum(data.cycle_accounts)} accounts` : 'No billing cycle loaded'}
        style={{ marginBottom: 14 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[5], marginBottom: SP[4] }}>
          <Stat label="Gross Receivable" value={fmtKobo(data.gross_receivable_kobo)} sub={`${fmtNum(data.debit_accounts)} accounts owing`} />
          <Stat label="Customer Credit" value={fmtKobo(Math.abs(data.credit_balance_kobo))} sub={`${fmtNum(data.credit_accounts)} in credit`} tone={BLUE} />
          <Stat label="Net Book" value={fmtKobo(data.credit_book_kobo)} sub="gross less credit balances" />
          <Stat
            label="Overdue"
            value={fmtKobo(data.overdue_kobo)}
            sub={`${fmtNum(data.overdue_accounts)} accounts · ${fmtPct(data.delinquency_pct)} of gross`}
            tone={data.delinquency_pct > 10 ? RED : 'var(--txt)'}
          />
          <Stat
            label="Utilisation"
            value={fmtPct(data.utilisation_pct)}
            sub={`limit ${fmtKobo(data.credit_limit_kobo)} · ${fmtNum(data.over_limit_accounts)} over limit`}
            tone={data.utilisation_pct > 100 ? RED : 'var(--txt)'}
          />
        </div>

        {/* The numbers above are unusual enough that an exec will assume a bug unless
            the page explains itself. Both conditions are read from the data, never
            hardcoded, so these notes disappear once the underlying position improves. */}
        {data.credit_accounts > data.debit_accounts && (
          <Note>
            <b>Most cards sit in credit.</b> {fmtNum(data.credit_accounts)} of {fmtNum(data.cycle_accounts)} accounts
            carry a credit balance totalling {fmtKobo(Math.abs(data.credit_balance_kobo))} — customers ahead of their
            card. A single netted "book" figure hides this, which is why gross and net are shown separately:
            gross is credit exposure, the credit balance is a liability owed back.
          </Note>
        )}
        {data.delinquency_pct > 50 && (
          <div style={{ marginTop: SP[3] }}>
            <Note tone={RED}>
              <b>Delinquency is {fmtPct(data.delinquency_pct)} of gross receivables</b> ({fmtKobo(data.overdue_kobo)} across{' '}
              {fmtNum(data.overdue_accounts)} accounts), and {fmtNum(data.over_limit_accounts)} accounts are drawn beyond
              their limit. Worth confirming against the card system before this is reported externally — a rate this
              high is either a serious collections position or a cycle-file mapping problem.
            </Note>
          </div>
        )}
      </SectionCard>

      {/* ── Where the money moved ──────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Activity Mix" subtitle="By value this period">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.category_mix} margin={{ top: 4, right: 8, bottom: 14, left: 8 }} layout="vertical">
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
              <XAxis type="number" tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="category" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} width={82} />
              <Tooltip content={<Tip fmt={fmtKobo} />} cursor={{ fill: 'var(--row-hvr)' }} />
              <Bar dataKey="volume_kobo" name="Value" radius={[0, 4, 4, 0]} barSize={18}>
                {data.category_mix.map(entry => (
                  <Cell key={entry.category} fill={CAT_COLOR[entry.category] ?? CAT_COLOR.Other} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="12-Month Trend" subtitle="Spend, repayments and interest">
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.monthly_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
              <defs>
                {[['spend', NAVY], ['repayments', GREEN], ['interest', AMBER]].map(([k, c]) => (
                  <linearGradient key={k} id={`cgrad_${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={c} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
              <YAxis width={70} tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip fmt={fmtKobo} />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt2)' }} />
              {([['spend_kobo', 'Spend', NAVY], ['repayments_kobo', 'Repayments', GREEN], ['interest_kobo', 'Interest', AMBER]] as const).map(([k, label, c]) => (
                <Area key={k} type="monotone" dataKey={k} name={label} stroke={c} strokeWidth={2} fill={`url(#cgrad_${k.replace('_kobo', '')})`}
                  dot={{ r: 2, fill: c, strokeWidth: 0 }} activeDot={{ r: 4, fill: c, stroke: '#fff', strokeWidth: 2 }} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          {gapMonths.length > 0 && (
            <div style={{ marginTop: SP[2] }}>
              <Note tone={AMBER}>
                No transactions loaded for <b>{gapMonths.join(', ')}</b>. Those months are plotted at zero rather than
                skipped, so the dip is a feed gap and not a real collapse in card activity.
              </Note>
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Who they paid, and what is stuck ───────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: SP[3] }}>
        <SectionCard title="Top Merchants" subtitle="Card spend this period">
          {data.top_merchants.length === 0 ? (
            <Note>
              No merchant-tagged spend in this period. Merchant names arrive on the Interswitch-decoded
              history; the going-forward feed does not carry them, so this table fills only for periods
              covered by that history.
            </Note>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Merchant', 'Spend', 'Transactions', '% of Top 10'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Merchant' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.top_merchants.slice(0, 8).map((m, i) => (
                  <tr key={m.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 28, height: 28, borderRadius: RADIUS.md, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, fontFamily: INTER, flexShrink: 0 }}>{i + 1}</div>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', fontFamily: SORA }}>{m.name}</span>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(m.volume_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(m.count)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtPct((m.volume_kobo / totalMerchantVol) * 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="This Period">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <Stat label="Net Lending" value={fmtKobo(netSpend)} sub={netSpend > 0 ? 'spend exceeded repayments' : 'repayments exceeded spend'} tone={netSpend > 0 ? AMBER : GREEN} />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Transactions" value={fmtNum(data.txn_count)} sub={`${fmtPct(data.activation_rate_pct)} of cards active`} />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat
                label="Open Disputes"
                value={fmtNum(data.disputes_open)}
                sub={data.disputes_open === 0 ? 'none logged' : `${fmtNum(data.disputes_resolved_mtd)} resolved this period`}
                tone={data.disputes_open > 5 ? RED : 'var(--txt)'}
              />
            </div>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
