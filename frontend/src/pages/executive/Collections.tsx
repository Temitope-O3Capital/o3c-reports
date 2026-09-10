import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { EBar } from '../../components/echarts'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { RED, DARKRED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { Stat, Note, ytick, share } from './shared'
import { SEVERITY } from '../../components/charts'

interface ExecCollections {
  period: { type: string; start: string; end: string }

  // The assigned book — the real collections position.
  assigned_kobo: number
  assigned_count: number
  assigned_target_kobo: number
  agent_count: number
  assigned_ladder: { bucket: string; count: number; value_kobo: number }[]
  top_agents: { name: string; role: string; accounts: number; assigned_kobo: number; target_kobo: number; deep_accounts: number }[]

  // Card delinquency, which is larger than the loan book.
  card_overdue_kobo: number
  card_overdue_accounts: number

  // Logged activity.
  activity_contacts: number
  activity_promises: number
  activity_payments: number
  collected_mtd_kobo: number

  // Legacy CBS loan-book view, retained.
  par30_value_kobo: number
  par30_count: number
  par60_value_kobo: number
  par60_count: number
  par90_value_kobo: number
  par90_count: number

  // Loan repayment status from the Udara installment schedule (payment_status).
  loan_overdue_kobo: number
  loan_overdue_count: number
  loan_partial_kobo: number
  loan_collected_kobo: number
  loan_due_7d_kobo: number
  loan_due_30d_kobo: number
  loan_overdue_list: { account: string; customer_name: string; product: string; amount_kobo: number; days_overdue: number }[]
}

// Ladder colours run calm → alarming with depth, so the shape reads before the labels.
const BUCKET_COLOR: Record<string, string> = {
  '1-30': SEVERITY[0], '31-60': SEVERITY[1], '61-90': SEVERITY[2],
  '91-180': SEVERITY[3], '181-360': SEVERITY[4], '360+': SEVERITY[5], unclassified: '#5B7A94',
}

export default function ExecCollections() {
  const [data, setData] = useState<ExecCollections | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sp] = useSearchParams()
  const [from, setFrom] = useState(sp.get('from') || monthStart())
  const [to,   setTo]   = useState(sp.get('to')   || today())

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecCollections }>(`/api/executive/collections?period=custom&start=${f}&end=${t}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(from, to) }, [load, from, to])

  const title = 'Collections: Executive View'
  const back = { label: 'Executive Overview', to: '/' }
  const actions = <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />

  if (loading) return (
    <Page title={title} back={back} actions={actions}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back} actions={actions}>
      <ErrBanner error={error} onRetry={() => load(from, to)} />
    </Page>
  )
  if (!data) return null

  // "Deep" = past 180 days, where recovery odds fall off a cliff.
  const deep = data.assigned_ladder
    .filter(b => b.bucket === '181-360' || b.bucket === '360+')
    .reduce((s, b) => s + b.value_kobo, 0)
  const deepShare = share(deep, data.assigned_kobo)
  const noActivity = data.activity_contacts === 0 && data.activity_promises === 0 && data.activity_payments === 0
  const perAgent = data.agent_count > 0 ? data.assigned_kobo / data.agent_count : 0

  return (
    <Page title={title} back={back} actions={actions}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Assigned Book" value={fmtKobo(data.assigned_kobo)} icon="assignment" accent={NAVY} />
        <KpiCard label="Accounts in Collections" value={fmtNum(data.assigned_count)} icon="groups" accent={BLUE} />
        <KpiCard label="Past 180 Days" value={fmtPct(deepShare)} icon="hourglass_bottom" accent={deepShare > 50 ? RED : AMBER} />
        <KpiCard label="Collected This Period" value={fmtKobo(data.collected_mtd_kobo)} icon="payments" accent={data.collected_mtd_kobo > 0 ? GREEN : RED} />
      </div>

      {noActivity && (
        <div style={{ marginBottom: 14 }}>
          <Note tone={RED}>
            <b>No collections activity has been logged in this period.</b> {fmtNum(data.assigned_count)} accounts
            worth {fmtKobo(data.assigned_kobo)} are assigned to {fmtNum(data.agent_count)} agents, but there are zero
            recorded contacts, zero promises to pay and zero payments. Either the work is happening outside the
            system or it is not happening. Both are worth knowing, and neither is visible from the assignment
            count alone.
          </Note>
        </div>
      )}

      {/* ── Loan Repayment Status (Udara installment schedule) ────────────── */}
      {(data.loan_overdue_kobo > 0 || data.loan_due_30d_kobo > 0 || data.loan_collected_kobo > 0) && (
      <SectionCard title="Loan Repayment Status" subtitle="Installment-level dues from the Udara repayment schedule — overdue is what is genuinely past due (not the whole book)" style={{ marginBottom: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3] }}>
          <KpiCard label="Overdue" value={fmtKobo(data.loan_overdue_kobo)} sub={`${fmtNum(data.loan_overdue_count)} unpaid installment${data.loan_overdue_count === 1 ? '' : 's'}`} icon="error" accent={RED} />
          <KpiCard label="Due Next 7 Days" value={fmtKobo(data.loan_due_7d_kobo)} icon="event_upcoming" accent={AMBER} />
          <KpiCard label="Due Next 30 Days" value={fmtKobo(data.loan_due_30d_kobo)} icon="calendar_month" accent={NAVY} />
          <KpiCard label="Collected" value={fmtKobo(data.loan_collected_kobo)} sub={data.loan_partial_kobo > 0 ? `+ ${fmtKobo(data.loan_partial_kobo)} partial` : 'fully paid installments'} icon="check_circle" accent={GREEN} />
        </div>
        {(data.loan_overdue_list ?? []).length > 0 && (
          <div style={{ marginTop: 16, overflowX: 'auto' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>Overdue Loans</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                  {['Customer', 'Product', 'Overdue', 'Days'].map((h, i) => (
                    <th key={h} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '8px 12px', fontSize: TEXT['2xs'], textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--txt3)', fontFamily: INTER, fontWeight: FW.bold }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.loan_overdue_list ?? []).map((l, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '9px 12px', color: 'var(--txt)', fontFamily: INTER }}>{l.customer_name || l.account}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--txt2)', fontFamily: INTER }}>{l.product || '—'}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', ...NUM, color: RED, fontWeight: FW.bold }}>{fmtKobo(l.amount_kobo)}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right', ...NUM, color: l.days_overdue > 60 ? RED : 'var(--txt2)' }}>{fmtNum(l.days_overdue)}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      )}

      {/* ── The ladder ────────────────────────────────────────────────────── */}
      <SectionCard
        title="Delinquency Ladder"
        subtitle={`${fmtNum(data.assigned_count)} assigned accounts by days past due`}
        style={{ marginBottom: 14 }}
      >
        <EBar
          data={data.assigned_ladder}
          xKey="bucket"
          height={250}
          legend={false}
          valueFmt={fmtKobo}
          axisFmt={ytick}
          series={[{ key: 'value_kobo', name: 'Outstanding', colorFn: (b) => BUCKET_COLOR[b.bucket] ?? BUCKET_COLOR.unclassified }]}
        />

        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(data.assigned_ladder.length, 1)},1fr)`, gap: SP[3], marginTop: SP[3] }}>
          {data.assigned_ladder.map(b => (
            <div key={b.bucket} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{b.bucket}</div>
              <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER, marginTop: 2 }}>{fmtNum(b.count)}</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>{fmtPct(share(b.value_kobo, data.assigned_kobo))} of value</div>
            </div>
          ))}
        </div>

        {deepShare > 50 && (
          <div style={{ marginTop: SP[4] }}>
            <Note tone={RED}>
              <b>{fmtPct(deepShare)} of the assigned book is more than 180 days past due</b> ({fmtKobo(deep)}).
              Recovery rates fall sharply past six months, so the bulk of this book is unlikely to be collected
              through ordinary follow-up. It is a write-off, restructure or legal decision rather than a calling
              problem.
            </Note>
          </div>
        )}
      </SectionCard>

      {/* ── Agents + exposure ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3] }}>
        <SectionCard title="Agent Workload" subtitle="Assigned value per collections agent">
          {data.top_agents.length === 0 ? (
            <Note>No active assignments.</Note>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Agent', 'Accounts', 'Assigned', 'Past 180d', 'Target'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Agent' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.top_agents.map(a => (
                  <tr key={a.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{a.name}</div>
                      {a.role && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER, textTransform: 'capitalize' }}>{a.role.replace(/_/g, ' ')}</div>}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(a.accounts)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(a.assigned_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: a.deep_accounts > a.accounts / 2 ? RED : 'var(--txt2)', fontFamily: INTER }}>{fmtNum(a.deep_accounts)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{a.target_kobo > 0 ? fmtKobo(a.target_kobo) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.assigned_target_kobo === 0 && data.top_agents.length > 0 && (
            <div style={{ marginTop: SP[3] }}>
              <Note tone={AMBER}>
                No recovery targets are set on any assignment, so there is nothing to measure agent performance
                against. Only how much each is holding.
              </Note>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Total Exposure">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <Stat label="Assigned per Agent" value={fmtKobo(perAgent)} sub={`${fmtNum(data.agent_count)} agents`} />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat
                label="Card Overdue"
                value={fmtKobo(data.card_overdue_kobo)}
                sub={`${fmtNum(data.card_overdue_accounts)} card accounts`}
                tone={RED}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat
                label="Loan Book PAR90"
                value={fmtKobo(data.par90_value_kobo)}
                sub={`${fmtNum(data.par90_count)} loans`}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Note>
                Card delinquency is reported beside the assigned book because it is the larger exposure.
                The CBS loan book is small enough that a collections view built on it alone would describe
                a fraction of what is actually owed.
              </Note>
            </div>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
