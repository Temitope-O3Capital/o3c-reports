import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { EArea, EDonut } from '../../components/echarts'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, SP } from '../../lib/design'
import { CHART_SERIES } from '../../components/charts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecFD {
  fd_book_kobo: number
  fd_count: number
  accrued_interest_kobo: number
  avg_rate_pct: number
  maturing_30d: number
  maturing_90d: number
  maturity_ladder: { month: string; payout_kobo: number }[]
  product_breakdown: { product: string; count: number; principal_kobo: number }[]
  tenor_breakdown: { bucket: string; count: number; principal_kobo: number }[]
  top_deposits: { account: string; customer: string; agent: string; product: string; principal_kobo: number; rate: number; maturity: string }[]
  // A deposit book is funding, so these two answer what it costs and how exposed the
  // book is if the largest depositors leave.
  cost_of_funds_monthly_kobo?: number
  top10_share_pct?: number
  top10_value_kobo?: number
}

const DONUT_COLORS = CHART_SERIES

// Same money-scale formatter the maturity-ladder Y-axis used, reused for the
// endpoint label so the figure reads in ₦m / ₦k consistently.
const fdTick = (v: number) => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''

interface FDRow {
  account: string; customer: string; agent: string; product: string
  principal_kobo: number; accrued_kobo: number; rate: number; tenor_days: number
  commencement: string; maturity: string; status: string; branch: string
}

export default function ExecFixedDeposits() {
  const [data, setData] = useState<ExecFD | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // All-deposits browser. The date filter is applied server-side (commencement_date);
  // search / sort / pagination are handled client-side by the shared DataTable, so the
  // whole in-range set is loaded once.
  const [sp] = useSearchParams()
  const [from, setFrom] = useState(sp.get('from') || '')
  const [to,   setTo]   = useState(sp.get('to')   || '')
  const [rows, setRows] = useState<FDRow[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecFD }>('/api/executive/fixed-deposits')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const loadList = useCallback(async () => {
    setListLoading(true)
    const p = new URLSearchParams({ limit: '2000' })
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    try {
      const r = await apiFetch<{ data: { rows: FDRow[]; total: number } }>(`/api/executive/fixed-deposits/list?${p}`)
      setRows(r.data?.rows ?? [])
      setTotal(r.data?.total ?? 0)
    } catch { setRows([]); setTotal(0) }
    finally { setListLoading(false) }
  }, [from, to])

  useEffect(() => { loadList() }, [loadList])

  const title = 'Fixed Deposits: Executive View'
  const back = { label: 'Executive Overview', to: '/' }
  const actions = <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />

  if (loading) return (
    <Page title={title} back={back} actions={actions}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back} actions={actions}>
      <ErrBanner error={error} onRetry={() => load()} />
    </Page>
  )
  if (!data) return null

  const totalPrincipal = data.product_breakdown.reduce((s, p) => s + p.principal_kobo, 0) || 1
  const maxTenor = Math.max(1, ...data.tenor_breakdown.map(t => t.principal_kobo))

  const depositCols: TableCol<FDRow>[] = [
    { key: 'account', label: 'Account', sortable: true, render: r => <span style={NUM}>{r.account}</span> },
    { key: 'customer', label: 'Customer', sortable: true },
    { key: 'agent', label: 'Agent', sortable: true, render: r => <span style={{ color: 'var(--txt2)' }}>{r.agent}</span> },
    { key: 'product', label: 'Product', sortable: true, render: r => <span style={{ color: 'var(--txt2)' }}>{r.product}</span> },
    { key: 'principal_kobo', label: 'Principal', sortable: true, align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKobo(r.principal_kobo)}</span> },
    { key: 'rate', label: 'Rate', sortable: true, align: 'right', render: r => <span style={NUM}>{fmtPct(r.rate)}</span> },
    { key: 'tenor_days', label: 'Tenor', sortable: true, align: 'right', render: r => <span style={NUM}>{r.tenor_days}d</span> },
    { key: 'commencement', label: 'Commenced', sortable: true, render: r => <span style={NUM}>{fmtDate(r.commencement)}</span> },
    { key: 'maturity', label: 'Maturity', sortable: true, render: r => <span style={NUM}>{fmtDate(r.maturity)}</span> },
    { key: 'status', label: 'Status', sortable: true, render: r => <span style={{ fontSize: TEXT.xs, color: r.status === 'Active' ? GREEN : 'var(--txt3)' }}>{r.status}</span> },
  ]

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Total FD Book"     value={fmtKobo(data.fd_book_kobo)}           sub={`${fmtNum(data.fd_count)} active deposits`}     icon="savings"          accent={AMBER} />
        <KpiCard label="Accrued Interest"  value={fmtKobo(data.accrued_interest_kobo)}  sub="payable at maturity"                            icon="trending_up"      accent={GREEN} />
        <KpiCard label="Avg Rate"          value={fmtPct(data.avg_rate_pct)}            sub="weighted book rate"                             icon="percent"          accent={NAVY} />
        <KpiCard label="Maturing 30 Days"  value={fmtNum(data.maturing_30d)}            sub={`${fmtNum(data.maturing_90d)} within 90d`}      icon="event"            accent={data.maturing_30d > 10 ? RED : BLUE} />
      </div>

      {/* Funding cost and concentration — the two questions a deposit book raises. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard
          label="Cost of Funds / Month"
          value={data.cost_of_funds_monthly_kobo != null ? fmtKobo(data.cost_of_funds_monthly_kobo) : '—'}
          sub="interest accruing to depositors"
          icon="payments" accent={AMBER}
        />
        <KpiCard
          label="Top 10 Depositors"
          value={data.top10_share_pct != null ? fmtPct(data.top10_share_pct) : '—'}
          sub={data.top10_value_kobo != null ? `${fmtKobo(data.top10_value_kobo)} of the book` : 'concentration'}
          icon="donut_large"
          accent={(data.top10_share_pct ?? 0) > 30 ? RED : GREEN}
        />
      </div>

      {/* Maturity ladder + Product mix */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Maturity Ladder" subtitle="Expected payouts (principal + accrued) per month: next 12 months">
          <EArea
            data={data.maturity_ladder}
            xKey="month"
            height={230}
            dots
            endLabel
            endFmt={fdTick}
            hideYAxis
            valueFmt={fmtKobo}
            series={[{ key: 'payout_kobo', name: 'Payout', color: AMBER }]}
          />
        </SectionCard>

        <SectionCard title="Book by Product" subtitle="Active deposits by principal">
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], marginTop: 6 }}>
            <div style={{ flexShrink: 0 }}>
              <EDonut
                data={data.product_breakdown}
                valueKey="principal_kobo"
                nameKey="product"
                colorFn={(_, i) => DONUT_COLORS[i % DONUT_COLORS.length]}
                size={148}
                inner={42}
                outer={66}
                centerValue={fmtKobo(totalPrincipal)}
                centerLabel="total book"
                valueFmt={fmtKobo}
              />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {data.product_breakdown.map((p, i) => {
                const pct = Math.round((p.principal_kobo / totalPrincipal) * 100)
                const color = DONUT_COLORS[i % DONUT_COLORS.length]
                return (
                  <div key={p.product}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: TEXT.xs, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.product}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{pct}%</span>
                    </div>
                    <div style={{ height: 3, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Tenor mix + Top deposits */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 3fr', gap: SP[3] }}>
        <SectionCard title="Tenor Mix" subtitle="Active book by term">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], paddingTop: 4 }}>
            {data.tenor_breakdown.map((t, i) => {
              const color = DONUT_COLORS[i % DONUT_COLORS.length]
              const pct = Math.round((t.principal_kobo / maxTenor) * 100)
              return (
                <div key={t.bucket}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, fontWeight: FW.medium }}>{t.bucket}</span>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM }}>{fmtKobo(t.principal_kobo)}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, ...NUM, minWidth: 34, textAlign: 'right' }}>{fmtNum(t.count)}</span>
                  </div>
                  <div style={{ height: 5, background: 'var(--bdr)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99 }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SectionCard>

        <SectionCard title="Largest Deposits" subtitle="Top 10 active by principal">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                  {['Account', 'Customer', 'Agent', 'Product', 'Principal', 'Rate', 'Maturity'].map((h, i) => (
                    <th key={h} style={{ textAlign: i > 3 ? 'right' : 'left', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 10px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.top_deposits.map((d, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, ...NUM, padding: '8px 10px' }}>{d.account}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, padding: '8px 10px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.customer}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, padding: '8px 10px' }}>{d.agent}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA, padding: '8px 10px' }}>{d.product}</td>
                    <td style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{fmtKobo(d.principal_kobo)}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{fmtPct(d.rate)}</td>
                    <td style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER, ...NUM, padding: '8px 10px', textAlign: 'right' }}>{d.maturity}</td>
                  </tr>
                ))}
                {data.top_deposits.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: 'var(--txt3)', fontSize: TEXT.sm, fontFamily: INTER }}>No active deposits</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      {/* ── All Deposits — full register (standard DataTable: search / sort / page) ─── */}
      <SectionCard
        title="All Deposits"
        subtitle={`${fmtNum(total)} deposit${total === 1 ? '' : 's'}${from || to ? ' placed in range' : ''} · with account officer`}
        style={{ marginTop: 14 }}
      >
        <DataTable
          cols={depositCols}
          rows={rows}
          keyFn={(r, i) => `${r.account}-${i}`}
          loading={listLoading}
          searchKeys={['account', 'customer', 'agent', 'product']}
          searchPlaceholder="Search account, customer, agent…"
          filters={[
            { key: 'status', label: 'Status' },
            { key: 'product', label: 'Product' },
            { key: 'agent', label: 'Agent' },
            { key: 'branch', label: 'Branch' },
          ]}
          pageSize={25}
          emptyText="No deposits match."
        />
      </SectionCard>
    </Page>
  )
}
