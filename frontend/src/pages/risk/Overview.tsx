import { snake } from '../../lib/labels'
import { useState, useEffect } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ColDef, ErrBanner, DateFilter, Spinner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, today, monthStart } from '../../lib/fmt'

/* ── Types ─────────────────────────────────────────────────────── */

interface RiskOverview {
  total_applications: number
  pending_review: number
  approved_mtd: number
  declined_mtd: number
  total_portfolio_kobo: number
  npl_count: number
  approval_rate: number
}

interface StageRow {
  stage: string
  count: number
}

interface PortfolioQuality {
  by_stage: StageRow[]
  by_product: Array<{ product: string; count: number; total_kobo: number }>
}

const stageCols: ColDef<StageRow>[] = [
  {
    key: 'stage', label: 'Stage', render: r => (
      <span className="font-medium text-slate-700 capitalize">{snake(r.stage || '—')}</span>
    ),
  },
  {
    key: 'count', label: 'Applications', right: true, render: r => (
      <span className="font-mono font-semibold text-slate-800">{fmtNum(r.count)}</span>
    ),
  },
]

/* ── Component ─────────────────────────────────────────────────── */

export default function RiskOverview() {
  const [kpis, setKpis] = useState<RiskOverview | null>(null)
  const [quality, setQuality] = useState<PortfolioQuality | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [from, setFrom] = useState(monthStart)
  const [to,   setTo]   = useState(today)

  useEffect(() => {
    let active = true
    setLoading(true); setErr('')
    const qs = `date_from=${from}&date_to=${to}`
    async function load() {
      const [rOv, rPq] = await Promise.allSettled([
        apiFetch<{ data: RiskOverview }>(`/api/risk/overview?${qs}`),
        apiFetch<{ data: PortfolioQuality }>(`/api/risk/portfolio-quality?${qs}`),
      ])
      if (!active) return
      if (rOv.status === 'fulfilled') setKpis(rOv.value.data ?? (rOv.value as any))
      if (rPq.status === 'fulfilled') setQuality(rPq.value.data ?? (rPq.value as any))
      if (rOv.status === 'rejected' && rPq.status === 'rejected') {
        setErr((rOv as PromiseRejectedResult).reason?.message ?? 'Failed to load')
      }
      if (active) setLoading(false)
    }
    load()
    return () => { active = false }
  }, [from, to])

  const k = kpis

  return (
    <Page
      dept="Risk & Credit"
      title="Risk Overview"
      subtitle="Credit portfolio quality and application pipeline"
      actions={<DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />}
    >
      <ErrBanner msg={err} />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
        <KpiCard
          label="Total Applications"
          value={loading ? '—' : fmtNum(k?.total_applications ?? 0)}
          icon="folder_open"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Pending Review"
          value={loading ? '—' : fmtNum(k?.pending_review ?? 0)}
          sub={k && k.pending_review > 0 ? 'Awaiting decision' : 'None pending'}
          icon="pending_actions"
          accent={(k?.pending_review ?? 0) > 0 ? AMBER : NAVY}
          loading={loading}
        />
        <KpiCard
          label="Approved MTD"
          value={loading ? '—' : fmtNum(k?.approved_mtd ?? 0)}
          sub="This month"
          icon="check_circle"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Declined MTD"
          value={loading ? '—' : fmtNum(k?.declined_mtd ?? 0)}
          sub="This month"
          icon="cancel"
          accent={RED}
          loading={loading}
        />
        <KpiCard
          label="Portfolio Value"
          value={loading ? '—' : fmt((k?.total_portfolio_kobo ?? 0) / 100)}
          sub="Active loans"
          icon="account_balance_wallet"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Approval Rate"
          value={loading ? '—' : `${Number(k?.approval_rate ?? 0).toFixed(1)}%`}
          sub="Approved vs decided"
          icon="percent"
          accent={GREEN}
          loading={loading}
        />
      </div>

      {/* NPL callout */}
      {!loading && (k?.npl_count ?? 0) > 0 && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm mb-5"
          style={{ background: 'rgba(192,0,0,0.06)', border: '1px solid rgba(192,0,0,0.18)', color: RED }}
        >
          <span className="material-symbols-rounded text-[18px] flex-shrink-0">warning</span>
          <span>
            <strong>{fmtNum(k?.npl_count ?? 0)}</strong> active {k?.npl_count === 1 ? 'loan' : 'loans'} with DPD &gt; 90 days (NPL).
          </span>
        </div>
      )}

      {/* Applications by stage */}
      <SectionCard
        title="Applications by Stage"
        subtitle="Distribution across the credit pipeline"
        badge={quality?.by_stage?.length ?? 0}
      >
        {loading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <DataTable<StageRow>
            cols={stageCols}
            rows={quality?.by_stage ?? []}
            emptyIcon="table_rows"
            emptyMsg="No stage data available"
          />
        )}
      </SectionCard>
    </Page>
  )
}
