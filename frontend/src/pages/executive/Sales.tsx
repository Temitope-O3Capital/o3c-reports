import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { EBar, EBarH } from '../../components/echarts'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { Stat, Note, ytick, share } from './shared'

interface ExecSales {
  period: { type: string; start: string; end: string }

  // Acquisition — what this business actually sells.
  new_accounts: number
  acquisition_change_pct: number
  new_deposits: number
  new_deposit_value_kobo: number
  cards_opened: number
  credit_cards_opened: number
  credit_book_kobo: number
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
  prepaid: NAVY, credit_card: RED, deposit: GREEN, other: BLUE, unclassified: '#5B7A94',
}
const LINE_LABEL: Record<string, string> = {
  prepaid: 'Prepaid', credit_card: 'Credit Card', deposit: 'Deposit',
  other: 'Other', unclassified: 'Unclassified',
}

interface LeadPipeline {
  funnel: { stage: string; count: number }[]
  campaign_leads: number
  interested: number
  forwarded_total: number
  forwards: Record<string, number>
  crm_stages: Record<string, number>
  by_source: { source: string; n: number }[]
  forward_conv_rate: number
}

export default function ExecSales() {
  const [data, setData] = useState<ExecSales | null>(null)
  const [pipeline, setPipeline] = useState<LeadPipeline | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sp] = useSearchParams()
  const [from, setFrom] = useState(sp.get('from') || monthStart())
  const [to,   setTo]   = useState(sp.get('to')   || today())

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecSales }>(`/api/executive/sales?period=custom&start=${f}&end=${t}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(from, to) }, [load, from, to])

  // The campaign → call-centre → sales funnel is cumulative, not date-scoped.
  useEffect(() => {
    apiFetch<{ data: LeadPipeline }>('/api/executive/lead-pipeline')
      .then(r => setPipeline(r.data)).catch(() => {})
  }, [])

  const title = 'Sales: Executive View'
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

  const totalBook = data.acquisition_mix.reduce((s, m) => s + m.total, 0) || 1
  const openedTotal = data.acquisition_mix.reduce((s, m) => s + m.opened, 0)

  return (
    <Page title={title} back={back} actions={actions}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Accounts Opened" value={fmtNum(data.new_accounts)} change={data.acquisition_change_pct} icon="person_add" accent={NAVY} />
        <KpiCard label="Cards Issued" value={fmtNum(data.cards_opened)} sub={`${fmtNum(data.credit_cards_opened)} credit`} icon="credit_card" accent={PURPLE} />
        <KpiCard label="Credit Card Book" value={fmtKobo(data.credit_book_kobo)} icon="account_balance_wallet" accent={RED} />
        <KpiCard label="Deposits Placed" value={fmtNum(data.new_deposits)} sub={fmtKobo(data.new_deposit_value_kobo)} icon="savings" accent={GREEN} />
        <KpiCard label="Loans Booked" value={fmtNum(data.conversions_mtd)} icon="request_quote" accent={BLUE} />
      </div>

      {/* ── Lead pipeline: campaign → call centre → sales ─────────────────── */}
      {pipeline && (
        <SectionCard title="Lead Pipeline" subtitle="Campaign → call centre → sales, tracked to conversion" style={{ marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: SP[3], marginBottom: SP[4] }}>
            <Stat label="Campaign leads" value={fmtNum(pipeline.campaign_leads)} />
            <Stat label="Interested" value={fmtNum(pipeline.interested)} />
            <Stat label="Forwarded" value={fmtNum(pipeline.forwarded_total)} />
            <Stat label="Converted" value={fmtNum(pipeline.forwards?.converted ?? 0)} />
            <Stat label="Forward → conv." value={`${pipeline.forward_conv_rate ?? 0}%`} />
          </div>
          {(() => {
            const max = Math.max(1, ...pipeline.funnel.map(s => s.count))
            const COLORS = [PURPLE, AMBER, BLUE, NAVY, GREEN]
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {pipeline.funnel.map((s, i) => (
                  <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ width: 132, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, flexShrink: 0 }}>{s.stage}</span>
                    <div style={{ flex: 1, height: 22, background: 'var(--th-bg)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                      <div style={{ width: `${Math.max(2, (s.count / max) * 100)}%`, height: '100%', background: COLORS[i % COLORS.length], borderRadius: 6, opacity: 0.92 }} />
                      <span style={{ position: 'absolute', left: 10, top: 0, height: '100%', display: 'flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.35)', ...NUM }}>{fmtNum(s.count)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
          <div style={{ marginTop: SP[4] }}>
            <Note>
              The blast (campaign leads) narrows as agents qualify interest, supervisors forward the warm ones,
              and Sales claims and converts. A wide gap between <b>Forwarded</b> and <b>Converted</b> is where Sales follow-up is leaking.
            </Note>
          </div>
        </SectionCard>
      )}

      {/* ── Acquisition over time ─────────────────────────────────────────── */}
      <SectionCard title="Acquisition" subtitle="New accounts, deposits and loans per month" style={{ marginBottom: 14 }}>
        <EBar
          data={data.acquisition_trend}
          xKey="month"
          height={250}
          valueFmt={(v) => Number(v).toLocaleString()}
          series={[
            { key: 'accounts', name: 'Accounts', color: NAVY },
            { key: 'deposits', name: 'Deposits', color: GREEN },
            { key: 'loans', name: 'Loans', color: BLUE },
          ]}
        />
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
              differ sharply: prepaid dominates the book while credit card leads new openings.
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
            <EBarH
              data={data.pipeline_stages}
              catKey="stage"
              height={170}
              barMax={18}
              valueFmt={fmtKobo}
              axisFmt={ytick}
              series={[{ key: 'value_kobo', name: 'Outstanding', colorFn: (s) => (/default|expir/i.test(s.stage) ? RED : NAVY) }]}
            />
          )}
        </SectionCard>
      </div>

      {/* ── Officers ──────────────────────────────────────────────────────── */}
      <SectionCard title="Loan Officers" subtitle="By book size">
        {data.top_performers.length === 0 ? (
          <Note>
            No officer is named on any open loan, so the book cannot be attributed. Officer names come from the
            CBS loan record. Until they are populated there is nothing to rank.
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
