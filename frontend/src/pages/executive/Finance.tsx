import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { PeriodFilter, Tip, Stat, Note, ytick, share, type Period } from './shared'

interface ExecFinance {
  period: { type: string; start: string; end: string }

  // Whether a real general ledger exists behind this page.
  gl_available: boolean
  gl_entry_count: number

  // Operating picture assembled from the card and deposit books.
  operating_revenue_kobo: number
  operating_cost_kobo: number
  operating_net_kobo: number
  operating_margin_pct: number
  card_interest_kobo: number
  card_interest_change_pct: number
  card_fees_kobo: number
  fd_period_cost_kobo: number
  fd_accrued_to_date_kobo: number
  fd_avg_rate_pct: number
  processing_fees_kobo: number
  period_days: number

  fd_book_kobo: number
  fd_count: number
  fd_maturing_30d: number
  paystack_wallet_kobo: number

  revenue_breakdown: { source: string; amount_kobo: number }[]
  cost_breakdown: { source: string; amount_kobo: number }[]
  monthly_pnl: { month: string; interest_kobo: number; fees_kobo: number; revenue_kobo: number }[]
}

export default function ExecFinance() {
  const [data, setData] = useState<ExecFinance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('l30d')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecFinance }>(`/api/executive/finance?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Finance — Executive View'
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

  const loss = data.operating_net_kobo < 0
  const costTotal = data.cost_breakdown.reduce((s, c) => s + c.amount_kobo, 0) || 1
  const revTotal = data.revenue_breakdown.reduce((s, c) => s + c.amount_kobo, 0) || 1

  return (
    <Page title={title} back={back} actions={actions}>

      {!data.gl_available && (
        <div style={{ marginBottom: 14 }}>
          <Note tone={AMBER}>
            <b>This is not the general ledger.</b> No journal entries have been posted, so a GL-based P&amp;L
            cannot be produced. What follows is an operating picture assembled from sources that do have data —
            card interest and fees from posted transactions, deposit funding cost from the FD register, and
            processing fees from the payment provider. It is useful for direction and scale. It is not
            accounting-grade and should not be used for statutory reporting.
          </Note>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Operating Revenue" value={fmtKobo(data.operating_revenue_kobo)} change={data.card_interest_change_pct} icon="trending_up" accent={GREEN} />
        <KpiCard label="Operating Cost" value={fmtKobo(data.operating_cost_kobo)} icon="trending_down" accent={AMBER} />
        <KpiCard label={loss ? 'Operating Deficit' : 'Operating Surplus'} value={fmtKobo(Math.abs(data.operating_net_kobo))} icon={loss ? 'warning' : 'account_balance'} accent={loss ? RED : GREEN} />
        <KpiCard label="Deposit Book" value={fmtKobo(data.fd_book_kobo)} icon="savings" accent={NAVY} />
      </div>

      {loss && (
        <div style={{ marginBottom: 14 }}>
          <Note tone={RED}>
            <b>Funding cost exceeds visible income by {fmtKobo(Math.abs(data.operating_net_kobo))} over {fmtNum(data.period_days)} days.</b>{' '}
            Deposits cost roughly {fmtKobo(data.fd_period_cost_kobo)} for the period at an average rate of{' '}
            {fmtPct(data.fd_avg_rate_pct)}, against {fmtKobo(data.operating_revenue_kobo)} of card income. This does
            not mean the business is losing money — it means the income earned on deposit funds is not visible in
            this workspace. Treasury, investment and interbank returns are not mirrored here, so the earning side of
            the deposit book is missing rather than absent. Connecting that source is what would make this page a
            genuine P&amp;L.
          </Note>
        </div>
      )}

      {/* ── Where income comes from, and what it costs ────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Revenue" subtitle="Sources with a live feed">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            {data.revenue_breakdown.map(rb => (
              <div key={rb.source}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{rb.source}</span>
                  <span style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(rb.amount_kobo)}</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${share(rb.amount_kobo, revTotal)}%`, height: '100%', borderRadius: 4, background: GREEN }} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Cost" subtitle="What the money costs to hold and move">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            {data.cost_breakdown.map(cb => (
              <div key={cb.source}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{cb.source}</span>
                  <span style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(cb.amount_kobo)}</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${share(cb.amount_kobo, costTotal)}%`, height: '100%', borderRadius: 4, background: AMBER }} />
                </div>
              </div>
            ))}
            <Note>
              Deposit interest is <b>estimated</b> — principal × contract rate × {fmtNum(data.period_days)}/365 —
              because the FD register stores interest accrued to date, not per period. Accrued to date across the
              whole book is {fmtKobo(data.fd_accrued_to_date_kobo)}.
            </Note>
          </div>
        </SectionCard>
      </div>

      {/* ── Card income history ───────────────────────────────────────────── */}
      <SectionCard title="Card Income" subtitle="Interest and fees, last 12 months" style={{ marginBottom: 14 }}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data.monthly_pnl} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
            <defs>
              {[['interest', GREEN], ['fees', BLUE]].map(([k, c]) => (
                <linearGradient key={k} id={`fgrad_${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={c} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
            <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis width={70} tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip fmt={fmtKobo} />} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt2)' }} />
            <Area type="monotone" dataKey="interest_kobo" name="Interest" stroke={GREEN} strokeWidth={2} fill="url(#fgrad_interest)" dot={{ r: 2, fill: GREEN, strokeWidth: 0 }} activeDot={{ r: 4, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} stackId="1" />
            <Area type="monotone" dataKey="fees_kobo" name="Fees" stroke={BLUE} strokeWidth={2} fill="url(#fgrad_fees)" dot={{ r: 2, fill: BLUE, strokeWidth: 0 }} activeDot={{ r: 4, fill: BLUE, stroke: '#fff', strokeWidth: 2 }} stackId="1" />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* ── Balance sheet position ────────────────────────────────────────── */}
      <SectionCard title="Position" subtitle="Deposit book and available cash">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[5] }}>
          <Stat label="Deposit Book" value={fmtKobo(data.fd_book_kobo)} sub={`${fmtNum(data.fd_count)} active deposits`} />
          <Stat label="Average Rate" value={fmtPct(data.fd_avg_rate_pct)} sub="contract rate" tone={AMBER} />
          <Stat label="Accrued Interest" value={fmtKobo(data.fd_accrued_to_date_kobo)} sub="owed to depositors" tone={AMBER} />
          <Stat label="Maturing 30d" value={fmtNum(data.fd_maturing_30d)} sub="deposits due" />
          <Stat label="Paystack Wallet" value={fmtKobo(data.paystack_wallet_kobo)} sub="available now" />
        </div>
      </SectionCard>
    </Page>
  )
}
