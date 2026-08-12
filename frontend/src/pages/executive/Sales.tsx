import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { PeriodFilter, Tip, Stat, Note, ytick, share, type Period } from './shared'

interface ExecSales {
  period: { type: string; start: string; end: string }

  // Acquisition — what this business actually sells.
  new_accounts: number
  acquisition_change_pct: number
  new_deposits: number
  new_deposit_value_kobo: number
  acquisition_mix: { product_line: string; opened: number; total: number }[]
  acquisition_trend: { month: string; accounts: number; deposits: number; loans: number }[]

  // CBS loan book.
  pipeline_value_kobo: number
  pipeline_count: number
  conversions_mtd: number
  pipeline_stages: { stage: string; count: number; value_kobo: number }[]
  top_performers: { name: string; conversions: number; value_kobo: number }[]
}

const LINE_COLOR: Record<string, string> = {
  prepaid: NAVY, credit_card: RED, deposit: GREEN, other: BLUE, unclassified: '#94A3B8',
}
const LINE_LABEL: Record<string, string> = {
  prepaid: 'Prepaid', credit_card: 'Credit Card', deposit: 'Deposit',
  other: 'Other', unclassified: 'Unclassified',
}

export default function ExecSales() {
  const [data, setData] = useState<ExecSales | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecSales }>(`/api/executive/sales?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Sales — Executive View'
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

  const totalBook = data.acquisition_mix.reduce((s, m) => s + m.total, 0) || 1
  const openedTotal = data.acquisition_mix.reduce((s, m) => s + m.opened, 0)

  return (
    <Page title={title} back={back} actions={actions}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Accounts Opened" value={fmtNum(data.new_accounts)} change={data.acquisition_change_pct} icon="person_add" accent={NAVY} />
        <KpiCard label="Deposits Placed" value={fmtNum(data.new_deposits)} icon="savings" accent={GREEN} />
        <KpiCard label="Deposit Value" value={fmtKobo(data.new_deposit_value_kobo)} icon="payments" accent={AMBER} />
        <KpiCard label="Loans Booked" value={fmtNum(data.conversions_mtd)} icon="request_quote" accent={BLUE} />
      </div>

      {/* ── Acquisition over time ─────────────────────────────────────────── */}
      <SectionCard title="Acquisition" subtitle="New accounts, deposits and loans per month" style={{ marginBottom: 14 }}>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data.acquisition_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
            <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis width={44} allowDecimals={false} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip />} cursor={{ fill: 'var(--row-hvr)' }} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt2)' }} />
            <Bar dataKey="accounts" name="Accounts" fill={NAVY} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="deposits" name="Deposits" fill={GREEN} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="loans" name="Loans" fill={BLUE} radius={[3, 3, 0, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* ── Mix + book ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Product Mix" subtitle={`${fmtNum(openedTotal)} opened this period · ${fmtNum(totalBook)} on book`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            {data.acquisition_mix.map(m => (
              <div key={m.product_line}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>
                    {LINE_LABEL[m.product_line] ?? m.product_line}
                  </span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                    +{fmtNum(m.opened)} · {fmtNum(m.total)} total
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{
                    width: `${share(m.total, totalBook)}%`, height: '100%', borderRadius: 4,
                    background: LINE_COLOR[m.product_line] ?? LINE_COLOR.unclassified,
                  }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: SP[4] }}>
            <Note>
              Bars show each line's share of the total book; the <b>+n</b> is what opened in this period. The two
              differ sharply — prepaid dominates the book while credit card leads new openings.
            </Note>
          </div>
        </SectionCard>

        <SectionCard title="Loan Book" subtitle="Open loans by status">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[5], marginBottom: SP[4] }}>
            <Stat label="Open Value" value={fmtKobo(data.pipeline_value_kobo)} sub={`${fmtNum(data.pipeline_count)} loans`} />
            <Stat label="Booked This Period" value={fmtNum(data.conversions_mtd)} sub="new loans" />
          </div>
          {data.pipeline_stages.length === 0 ? (
            <Note>No open loans.</Note>
          ) : (
            <ResponsiveContainer width="100%" height={170}>
              <BarChart data={data.pipeline_stages} margin={{ top: 4, right: 8, bottom: 4, left: 8 }} layout="vertical">
                <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
                <XAxis type="number" tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="stage" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} width={84} />
                <Tooltip content={<Tip fmt={fmtKobo} />} cursor={{ fill: 'var(--row-hvr)' }} />
                <Bar dataKey="value_kobo" name="Outstanding" radius={[0, 4, 4, 0]} barSize={18}>
                  {data.pipeline_stages.map(s => (
                    <Cell key={s.stage} fill={/default|expir/i.test(s.stage) ? RED : NAVY} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </div>

      {/* ── Officers ──────────────────────────────────────────────────────── */}
      <SectionCard title="Loan Officers" subtitle="By book size">
        {data.top_performers.length === 0 ? (
          <Note>
            No officer is named on any open loan, so the book cannot be attributed. Officer names come from the
            CBS loan record — until they are populated there is nothing to rank.
          </Note>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Officer', 'Loans', 'Book Value', 'Share'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Officer' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_performers.map((p, i) => (
                <tr key={p.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                  <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 26, height: 26, borderRadius: 8, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, fontFamily: INTER, flexShrink: 0 }}>{i + 1}</div>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{p.name}</span>
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(p.conversions)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(p.value_kobo)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                    {share(p.value_kobo, data.pipeline_value_kobo).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </Page>
  )
}
