import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { PeriodFilter, Tip, Stat, Note, ytick, share, type Period } from './shared'

interface ExecCollections {
  period: { type: string; start: string; end: string }

  // The assigned book — the real collections position.
  assigned_kobo: number
  assigned_count: number
  assigned_target_kobo: number
  agent_count: number
  assigned_ladder: { bucket: string; count: number; value_kobo: number }[]
  top_agents: { name: string; accounts: number; assigned_kobo: number; target_kobo: number; deep_accounts: number }[]

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
}

// Ladder colours run calm → alarming with depth, so the shape reads before the labels.
const BUCKET_COLOR: Record<string, string> = {
  '1-30': GREEN, '31-60': BLUE, '61-90': AMBER,
  '91-180': '#F97316', '181-360': RED, '360+': '#7F1D1D', unclassified: '#94A3B8',
}

export default function ExecCollections() {
  const [data, setData] = useState<ExecCollections | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('mtd')

  const load = useCallback(async (p: Period) => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecCollections }>(`/api/executive/collections?period=${p}`)
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(period) }, [load, period])

  const title = 'Collections: Executive View'
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

      {/* ── The ladder ────────────────────────────────────────────────────── */}
      <SectionCard
        title="Delinquency Ladder"
        subtitle={`${fmtNum(data.assigned_count)} assigned accounts by days past due`}
        style={{ marginBottom: 14 }}
      >
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data.assigned_ladder} margin={{ top: 4, right: 8, bottom: 14, left: 8 }}>
            <CartesianGrid strokeDasharray="0" stroke="var(--chart-grid)" vertical={false} strokeWidth={1} />
            <XAxis dataKey="bucket" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} tickMargin={8} />
            <YAxis width={72} tickFormatter={ytick} tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)', fontFamily: INTER }} axisLine={false} tickLine={false} />
            <Tooltip content={<Tip fmt={fmtKobo} />} cursor={{ fill: 'var(--row-hvr)' }} />
            <Bar dataKey="value_kobo" name="Outstanding" radius={[4, 4, 0, 0]} barSize={54}>
              {data.assigned_ladder.map(b => <Cell key={b.bucket} fill={BUCKET_COLOR[b.bucket] ?? BUCKET_COLOR.unclassified} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

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
                    <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER, fontWeight: FW.medium }}>{a.name}</td>
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
