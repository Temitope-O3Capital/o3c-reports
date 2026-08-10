import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell, LabelList,
} from 'recharts'
import {
  Page, KpiCard, SectionCard, ErrBanner, Spinner, EmptyState, DateFilter, Button,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Totals {
  funding_in_kobo: number
  funding_in_n: number
  fees_kobo: number
  transfers_out_kobo: number
  transfers_out_n: number
  settled_kobo: number
  settled_n: number
  net_kobo: number
}

interface SeriesPoint {
  day: string
  funding_in_kobo: number
  transfers_out_kobo: number
  settled_kobo: number
}

interface Unreconciled {
  open_n: number
  open_value_kobo: number
  aged_30d_n: number
}

interface PositionResp {
  period: { from: string; to: string }
  totals: Totals
  series: SeriesPoint[]
  unreconciled: Unreconciled
}

interface ChannelRow {
  channel: string
  attempts: number
  success: number
  abandoned: number
  failed: number
  success_kobo: number
  lost_kobo: number
  completion_pct: number
}

// ── Chart chrome ──────────────────────────────────────────────────────────────

// Series slots are assigned in fixed order and never cycled. Both themes are
// validated against their own card surface (see LIGHT/DARK in lib/design).
const SERIES = [
  { key: 'funding_in_kobo',    name: 'Funding in',     color: 'var(--sc-2)' },
  { key: 'transfers_out_kobo', name: 'Transfers out',  color: 'var(--sc-1)' },
  { key: 'settled_kobo',       name: 'Settled to bank', color: 'var(--sc-3)' },
] as const

function nairaAxis(v: number) {
  if (v >= 1_000_000_00) return `₦${(v / 1_000_000_00).toFixed(0)}m`
  if (v >= 1_000_00) return `₦${(v / 1_000_00).toFixed(0)}k`
  return v === 0 ? '0' : ''
}

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      borderRadius: RADIUS.md, padding: '8px 10px', boxShadow: 'var(--card-shadow)',
    }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          <span style={{ color: 'var(--txt2)' }}>{p.name}</span>
          <span style={{ ...NUM, color: 'var(--txt)', fontWeight: FW.semibold, marginLeft: 'auto' }}>
            {fmtKobo(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

const tdBase: React.CSSProperties = {
  padding: '9px 14px', fontSize: TEXT.sm, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)',
}
const thBase: React.CSSProperties = {
  padding: '9px 14px', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
  textAlign: 'left', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
}

// Completion is a rate, so it gets its own single-hue treatment rather than a
// categorical slot — and the poor performers are called out with status colour.
function completionColor(pct: number) {
  return pct >= 60 ? GREEN : pct >= 30 ? AMBER : RED
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementPosition() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [pos, setPos] = useState<PositionResp | null>(null)
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = `date_from=${from}&date_to=${to}`
      const [position, funnel] = await Promise.all([
        apiFetch<PositionResp>(`/api/paystack/position?${p}`),
        apiFetch<{ by_channel: ChannelRow[] }>(`/api/paystack/funnel?${p}`),
      ])
      setPos(position)
      setChannels(funnel.by_channel ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const t = pos?.totals
  const unrec = pos?.unreconciled
  const series = (pos?.series ?? []).map(s => ({ ...s, day: fmtDate(s.day, { day: '2-digit', month: 'short' }) }))
  const worst = channels.length
    ? [...channels].sort((a, b) => Number(a.completion_pct) - Number(b.completion_pct))[0]
    : null

  return (
    <Page
      title="Settlement Position"
      subtitle="What came in, what went out, and what is still unreconciled"
      actions={<DateFilter from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[6] }}>
        <KpiCard label="Funding in" value={fmtKobo(t?.funding_in_kobo)} sub={`${fmtNum(t?.funding_in_n)} successful`} icon="south_west" accent={GREEN} loading={loading && !pos} />
        <KpiCard label="Transfers out" value={fmtKobo(t?.transfers_out_kobo)} sub={`${fmtNum(t?.transfers_out_n)} paid`} icon="north_east" accent={NAVY} loading={loading && !pos} />
        <KpiCard label="Settled to bank" value={fmtKobo(t?.settled_kobo)} sub={`${fmtNum(t?.settled_n)} settlements · ${fmtKobo(t?.fees_kobo)} fees`} icon="account_balance" accent={NAVY} loading={loading && !pos} />
        <KpiCard
          label="Unreconciled"
          value={fmtKobo(unrec?.open_value_kobo)}
          sub={`${fmtNum(unrec?.open_n)} open · ${fmtNum(unrec?.aged_30d_n)} over 30 days`}
          icon="rule"
          accent={Number(unrec?.aged_30d_n ?? 0) > 0 ? RED : AMBER}
          loading={loading && !pos}
        />
      </div>

      <SectionCard
        title="Daily flow"
        subtitle="Funding in, transfers out and settlements to the bank — all in naira, one scale"
        style={{ marginBottom: SP[4] }}
        actions={
          <Button variant="secondary" size="sm" icon={showTable ? 'show_chart' : 'table_rows'}
            onClick={() => setShowTable(s => !s)}>
            {showTable ? 'Chart' : 'Table'}
          </Button>
        }
      >
        {loading && !pos ? (
          <div style={{ padding: SP[5], textAlign: 'center' }}><Spinner /></div>
        ) : series.length === 0 ? (
          <EmptyState icon="show_chart" title="No activity" description="Nothing moved in this period." />
        ) : showTable ? (
          <div style={{ overflowX: 'auto', maxHeight: 320 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--th-bg)' }}>
                  <th style={thBase}>Day</th>
                  {SERIES.map(s => <th key={s.key} style={{ ...thBase, textAlign: 'right' }}>{s.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {series.map(row => (
                  <tr key={row.day}>
                    <td style={tdBase}>{row.day}</td>
                    {SERIES.map(s => (
                      <td key={s.key} style={{ ...tdBase, textAlign: 'right', ...NUM }}>
                        {fmtKobo((row as any)[s.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
              <XAxis dataKey="day" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                axisLine={false} tickLine={false} tickMargin={8} minTickGap={24} />
              <YAxis width={72} tickFormatter={nairaAxis}
                tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                axisLine={false} tickLine={false} />
              <Tooltip content={<Tip />} cursor={{ stroke: 'var(--chart-grid)', strokeWidth: 1 }} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: TEXT.xs, color: 'var(--txt2)' }} />
              {SERIES.map(s => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.name}
                  stroke={s.color} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </SectionCard>

      <SectionCard
        title="Funding completion by channel"
        subtitle="Share of funding attempts that complete — the gap here is lost revenue, not a settlement problem"
      >
        {loading && !channels.length ? (
          <div style={{ padding: SP[5], textAlign: 'center' }}><Spinner /></div>
        ) : channels.length === 0 ? (
          <EmptyState icon="donut_small" title="No funding attempts" description="Nothing to analyse in this period." />
        ) : (
          <>
            {worst && Number(worst.completion_pct) < 30 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[4],
                padding: '10px 12px', borderRadius: RADIUS.md,
                background: 'rgba(192,0,0,0.06)', border: '1px solid rgba(192,0,0,0.14)',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: RED }}>warning</span>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
                  <strong>{worst.channel}</strong> completes only {Number(worst.completion_pct).toFixed(1)}% of
                  attempts — {fmtNum(worst.abandoned)} abandoned and {fmtNum(worst.failed)} failed,
                  worth {fmtKobo(worst.lost_kobo)}.
                </span>
              </div>
            )}
            <ResponsiveContainer width="100%" height={40 + channels.length * 44}>
              <BarChart data={channels} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 8 }}
                barCategoryGap="30%">
                <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" horizontal={false} strokeWidth={1} />
                <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                  axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="channel" width={110}
                  tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }}
                  axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--row-hvr)' }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null
                    const c: ChannelRow = payload[0].payload
                    return (
                      <div style={{
                        background: 'var(--card)', border: '1px solid var(--card-bdr)',
                        borderRadius: RADIUS.md, padding: '8px 10px', boxShadow: 'var(--card-shadow)', fontSize: TEXT.sm,
                      }}>
                        <div style={{ fontWeight: FW.semibold, marginBottom: 4 }}>{c.channel}</div>
                        <div style={{ color: 'var(--txt2)' }}>{fmtNum(c.success)} of {fmtNum(c.attempts)} completed</div>
                        <div style={{ color: 'var(--txt2)' }}>{fmtNum(c.abandoned)} abandoned · {fmtNum(c.failed)} failed</div>
                        <div style={{ ...NUM, marginTop: 4 }}>{fmtKobo(c.success_kobo)} funded</div>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="completion_pct" name="Completion" radius={[0, 4, 4, 0]} barSize={18}>
                  {channels.map(c => (
                    <Cell key={c.channel} fill={completionColor(Number(c.completion_pct))} />
                  ))}
                  <LabelList dataKey="completion_pct" position="right"
                    formatter={(v: number) => `${Number(v).toFixed(1)}%`}
                    style={{ fontSize: 11, fill: 'var(--txt2)', fontFamily: INTER }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <div style={{ overflowX: 'auto', marginTop: SP[4] }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    <th style={thBase}>Channel</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Attempts</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Completed</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Abandoned</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Failed</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Funded</th>
                    <th style={{ ...thBase, textAlign: 'right' }}>Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map(c => (
                    <tr key={c.channel}>
                      <td style={tdBase}>{c.channel}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(c.attempts)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(c.success)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(c.abandoned)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtNum(c.failed)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM }}>{fmtKobo(c.success_kobo)}</td>
                      <td style={{ ...tdBase, textAlign: 'right', ...NUM, fontWeight: FW.semibold, color: completionColor(Number(c.completion_pct)) }}>
                        {Number(c.completion_pct).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>
    </Page>
  )
}
