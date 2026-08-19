import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, PieChart, Pie, Cell, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct, monthStart, today } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ──────────────────────────────────────────────────────────────────────

interface KPIs {
  total_issued:    number
  active:          number
  inactive:        number
  terminated:      number
  legal_suspended: number
  issued_mtd:      number
  activation_rate: number
}

interface IssuanceRow { month: string; issued: number }
interface StatusRow   { status: string; count: number }
interface ProgramRow  {
  program:         string
  total:           number
  active:          number
  inactive:        number
  activation_rate: number
}
interface ProductRow  {
  Product_Name?:   string
  product_name?:   string
  total:           number
  active:          number
  inactive:        number
  activation_rate: number
}

// ── Chart palette ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  Open:           GREEN,  Active:     GREEN,  ACTIVE:     GREEN,
  Inactive:       AMBER,  INACTIVE:   AMBER,
  Closed:         'var(--chart-lbl)', CLOSED: 'var(--chart-lbl)',
  Terminated:     RED,    TERMINATED: RED,
  'LEGAL ACTI':   PURPLE, 'Legal Suspended': PURPLE,
  SUSPENDED:      AMBER,
}

const PIE_FALLBACK = [NAVY, RED, BLUE, GREEN, AMBER, PURPLE, '#0EA5E9', '#06B6D4']

// ── Custom tooltip ─────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)',
      borderRadius: RADIUS.md, padding: '10px 14px', fontSize: TEXT.sm,
    }}>
      <div style={{ fontWeight: FW.semibold, marginBottom: 4, color: 'var(--txt)' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color ?? 'var(--txt2)' }}>
          {p.name}: {fmtNum(p.value)}
        </div>
      ))}
    </div>
  )
}

function EmptyMsg({ text }: { text: string }) {
  return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
      {text}
    </div>
  )
}

// ── Product breakdown table columns ────────────────────────────────────────────

const PRODUCT_COLS: TableCol<ProductRow>[] = [
  {
    key: 'product', label: 'Product',
    render: r => {
      const name = r.Product_Name ?? r.product_name ?? '—'
      return <span style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{name}</span>
    },
  },
  {
    key: 'total', label: 'Total', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.total)}</span>,
  },
  {
    key: 'active', label: 'Active', align: 'right',
    render: r => <span style={{ ...NUM, color: GREEN }}>{fmtNum(r.active)}</span>,
  },
  {
    key: 'inactive', label: 'Inactive', align: 'right',
    render: r => <span style={{ ...NUM, color: AMBER }}>{fmtNum(r.inactive)}</span>,
  },
  {
    key: 'activation_rate', label: 'Activation %', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtPct(r.activation_rate)}</span>,
  },
]

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CardTrends() {
  const [kpis,     setKpis]     = useState<KPIs | null>(null)
  const [issuance, setIssuance] = useState<IssuanceRow[]>([])
  const [statuses, setStatuses] = useState<StatusRow[]>([])
  const [programs, setPrograms] = useState<ProgramRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    const qs = `date_from=${dateFrom}&date_to=${dateTo}`
    try {
      const [k, isr, sd, bp, bpr] = await Promise.all([
        apiFetch<{ data: KPIs          }>(`/api/card-trends/kpis?${qs}`),
        apiFetch<{ data: IssuanceRow[] }>(`/api/card-trends/issuance-trend?${qs}`),
        apiFetch<{ data: StatusRow[]   }>(`/api/card-trends/status-distribution?${qs}`),
        apiFetch<{ data: ProgramRow[]  }>(`/api/card-trends/by-program?${qs}`),
        apiFetch<{ data: ProductRow[]  }>(`/api/card-trends/by-product?${qs}`),
      ])
      setKpis(k?.data ?? null)
      setIssuance(Array.isArray(isr?.data) ? isr.data : [])
      setStatuses(Array.isArray(sd?.data)  ? sd.data  : [])
      setPrograms(Array.isArray(bp?.data)  ? bp.data  : [])
      setProducts(Array.isArray(bpr?.data) ? bpr.data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['cards'] })

  const delinquent = (kpis?.terminated ?? 0) + (kpis?.legal_suspended ?? 0)

  const pieData = statuses.map((r, i) => ({
    name:  r.status ?? '?',
    value: r.count,
    color: STATUS_COLORS[r.status] ?? PIE_FALLBACK[i % PIE_FALLBACK.length],
  }))

  return (
    <Page
      title="Card Trends"
      subtitle="Issuance and portfolio analytics"
      actions={
        <DateFilter
          from={dateFrom} to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t) }}
          align="right"
        />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard
          label="Active Cards"
          value={fmtNum(kpis?.active ?? 0)}
          loading={loading}
        />
        <KpiCard
          label="New Issuances (MTD)"
          value={fmtNum(kpis?.issued_mtd ?? 0)}
          loading={loading}
          sub={kpis ? `${fmtNum(kpis.total_issued)} total issued` : undefined}
        />
        <KpiCard
          label="Activation Rate"
          value={fmtPct(kpis?.activation_rate ?? 0)}
          loading={loading}
        />
        <KpiCard
          label="Terminated / Suspended"
          value={fmtNum(delinquent)}
          loading={loading}
          sub={kpis ? `${fmtNum(kpis.inactive)} inactive` : undefined}
        />
      </div>

      {/* Monthly issuance line chart — full width */}
      <SectionCard title="Monthly Issuance Trend" style={{ marginBottom: SP[5] }}>
        {issuance.length === 0 && !loading
          ? <EmptyMsg text="No issuance data for selected period" />
          : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={issuance} margin={{ top: 4, right: 20, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} width={48}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--bdr)', strokeWidth: 1.5 }} />
                <Line
                  type="monotone" dataKey="issued" name="Cards Issued"
                  stroke={NAVY} strokeWidth={2.5}
                  dot={{ r: 3, fill: NAVY }} activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )
        }
      </SectionCard>

      {/* Status distribution (pie) + By card program (bar) — side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: SP[4], marginBottom: SP[5] }}>

        <SectionCard title="Status Distribution">
          {pieData.length === 0 && !loading
            ? <EmptyMsg text="No status data" />
            : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData} cx="50%" cy="48%"
                    innerRadius={58} outerRadius={86}
                    dataKey="value" paddingAngle={2}
                  >
                    {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v: number, name: string) => [fmtNum(v), name]} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11.5 }} />
                </PieChart>
              </ResponsiveContainer>
            )
          }
        </SectionCard>

        <SectionCard title="By Card Program">
          {programs.length === 0 && !loading
            ? <EmptyMsg text="No program data" />
            : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={programs} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                  <XAxis
                    dataKey="program"
                    tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                    axisLine={false} tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                    axisLine={false} tickLine={false} width={48}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11.5 }} />
                  <Bar dataKey="active"   name="Active"   fill={GREEN} radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="inactive" name="Inactive" fill={AMBER} radius={[4, 4, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            )
          }
        </SectionCard>

      </div>

      {/* By product breakdown table */}
      <SectionCard title="By Product" badge={products.length} padding={false}>
        <DataTable
          cols={PRODUCT_COLS}
          rows={products}
          keyFn={(_, i) => i}
          loading={loading}
          emptyText="No product data"
        />
      </SectionCard>
    </Page>
  )
}
