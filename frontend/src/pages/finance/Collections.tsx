import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiExport } from '../../lib/api'
import { fmt, fmtNum, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, DataTable, DateFilter,
  AreaChartCard, DonutCard, ProgressList, StatusBadge,
  ErrBanner, ExportBtn, ColDef, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

export default function Collections() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [agent, setAgent] = useState('')
  const [kpis, setKpis] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [modes, setModes] = useState<any[]>([])
  const [trend, setTrend] = useState<any[]>([])
  const [log, setLog] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const agentParam = agent ? `&agent=${encodeURIComponent(agent)}` : ''
      const qs = `date_from=${from}&date_to=${to}${agentParam}`
      const [rK, rAg, rMo, rTr, rLg] = await Promise.allSettled([
        apiFetch(`/api/collections/kpis?${qs}`),
        apiFetch(`/api/collections/by-agent?date_from=${from}&date_to=${to}`),
        apiFetch('/api/collections/by-mode'),
        apiFetch('/api/collections/monthly-trend'),
        apiFetch(`/api/collections/log?${qs}`),
      ])
      if (rK.status === 'fulfilled') setKpis(rK.value.data ?? rK.value)
      if (rAg.status === 'fulfilled') setAgents(rAg.value.data ?? rAg.value)
      if (rMo.status === 'fulfilled') setModes(rMo.value.data ?? rMo.value)
      if (rTr.status === 'fulfilled') setTrend(rTr.value.data ?? rTr.value)
      if (rLg.status === 'fulfilled') setLog(rLg.value.data ?? rLg.value)
      if ([rK, rAg, rMo, rTr, rLg].every(r => r.status === 'rejected')) setError((rK as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to, agent])

  useEffect(() => { load() }, [load])

  const d = kpis || {}
  const agentList: string[] = agents.map((a: any) => a.Agent).filter(Boolean)

  interface LogRow {
    Date: string
    CIF: string
    'First Name': string
    'Last Name': string
    Agent: string
    Amount: number
    'Mode Of Payment': string
    'Payment Receipt': string
  }

  const logCols: ColDef<LogRow>[] = [
    {
      key: 'Date', label: 'Date', sortable: false,
      render: r => <span className="text-xs text-slate-500 whitespace-nowrap">{r.Date ? fmtDate(r.Date) : '—'}</span>,
    },
    {
      key: 'CIF', label: 'CIF', sortable: false,
      render: r => <span className="font-mono text-xs text-slate-500">{r.CIF}</span>,
    },
    {
      key: 'First Name', label: 'Customer', sortable: false,
      render: r => <span className="font-medium">{[r['First Name'], r['Last Name']].filter(Boolean).join(' ') || '—'}</span>,
    },
    { key: 'Agent', label: 'Agent', sortable: false },
    {
      key: 'Mode Of Payment', label: 'Mode', sortable: false,
      render: r => <StatusBadge status={r['Mode Of Payment'] || 'pending'} />,
    },
    {
      key: 'Amount', label: 'Amount', right: true,
      render: r => <span className="font-mono font-semibold">{fmt(r.Amount)}</span>,
    },
    {
      key: 'Payment Receipt', label: 'Receipt', sortable: false,
      render: r => <span className="text-xs text-slate-400">{r['Payment Receipt'] || '—'}</span>,
    },
  ]

  return (
    <Page dept="Finance" title="Collections"
      subtitle="Agent performance, payment modes, and monthly trends"
      actions={
        <div className="flex items-center gap-2">
          {/* Agent filter chip */}
          <div className="relative">
            <select
              value={agent}
              onChange={e => setAgent(e.target.value)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white appearance-none pr-7 cursor-pointer"
              style={{ borderColor: agent ? '#0E2841' : 'rgba(15,23,42,0.15)', color: '#334155' }}
            >
              <option value="">All Agents</option>
              {agentList.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <span className="material-symbols-rounded absolute right-2 top-1/2 -translate-y-1/2 text-[14px] text-slate-400 pointer-events-none">
              expand_more
            </span>
          </div>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
          <ExportBtn
            onClick={async () => {
              setExporting(true)
              const agentParam = agent ? `&agent=${encodeURIComponent(agent)}` : ''
              await apiExport(
                `/api/collections/export?date_from=${from}&date_to=${to}${agentParam}`,
                `collections_${from}_${to}`,
              )
              setExporting(false)
            }}
            loading={exporting}
          />
        </div>
      }>

      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Collected" value={fmt(d.total_collected)} icon="account_balance_wallet" accent={GREEN} />
        <KpiCard loading={loading} label="Collections MTD" value={fmt(d.collections_mtd)} icon="calendar_month" accent={RED} />
        <KpiCard loading={loading} label="Collection Count" value={fmtNum(d.collection_count)} icon="tag" accent={NAVY} />
        <KpiCard loading={loading} label="Paid" value={fmt(d.paid_collections)} icon="check_circle" accent={GREEN} />
        <KpiCard loading={loading} label="Pending" value={fmt(d.pending_collections)} icon="schedule" accent={AMBER} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <div className="lg:col-span-2">
          <AreaChartCard
            title="Monthly Collections Trend"
            subtitle="All time"
            data={trend}
            xKey="month"
            areaKey="total"
            color={GREEN}
            currency
            height={240}
            loading={loading}
          />
        </div>
        <DonutCard
          title="Collections by Status"
          subtitle="All time breakdown"
          data={modes.map((m: any) => ({ name: m.payment_status, value: n(m.total) }))}
          nameKey="name"
          valueKey="value"
          loading={loading}
        />
      </div>

      <div className="mb-5">
        <ProgressList
          title="Top Agents by Collections"
          subtitle="Amount collected in period"
          data={agents.map((a: any) => ({ name: a.Agent, total: n(a.total) }))}
          nameKey="name"
          valueKey="total"
          currency
          loading={loading}
        />
      </div>

      <SectionCard title="Collections Log" badge={log.length}>
        <DataTable
          cols={logCols}
          rows={log}
          loading={loading}
          emptyIcon="receipt_long"
          emptyMsg="No collections in this period"
        />
      </SectionCard>
    </Page>
  )
}
