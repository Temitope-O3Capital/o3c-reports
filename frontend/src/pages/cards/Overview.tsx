import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { NUM, TEXT, FW, SP } from '../../lib/design'
import { CHART_SERIES } from '../../components/charts'
import { EBar, EDonut } from '../../components/echarts'
import { CARD_FAMILIES, CARD_STATE_COLORS, familyColor, familyLabel } from '../../lib/cardProducts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPIs {
  total_issued: number
  active: number
  inactive: number
  activation_rate: number
  unique_merchants: number
}

interface ProductRow { Product_Name?: string; product_name?: string; category?: string; count: number }
interface StatusRow  { Status?: string; Account_Status?: string; status?: string; count: number }
interface VolumeRow  {
  Product_Name?: string; product_name?: string
  volume: number; txn_count: number
}

// ── Chart colours ──────────────────────────────────────────────────────────────
//
// Product colour now comes from the funding family, not a hardcoded map of four
// product names. That map keyed on 'Amex Naira' and 'Amex USD' — both renamed to
// O3 Green years ago and inactive — so most products fell through to grey while
// two dead names held reserved colours.
//
// Status colours follow app.card_book.card_state (Live / Expired / Terminated /
// Legal action / Suspended / Hot listed / Inactive / Unknown), which is what the
// API now returns. The old keys ('Open', 'Closed', 'Legal Suspended') are values
// of the raw status column and no longer appear.

const PIE_FALLBACK = CHART_SERIES

// ── Product table ──────────────────────────────────────────────────────────────

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  { key: 'Product_Name', label: 'Product',
    render: r => {
      const name = r.Product_Name ?? r.product_name ?? '—'
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: familyColor(r.category), flexShrink: 0, display: 'inline-block' }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{name}</span>
        </span>
      )
    },
  },
  { key: 'category', label: 'Family',
    render: r => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{familyLabel(r.category)}</span>
    ),
  },
  { key: 'count', label: 'Cards', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.count)}</span> },
]

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CardsOverview() {
  const [kpis, setKpis]       = useState<KPIs | null>(null)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [statuses, setStatuses] = useState<StatusRow[]>([])
  const [volume, setVolume]     = useState<VolumeRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [k, p, s, v] = await Promise.all([
        apiFetch<any>(`/api/cards/kpis?from=${dateFrom}&to=${dateTo}`),
        apiFetch<any>('/api/cards/by-product'),
        apiFetch<any>('/api/cards/by-status'),
        apiFetch<any>('/api/cards/volume-by-type'),
      ])
      setKpis((k as any)?.data ?? k)
      setProducts(Array.isArray(p) ? p : ((p as any)?.data ?? []))
      setStatuses(Array.isArray(s) ? s : ((s as any)?.data ?? []))
      setVolume(Array.isArray(v) ? v : ((v as any)?.data ?? []))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['cards'] })

  const volumeData = volume.map(r => ({
    name: r.Product_Name ?? r.product_name ?? '?',
    volume: r.volume,
    txns: r.txn_count,
  }))

  // The mix is by FAMILY (credit / prepaid / blink), not by product. With 39
  // products a per-product donut is unreadable, and the three families are the
  // split the business actually thinks in. Rows the catalogue cannot place are
  // shown as Unmatched rather than being folded into a family.
  // Literal hex, not a CSS var: these are canvas fills, where var() does not resolve.
  const pieData = CARD_FAMILIES.map(f => ({
    name: f.label,
    value: products.filter(p => p.category === f.key).reduce((s, p) => s + Number(p.count ?? 0), 0),
    color: f.color,
  })).filter(d => d.value > 0)

  const unmatchedCards = products
    .filter(p => !CARD_FAMILIES.some(f => f.key === p.category))
    .reduce((s, p) => s + Number(p.count ?? 0), 0)
  if (unmatchedCards > 0) pieData.push({ name: 'Unmatched', value: unmatchedCards, color: '#9AA4B8' })

  return (
    <Page title="Cards Overview" subtitle="Card portfolio health and transaction activity" loading={loading && !kpis} skeletonKpis={4} actions={
      <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
    }>
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total Issued" value={fmtNum(kpis?.total_issued ?? 0)} loading={loading} />
        <KpiCard label="Active Cards" value={fmtNum(kpis?.active ?? 0)} loading={loading}
          sub={kpis ? `${fmtPct(kpis.activation_rate)} activation rate` : undefined} />
        <KpiCard label="Inactive" value={fmtNum(kpis?.inactive ?? 0)} loading={loading} />
        <KpiCard label="Unique Merchants" value={fmtNum(kpis?.unique_merchants ?? 0)} loading={loading} />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: SP[4], marginBottom: SP[5] }}>

        {/* Bar: volume by product */}
        <SectionCard title="Transaction Volume by Product">
          {volumeData.length === 0 && !loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No Transaction Data for Current Period
            </div>
          ) : (
            <EBar
              data={volumeData} xKey="name" height={220}
              axisFmt={v => `₦${fmtNum(v / 100)}`}
              series={[
                { key: 'volume', name: 'Volume', fmt: v => `₦${fmtNum(v / 100)}`, colorFn: (_d, i) => PIE_FALLBACK[i % PIE_FALLBACK.length] },
                { key: 'txns', name: 'Txns', color: 'rgba(14,40,65,.15)', fmt: v => fmtNum(v) },
              ]}
            />
          )}
        </SectionCard>

        {/* Donut: card type mix */}
        <SectionCard title="Card Type Mix">
          {pieData.length === 0 && !loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No Product Data
            </div>
          ) : (
            <EDonut
              data={pieData} valueKey="value" nameKey="name" colorFn={(d) => d.color}
              size={220} inner={60} outer={88} legend showPercent={false}
              valueFmt={(v) => fmtNum(v)}
            />
          )}
        </SectionCard>
      </div>

      {/* Status distribution */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>

        <SectionCard title="By Product" badge={products.length} padding={false}>
          <DataTable
            cols={PRODUCT_COLS}
            rows={products}
            keyFn={(r, i) => i}
            loading={loading}
            emptyText="No Product Data"
          />
        </SectionCard>

        <SectionCard title="By Status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {statuses.map((r, i) => {
              const name = r.Status ?? r['Account_Status' as keyof StatusRow] as string ?? r.status ?? '?'
              const c = CARD_STATE_COLORS[name] ?? 'var(--chart-lbl)'
              const total = statuses.reduce((s, x) => s + x.count, 0) || 1
              const pct = (r.count / total) * 100
              return (
                <div key={i}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: TEXT.sm }}>
                    <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{name}</span>
                    <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(r.count)} ({pct.toFixed(1)}%)</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)' }}>
                    <div style={{ height: '100%', borderRadius: 3, background: c, width: `${pct}%`, transition: 'width .4s' }} />
                  </div>
                </div>
              )
            })}
            {statuses.length === 0 && !loading && (
              <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, padding: '24px 0' }}>No Status Data</div>
            )}
          </div>
        </SectionCard>

      </div>
    </Page>
  )
}
