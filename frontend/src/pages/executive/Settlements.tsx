import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExecSettlements {
  paystack_wallet_kobo: number
  nip_success_rate_pct: number
  settled_today_kobo: number
  pending_kobo: number
  failed_count: number
  recon_rate_pct: number
  channel_volumes: { channel: string; volume_kobo: number; count: number; success_rate_pct: number }[]
  daily_trend: { date: string; settled: number; failed: number }[]
  open_exceptions: number
  exception_value_kobo: number
}

type Period = 'mtd' | 'l30d' | 'l90d' | 'ytd'
const PERIOD_OPTIONS: { id: Period; label: string }[] = [
  { id: 'mtd', label: 'MTD' }, { id: 'l30d', label: 'Last 30d' },
  { id: 'l90d', label: 'Last 90d' }, { id: 'ytd', label: 'YTD' },
]

function PeriodFilter({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--chip-bg)', borderRadius: RADIUS.md, padding: 3, border: '1px solid var(--bdr)' }}>
      {PERIOD_OPTIONS.map(opt => (
        <button key={opt.id} onClick={() => onChange(opt.id)} style={{
          padding: '5px 14px', borderRadius: 7, border: 'none',
          fontSize: TEXT.sm, fontWeight: period === opt.id ? FW.bold : FW.medium,
          fontFamily: INTER, cursor: 'pointer',
          background: period === opt.id ? 'var(--card)' : 'transparent',
          color: period === opt.id ? 'var(--txt)' : 'var(--txt2)',
          boxShadow: period === opt.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
          transition: 'all 130ms',
        }}>{opt.label}</button>
      ))}
    </div>
  )
}

function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px', boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.4)', fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: '#fff', fontFamily: INTER, ...NUM }}>{fmt ? fmt(p.value) : p.value}</span>
          {p.name && payload.length > 1 && <span style={{ fontSize: TEXT.xs, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>}
        </div>
      ))}
    </div>
  )
}

export default function ExecSettlements() {
  const [data, setData] = useState<ExecSettlements | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecSettlements }>(`/api/executive/settlements?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Settlements — Executive View'
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

  return (
    <Page title={title} back={back} actions={actions}>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Settled Today"     value={fmtKobo(data.settled_today_kobo)}   sub={`₦${fmtKobo(data.pending_kobo)} pending`}     icon="check_circle"  accent={GREEN} />
        <KpiCard label="Paystack Wallet"   value={fmtKobo(data.paystack_wallet_kobo)}                                                     icon="account_balance" accent={NAVY}  />
        <KpiCard label="NIP Success Rate"  value={fmtPct(data.nip_success_rate_pct)}   sub={`Recon: ${fmtPct(data.recon_rate_pct)}`}      icon="swap_horiz"    accent={data.nip_success_rate_pct < 95 ? AMBER : BLUE} />
        <KpiCard label="Open Exceptions"   value={fmtNum(data.open_exceptions)}        sub={fmtKobo(data.exception_value_kobo)}            icon="error_outline" accent={data.open_exceptions > 0 ? RED : GREEN} />
      </div>

      {/* Settlement trend */}
      <SectionCard title="Daily Settlement Trend" subtitle="Settled vs failed" style={{ marginBottom: 14 }}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data.daily_trend} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
            <defs>
              <linearGradient id="gradSettled" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GREEN} stopOpacity={0.2} />
                <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradFailed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={RED} stopOpacity={0.15} />
                <stop offset="100%" stopColor={RED} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
            <XAxis dataKey="date" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis width={72} tickFormatter={v => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : ''}
              tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip fmt={fmtKobo} />} />
            <Area type="monotone" dataKey="settled" name="Settled" stroke={GREEN} strokeWidth={2.2} fill="url(#gradSettled)"
              dot={false} activeDot={{ r: 4, fill: GREEN, stroke: '#fff', strokeWidth: 2 }} />
            <Area type="monotone" dataKey="failed" name="Failed" stroke={RED} strokeWidth={1.8} fill="url(#gradFailed)"
              dot={false} activeDot={{ r: 4, fill: RED, stroke: '#fff', strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </SectionCard>

      {/* Channel breakdown + Exception summary */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: SP[3] }}>
        <SectionCard title="Channel Breakdown" subtitle="Volume, count and success rate by channel">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Channel', 'Volume', 'Transactions', 'Success Rate', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Channel' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.4 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.channel_volumes.map(ch => {
                const isHealthy = ch.success_rate_pct >= 95
                return (
                  <tr key={ch.channel} style={{ borderBottom: '1px solid var(--bdr)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}>
                    <td style={{ padding: '10px 12px', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{ch.channel}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtKobo(ch.volume_kobo)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtNum(ch.count)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: isHealthy ? GREEN : RED, fontWeight: FW.bold, fontFamily: INTER }}>{fmtPct(ch.success_rate_pct)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER, padding: '2px 8px', borderRadius: 99, background: isHealthy ? 'rgba(22,163,74,0.12)' : 'rgba(192,0,0,0.1)', color: isHealthy ? GREEN : RED }}>
                        {isHealthy ? 'Healthy' : 'Degraded'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </SectionCard>

        <SectionCard title="Exceptions">
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
            <div style={{ borderLeft: `3px solid ${data.open_exceptions > 0 ? RED : GREEN}`, paddingLeft: SP[3] }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Open</div>
              <div style={{ ...NUM, fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: data.open_exceptions > 0 ? RED : GREEN, fontFamily: INTER, lineHeight: 1 }}>{fmtNum(data.open_exceptions)}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 3 }}>unresolved</div>
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4], borderLeft: `3px solid ${AMBER}`, paddingLeft: SP[3] }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', fontFamily: INTER, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>At Risk Value</div>
              <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)', fontFamily: INTER, lineHeight: 1 }}>{fmtKobo(data.exception_value_kobo)}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 3 }}>pending resolution</div>
            </div>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[4] }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                Failed txns: <span style={{ ...NUM, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(data.failed_count)}</span>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
