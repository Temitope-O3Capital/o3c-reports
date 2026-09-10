import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { EArea, EBar } from '../../components/echarts'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { RED, DARKRED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { Stat, Note, ytick, share } from './shared'
import { SEVERITY } from '../../components/charts'

interface ExecRecovery {
  period: { type: string; start: string; end: string }

  // Book snapshot.
  open_cases: number
  open_outstanding_kobo: number
  total_recovered_kobo: number
  cases_total: number
  recovery_rate_pct: number

  // Period flow.
  recovered_period_kobo: number
  recovered_period_count: number
  cases_opened_period: number
  cases_closed_period: number

  // Write-off position.
  written_off_book_kobo: number
  writeoff_pending: number
  writeoff_pending_kobo: number

  status_breakdown: { status: string; count: number; outstanding_kobo: number }[]
  handoff_ladder: { bucket: string; count: number; value_kobo: number }[]

  legal_cases: number
  legal_by_stage: { stage: string; count: number; value_kobo: number }[]
  legal_pipeline: { proceeding_type: string; count: number }[]

  monthly_trend: { month: string; recovered_kobo: number; count: number }[]
  top_agents: { name: string; role: string; open_cases: number; cases: number; open_outstanding_kobo: number; recovered_period_kobo: number }[]
}

// Status keeps its colour whatever the mix looks like this period.
const STATUS_COLOR: Record<string, string> = {
  active: BLUE, open: BLUE, legal: RED, closed: GREEN, written_off: '#5B7A94',
}
const STATUS_LABEL: Record<string, string> = {
  active: 'Active', open: 'Open', legal: 'Legal', closed: 'Closed', written_off: 'Written Off',
}
// Handoff buckets run calm → alarming with depth. Keys match the backend's DPD-at-
// handoff ranges (numeric day count bucketed server-side); Unknown = blank/non-numeric.
const BUCKET_COLOR: Record<string, string> = {
  '0-90': SEVERITY[0], '91-180': SEVERITY[2], '181-360': SEVERITY[4], '360+': SEVERITY[5], Unknown: '#5B7A94',
}

export default function ExecRecovery() {
  const [data, setData] = useState<ExecRecovery | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [sp] = useSearchParams()
  const [from, setFrom] = useState(sp.get('from') || monthStart())
  const [to,   setTo]   = useState(sp.get('to')   || today())

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecRecovery }>(`/api/executive/recovery?period=custom&start=${f}&end=${t}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(from, to) }, [load, from, to])

  const title = 'Recovery: Executive View'
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

  const statusTotal = data.status_breakdown.reduce((s, x) => s + x.count, 0) || 1
  // "Deep" handoffs — past 180 days at hand-off, where recovery odds are lowest.
  const deep = data.handoff_ladder
    .filter(b => b.bucket === '181-360' || b.bucket === '360+')
    .reduce((s, b) => s + b.value_kobo, 0)
  const deepShare = share(deep, data.open_outstanding_kobo)
  const noRecovery = data.recovered_period_kobo === 0 && data.recovered_period_count === 0
  const recoveredMax = Math.max(1, ...data.monthly_trend.map(m => m.recovered_kobo))

  return (
    <Page title={title} back={back} actions={actions}>

      {/* ── Headline ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Open Cases" value={fmtNum(data.open_cases)} icon="gavel" accent={NAVY} />
        <KpiCard label="In Recovery" value={fmtKobo(data.open_outstanding_kobo)} icon="account_balance_wallet" accent={AMBER} />
        <KpiCard label="Recovered (period)" value={fmtKobo(data.recovered_period_kobo)} icon="payments" accent={data.recovered_period_kobo > 0 ? GREEN : RED} />
        <KpiCard label="Recovery Rate" value={fmtPct(data.recovery_rate_pct)} icon="target" accent={data.recovery_rate_pct >= 30 ? GREEN : AMBER} />
      </div>

      {noRecovery && (
        <div style={{ marginBottom: 14 }}>
          <Note tone={RED}>
            <b>No recovery payments have been logged in this period.</b> {fmtNum(data.open_cases)} cases worth{' '}
            {fmtKobo(data.open_outstanding_kobo)} are open, but nothing has been recorded as recovered in the
            selected window. Either recovery is happening off-system or it has stalled — both are worth knowing.
          </Note>
        </div>
      )}

      {/* ── Recovered over time ───────────────────────────────────────────── */}
      <SectionCard title="Recovered" subtitle="Posted recovery payments per month · rolling 12 months" style={{ marginBottom: 14 }}>
        <EArea
          data={data.monthly_trend}
          xKey="month"
          height={230}
          dots
          endLabel
          endFmt={ytick}
          hideYAxis
          valueFmt={fmtKobo}
          series={[{ key: 'recovered_kobo', name: 'Recovered', color: GREEN }]}
        />
        {recoveredMax === 1 && (
          <div style={{ marginTop: SP[2] }}>
            <Note tone={AMBER}>No recovery payments are recorded in any of the last 12 months.</Note>
          </div>
        )}
      </SectionCard>

      {/* ── Where the open book sits ──────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Open Book by Hand-off Age" subtitle={`${fmtNum(data.open_cases)} open cases by DPD at hand-off`}>
          {data.handoff_ladder.length === 0 ? (
            <Note>No open recovery cases.</Note>
          ) : (
            <>
              <EBar
                data={data.handoff_ladder}
                xKey="bucket"
                height={230}
                legend={false}
                valueFmt={fmtKobo}
                axisFmt={ytick}
                series={[{ key: 'value_kobo', name: 'Outstanding', colorFn: (b) => BUCKET_COLOR[b.bucket] ?? '#5B7A94' }]}
              />
              {deepShare > 50 && (
                <div style={{ marginTop: SP[3] }}>
                  <Note tone={RED}>
                    <b>{fmtPct(deepShare)} of the open recovery book was already 180+ days past due at hand-off</b>{' '}
                    ({fmtKobo(deep)}). This is the hardest tier to recover through ordinary follow-up; it is largely a
                    settlement, write-off or legal decision.
                  </Note>
                </div>
              )}
            </>
          )}
        </SectionCard>

        <SectionCard title="Case Status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            {data.status_breakdown.map(s => (
              <div key={s.status}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>
                    {STATUS_LABEL[s.status] ?? s.status}
                  </span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                    {fmtNum(s.count)} · {fmtKobo(s.outstanding_kobo)}
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{ width: `${share(s.count, statusTotal)}%`, height: '100%', borderRadius: 4, background: STATUS_COLOR[s.status] ?? '#5B7A94' }} />
                </div>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4], display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
              <Stat label="Opened (period)" value={fmtNum(data.cases_opened_period)} sub="new cases" />
              <Stat label="Closed (period)" value={fmtNum(data.cases_closed_period)} sub="resolved" tone={GREEN} />
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ── Legal + write-off position ────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3], marginBottom: 14 }}>
        <SectionCard title="Legal Pipeline" subtitle="Cases at each legal stage">
          {data.legal_by_stage.length === 0 ? (
            <Note>No cases are at a legal stage. Recovery is being pursued through ordinary follow-up.</Note>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
              {data.legal_by_stage.map(s => {
                const maxVal = Math.max(1, ...data.legal_by_stage.map(x => x.value_kobo))
                return (
                  <div key={s.stage}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{s.stage}</span>
                      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(s.count)} · {fmtKobo(s.value_kobo)}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                      <div style={{ width: `${share(s.value_kobo, maxVal)}%`, height: '100%', borderRadius: 3, background: RED }} />
                    </div>
                  </div>
                )
              })}
              {data.legal_pipeline.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: SP[2] }}>
                  {data.legal_pipeline.map(p => (
                    <span key={p.proceeding_type} style={{ fontSize: TEXT.xs, fontFamily: INTER, color: 'var(--txt2)', padding: '3px 10px', borderRadius: 99, background: 'var(--chip-bg)', border: '1px solid var(--bdr)' }}>
                      {p.proceeding_type} · <b style={{ color: 'var(--txt)' }}>{fmtNum(p.count)}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Write-off Position">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <Stat label="Written Off (book)" value={fmtKobo(data.written_off_book_kobo)} sub="cumulative across all cases" tone="#6B7280" />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat
                label="Pending Approval"
                value={fmtNum(data.writeoff_pending)}
                sub={data.writeoff_pending === 0 ? 'none awaiting sign-off' : `${fmtKobo(data.writeoff_pending_kobo)} to decide`}
                tone={data.writeoff_pending > 0 ? AMBER : GREEN}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Recovered All-time" value={fmtKobo(data.total_recovered_kobo)} sub={`${fmtNum(data.cases_total)} cases ever opened`} tone={GREEN} />
            </div>
            <Note>
              Recovery rate is the share of everything ever taken into recovery that has been recovered
              ({fmtKobo(data.total_recovered_kobo)} of {fmtKobo(data.total_recovered_kobo + data.open_outstanding_kobo)}).
              The remainder is still live or written off.
            </Note>
          </div>
        </SectionCard>
      </div>

      {/* ── Agents ────────────────────────────────────────────────────────── */}
      <SectionCard title="Agent Recovery" subtitle="Recovered in the selected period, and the book each is carrying">
        {data.top_agents.length === 0 ? (
          <Note>No cases are assigned to a recovery agent.</Note>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Agent', 'Open Cases', 'Open Book', 'Recovered (period)', 'Rate'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Agent' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_agents.map((a, i) => {
                const rate = share(a.recovered_period_kobo, a.recovered_period_kobo + a.open_outstanding_kobo)
                return (
                  <tr key={a.name} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 8, background: `${NAVY}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, fontFamily: INTER, flexShrink: 0 }}>{i + 1}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{a.name}</div>
                        {a.role && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER, textTransform: 'capitalize' }}>{a.role.replace(/_/g, ' ')}</div>}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(a.open_cases)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(a.open_outstanding_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(a.recovered_period_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: rate >= 30 ? GREEN : 'var(--txt2)', fontFamily: INTER }}>{fmtPct(rate)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </SectionCard>
    </Page>
  )
}
