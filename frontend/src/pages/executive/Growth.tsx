import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner } from '../../components/UI'
import SpendingBehaviour from '../../components/SpendingBehaviour'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, INTER, NUM, TEXT, FW, SP } from '../../lib/design'
import { Stat, ytick } from './shared'
import { ECombo, EBar } from '../../components/echarts'

interface ExecGrowth {
  registrations: { this_month: number; last_month: number; ytd: number; total: number }
  transactions: {
    count_this: number; count_last: number
    spend_kobo_this: number; spend_kobo_last: number; inflow_kobo_this: number
    active_this: number; active_last: number
  }
  activity: { total: number; active: number; lapsing: number; dormant: number; never_active: number }
  trend: { month: string; new_accounts: number; active_customers: number; spend_kobo: number; inflow_kobo: number }[]
}

const n = (v: unknown) => Number(v ?? 0) || 0
const pctDelta = (cur: number, prev: number): number | null => prev ? ((cur - prev) / prev) * 100 : null

// Activity bands run healthy → churned, so the colour ramps that way.
const BANDS = [
  { key: 'active',       label: 'Active (≤90d)',   color: GREEN },
  { key: 'lapsing',      label: 'Lapsing (90–365d)', color: AMBER },
  { key: 'dormant',      label: 'Dormant (>1yr)',  color: RED },
  { key: 'never_active', label: 'Never transacted', color: '#94A3B8' },
] as const

export default function ExecGrowth() {
  const [data, setData] = useState<ExecGrowth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<{ data: ExecGrowth }>('/api/executive/growth')
      setData(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const title = 'Customer Growth & Activity: Executive View'
  const back = { label: 'Executive Overview', to: '/' }

  if (loading) return (
    <Page title={title} back={back}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title={title} back={back}>
      <ErrBanner error={error} onRetry={() => load()} />
    </Page>
  )
  if (!data) return null

  const reg = data.registrations
  const txn = data.transactions
  const act = data.activity
  const everActive = n(act.active) + n(act.lapsing) + n(act.dormant)
  const dormantRate = everActive ? (n(act.dormant) / everActive) * 100 : 0
  const bandTotal = n(act.total) || 1
  const regDelta = pctDelta(n(reg.this_month), n(reg.last_month))
  const txnDelta = pctDelta(n(txn.count_this), n(txn.count_last))

  return (
    <Page title={title} back={back}>

      {/* ── Headline ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="New Registrations" value={fmtNum(reg.this_month)} change={regDelta ?? undefined} sub={`${fmtNum(reg.ytd)} YTD`} icon="person_add" accent={NAVY} />
        <KpiCard label="Active Customers" value={fmtNum(act.active)} sub="transacted ≤ 90d" icon="how_to_reg" accent={GREEN} />
        <KpiCard label="Dormant Rate" value={fmtPct(dormantRate)} sub={`${fmtNum(act.dormant)} dormant > 1yr`} icon="trending_down" accent={dormantRate > 40 ? RED : AMBER} />
        <KpiCard label="Transactions" value={fmtNum(txn.count_this)} change={txnDelta ?? undefined} sub="this month" icon="sync_alt" accent={BLUE} />
        <KpiCard label="Card Spend" value={fmtKobo(txn.spend_kobo_this)} sub={`${fmtKobo(txn.inflow_kobo_this)} inflow`} icon="shopping_bag" accent="#7C3AED" />
        <KpiCard label="Total Customers" value={fmtNum(act.total)} sub="on the book" icon="groups" accent={NAVY} />
      </div>

      {/* ── Activity distribution (churn snapshot) ────────────────────────── */}
      <SectionCard title="Activity Distribution" subtitle="Every customer by recency of last transaction — the churn snapshot" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', height: 46, borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
          {BANDS.map(b => {
            const v = n((act as any)[b.key])
            const pct = (v / bandTotal) * 100
            if (pct <= 0) return null
            return (
              <div key={b.key} title={`${b.label}: ${fmtNum(v)} (${fmtPct(pct)})`}
                style={{ flex: pct, background: b.color, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 28 }}>
                {pct > 6 && <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', fontFamily: INTER }}>{fmtPct(pct)}</span>}
              </div>
            )
          })}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3] }}>
          {BANDS.map(b => {
            const v = n((act as any)[b.key])
            return (
              <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: b.color, flexShrink: 0 }} />
                <div>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>{fmtNum(v)}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>{b.label}</div>
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>

      {/* ── Trends ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <SectionCard title="Registrations vs Active" subtitle="New accounts and active customers · 12 months">
          <ECombo
            data={data.trend} xKey="month" height={240} rightAxis
            valueFmt={fmtNum} axisFmt={fmtNum} rightFmt={fmtNum}
            areas={[{ key: 'new_accounts', name: 'New accounts', color: NAVY }]}
            lines={[{ key: 'active_customers', name: 'Active', color: GREEN }]}
          />
        </SectionCard>

        <SectionCard title="Spend vs Inflow" subtitle="Card money out and money in · 12 months">
          <EBar
            data={data.trend} xKey="month" height={240}
            valueFmt={fmtKobo} axisFmt={ytick}
            series={[
              { key: 'spend_kobo', name: 'Spend', color: NAVY },
              { key: 'inflow_kobo', name: 'Inflow', color: GREEN },
            ]}
          />
        </SectionCard>
      </div>

      <div style={{ marginTop: 14 }}>
        <SectionCard title="Registration Momentum">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: SP[5] }}>
            <Stat label="This Month" value={fmtNum(reg.this_month)} sub="new accounts" />
            <Stat label="Last Month" value={fmtNum(reg.last_month)} sub="new accounts" />
            <Stat label="Year to Date" value={fmtNum(reg.ytd)} sub="new accounts" tone={GREEN} />
            <Stat label="Total Book" value={fmtNum(reg.total)} sub="accounts ever opened" />
          </div>
        </SectionCard>
      </div>

      {/* Portfolio-wide spending & behaviour — where the book spends, on what, how, where. */}
      <div style={{ marginTop: 14 }}>
        <SpendingBehaviour title="Customer spending & behaviour" subtitle="Where the book spends, on what and how · last 12 months" />
      </div>
    </Page>
  )
}
