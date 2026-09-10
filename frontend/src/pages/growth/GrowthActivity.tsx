import { useEffect, useState, useCallback } from 'react'
import { EBar, EChart, baseTooltip, tipCard, type ChartTokens } from '../../components/echarts'
import { Page, SectionCard, Spinner, ErrBanner, EmptyState } from '../../components/UI'
import SpendingBehaviour from '../../components/SpendingBehaviour'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, PURPLE, INTER, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types (pg serialises bigint/numeric as strings — coerce every field) ───────

interface Summary {
  registrations: { this_month: unknown; last_month: unknown; ytd: unknown; total: unknown }
  transactions: {
    count_this: unknown; count_last: unknown
    spend_kobo_this: unknown; spend_kobo_last: unknown; inflow_kobo_this: unknown
    active_this: unknown; active_last: unknown
  }
  activity: { total: unknown; active: unknown; lapsing: unknown; dormant: unknown; never_active: unknown }
}
interface TrendRow {
  month: string
  new_accounts: number; new_customers: number
  txn_count: number; spend_kobo: number; inflow_kobo: number; active_customers: number
  is_gap: boolean
  // null during a feed gap (and the month after one) — churn is unreliable there.
  retained: number | null; reactivated: number | null; churned: number | null
}

const N = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
// Nullable coercion — preserves null (a feed gap) instead of flattening it to 0.
const Nn = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Delta pill (period-over-period) ────────────────────────────────────────────
function Delta({ cur, prev, unit = '%' }: { cur: number; prev: number; unit?: string }) {
  if (!prev) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>no prior period</span>
  const pct = ((cur - prev) / prev) * 100
  const up = pct >= 0
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: SP[1], fontSize: TEXT.xs, fontWeight: FW.semibold, color: up ? GREEN : RED, fontFamily: INTER }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{up ? 'arrow_upward' : 'arrow_downward'}</span>
      <span>{up ? '+' : ''}{pct.toFixed(1)}{unit} vs last month</span>
    </span>
  )
}

// ── KPI card ───────────────────────────────────────────────────────────────────
function KPI({ label, value, sub, icon, color, foot }: {
  label: string; value: string; sub?: string; icon: string; color: string; foot?: React.ReactNode
}) {
  return (
    <div style={{ padding: '20px 22px', borderRight: '1px solid var(--bdr)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER }}>{label}</span>
        <span className="material-symbols-rounded" style={{ fontSize: 17, color, opacity: 0.7 }}>{icon}</span>
      </div>
      <div style={{ ...NUM, fontSize: 28, fontWeight: FW.extrabold, color: 'var(--txt)', letterSpacing: -1, fontFamily: INTER, lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 8, minHeight: 18 }}>
        {foot ?? <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{sub}</span>}
      </div>
    </div>
  )
}

export default function GrowthActivity() {
  const [months, setMonths]   = useState(12)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [trends, setTrends]   = useState<TrendRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async (m: number, silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [s, t] = await Promise.allSettled([
        apiFetch<{ data: Summary }>('/api/growth/summary'),
        apiFetch<{ data: any[] }>(`/api/growth/trends?months=${m}`),
      ])
      if (s.status === 'fulfilled') setSummary(s.value.data)
      if (t.status === 'fulfilled') {
        setTrends((t.value.data ?? []).map(r => ({
          month: r.month,
          new_accounts: N(r.new_accounts), new_customers: N(r.new_customers),
          txn_count: N(r.txn_count), spend_kobo: N(r.spend_kobo), inflow_kobo: N(r.inflow_kobo),
          active_customers: N(r.active_customers),
          is_gap: r.is_gap === true,
          retained: Nn(r.retained), reactivated: Nn(r.reactivated), churned: Nn(r.churned),
        })))
      }
      if (s.status === 'rejected' && t.status === 'rejected') setError('Could not load growth data.')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(months) }, [months, load])

  // ── Derived ──
  const reg = summary?.registrations
  const act = summary?.activity
  const tx  = summary?.transactions

  // Windowed registration totals — the KPI strip ties to the same months toggle as the
  // charts, so nothing on the page reads a different period than the header says.
  const regWindow = trends.reduce((s, r) => s + r.new_accounts, 0)
  const custWindow = trends.reduce((s, r) => s + r.new_customers, 0)

  // retention % per month = retained / (retained + churned) — of last month's actives, who
  // stayed. null (a feed gap) stays null so the line and bars show a break, not a zero.
  const retChart = trends.map(r => {
    const denom = (r.retained ?? 0) + (r.churned ?? 0)
    return {
      ...r,
      retention_pct: (r.retained != null && r.churned != null && denom) ? (r.retained / denom) * 100 : null,
    }
  })
  const gapCount = trends.filter(r => r.is_gap).length
  const txnLastIdx = (trends ?? []).length - 1
  const retLastIdx = (retChart ?? []).length - 1

  const monthsToggle = (
    <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: 3 }}>
      {[6, 12, 24].map(m => (
        <button key={m} onClick={() => setMonths(m)} style={{
          padding: '5px 14px', borderRadius: RADIUS.md, border: 'none', cursor: 'pointer',
          fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: INTER,
          background: months === m ? NAVY : 'transparent',
          color: months === m ? '#fff' : 'var(--txt2)',
        }}>{m}m</button>
      ))}
    </div>
  )

  if (loading) return (
    <Page title="Growth & Activity" actions={monthsToggle}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '100px 0' }}><Spinner size={36} /></div>
    </Page>
  )

  return (
    <Page
      title="Growth & Activity"
      subtitle={act ? `${fmtNum(N(act.total))} customers · registrations, transactions & churn` : undefined}
      actions={monthsToggle}
    >
      <ErrBanner error={error} onRetry={() => load(months)} />

      {/* ── KPI strip — growth headline (registrations). Transaction/spend/activity
             metrics live once, in the Spending & Behaviour section below. ──────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
        borderRadius: RADIUS.xl, marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <KPI label="New (month to date)" icon="person_add" color={NAVY}
          value={reg ? fmtNum(N(reg.this_month)) : '—'}
          foot={reg ? <Delta cur={N(reg.this_month)} prev={N(reg.last_month)} /> : undefined} />
        <KPI label={`Registered · ${months}mo`} icon="how_to_reg" color={BLUE}
          value={fmtNum(regWindow)} sub="new accounts in window" />
        <KPI label={`New Customers · ${months}mo`} icon="groups" color={GREEN}
          value={fmtNum(custWindow)} sub="first-time onboarded" />
        <KPI label="Registered YTD" icon="calendar_month" color={PURPLE}
          value={reg ? fmtNum(N(reg.ytd)) : '—'} sub="this year" />
        <KPI label="Total Book" icon="account_balance" color={AMBER}
          value={act ? fmtNum(N(act.total)) : '—'} sub="customers ever onboarded" />
      </div>

      {/* ── Monthly momentum — this month so far vs last month's full total. Surfaces
             the transaction signal (spend, inflow, active, count) alongside registrations. ── */}
      {tx && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '2px 2px 8px' }}>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: INTER }}>Monthly momentum</span>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>this month is still in progress — deltas compare against last month's full total</span>
          </div>
          <div style={{
            background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
            borderRadius: RADIUS.xl, marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          }}>
            <KPI label="Spend · MTD" icon="payments" color={RED}
              value={fmtKobo(N(tx.spend_kobo_this))}
              foot={<Delta cur={N(tx.spend_kobo_this)} prev={N(tx.spend_kobo_last)} />} />
            <KPI label="Money In · MTD" icon="savings" color={GREEN}
              value={fmtKobo(N(tx.inflow_kobo_this))} sub="repayments & loads" />
            <KPI label="Active Cards · MTD" icon="credit_card" color={BLUE}
              value={fmtNum(N(tx.active_this))}
              foot={<Delta cur={N(tx.active_this)} prev={N(tx.active_last)} />} />
            <KPI label="Transactions · MTD" icon="receipt_long" color={NAVY}
              value={fmtNum(N(tx.count_this))}
              foot={<Delta cur={N(tx.count_this)} prev={N(tx.count_last)} />} />
          </div>
        </>
      )}

      {/* ── Registrations (windowed) ──────────────────────────────────────── */}
      <SectionCard title="Registrations" subtitle={`New card accounts onboarded per month · last ${months} months`} style={{ marginBottom: 14 }}>
        {trends.length === 0 ? (
          <EmptyState icon="how_to_reg" title="No registrations in this window" description="No new accounts were onboarded in the selected period." />
        ) : (
          <EBar
            data={trends} xKey="month" height={230} leftMargin={0}
            valueFmt={(v) => `${fmtNum(v)} new`}
            series={[{ key: 'new_accounts', name: 'New accounts', color: NAVY }]}
          />
        )}
      </SectionCard>

      {/* ── Churn & retention ─────────────────────────────────────────────── */}
      <SectionCard title="Churn & Retention"
        subtitle={gapCount > 0
          ? `Active customers each month — retained, returning, churned · ${gapCount} feed-gap month${gapCount > 1 ? 's' : ''} omitted`
          : 'Active customers each month — retained, returning, and churned'}
        actions={
          <div style={{ display: 'flex', gap: SP[3] }}>
            {[{ c: GREEN, l: 'Retained' }, { c: BLUE, l: 'New / Returning' }, { c: RED, l: 'Churned' }, { c: AMBER, l: 'Retention %' }].map(({ c, l }) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                <div style={{ width: 10, height: 3, borderRadius: 2, background: c }} />{l}
              </div>
            ))}
          </div>
        }>
        {trends.length === 0 ? (
          <EmptyState icon="show_chart" title="No activity in this window" description="Churn and retention need at least one month of transaction activity." />
        ) : (
        <EChart height={250} option={(t: ChartTokens) => ({
          grid: { top: 10, right: 44, bottom: 24, left: 8, containLabel: true },
          tooltip: {
            trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
            formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), ps.map((p) => ({
              color: p.color, name: p.seriesName,
              value: p.seriesName === 'Retention %' ? fmtPct(Number(p.value)) : `${fmtNum(Number(p.value))} customers`,
            }))),
          },
          xAxis: { type: 'category', data: retChart.map((d: any) => d.month), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.lbl, fontSize: 11, fontFamily: 'Segoe UI, sans-serif' } },
          yAxis: [
            { type: 'value', axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.lbl, fontSize: 10, fontFamily: 'Segoe UI, sans-serif', formatter: (v: number) => fmtNum(v) }, splitLine: { lineStyle: { color: t.grid } } },
            { type: 'value', min: 0, max: 100, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.lbl, fontSize: 10, fontFamily: 'Segoe UI, sans-serif', formatter: '{value}%' }, splitLine: { show: false } },
          ],
          series: [
            { type: 'bar', name: 'Retained', stack: 'a', data: retChart.map((d: any) => d.retained), itemStyle: { color: GREEN } },
            { type: 'bar', name: 'New / Returning', stack: 'a', data: retChart.map((d: any) => d.reactivated), itemStyle: { color: BLUE } },
            { type: 'bar', name: 'Churned', stack: 'a', data: retChart.map((d: any) => d.churned), itemStyle: { color: RED, borderRadius: [4, 4, 0, 0] } },
            { type: 'line', name: 'Retention %', yAxisIndex: 1, data: retChart.map((d: any) => d.retention_pct), smooth: true, smoothMonotone: 'x', symbolSize: 6, lineStyle: { width: 2.4, color: AMBER }, itemStyle: { color: AMBER }, connectNulls: false },
          ],
          animationDuration: 700,
        })} />
        )}
      </SectionCard>

      {/* Spending & behaviour — the single home for transaction/spend/activity metrics
          (merchants, categories, channels, recency cohorts), tied to the window above. */}
      <div style={{ marginTop: 14 }}>
        <SpendingBehaviour title="Transaction, Spending & Behaviour" subtitle={`Where customers spend, on what, how — and who's active · last ${months} months`} months={months} />
      </div>

    </Page>
  )
}
