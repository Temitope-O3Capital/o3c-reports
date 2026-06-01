import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../hooks/useApi.js'

const PRIORITY_COLOR = { low: '#94A3B8', medium: '#F59E0B', high: '#EF4444', urgent: '#7C3AED' }

function DealCard({ deal, onMove, stages, onClick }) {
  return (
    <div
      onClick={() => onClick(deal)}
      className="card p-4 cursor-pointer card-hover"
      style={{ marginBottom: 8 }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 leading-tight">{deal.title}</p>
        {deal.expected_value && (
          <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
            ₦{Number(deal.expected_value).toLocaleString()}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        {deal.first_name} {deal.last_name}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {deal.product && (
            <span className="badge badge-navy text-[10px]">{deal.product}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="material-symbols-rounded text-[13px] text-slate-400">person</span>
          <span className="text-[11px] text-slate-400">{deal.assigned_name || '—'}</span>
        </div>
      </div>
      {/* Move buttons */}
      <div className="flex gap-1 mt-3">
        {stages.filter(s => s.id !== deal.stage_id).slice(0, 3).map(s => (
          <button
            key={s.id}
            onClick={e => { e.stopPropagation(); onMove(deal.id, s.id) }}
            className="text-[10px] px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-600 text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors"
          >
            → {s.name}
          </button>
        ))}
      </div>
    </div>
  )
}

function NewDealModal({ stages, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', contact_search: '', stage_id: stages[0]?.id, product: '', expected_value: '' })
  const [contacts, setContacts] = useState([])
  const [selectedContact, setSelectedContact] = useState(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef(null)

  function searchContacts(q) {
    clearTimeout(timer.current)
    if (!q) { setContacts([]); return }
    timer.current = setTimeout(async () => {
      const res = await apiFetch(`/api/crm/contacts?q=${encodeURIComponent(q)}&limit=8`)
      setContacts(res.data || [])
    }, 300)
  }

  async function submit(e) {
    e.preventDefault()
    if (!selectedContact) return
    setSaving(true)
    try {
      const deal = await apiFetch('/api/crm/deals', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: selectedContact.id,
          title: form.title,
          stage_id: Number(form.stage_id),
          product: form.product || null,
          expected_value: form.expected_value ? Number(form.expected_value) : null,
        }),
      })
      onCreated(deal)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}>
      <div className="card w-full max-w-md p-6 animate-fade-in" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">New Deal</h2>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="form-label">Deal Title *</label>
            <input className="form-input" required value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Prepaid card — John Doe" />
          </div>
          <div className="relative">
            <label className="form-label">Contact *</label>
            <input className="form-input" placeholder="Search by name, phone or CIF…"
              value={selectedContact ? `${selectedContact.first_name} ${selectedContact.last_name}` : form.contact_search}
              onChange={e => { setForm(f => ({ ...f, contact_search: e.target.value })); setSelectedContact(null); searchContacts(e.target.value) }} />
            {contacts.length > 0 && !selectedContact && (
              <div className="absolute z-10 w-full mt-1 card overflow-hidden" style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
                {contacts.map(c => (
                  <button key={c.id} type="button" onClick={() => { setSelectedContact(c); setContacts([]) }}
                    className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                    <span className="font-medium">{c.first_name} {c.last_name}</span>
                    <span className="text-slate-400 ml-2">{c.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Stage</label>
              <select className="form-input" value={form.stage_id}
                onChange={e => setForm(f => ({ ...f, stage_id: e.target.value }))}>
                {stages.filter(s => !s.is_won && !s.is_lost).map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label">Product</label>
              <select className="form-input" value={form.product} onChange={e => setForm(f => ({ ...f, product: e.target.value }))}>
                <option value="">—</option>
                {['Prepaid', 'Credit', 'International USD', 'Business Loan'].map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">Expected Value (₦)</label>
            <input className="form-input" type="number" placeholder="0"
              value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} />
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving || !selectedContact} className="btn btn-primary disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Deal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Pipeline() {
  const [pipeline, setPipeline] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [showNew, setShowNew]   = useState(false)
  const navigate = useNavigate()

  async function load() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/crm/pipeline')
      setPipeline(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function moveDeal(dealId, stageId) {
    await apiFetch(`/api/crm/deals/${dealId}`, { method: 'PUT', body: JSON.stringify({ stage_id: stageId }) })
    load()
  }

  if (loading) return (
    <div className="px-6 py-8 flex items-center gap-3 text-slate-400">
      <div className="spinner" /> Loading pipeline…
    </div>
  )

  const { stages = [], deals = {} } = pipeline || {}
  const totalDeals = Object.values(deals).flat().length
  const totalValue = Object.values(deals).flat().reduce((s, d) => s + Number(d.expected_value || 0), 0)

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Pipeline</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {totalDeals} deals · ₦{Number(totalValue).toLocaleString()} total value
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[18px]">add</span>
          New Deal
        </button>
      </div>

      {/* Kanban board */}
      <div className="flex gap-4 overflow-x-auto pb-6" style={{ minHeight: 'calc(100vh - 200px)' }}>
        {stages.map(stage => {
          const stageDeals = deals[stage.id] || []
          return (
            <div key={stage.id} className="flex-shrink-0 w-72">
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3 px-1">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: stage.color }} />
                <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 flex-1">{stage.name}</p>
                <span className="text-[11px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                  {stageDeals.length}
                </span>
              </div>

              {/* Cards */}
              <div className="rounded-xl p-2 min-h-[200px]"
                style={{ background: 'rgb(var(--bg-subtle))' }}>
                {stageDeals.map(deal => (
                  <DealCard key={deal.id} deal={deal} stages={stages}
                    onMove={moveDeal}
                    onClick={d => navigate(`/crm/contacts/${d.contact_id}`)} />
                ))}
                {stageDeals.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-slate-300 dark:text-slate-600">
                    <span className="material-symbols-rounded text-[28px] mb-1">inbox</span>
                    <p className="text-xs">Empty</p>
                  </div>
                )}
              </div>

              {/* Stage total */}
              {stageDeals.some(d => d.expected_value) && (
                <p className="text-[11px] text-slate-400 text-center mt-2">
                  ₦{stageDeals.reduce((s, d) => s + Number(d.expected_value || 0), 0).toLocaleString()}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {showNew && (
        <NewDealModal
          stages={stages}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); load() }}
        />
      )}
    </div>
  )
}
