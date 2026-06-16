import { useState, useEffect } from 'react'
import { apiFetch, apiPost, apiPut, apiDelete } from '../../lib/api'
import { fmt, fmtDate, n } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ColDef, KpiCard,
  StatusBadge, ErrBanner, Sk, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

/* ── Types ──────────────────────────────────────────────────────── */
interface Stage {
  id: number
  name: string
  color: string
  order_index: number
  is_won: boolean
  is_lost: boolean
}

interface Deal {
  id: number
  title: string
  stage_id: number
  stage_name: string
  stage_color: string
  is_won: boolean
  is_lost: boolean
  first_name: string
  last_name: string
  phone: string | null
  contact_status: string
  expected_value: number | null
  probability: number
  assigned_name: string | null
  expected_close_date: string | null
  updated_at: string
}

interface PipelineResp {
  stages: Stage[]
  deals: Record<string, Deal[]>
}

/* ── Pipeline summary bar ───────────────────────────────────────── */
function SummaryBar({ stages, deals }: { stages: Stage[]; deals: Record<string, Deal[]> }) {
  const total = Object.values(deals).flat().length
  if (total === 0) return null
  return (
    <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-1">
      {stages.map(s => {
        const count = (deals[String(s.id)] ?? []).length
        const pct = total > 0 ? (count / total) * 100 : 0
        return pct > 0 ? (
          <div key={s.id} style={{ width: `${pct}%`, background: s.color || NAVY, transition: 'width 0.4s ease' }} />
        ) : null
      })}
    </div>
  )
}

/* ── Stage column (Kanban) ──────────────────────────────────────── */
function StageColumn({ stage, deals, onClick }: { stage: Stage; deals: Deal[]; onClick: (d: Deal) => void }) {
  const totalValue = deals.reduce((s, d) => s + n(d.expected_value), 0)
  return (
    <div className="flex-1 min-w-[220px] max-w-[300px]">
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: stage.color || NAVY }} />
          <span className="text-[12px] font-semibold text-slate-700">{stage.name}</span>
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}>
            {deals.length}
          </span>
        </div>
        <span className="text-[11px] font-mono text-slate-400">{fmt(totalValue)}</span>
      </div>
      <div className="space-y-2">
        {deals.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed p-4 text-center"
            style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
            <p className="text-[12px] text-slate-300">No deals</p>
          </div>
        ) : deals.map(d => (
          <button key={d.id} onClick={() => onClick(d)}
            className="w-full card p-3 text-left hover:shadow-md transition-all"
            style={{ borderLeft: `3px solid ${stage.color || NAVY}` }}>
            <p className="text-[12px] font-semibold text-slate-800 truncate mb-1">{d.title}</p>
            <p className="text-[11px] text-slate-500 mb-2">{d.first_name} {d.last_name}</p>
            <div className="flex items-center justify-between">
              {d.expected_value != null
                ? <span className="text-[12px] font-mono font-semibold text-slate-700">{fmt(d.expected_value)}</span>
                : <span className="text-[11px] text-slate-300">—</span>}
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(14,40,65,0.05)', color: '#94A3B8' }}>
                {d.probability}%
              </span>
            </div>
            {d.assigned_name && (
              <p className="text-[10px] text-slate-400 mt-1.5">{d.assigned_name}</p>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Deal detail drawer ─────────────────────────────────────────── */
function DealDrawer({ deal, stages, onClose, onUpdated }: {
  deal: Deal; stages: Stage[]; onClose: () => void; onUpdated: () => void
}) {
  const [form, setForm] = useState({
    stage_id: String(deal.stage_id),
    expected_value: String(deal.expected_value ?? ''),
    probability: String(deal.probability ?? 50),
    expected_close_date: deal.expected_close_date?.slice(0, 10) ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setSaving(true); setErr('')
    try {
      await apiPut(`/api/crm/deals/${deal.id}`, {
        stage_id: Number(form.stage_id),
        expected_value: form.expected_value ? Number(form.expected_value) : null,
        probability: Number(form.probability),
        expected_close_date: form.expected_close_date || null,
      })
      onUpdated()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  async function remove() {
    if (!confirm('Delete this deal?')) return
    await apiDelete(`/api/crm/deals/${deal.id}`)
    onUpdated()
  }

  return (
    <div className="fixed inset-0 z-50 flex" style={{ background: 'rgba(0,0,0,0.3)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ml-auto w-full max-w-sm bg-white shadow-2xl h-full overflow-auto flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <h3 className="text-[14px] font-semibold text-slate-800 truncate">{deal.title}</h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[18px] text-slate-500">close</span>
          </button>
        </div>

        <div className="flex-1 p-5 space-y-4">
          <ErrBanner msg={err} />

          <div>
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Contact</p>
            <p className="text-[13px] font-semibold text-slate-800">{deal.first_name} {deal.last_name}</p>
            {deal.phone && <p className="text-[12px] text-slate-500">{deal.phone}</p>}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Stage</label>
            <select className="w-full px-3 py-2 rounded-lg border text-[13px] bg-white outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              value={form.stage_id} onChange={e => setForm(f => ({ ...f, stage_id: e.target.value }))}>
              {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Value (₦)</label>
              <input type="number" className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Probability %</label>
              <input type="number" min={0} max={100} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.18)' }}
                value={form.probability} onChange={e => setForm(f => ({ ...f, probability: e.target.value }))} />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Expected Close</label>
            <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.18)' }}
              value={form.expected_close_date} onChange={e => setForm(f => ({ ...f, expected_close_date: e.target.value }))} />
          </div>

          <div className="pt-1">
            <p className="text-[11px] text-slate-400">Assigned to: <span className="text-slate-600">{deal.assigned_name ?? '—'}</span></p>
            <p className="text-[11px] text-slate-400 mt-1">Last updated: <span className="text-slate-600">{fmtDate(deal.updated_at)}</span></p>
          </div>
        </div>

        <div className="p-5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
          <button onClick={remove} className="text-[12px] text-red-500 hover:text-red-700 transition-colors font-medium">
            Delete deal
          </button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60 transition-all"
            style={{ background: NAVY }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Main page ──────────────────────────────────────────────────── */
export default function Pipeline() {
  const [data, setData] = useState<PipelineResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [view, setView] = useState<'kanban' | 'table'>('kanban')
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)

  async function load() {
    setLoading(true); setErr('')
    try {
      const res = await apiFetch<PipelineResp>('/api/crm/pipeline')
      setData(res)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const stages = data?.stages ?? []
  const dealMap = data?.deals ?? {}
  const allDeals: Deal[] = stages.flatMap(s => dealMap[String(s.id)] ?? [])
  const wonDeals = allDeals.filter(d => d.is_won)
  const activeDeals = allDeals.filter(d => !d.is_won && !d.is_lost)
  const totalValue = activeDeals.reduce((s, d) => s + n(d.expected_value), 0)
  const weightedValue = activeDeals.reduce((s, d) => s + n(d.expected_value) * (d.probability / 100), 0)

  const tableCols: ColDef<Deal>[] = [
    {
      key: 'title', label: 'Deal',
      render: d => (
        <div>
          <p className="font-semibold text-slate-800 text-[13px]">{d.title}</p>
          <p className="text-[11px] text-slate-400">{d.first_name} {d.last_name}</p>
        </div>
      ),
    },
    {
      key: 'stage_name', label: 'Stage',
      render: d => (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded"
          style={{ background: `${d.stage_color}14`, color: d.stage_color }}>
          {d.stage_name}
        </span>
      ),
    },
    { key: 'expected_value', label: 'Value', right: true, render: d => <span className="kpi-number text-[12px]">{d.expected_value != null ? fmt(d.expected_value) : '—'}</span> },
    { key: 'probability', label: 'Prob.', right: true, render: d => <span className="text-slate-600 text-[12px]">{d.probability}%</span> },
    { key: 'assigned_name', label: 'Assigned To', render: d => <span className="text-slate-500">{d.assigned_name ?? '—'}</span> },
    { key: 'expected_close_date', label: 'Close Date', render: d => <span className="text-slate-400 text-[12px]">{fmtDate(d.expected_close_date)}</span> },
    {
      key: '_action', label: '', sortable: false,
      render: d => (
        <button onClick={() => setSelectedDeal(d)}
          className="text-[11px] text-slate-400 hover:text-slate-700 transition-colors font-medium">
          Edit
        </button>
      ),
    },
  ]

  return (
    <Page dept="CRM" title="Pipeline" subtitle="Track deals through your sales stages">

      <ErrBanner msg={err} />

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard label="Active Deals" value={String(activeDeals.length)} icon="handshake" loading={loading} />
        <KpiCard label="Pipeline Value" value={fmt(totalValue)} icon="attach_money" accent={GREEN} loading={loading} />
        <KpiCard label="Weighted Value" value={fmt(weightedValue)} icon="trending_up" accent={AMBER} loading={loading} />
        <KpiCard label="Won Deals" value={String(wonDeals.length)} icon="check_circle" accent={GREEN}
          sub={wonDeals.length > 0 ? `${fmt(wonDeals.reduce((s, d) => s + n(d.expected_value), 0))} total` : undefined}
          loading={loading} />
      </div>

      {/* Stage summary bar */}
      {!loading && stages.length > 0 && (
        <div className="card p-4 mb-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Stage distribution</p>
          <SummaryBar stages={stages} deals={dealMap} />
          <div className="flex flex-wrap gap-3 mt-3">
            {stages.map(s => (
              <div key={s.id} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-sm" style={{ background: s.color || NAVY }} />
                <span className="text-[11px] text-slate-500">{s.name} <span className="font-semibold text-slate-700">{(dealMap[String(s.id)] ?? []).length}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* View toggle */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px] text-slate-500">{allDeals.length} total deals</p>
        <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
          {(['kanban', 'table'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className="px-3 py-1.5 text-[12px] font-medium transition-all flex items-center gap-1.5"
              style={{ background: view === v ? NAVY : 'white', color: view === v ? '#fff' : '#475569' }}>
              <span className="material-symbols-rounded text-[14px]">
                {v === 'kanban' ? 'view_kanban' : 'table_rows'}
              </span>
              {v === 'kanban' ? 'Kanban' : 'Table'}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-1 min-w-[220px] space-y-2">
              <Sk h="h-5" w="w-24" />
              {Array.from({ length: 3 }).map((__, j) => <div key={j} className="card p-3 space-y-1.5"><Sk /><Sk w="w-2/3" /><Sk w="w-1/2" /></div>)}
            </div>
          ))}
        </div>
      ) : view === 'kanban' ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {stages.map(s => (
            <StageColumn key={s.id} stage={s}
              deals={dealMap[String(s.id)] ?? []}
              onClick={setSelectedDeal} />
          ))}
        </div>
      ) : (
        <SectionCard title="All Deals" badge={allDeals.length}>
          <DataTable<Deal>
            cols={tableCols} rows={allDeals} loading={loading}
            emptyIcon="handshake" emptyMsg="No deals in the pipeline" />
        </SectionCard>
      )}

      {selectedDeal && (
        <DealDrawer
          deal={selectedDeal}
          stages={stages}
          onClose={() => setSelectedDeal(null)}
          onUpdated={() => { setSelectedDeal(null); load() }} />
      )}
    </Page>
  )
}
