import { useEffect, useState } from 'react'
import { EBar } from './echarts'
import { SectionCard, KpiCard, Sk, EmptyState } from './UI'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtNum, n } from '../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, RADIUS } from '../lib/design'
import { mccName } from '../lib/mcc'
import { currencyName } from '../lib/currency'

// Portfolio-wide spending & behaviour — the aggregated twin of Customer 360's per-customer
// panel. Drops into any page (Executive Growth, the Growth monitor, the Customer Behaviour
// page) as one self-contained block. Reads GET /api/growth/behaviour (money in *_kobo,
// spend = money out). Charts use the ECharts wrapper to match the rest of the page.
//
// A note on units: "customers" in the source is COUNT(DISTINCT cif) and a CIF is a card,
// so the windowed KPIs count CARDS. Only the recency cohort, which can roll cards up to a
// person, offers a People/Cards toggle — and it is all-time, not windowed.

interface Cohort { active: number; lapsing: number; dormant: number; never: number }
interface Behaviour {
  totals?: { txns: number; spend_txns: number; spend_kobo: number; inflow_kobo: number; active_customers: number; merchants: number; first_txn: string; last_txn: string }
  cohorts?: Cohort
  cohorts_person?: Cohort
  top_merchants?: { merchant: string; txns: number; spend_kobo: number }[]
  by_category?: { mcc: string; txns: number; spend_kobo: number }[]
  by_channel?: { channel: string; txns: number; spend_kobo: number }[]
  by_city?: { city: string; txns: number; spend_kobo: number }[]
  by_currency?: { currency_code: string; txns: number; spend_kobo: number; inflow_kobo: number }[]
  by_type?: { txn_type: string; txns: number; spend_kobo: number }[]
  // On cash-advance rows the feed's narrative field carries the ATM's location.
  top_atm_locations?: { location: string; txns: number; amount_kobo: number }[]
  monthly?: { month: string; spend_kobo: number; inflow_kobo: number; active: number }[]
}


function initCap(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—' }

function BarList({ items, color }: { items: { label: string; value: number; sub: string }[]; color: string }) {
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: TEXT.sm, marginBottom: 3 }}>
            <span style={{ color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
            <span style={{ ...NUM, color: 'var(--txt2)', flexShrink: 0 }}>{it.sub}</span>
          </div>
          <div style={{ height: 6, background: 'var(--chip-bg)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, (it.value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function SpendingBehaviour({ title = 'Spending & Behaviour', subtitle, months }: {
  title?: string; subtitle?: string; months?: number
}) {
  const [b, setB] = useState<Behaviour | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // A CIF is a card and a person holds many, so the recency cohorts can be counted either
  // way. Default to people (what "customers" means to a reader); toggle switches instantly
  // (both sets come in one response — no refetch).
  const [cohortUnit, setCohortUnit] = useState<'card' | 'person'>('person')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    apiFetch<any>(`/api/growth/behaviour${months ? `?months=${months}` : ''}`)
      .then(r => { if (!cancelled) setB(r?.data ?? r) })
      .catch(e => { if (!cancelled) setErr(e?.message ?? 'Could not load behaviour analytics') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [months])

  const t = b?.totals
  const merchants = b?.top_merchants ?? []
  const cats = b?.by_category ?? []
  const channels = b?.by_channel ?? []
  const cities = b?.by_city ?? []
  const currencies = b?.by_currency ?? []
  const types = b?.by_type ?? []
  const atmLocations = b?.top_atm_locations ?? []
  // More than one currency present means the KPI row above is summing across
  // currencies — say so rather than letting it read as one number.
  const mixedCurrency = currencies.filter(c => n(c.txns) > 0).length > 1
  const monthly = (b?.monthly ?? []).map(m => ({ month: m.month.slice(2), spend: n(m.spend_kobo), inflow: n(m.inflow_kobo) }))
  const span = t ? `${t.first_txn?.slice(0, 10)} → ${t.last_txn?.slice(0, 10)}` : ''

  // Frequency / recency derived metrics (all card-level).
  const spendKobo = n(t?.spend_kobo), spendTxns = n(t?.spend_txns), activeCards = n(t?.active_customers)
  const avgBasketKobo = spendTxns > 0 ? Math.round(spendKobo / spendTxns) : 0
  const spendPerCardKobo = activeCards > 0 ? Math.round(spendKobo / activeCards) : 0
  const txnsPerCard = activeCards > 0 ? (n(t?.txns) / activeCards) : 0

  const co = cohortUnit === 'person' ? (b?.cohorts_person ?? b?.cohorts) : b?.cohorts
  const coTotal = co ? n(co.active) + n(co.lapsing) + n(co.dormant) + n(co.never) : 0
  const cohortRows = co ? [
    { label: 'Active', hint: '≤ 90 days', value: n(co.active), color: GREEN },
    { label: 'Lapsing', hint: '90–365 days', value: n(co.lapsing), color: AMBER },
    { label: 'Dormant', hint: '> 1 year', value: n(co.dormant), color: RED },
    { label: 'Never', hint: 'no transaction', value: n(co.never), color: '#94A3B8' },
  ] : []

  const hasDistribution = merchants.length > 0 || cats.length > 0 || channels.length > 0
    || cities.length > 0 || types.length > 0 || currencies.length > 0 || atmLocations.length > 0
  const isEmpty = !loading && !err && n(t?.txns) === 0 && !hasDistribution && monthly.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionCard title={title} subtitle={subtitle ?? (span ? `Card & account activity · ${span}` : 'Card & account activity')}>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            {Array.from({ length: 6 }).map((_, i) => <Sk key={i} h={78} />)}
          </div>
        ) : err ? (
          <div style={{ fontSize: TEXT.sm, color: RED }}>{err}</div>
        ) : isEmpty ? (
          <EmptyState icon="receipt_long" title="No Transactions in This Window"
            description="No card or account activity was recorded for the selected period. Widen the window or check that the transaction feed has delivered." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <KpiCard label="Total Spend" value={fmtKobo(t?.spend_kobo ?? 0)} sub="money out" icon="payments" accent={RED} />
            <KpiCard label="Money In" value={fmtKobo(t?.inflow_kobo ?? 0)} sub="repayments & loads" icon="savings" accent={GREEN} />
            <KpiCard label="Avg Basket" value={fmtKobo(avgBasketKobo)} sub="per purchase" icon="shopping_cart" accent={PURPLE} />
            <KpiCard label="Spend / Card" value={fmtKobo(spendPerCardKobo)} sub={`${txnsPerCard.toFixed(1)} txns / active card`} icon="account_balance_wallet" accent={AMBER} />
            <KpiCard label="Transactions" value={fmtNum(t?.txns ?? 0)} sub={`${fmtNum(t?.merchants ?? 0)} merchants`} icon="receipt_long" accent={NAVY} />
            <KpiCard label="Active Cards" value={fmtNum(t?.active_customers ?? 0)} sub="transacted in window" icon="credit_card" accent={BLUE} />
          </div>
        )}
      </SectionCard>

      {!loading && !err && hasDistribution && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          {merchants.length > 0 && (
            <SectionCard title="Top Merchants" subtitle="Card purchases only, by spend">
              {/* Purchases only: on other transaction types the same field holds a
                  transfer narrative, the staff member who posted a payment, or an
                  ATM location — which used to rank as "merchants". */}
              <BarList color={NAVY} items={merchants.slice(0, 10).map(m => ({ label: m.merchant || '—', value: n(m.spend_kobo), sub: fmtKobo(m.spend_kobo) }))} />
            </SectionCard>
          )}
          {atmLocations.length > 0 && (
            <SectionCard title="Cash Withdrawal Locations" subtitle="ATMs where customers take out cash, by volume">
              <BarList color={NAVY} items={atmLocations.map(l => ({ label: l.location || '—', value: n(l.txns), sub: `${fmtNum(l.txns)}× · ${fmtKobo(l.amount_kobo)}` }))} />
            </SectionCard>
          )}
          {cats.length > 0 && (
            <SectionCard title="Spending by Category" subtitle="Merchant category (MCC), by spend">
              <BarList color={PURPLE} items={cats.map(c => ({ label: mccName(c.mcc), value: n(c.spend_kobo), sub: fmtKobo(c.spend_kobo) }))} />
            </SectionCard>
          )}
          {channels.length > 0 && (
            <SectionCard title="How Customers Transact" subtitle="By channel, by volume">
              <BarList color={BLUE} items={channels.map(c => ({ label: initCap(c.channel), value: n(c.txns), sub: `${fmtNum(c.txns)}×` }))} />
            </SectionCard>
          )}
          {types.length > 0 && (
            <SectionCard title="What Customers Did" subtitle="ATM, POS, transfer, bills — from the transaction code">
              <BarList color={NAVY} items={types.map(t => ({ label: t.txn_type, value: n(t.txns), sub: `${fmtNum(t.txns)}×` }))} />
            </SectionCard>
          )}
          {cities.length > 0 && (
            /* Field 13 of the feed is a packed merchant/terminal location string, not a
               city — values like "La", "Lagos Stat", "Lekki Expre". Labelled for what it
               is rather than implying clean geography. */
            <SectionCard title="Merchant Location" subtitle="As supplied by the terminal — unnormalised">
              <BarList color={GREEN} items={cities.map(c => ({ label: c.city || '—', value: n(c.txns), sub: `${fmtNum(c.txns)}×` }))} />
            </SectionCard>
          )}
          {currencies.length > 0 && (
            <SectionCard title="Currency Mix"
              subtitle={mixedCurrency ? 'The totals above combine these' : 'ISO-4217, from the account'}>
              <BarList color={AMBER} items={currencies.map(c => ({
                label: currencyName(c.currency_code),
                value: n(c.txns),
                sub: `${fmtNum(c.txns)}× · ${currencyName(c.currency_code)} ${fmtNum(Math.round(n(c.spend_kobo) / 100))}`,
              }))} />
              {mixedCurrency && (
                <div style={{ marginTop: 10, fontSize: TEXT.xs, color: AMBER }}>
                  Amounts are not converted — USD and NGN figures are reported as supplied by the feed.
                </div>
              )}
            </SectionCard>
          )}
          {coTotal > 0 && (
            <SectionCard title="Customer Activity" subtitle={`All-time recency · counting ${cohortUnit === 'person' ? 'people' : 'cards'}`}
              actions={
                <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: 2 }}>
                  {(['person', 'card'] as const).map(u => (
                    <button key={u} onClick={() => setCohortUnit(u)} style={{
                      padding: '3px 11px', borderRadius: 5, border: 'none', cursor: 'pointer',
                      fontSize: TEXT.xs, fontWeight: FW.semibold,
                      background: cohortUnit === u ? NAVY : 'transparent',
                      color: cohortUnit === u ? '#fff' : 'var(--txt2)',
                    }}>{u === 'person' ? 'People' : 'Cards'}</button>
                  ))}
                </div>
              }>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {cohortRows.map(r => {
                  const pct = coTotal > 0 ? (r.value / coTotal) * 100 : 0
                  return (
                    <div key={r.label}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: TEXT.sm, marginBottom: 3 }}>
                        <span style={{ color: 'var(--txt)' }}>{r.label} <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>{r.hint}</span></span>
                        <span style={{ ...NUM, color: 'var(--txt2)', flexShrink: 0 }}>{fmtNum(r.value)} · {pct.toFixed(0)}%</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--chip-bg)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.max(1, pct)}%`, height: '100%', background: r.color, borderRadius: 3 }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </SectionCard>
          )}
        </div>
      )}

      {!loading && !err && monthly.length > 1 && (
        <SectionCard title="Money Out vs In" subtitle="Monthly card & account cashflow — the latest month is partial">
          <EBar
            data={monthly} xKey="month" height={260} leftMargin={0}
            valueFmt={(v) => fmtKobo(v)} axisFmt={(v) => fmtKobo(v).replace(/\.00$/, '')}
            series={[
              { key: 'spend', name: 'Money Out', color: RED },
              { key: 'inflow', name: 'Money In', color: GREEN },
            ]}
          />
        </SectionCard>
      )}
    </div>
  )
}
