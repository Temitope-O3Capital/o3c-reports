import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPIs {
  total_issued: number
  active: number
  inactive: number
  activation_rate: number
  unique_merchants: number
}

interface ProductRow { Product_Name?: string; product_name?: string; count: number }
interface StatusRow  { Status?: string; Account_Status?: string; status?: string; count: number }
interface VolumeRow  {
  Product_Name?: string; product_name?: string
  volume: number; txn_count: number
}

// ── Chart colours ──────────────────────────────────────────────────────────────

const PRODUCT_COLORS: Record<string, string> = {
  'PREP': NAVY,
  'Amex Naira': RED,
  'Amex USD': BLUE,
  'Classic Accounts': GREEN,
}

const STATUS_COLORS: Record<string, string> = {
  'Open': GREEN, 'Active': GREEN,
  'Inactive': AMBER, 'Closed': 'var(--chart-lbl)', 'Terminated': RED,
  'Legal Suspended': '#7C3AED',
}

const PIE_FALLBACK = [RED, BLUE, GREEN, AMBER, NAVY, '#7C3AED']

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function VolumeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '10px 14px', fontSize: TEXT.sm }}>
      <div style={{ fontWeight: FW.semibold, marginBottom: 4, color: 'var(--txt)' }}>{label}</div>
      <div style={{ color: NAVY }}>Volume: ₦{fmtNum(payload[0]?.value / 100)}</div>
      <div style={{ color: 'var(--txt2)' }}>Txns: {fmtNum(payload[1]?.value ?? 0)}</div>
    </div>
  )
}

// ── Product table ──────────────────────────────────────────────────────────────

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  { key: 'Product_Name', label: 'Product',
    render: r => {
      const name = r.Product_Name ?? r.product_name ?? '—'
      const c = PRODUCT_COLORS[name] ?? '#6B7280'
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0, display: 'inline-block' }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{name}</span>
        </span>
      )
    },
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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [k, p, s, v] = await Promise.all([
        apiFetch<KPIs>('/api/cards/kpis'),
        apiFetch<ProductRow[]>('/api/cards/by-product'),
        apiFetch<StatusRow[]>('/api/cards/by-status'),
        apiFetch<VolumeRow[]>('/api/cards/volume-by-type'),
      ])
      setKpis(k)
      setProducts(Array.isArray(p) ? p : [])
      setStatuses(Array.isArray(s) ? s : [])
      setVolume(Array.isArray(v) ? v : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const volumeData = volume.map(r => ({
    name: r.Product_Name ?? r.product_name ?? '?',
    volume: r.volume,
    txns: r.txn_count,
  }))

  const pieData = products.map((r, i) => {
    const name = r.Product_Name ?? r.product_name ?? '?'
    return { name, value: r.count, color: PRODUCT_COLORS[name] ?? PIE_FALLBACK[i % PIE_FALLBACK.length] }
  })

  return (
    <Page title="Cards Overview" subtitle="Card portfolio health and transaction activity">
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
              No transaction data for current period
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={volumeData} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--txt2)' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--txt2)' }} axisLine={false} tickLine={false}
                  tickFormatter={v => `₦${fmtNum(v / 100)}`} width={70} />
                <Tooltip content={<VolumeTooltip />} cursor={{ fill: 'rgba(14,40,65,.05)' }} />
                <Bar dataKey="volume" radius={[4, 4, 0, 0]}>
                  {volumeData.map((d, i) => (
                    <Cell key={i} fill={PRODUCT_COLORS[d.name] ?? PIE_FALLBACK[i % PIE_FALLBACK.length]} />
                  ))}
                </Bar>
                <Bar dataKey="txns" radius={[4, 4, 0, 0]} fill="rgba(14,40,65,.15)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        {/* Donut: card type mix */}
        <SectionCard title="Card Type Mix">
          {pieData.length === 0 && !loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No product data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="48%" innerRadius={60} outerRadius={88}
                  dataKey="value" paddingAngle={2}>
                  {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v: number, name: string) => [fmtNum(v), name]} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11.5 }} />
              </PieChart>
            </ResponsiveContainer>
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
            emptyText="No product data"
          />
        </SectionCard>

        <SectionCard title="By Status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {statuses.map((r, i) => {
              const name = r.Status ?? r['Account_Status' as keyof StatusRow] as string ?? r.status ?? '?'
              const c = STATUS_COLORS[name] ?? 'var(--chart-lbl)'
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
              <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, padding: '24px 0' }}>No status data</div>
            )}
          </div>
        </SectionCard>

      </div>
    </Page>
  )
}
