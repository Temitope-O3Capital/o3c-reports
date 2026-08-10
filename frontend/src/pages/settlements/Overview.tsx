import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList,
} from 'recharts'
import {
  Page, KpiCard, SectionCard, ErrBanner, Spinner, EmptyState, DateFilter, Badge, Button,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CcsRoute { route: string; txns: number; value_kobo: number; debits: number; credits: number }
interface CcsTotals { txns: number; debit_kobo: number; credit_kobo: number; days_with_data: number; first_day: string | null; last_day: string | null }
interface IswChannel { channel: string; txns: number; value_kobo: number; fees_kobo: number; legs: number }
interface IswTotals { txns: number; value_kobo: number; fees_kobo: number; legs: number; days_with_data: number }
interface PsTotals {
  funding_n: number; funding_kobo: number; funding_lost_n: number
  transfer_n: number; transfer_kobo: number; transfer_failed_n: number
  settled_kobo: number; open_disputes: number
}
interface PsChannel { channel: string; attempts: number; success: number; value_kobo: number; completion_pct: number }
interface LinkInfo { isw_txns: number; matched_to_ccs: number; paystack_linkable: boolean; paystack_note: string }

interface Overview3 {
  period: { from: string; to: string }
  ccs: { routes: CcsRoute[]; totals: CcsTotals }
  interswitch: { channels: IswChannel[]; totals: IswTotals }
  paystack: { totals: PsTotals; channels: PsChannel[] }
  link: LinkInfo
}

// ── Chrome ────────────────────────────────────────────────────────────────────

const ROUTE_LABEL: Record<string, string> = {
  ATM: 'ATM — Cash Advance',
  POS: 'POS — Purchases',
  WEB: 'WEB — Utility Payment',
  TRANSFER_OUT: 'Transfer — Web Out',
  TRANSFER_IN: 'Transfer — Web In',
  CASH_PAYMENT: 'Cash Payment (Bank)',
  OTHER: 'Other codes',
}

const tdBase: React.CSSProperties = {
  padding: '9px 12px', fontSize: TEXT.sm, color: 'var(--txt)', borderBottom: '1px solid var(--bdr)',
}
const thBase: React.CSSProperties = {
  padding: '9px 12px', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
  textAlign: 'left', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
}

// Source header: names the role each system plays, because the whole module was
// previously mislabelled — the table called "interswitch" held CCS data.
function SourceHeader({ title, role, sub, tone, feed }: {
  title: string; role: string; sub: string; tone: string; feed: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP[3], marginBottom: SP[4] }}>
      <div style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: tone }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{title}</span>
          <Badge variant="default">{role}</Badge>
          <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)' }}>{feed}</span>
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  )
}

function nairaAxis(v: number) {
  if (v >= 1_000_000_00) return `₦${(v / 1_000_000_00).toFixed(0)}m`
  if (v >= 1_000_00) return `₦${(v / 1_000_00).toFixed(0)}k`
  return v === 0 ? '0' : ''
}

function BarTip({ active, payload, valueKey }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.md,
      padding: '8px 10px', boxShadow: 'var(--card-shadow)', fontSize: TEXT.sm,
    }}>
      <div style={{ fontWeight: FW.semibold, marginBottom: 3 }}>{d.label ?? d.channel ?? d.route}</div>
      <div style={{ color: 'var(--txt2)' }}>{fmtNum(d.txns ?? d.attempts)} transactions</div>
      <div style={{ ...NUM, marginTop: 2 }}>{fmtKobo(d[valueKey])}</div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementsOverview() {
  const navigate = useNavigate()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [d, setD] = useState<Overview3 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD(await apiFetch<Overview3>(`/api/settlements/overview3?date_from=${from}&date_to=${to}`))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const ccs = d?.ccs
  const isw = d?.interswitch
  const ps = d?.paystack
  const link = d?.link

  const ccsBars = (ccs?.routes ?? [])
    .filter(r => r.route !== 'OTHER')
    .map(r => ({ ...r, label: ROUTE_LABEL[r.route] ?? r.route }))
  const iswBars = (isw?.channels ?? []).map(c => ({ ...c, label: c.channel.replace(/_/g, ' ') }))

  const stanRate = link && link.isw_txns > 0
    ? (Number(link.matched_to_ccs) / Number(link.isw_txns)) * 100
    : 0

  const psTotal = ps?.totals
  const providerValue = Number(isw?.totals?.value_kobo ?? 0) + Number(psTotal?.transfer_kobo ?? 0) + Number(psTotal?.funding_kobo ?? 0)

  return (
    <Page
      title="Settlement & Reconciliation"
      subtitle="CCS is the master ledger; Interswitch and Paystack are the payment providers"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Headline: master vs providers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[6] }}>
        <KpiCard label="CCS transactions" value={fmtNum(ccs?.totals?.txns)}
          sub={`${fmtNum(ccs?.totals?.days_with_data)} days with data`} icon="account_balance_wallet" accent={NAVY} loading={loading && !d} />
        <KpiCard label="CCS debits" value={fmtKobo(ccs?.totals?.debit_kobo)}
          sub={`credits ${fmtKobo(ccs?.totals?.credit_kobo)}`} icon="south_west" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Provider volume" value={fmtKobo(providerValue)}
          sub={`Interswitch ${fmtNum(isw?.totals?.txns)} · Paystack ${fmtNum(Number(psTotal?.transfer_n ?? 0) + Number(psTotal?.funding_n ?? 0))}`}
          icon="hub" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Tied to master" value={link ? `${stanRate.toFixed(1)}%` : '—'}
          sub={`${fmtNum(link?.matched_to_ccs)} of ${fmtNum(link?.isw_txns)} Interswitch txns by STAN`}
          icon="link" accent={stanRate >= 90 ? GREEN : stanRate >= 60 ? AMBER : RED} loading={loading && !d} />
      </div>

      {/* ── CCS master ── */}
      <SectionCard style={{ marginBottom: SP[4] }}>
        <SourceHeader
          title="CCS — O3 Card Management System" role="MASTER" tone={NAVY}
          feed="upload · EODTXN Report 620"
          sub={ccs?.totals?.first_day
            ? `Book of record. ${fmtDate(ccs.totals.first_day)} – ${fmtDate(ccs.totals.last_day)}`
            : 'Book of record for every card account transaction'}
        />
        {loading && !d ? <div style={{ padding: SP[5], textAlign: 'center' }}><Spinner /></div>
        : ccsBars.length === 0 ? <EmptyState icon="inbox" title="No CCS data in this period" description="Upload the EODTXN files for these dates." />
        : (
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: SP[5], alignItems: 'center' }}>
            <ResponsiveContainer width="100%" height={40 + ccsBars.length * 40}>
              <BarChart data={ccsBars} layout="vertical" margin={{ top: 4, right: 70, bottom: 4, left: 4 }} barCategoryGap="28%">
                <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
                <XAxis type="number" tickFormatter={nairaAxis} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'var(--row-hvr)' }} content={<BarTip valueKey="value_kobo" />} />
                <Bar dataKey="value_kobo" radius={[0, 4, 4, 0]} barSize={16} fill="var(--sc-1)">
                  <LabelList dataKey="txns" position="right" formatter={(v: number) => `${fmtNum(v)}`}
                    style={{ fontSize: 11, fill: 'var(--txt3)', fontFamily: INTER }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: 'var(--th-bg)' }}>
                  <th style={thBase}>Route</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Txns</th>
                  <th style={{ ...thBase, textAlign: 'right' }}>Value</th>
                </tr></thead>
                <tbody>
                  {(ccs?.routes ?? []).map(r => (
                    <tr key={r.route}>
                      <td style={tdBase}>{ROUTE_LABEL[r.route] ?? r.route}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(r.txns)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtKobo(r.value_kobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Providers side by side ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>

        <SectionCard>
          <SourceHeader
            title="Interswitch" role="PROVIDER" tone="var(--sc-3)"
            feed="upload · settlement reports"
            sub="Card rails — POS, ATM, WEB, Agency. One row per settlement leg."
          />
          {loading && !d ? <div style={{ padding: SP[4], textAlign: 'center' }}><Spinner /></div>
          : iswBars.length === 0 ? (
            <EmptyState icon="upload_file" title="No Interswitch reports loaded"
              description="Import the daily settlement files to populate this."
              action={{ label: 'Import reports', icon: 'upload', onClick: () => navigate('/settlements/runs') }} />
          ) : (
            <>
              <div style={{ display: 'flex', gap: SP[5], marginBottom: SP[4] }}>
                <div><div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Transactions</div>
                  <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold }}>{fmtNum(isw?.totals?.txns)}</div></div>
                <div><div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Gross</div>
                  <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold }}>{fmtKobo(isw?.totals?.value_kobo)}</div></div>
                <div><div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Settlement legs</div>
                  <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold }}>{fmtNum(isw?.totals?.legs)}</div></div>
              </div>
              <ResponsiveContainer width="100%" height={30 + iswBars.length * 32}>
                <BarChart data={iswBars} layout="vertical" margin={{ top: 2, right: 60, bottom: 2, left: 4 }} barCategoryGap="26%">
                  <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
                  <XAxis type="number" tickFormatter={nairaAxis} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" width={130} tick={{ fontSize: 10, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'var(--row-hvr)' }} content={<BarTip valueKey="value_kobo" />} />
                  <Bar dataKey="value_kobo" radius={[0, 4, 4, 0]} barSize={13} fill="var(--sc-3)">
                    <LabelList dataKey="txns" position="right" formatter={(v: number) => fmtNum(v)}
                      style={{ fontSize: 10, fill: 'var(--txt3)', fontFamily: INTER }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
        </SectionCard>

        <SectionCard>
          <SourceHeader
            title="Paystack" role="PROVIDER" tone="var(--sc-2)"
            feed="live API · synced"
            sub="App rails — transfers out and app funding in."
          />
          {loading && !d ? <div style={{ padding: SP[4], textAlign: 'center' }}><Spinner /></div> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
                <div style={{ padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Transfers out</div>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>{fmtKobo(psTotal?.transfer_kobo)}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                    {fmtNum(psTotal?.transfer_n)} paid · <span style={{ color: Number(psTotal?.transfer_failed_n ?? 0) > 0 ? RED : 'var(--txt2)' }}>{fmtNum(psTotal?.transfer_failed_n)} failed</span>
                  </div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Funding in</div>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>{fmtKobo(psTotal?.funding_kobo)}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                    {fmtNum(psTotal?.funding_n)} funded · <span style={{ color: AMBER }}>{fmtNum(psTotal?.funding_lost_n)} lost</span>
                  </div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Settled to bank</div>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>{fmtKobo(psTotal?.settled_kobo)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Open disputes</div>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: Number(psTotal?.open_disputes ?? 0) > 0 ? RED : 'var(--txt)' }}>
                    {fmtNum(psTotal?.open_disputes)}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 6 }}>FUNDING COMPLETION BY CHANNEL</div>
              {(ps?.channels ?? []).length === 0 ? (
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', padding: '8px 0' }}>No funding attempts in this period.</div>
              ) : (ps?.channels ?? []).map(c => {
                const pct = Number(c.completion_pct ?? 0)
                const col = pct >= 60 ? GREEN : pct >= 30 ? AMBER : RED
                return (
                  <div key={c.channel} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, marginBottom: 3 }}>
                      <span style={{ color: 'var(--txt)' }}>{c.channel.replace(/_/g, ' ')}</span>
                      <span style={{ ...NUM, color: col, fontWeight: FW.semibold }}>
                        {pct.toFixed(1)}% <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}>({fmtNum(c.success)}/{fmtNum(c.attempts)})</span>
                      </span>
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: col, borderRadius: 3 }} />
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </SectionCard>
      </div>

      {/* ── How the providers tie back ── */}
      <SectionCard title="Link to the master" subtitle="A provider transaction only counts once it can be tied to a CCS record">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
          <div style={{ padding: SP[4], borderRadius: RADIUS.lg, border: '1px solid var(--bdr)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[2] }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>Interswitch → CCS</span>
              <Badge variant="success" dot>linked</Badge>
            </div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: stanRate >= 90 ? GREEN : AMBER }}>
              {stanRate.toFixed(1)}%
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4 }}>
              Joined on <strong>STAN</strong> — the last 6 digits of the Interswitch RRN, zero-padded to match the CCS trace.
              {' '}{fmtNum(link?.matched_to_ccs)} of {fmtNum(link?.isw_txns)} matched.
            </div>
          </div>
          <div style={{ padding: SP[4], borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', background: 'rgba(217,119,6,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[2] }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>Paystack → CCS</span>
              <Badge variant="warning" dot>no key</Badge>
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
              {link?.paystack_note ?? 'No shared reference between Paystack and the CCS report.'}
              {' '}Until then Paystack is reported on volume only, not reconciled.
            </div>
          </div>
        </div>
        <div style={{ marginTop: SP[4], display: 'flex', gap: SP[2] }}>
          <Button variant="secondary" size="sm" icon="rule" onClick={() => navigate('/settlements/workbench')}>Recon Workbench</Button>
          <Button variant="secondary" size="sm" icon="report" onClick={() => navigate('/settlements/exceptions')}>Exceptions</Button>
          <Button variant="secondary" size="sm" icon="history" onClick={() => navigate('/settlements/runs')}>Runs &amp; Imports</Button>
        </div>
      </SectionCard>
    </Page>
  )
}
