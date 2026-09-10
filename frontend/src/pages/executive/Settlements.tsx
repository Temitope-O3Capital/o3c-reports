import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter } from '../../components/UI'
import { EArea, EBar } from '../../components/echarts'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { Stat, Note, ytick, share } from './shared'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecSettlements {
  period: { type: string; start: string; end: string }

  payouts_kobo: number
  payouts_count: number
  payouts_change_pct: number
  payout_fees_kobo: number
  failed_count: number
  failed_value_kobo: number
  nip_success_rate_pct: number

  collections_kobo: number
  collections_count: number
  collection_fees_kobo: number
  net_flow_kobo: number
  channel_volumes: { channel: string; volume_kobo: number; count: number; fees_kobo: number }[]

  paystack_wallet_kobo: number
  settled_period_kobo: number
  settled_period_count: number

  recon_rate_pct: number
  recon_matched: number
  recon_unmatched: number
  recon_last_run: string
  open_exceptions: number
  exception_value_kobo: number
  exception_reasons: { reason: string; count: number; value_kobo: number }[]
  exception_ageing: { bucket: string; count: number; value_kobo: number }[]

  daily_trend: { day: string; payouts_kobo: number; collections_kobo: number }[]
}

// Fixed hues — a reason keeps its colour whatever the mix looks like this period.
const REASON_COLOR: Record<string, string> = {
  no_candidate: RED, ambiguous: AMBER, amount_mismatch: BLUE, unclassified: '#5B7A94',
}
const REASON_LABEL: Record<string, string> = {
  no_candidate: 'No candidate', ambiguous: 'Ambiguous', amount_mismatch: 'Amount mismatch',
  unclassified: 'Unclassified',
}
// Ageing runs fresh → stale, so colour runs calm → alarming in the same direction.
const AGE_COLOR: Record<string, string> = {
  '0-7d': GREEN, '8-30d': BLUE, '31-90d': AMBER, '90d+': RED,
}

export default function ExecSettlements() {
  const [data, setData] = useState<ExecSettlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sp] = useSearchParams()
  const [from, setFrom] = useState(sp.get('from') || monthStart())
  const [to,   setTo]   = useState(sp.get('to')   || today())

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecSettlements }>(`/api/executive/settlements?period=custom&start=${f}&end=${t}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(from, to) }, [load, from, to])

  const title = 'Settlements: Executive View'
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

  const exceptionTotal = data.exception_reasons.reduce((s, x) => s + x.value_kobo, 0) || 1
  const stale = data.exception_ageing.find(a => a.bucket === '90d+')
  const staleShare = stale ? share(stale.value_kobo, data.exception_value_kobo) : 0
  const netOut = data.net_flow_kobo < 0

  return (
    <Page title={title} back={back} actions={actions}>

      {/* ── Money moved ───────────────────────────────────────────────────── */}
      {(() => {
        const totalFees = (data.payout_fees_kobo || 0) + (data.collection_fees_kobo || 0)
        const moved = (data.payouts_kobo || 0) + (data.collections_kobo || 0)
        const costPct = moved > 0 ? (totalFees / moved) * 100 : 0
        return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Payouts Out" value={fmtKobo(data.payouts_kobo)} change={data.payouts_change_pct} icon="north_east" accent={NAVY} />
        <KpiCard label="Collections In" value={fmtKobo(data.collections_kobo)} icon="south_west" accent={GREEN} />
        <KpiCard label="Net Flow" value={fmtKobo(Math.abs(data.net_flow_kobo))} sub={netOut ? 'net out' : 'net in'} icon="swap_vert" accent={netOut ? AMBER : GREEN} />
        <KpiCard label="Cost to Move Money" value={fmtKobo(totalFees)} sub={`${fmtPct(costPct)} of value moved`} icon="toll" accent={AMBER} />
        <KpiCard label="Payout Success" value={fmtPct(data.nip_success_rate_pct)} icon="check_circle" accent={data.nip_success_rate_pct >= 99 ? GREEN : AMBER} />
        <KpiCard label="Open Exceptions" value={fmtNum(data.open_exceptions)} icon="report" accent={data.open_exceptions > 0 ? RED : GREEN} />
      </div>
        )
      })()}

      {/* ── Reconciliation: the number that matters most ──────────────────── */}
      <SectionCard
        title="Reconciliation"
        subtitle={data.recon_last_run ? `Last run ${data.recon_last_run}` : 'Never run'}
        style={{ marginBottom: 14 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[5], marginBottom: SP[4] }}>
          <Stat label="Match Rate" value={fmtPct(data.recon_rate_pct)} sub={`${fmtNum(data.recon_matched)} matched`} tone={data.recon_rate_pct >= 95 ? GREEN : RED} />
          <Stat label="Unmatched" value={fmtNum(data.recon_unmatched)} sub="items with no counterparty" tone={AMBER} />
          <Stat label="Value Unreconciled" value={fmtKobo(data.exception_value_kobo)} sub="open exceptions" tone={RED} />
          <Stat label="Oldest Bucket" value={stale ? fmtPct(staleShare) : '—'} sub="of value aged 90d+" tone={staleShare > 50 ? RED : 'var(--txt)'} />
        </div>

        {data.open_exceptions > 0 && staleShare > 90 && (
          <Note tone={RED}>
            <b>Every open exception is more than 90 days old.</b> {fmtNum(data.open_exceptions)} items worth{' '}
            {fmtKobo(data.exception_value_kobo)} have no counterparty and none have been worked. This is not a
            backlog that is being cleared slowly. Nothing is moving. Exceptions are shown for the whole open
            book rather than the selected period, because an item unmatched since March is still unmatched today.
          </Note>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginTop: SP[4] }}>
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: SP[3] }}>Why they failed to match</div>
            {data.exception_reasons.length === 0 ? (
              <Note tone={GREEN}>Nothing unmatched. Every item found its counterparty.</Note>
            ) : data.exception_reasons.map(x => (
              <div key={x.reason} style={{ marginBottom: SP[3] }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>
                    {REASON_LABEL[x.reason] ?? x.reason}
                  </span>
                  <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                    {fmtKobo(x.value_kobo)} · {fmtNum(x.count)}
                  </span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--chip-bg)', overflow: 'hidden' }}>
                  <div style={{
                    width: `${share(x.value_kobo, exceptionTotal)}%`, height: '100%', borderRadius: 3,
                    background: REASON_COLOR[x.reason] ?? REASON_COLOR.unclassified,
                  }} />
                </div>
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: SP[3] }}>How long they have been sitting</div>
            <EBar
              data={data.exception_ageing}
              xKey="bucket"
              height={170}
              valueFmt={fmtKobo}
              axisFmt={ytick}
              series={[{ key: 'value_kobo', name: 'Value', colorFn: (a) => AGE_COLOR[a.bucket] ?? BLUE }]}
            />
          </div>
        </div>
      </SectionCard>

      {/* ── Daily flow ────────────────────────────────────────────────────── */}
      <SectionCard title="Daily Flow" subtitle="Payouts against collections" style={{ marginBottom: 14 }}>
        <EArea
          data={data.daily_trend}
          xKey="day"
          height={230}
          endLabel
          hideYAxis
          valueFmt={fmtKobo}
          endFmt={ytick}
          axisFmt={ytick}
          series={[
            { key: 'payouts_kobo', name: 'Payouts', color: NAVY },
            { key: 'collections_kobo', name: 'Collections', color: GREEN },
          ]}
        />
        <div style={{ display: 'flex', gap: SP[5], marginTop: SP[3] }}>
          {[{ color: NAVY, label: 'Payouts' }, { color: GREEN, label: 'Collections' }].map(({ color, label }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
              <span style={{ width: 22, height: 3, borderRadius: 2, background: color }} />
              {label}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ── Channels + position ───────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[3] }}>
        <SectionCard title="Collection Channels" subtitle="Inbound value and cost to collect">
          {data.channel_volumes.length === 0 ? (
            <Note>No collections settled in this period.</Note>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  {['Channel', 'Value', 'Count', 'Fees', 'Cost %'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Channel' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.channel_volumes.map(c => (
                  <tr key={c.channel} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium, textTransform: 'capitalize' }}>{c.channel.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(c.volume_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(c.count)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtKobo(c.fees_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtPct(share(c.fees_kobo, c.volume_kobo))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="Position">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <Stat
              label="Net Flow"
              value={fmtKobo(Math.abs(data.net_flow_kobo))}
              sub={netOut ? 'more paid out than collected' : 'more collected than paid out'}
              tone={netOut ? AMBER : GREEN}
            />
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Paystack Wallet" value={fmtKobo(data.paystack_wallet_kobo)} sub="available balance" />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Settled to Bank" value={fmtKobo(data.settled_period_kobo)} sub={`${fmtNum(data.settled_period_count)} settlements`} />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat
                label="Failed Payouts"
                value={fmtNum(data.failed_count)}
                sub={data.failed_count === 0 ? 'none' : `${fmtKobo(data.failed_value_kobo)} to retry`}
                tone={data.failed_count > 0 ? RED : GREEN}
              />
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <Stat label="Cost of Payouts" value={fmtKobo(data.payout_fees_kobo)} sub={`${fmtNum(data.payouts_count)} transfers`} />
            </div>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
