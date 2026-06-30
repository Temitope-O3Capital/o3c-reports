import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, fmtPct, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, ProgressList, StatusBadge, ColDef,
  ErrBanner, ExportBtn, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

function LegalBadge({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-slate-300 text-xs">—</span>
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
      style={{ background: 'rgba(192,0,0,0.08)', color: '#C00000' }}>
      {stage}
    </span>
  )
}

interface CaseRow {
  'CIF Number': string
  'First Name': string
  'Last Name': string
  'Recovery Amount': number
  'Recovery Method': string
  'Legal Stage': string
  Agent: string
  Status: string
  'Recovery Date': string
}

export default function Recovery() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [kpis, setKpis] = useState<any>(null)
  const [byMethod, setByMethod] = useState<any[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [cases, setCases] = useState<CaseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ date_from: from, date_to: to }).toString()
      const [rK, rBm, rTr, rCs] = await Promise.allSettled([
        apiFetch(`/api/recovery/kpis?${qs}`),
        apiFetch(`/api/recovery/by-method?${qs}`),
        apiFetch(`/api/recovery/monthly-trend?${qs}`),
        apiFetch(`/api/recovery/cases?${qs}`),
      ])
      if (rK.status === 'fulfilled') setKpis(rK.value.data ?? rK.value)
      if (rBm.status === 'fulfilled') setByMethod(rBm.value.data ?? rBm.value)
      if (rTr.status === 'fulfilled') setTrend(rTr.value.data ?? rTr.value)
      if (rCs.status === 'fulfilled') setCases(rCs.value.data ?? rCs.value)
      if ([rK, rBm, rTr, rCs].every(r => r.status === 'rejected')) setError((rK as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const d = kpis || {}

  const casesCols: ColDef<CaseRow>[] = [
    {
      key: 'Recovery Date', label: 'Date', sortable: false,
      render: r => <span className="text-xs text-slate-500 whitespace-nowrap">{r['Recovery Date'] ? fmtDate(r['Recovery Date']) : '—'}</span>,
    },
    {
      key: 'CIF Number', label: 'CIF', sortable: false,
      render: r => <span className="font-mono text-xs text-slate-500">{r['CIF Number']}</span>,
    },
    {
      key: 'First Name', label: 'Customer', sortable: false,
      render: r => <span className="font-medium">{[r['First Name'], r['Last Name']].filter(Boolean).join(' ') || '—'}</span>,
    },
    { key: 'Agent', label: 'Agent', sortable: false },
    { key: 'Recovery Method', label: 'Method', sortable: false },
    {
      key: 'Legal Stage', label: 'Legal Stage', sortable: false,
      render: r => <LegalBadge stage={r['Legal Stage']} />,
    },
    {
      key: 'Status', label: 'Status', sortable: false,
      render: r => <StatusBadge status={r.Status || 'pending'} />,
    },
    {
      key: 'Recovery Amount', label: 'Amount', right: true,
      render: r => <span className="font-mono font-semibold">{fmt(r['Recovery Amount'])}</span>,
    },
  ]

  return (
    <Page dept="Finance" title="Recovery & Legal"
      subtitle="Written-off accounts, legal proceedings, and recovery performance"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              await apiExport(
                `/api/recovery/export?date_from=${from}&date_to=${to}`,
                `recovery_${from}_${to}`,
              )
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Recovered" value={fmt(d.total_recovered)} icon="payments" accent={GREEN} />
        <KpiCard loading={loading} label="Recovery MTD" value={fmt(d.recovery_mtd)} icon="calendar_month" accent={RED} />
        <KpiCard loading={loading} label="Recovery Rate" value={fmtPct(d.recovery_rate)} icon="percent" accent={GREEN}
          sub="vs total portfolio" />
        <KpiCard loading={loading} label="Open Cases" value={fmtNum(d.open_cases)} icon="folder_open" accent={AMBER} />
      </div>

      {/* Second KPI row */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Accounts in Legal" value={fmtNum(d.accounts_in_legal)} icon="gavel" accent={RED} />
        <div className="lg:col-span-3">
          <ProgressList
            title="Recovery by Method"
            subtitle="All time — amount recovered per channel"
            data={byMethod.map((m: any) => ({ name: m['Recovery Method'] || 'Unknown', total: n(m.total) }))}
            nameKey="name"
            valueKey="total"
            currency
            loading={loading}
          />
        </div>
      </div>

      <div className="mb-5">
        <AreaChartCard
          title="Monthly Recovery Trend"
          subtitle="Amount recovered per month"
          data={trend}
          xKey="month"
          areaKey="total"
          color={GREEN}
          currency
          height={220}
          loading={loading}
        />
      </div>

      <SectionCard title="Active Recovery Cases" subtitle={`${from} – ${to}`} badge={cases.length}>
        <DataTable
          cols={casesCols}
          rows={cases}
          loading={loading}
          emptyIcon="gavel"
          emptyMsg="No recovery cases in this period"
        />
      </SectionCard>
    </Page>
  )
}
