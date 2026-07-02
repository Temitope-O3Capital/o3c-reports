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
          <span className="text-[12px] font-semibold" style={{ color: 'var(--txt)' }}>{stage.name}</span>
          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}>
            {deals.length}
          </span>
        </div>
        <span className="text-[11px] font-mono" style={{ color: 'var(--txt2)' }}>{fmt(totalValue)}</span>
      </div>
      <div className="space-y-2">
        {deals.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed p-4 text-center"
            style={{ borderColor: 'var(--bdr)' }}>
            <p className="text-[12px]" style={{ color: 'var(--txt3)' }}>No deals</p>
          </div>
        ) : deals.map(d => (
          <button key={d.id} onClick={() => onClick(d)}
            className="w-full card p-3 text-left hover:shadow-md transition-all"
            style={{ borderLeft: `3px solid ${stage.color || NAVY}` }}>
            <p className="text-[12px] font-semibold truncate mb-1" style={{ color: 'var(--txt)' }}>{d.title}</p>
            <p className="text-[11px] mb-2" style={{ color: 'var(--txt2)' }}>{d.first_name} {d.last_name}</p>
            <div className="flex items-center justify-between">
              {d.expected_value != null
                ? <span className="text-[12px] font-mono font-semibold" style={{ color: 'var(--txt)' }}>{fmt(d.expected_value)}</span>
                : <span className="text-[11px]" style={{ color: 'var(--txt3)' }}>—</span>}
              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}>
                {d.probability}%
              </span>
            </div>
            {d.assigned_name && (
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--txt2)' }}>{d.assigned_name}</p>
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
      <div className="ml-auto w-full max-w-sm shadow-2xl h-full overflow-auto flex flex-col" style={{ background: 'var(--card)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--bdr)' }}>
          <h3 className="text-[14px] font-semibold truncate" style={{ color: 'var(--txt)' }}>{deal.title}</h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg" style={{ color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded text-[18px]">close</span>
          </button>
        </div>

        <div className="flex-1 p-5 space-y-4">
          <ErrBanner msg={err} />

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Contact</p>
            <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>{deal.first_name} {deal.last_name}</p>
            {deal.phone && <p className="text-[12px]" style={{ color: 'var(--txt2)' }}>{deal.phone}</p>}
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Stage</label>
            <select className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.stage_id} onChange={e => setForm(f => ({ ...f, stage_id: e.target.value }))}>
              {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Value (₦)</label>
              <input type="number" className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Probability %</label>
              <input type="number" min={0} max={100} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                value={form.probability} onChange={e => setForm(f => ({ ...f, probability: e.target.value }))} />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Expected Close</label>
            <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.expected_close_date} onChange={e => setForm(f => ({ ...f, expected_close_date: e.target.value }))} />
          </div>

          <div className="pt-1">
            <p className="text-[11px]" style={{ color: 'var(--txt2)' }}>Assigned to: <span style={{ color: 'var(--txt2)' }}>{deal.assigned_name ?? '—'}</span></p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--txt2)' }}>Last updated: <span style={{ color: 'var(--txt2)' }}>{fmtDate(deal.updated_at)}</span></p>
          </div>
        </div>

        <div className="p-5 border-t flex items-center justify-between" style={{ borderColor: 'var(--bdr)' }}>
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

/* ── Create Deal modal ──────────────────────────────────────────── */
interface Contact { id: number; first_name: string; last_name: string }

function CreateDealModal({ stages, onClose, onCreated }: {
  stages: Stage[]; onClose: () => void; onCreated: () => void
}) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [form, setForm] = useState({
    title: '', contact_id: '', stage_id: String(stages[0]?.id ?? ''),
    expected_value: '', probability: '50', expected_close_date: '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    apiFetch<{ data: Contact[] } | Contact[]>('/api/crm/contacts?limit=200')
      .then(r => setContacts(Array.isArray(r) ? r : (r.data ?? [])))
      .catch(() => {})
  }, [])

  async function submit() {
    if (!form.title || !form.contact_id) { setErr('Title and contact are required'); return }
    setSaving(true); setErr('')
    try {
      await apiPost('/api/crm/deals', {
        title: form.title,
        contact_id: Number(form.contact_id),
        stage_id: form.stage_id ? Number(form.stage_id) : undefined,
        expected_value: form.expected_value ? Number(form.expected_value) : undefined,
        probability: Number(form.probability),
        expected_close_date: form.expected_close_date || undefined,
      })
      onCreated()
    } catch (ex: any) { setErr(ex.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="rounded-2xl shadow-xl p-6 w-full max-w-md" style={{ background: 'var(--card)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>New Deal</h2>
          <button onClick={onClose} style={{ color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>
        <ErrBanner msg={err} />
        <div className="space-y-3">
          <div>
            <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Deal Title *</label>
            <input className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. SME Loan — Adeola Bakeries" />
          </div>
          <div>
            <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Contact *</label>
            <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.contact_id} onChange={e => setForm(f => ({ ...f, contact_id: e.target.value }))}>
              <option value="">— Select contact —</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Stage</label>
            <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.stage_id} onChange={e => setForm(f => ({ ...f, stage_id: e.target.value }))}>
              {stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Value (₦)</label>
              <input type="number" min="0" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                placeholder="0" value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} />
            </div>
            <div>
              <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Probability %</label>
              <input type="number" min="0" max="100" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                value={form.probability} onChange={e => setForm(f => ({ ...f, probability: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Expected Close</label>
            <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={form.expected_close_date} onChange={e => setForm(f => ({ ...f, expected_close_date: e.target.value }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-black/[0.05]" style={{ color: 'var(--txt)' }} onClick={onClose}>Cancel</button>
          <button
            className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
            style={{ background: NAVY }}
            disabled={saving}
            onClick={submit}>
            {saving ? 'Creating…' : 'Create Deal'}
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
  const [createOpen, setCreateOpen] = useState(false)

  async function load() {
    setLoading(true); setErr('')
    try {
      const res = await apiFetch<PipelineResp>('/api/crm/pipeline')
      setData(res)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Deduplicate stages by name (DB may have seeded duplicates)
  const rawStages = data?.stages ?? []
  const seen = new Set<string>()
  const stages = rawStages.filter(s => { const k = s.name?.toLowerCase(); return k && !seen.has(k) && seen.add(k) })
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
          <p className="font-semibold text-[13px]" style={{ color: 'var(--txt)' }}>{d.title}</p>
          <p className="text-[11px]" style={{ color: 'var(--txt2)' }}>{d.first_name} {d.last_name}</p>
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
    { key: 'probability', label: 'Prob.', right: true, render: d => <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{d.probability}%</span> },
    { key: 'assigned_name', label: 'Assigned To', render: d => <span style={{ color: 'var(--txt2)' }}>{d.assigned_name ?? '—'}</span> },
    { key: 'expected_close_date', label: 'Close Date', render: d => <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{fmtDate(d.expected_close_date)}</span> },
    {
      key: '_action', label: '', sortable: false,
      render: d => (
        <button onClick={() => setSelectedDeal(d)}
          className="text-[11px] transition-colors font-medium" style={{ color: 'var(--txt2)' }}>
          Edit
        </button>
      ),
    },
  ]

  return (
    <Page dept="CRM" title="Pipeline" subtitle="Track deals through your sales stages"
      actions={
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}>
          <span className="material-symbols-rounded text-[16px]">add</span>
          New Deal
        </button>
      }>

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
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--txt2)' }}>Stage distribution</p>
          <SummaryBar stages={stages} deals={dealMap} />
          <div className="flex flex-wrap gap-3 mt-3">
            {stages.map(s => (
              <div key={s.id} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-sm" style={{ background: s.color || NAVY }} />
                <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{s.name} <span className="font-semibold" style={{ color: 'var(--txt)' }}>{(dealMap[String(s.id)] ?? []).length}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* View toggle */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>{allDeals.length} total deals</p>
        <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--bdr)' }}>
          {(['kanban', 'table'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className="px-3 py-1.5 text-[12px] font-medium transition-all flex items-center gap-1.5"
              style={{ background: view === v ? NAVY : 'var(--card)', color: view === v ? '#fff' : 'var(--txt2)' }}>
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
      {createOpen && (
        <CreateDealModal
          stages={stages}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); load() }} />
      )}
    </Page>
  )
}
