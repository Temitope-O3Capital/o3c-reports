import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, n } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef, DonutCard,
  AreaChartCard, ErrBanner, NAVY, RED, AMBER,
} from '../../components/UI'

/* ── DPD bucket colours ─────────────────────────────────────────── */
const BUCKET_COLORS: Record<string, string> = {
  'current':  '#059669',
  '1-30':     '#D97706',
  '31-60':    '#EA580C',
  '61-90':    '#DC2626',
  '91-180':   '#7C3AED',
  '180+':     '#1F2937',
}

const BUCKET_ORDER = ['current', '1-30', '31-60', '61-90', '91-180', '180+']

interface DpdBucket {
  bucket: string
  cif_count: number
  outstanding_kobo: number
}

interface Snapshot {
  total_outstanding_kobo: number
  npl_amount_kobo:        number
  npl_ratio_pct:          number
  par30_pct:              number
}

export default function PortfolioMetrics() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [buckets,  setBuckets]  = useState<DpdBucket[]>([])
  const [trend,    setTrend]    = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [rP, rT] = await Promise.allSettled([
        apiFetch('/api/kpi/portfolio'),
        apiFetch('/api/kpi/portfolio/trend'),
      ])
      if (rP.status === 'fulfilled') {
        const pData = rP.value.data ?? rP.value
        setSnapshot(pData.latest_snapshot ?? null)
        setBuckets(pData.dpd_buckets ?? [])
      }
      if (rT.status === 'fulfilled') setTrend(rT.value.data ?? rT.value ?? [])
      if (rP.status === 'rejected' && rT.status === 'rejected') setError((rP as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const s = snapshot || {} as Snapshot
  const totalOutstanding = n(s.total_outstanding_kobo)

  /* Sort buckets by canonical order */
  const sortedBuckets = [...buckets].sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket)
    const bi = BUCKET_ORDER.indexOf(b.bucket)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  /* Donut data */
  const donutData = sortedBuckets.map(b => ({
    bucket: b.bucket,
    outstanding: n(b.outstanding_kobo) / 100,
  }))

  const donutColors = sortedBuckets.map(b => BUCKET_COLORS[b.bucket] ?? NAVY)

  /* Trend data (kobo → naira) */
  const trendData = (trend as any[]).map(x => ({
    date:        x.snapshot_date ? x.snapshot_date.slice(5) : '',
    outstanding: n(x.total_outstanding_kobo) / 100,
    par30:       n(x.par30_kobo) / 100,
  }))

  /* Table cols */
  const cols: ColDef<DpdBucket & { pct: string }>[] = [
    {
      key: 'bucket',
      label: 'DPD Bucket',
      render: r => (
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ background: BUCKET_COLORS[r.bucket] ?? NAVY }} />
          <span className="font-medium text-slate-700">{r.bucket}</span>
        </span>
      ),
    },
    {
      key:    'cif_count',
      label:  'CIF Count',
      right:  true,
      render: r => fmtNum(r.cif_count),
    },
    {
      key:    'outstanding_kobo',
      label:  'Outstanding',
      right:  true,
      render: r => fmt(n(r.outstanding_kobo) / 100),
    },
    {
      key:    'pct',
      label:  '% of Portfolio',
      right:  true,
      render: r => r.pct,
    },
  ]

  const tableRows = sortedBuckets.map(b => ({
    ...b,
    pct: totalOutstanding > 0
      ? fmtPct((n(b.outstanding_kobo) / totalOutstanding) * 100)
      : '—',
  }))

  return (
    <Page dept="KPI" title="Portfolio Metrics" subtitle="DPD breakdown and 30-day trend">
      <ErrBanner msg={error} />

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard
          loading={loading}
          label="Total Outstanding"
          value={fmt(n(s.total_outstanding_kobo) / 100)}
          icon="account_balance"
          accent={NAVY}
        />
        <KpiCard
          loading={loading}
          label="NPL Amount"
          value={fmt(n(s.npl_amount_kobo) / 100)}
          icon="trending_down"
          accent={RED}
        />
        <KpiCard
          loading={loading}
          label="NPL Ratio"
          value={s.npl_ratio_pct != null ? fmtPct(s.npl_ratio_pct) : '—'}
          icon="percent"
          accent={RED}
        />
        <KpiCard
          loading={loading}
          label="PAR30"
          value={s.par30_pct != null ? fmtPct(s.par30_pct) : '—'}
          icon="warning"
          accent={AMBER}
        />
      </div>

      {/* ── DPD Breakdown ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <DonutCard
          title="DPD Bucket Breakdown"
          subtitle="By outstanding balance"
          data={donutData}
          nameKey="bucket"
          valueKey="outstanding"
          colors={donutColors}
          loading={loading}
        />

        <SectionCard title="Bucket Summary Table" subtitle="Count and exposure by DPD band">
          <DataTable
            cols={cols}
            rows={tableRows}
            loading={loading}
            emptyIcon="account_balance"
            emptyMsg="No portfolio data"
          />
        </SectionCard>
      </div>

      {/* ── 30-day Trends ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AreaChartCard
          title="Portfolio Outstanding Trend"
          subtitle="30 days"
          data={trendData}
          xKey="date"
          areaKey="outstanding"
          color={NAVY}
          currency
          height={220}
          loading={loading}
        />
        <AreaChartCard
          title="PAR30 Trend"
          subtitle="30 days"
          data={trendData}
          xKey="date"
          areaKey="par30"
          color={AMBER}
          currency
          height={220}
          loading={loading}
        />
      </div>
    </Page>
  )
}
