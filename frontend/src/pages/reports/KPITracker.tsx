import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, FilterBar, filterInputStyle, ErrBanner, Sk } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, n } from '../../lib/fmt'
import { GREEN, AMBER, RED, INTER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

type KPIValues = Record<string, number>

interface KPIHistoryRow {
  period_label: string
  [key: string]: number | string
}

type KPIFormat = 'kobo' | 'num' | 'pct'

interface KPIDef {
  key: string
  label: string
  format: KPIFormat
  target_key: string
  lower_is_better?: boolean
}

// ── KPI definitions ───────────────────────────────────────────────────────────

const KPI_DEFS: KPIDef[] = [
  { key: 'total_disbursed_kobo',  label: 'Total Disbursed',   format: 'kobo', target_key: 'target_disbursed_kobo' },
  { key: 'active_loans',          label: 'Active Loans',       format: 'num',  target_key: 'target_active_loans' },
  { key: 'npl_ratio_pct',         label: 'NPL Ratio',          format: 'pct',  target_key: 'target_npl_pct',           lower_is_better: true },
  { key: 'par30_pct',             label: 'PAR30 Rate',         format: 'pct',  target_key: 'target_par30_pct',         lower_is_better: true },
  { key: 'collection_rate_pct',   label: 'Collection Rate',    format: 'pct',  target_key: 'target_collection_pct' },
  { key: 'recovery_rate_pct',     label: 'Recovery Rate',      format: 'pct',  target_key: 'target_recovery_pct' },
  { key: 'csat_score',            label: 'CSAT Score',         format: 'num',  target_key: 'target_csat' },
  { key: 'new_customers',         label: 'New Customers',      format: 'num',  target_key: 'target_new_customers' },
  { key: 'active_cards',          label: 'Active Cards',       format: 'num',  target_key: 'target_active_cards' },
  { key: 'revenue_kobo',          label: 'Revenue',            format: 'kobo', target_key: 'target_revenue_kobo' },
]

const PERIOD_OPTIONS = [
  { value: 'this_month',    label: 'This Month' },
  { value: 'last_month',    label: 'Last Month' },
  { value: 'this_quarter',  label: 'This Quarter' },
  { value: 'last_quarter',  label: 'Last Quarter' },
  { value: 'this_year',     label: 'This Year' },
]

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(val: number, format: KPIFormat): string {
  if (format === 'kobo') return fmtKobo(val)
  if (format === 'pct')  return fmtPct(val)
  return fmtNum(val)
}

// ── RAG dot ───────────────────────────────────────────────────────────────────

function RagDot({ value, target, lowerIsBetter }: { value: number; target: number; lowerIsBetter?: boolean }) {
  let color = RED
  if (target === 0) {
    color = GREEN
  } else if (lowerIsBetter) {
    const ratio = value / target
    color = ratio <= 1 ? GREEN : ratio <= 1.25 ? AMBER : RED
  } else {
    const pct = (value / target) * 100
    color = pct >= 100 ? GREEN : pct >= 80 ? AMBER : RED
  }
  return (
    <div style={{
      width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0,
      boxShadow: `0 0 0 2px ${color}22`,
    }} />
  )
}

// ── MoM change indicator ──────────────────────────────────────────────────────

function MoMChange({ pct }: { pct: number }) {
  const positive = pct >= 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: TEXT.xs, fontWeight: FW.semibold, fontFamily: INTER, color: positive ? GREEN : RED }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm }}>{positive ? 'arrow_upward' : 'arrow_downward'}</span>
      {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

// ── KPI Card (custom, not KpiCard from UI — we need RAG + target) ─────────────

function KPICard({ def, values, loading }: { def: KPIDef; values: KPIValues; loading: boolean }) {
  const val = n(values[def.key])
  const target = n(values[def.target_key])
  const momKey = `${def.key}_mom_pct`
  const mom = n(values[momKey])

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
      borderRadius: RADIUS.xl, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', letterSpacing: '0.3px', textTransform: 'uppercase' }}>
        {def.label}
      </span>
      {loading ? (
        <Sk h={28} w="60%" />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', letterSpacing: '-0.6px', lineHeight: 1.2 }}>
            {fmt(val, def.format)}
          </span>
          <RagDot value={val} target={target} lowerIsBetter={def.lower_is_better} />
        </div>
      )}
      {!loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>Target: {fmt(target, def.format)}</span>
          {values[momKey] !== undefined && <MoMChange pct={mom} />}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function KPITracker() {
  const [period, setPeriod] = useState('this_month')
  const [values, setValues] = useState<KPIValues>({})
  const [history, setHistory] = useState<KPIHistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [histLoading, setHistLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setHistLoading(true)
    setError(null)
    try {
      const [kpiRes, histRes] = await Promise.all([
        apiFetch<{ data: KPIValues }>(`/api/reports/kpis?period=${period}`),
        apiFetch<{ data: KPIHistoryRow[] }>(`/api/reports/kpi-history?period=${period}`),
      ])
      setValues(kpiRes.data ?? {})
      setHistory((histRes.data ?? []).slice().sort((a, b) => String(b.period_label).localeCompare(String(a.period_label))))
    } catch (e: any) {
      setError(e.message ?? 'Failed to load KPIs')
    } finally {
      setLoading(false)
      setHistLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  // History table columns
  const historyCols: TableCol<KPIHistoryRow>[] = [
    {
      key: 'period_label',
      label: 'Period',
      sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, fontFamily: INTER, color: 'var(--txt2)' }}>{r.period_label}</span>,
    },
    ...KPI_DEFS.map(def => ({
      key: def.key,
      label: def.label,
      align: 'right' as const,
      sortable: true,
      render: (r: KPIHistoryRow) => {
        const val = n(r[def.key])
        return <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmt(val, def.format)}</span>
      },
    })),
  ]

  return (
    <Page title="KPI Tracker" subtitle="Business performance against targets">
      <ErrBanner error={error} onRetry={load} />

      <FilterBar>
        <select value={period} onChange={e => setPeriod(e.target.value)} style={filterInputStyle}>
          {PERIOD_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </FilterBar>

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: SP[4], marginBottom: SP[5] }}>
        {KPI_DEFS.map(def => (
          <KPICard key={def.key} def={def} values={values} loading={loading} />
        ))}
      </div>

      {/* KPI History table */}
      <SectionCard title="KPI History" subtitle="Last 12 periods" padding={false}>
        <DataTable
          cols={historyCols}
          rows={history}
          keyFn={r => String(r.period_label)}
          loading={histLoading}
          emptyText="No history data"
        />
      </SectionCard>
    </Page>
  )
}
