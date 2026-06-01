import { useState } from 'react'
import { useApi, apiFetch } from '../../hooks/useApi.js'

const REQUEST_TYPES = [
  'card_issue','card_replacement','card_upgrade',
  'dispute','complaint','limit_increase',
  'pin_reset','statement_request','account_info',
  'fraud_report','general',
]

const STATUS_CLS = {
  open:       'badge-amber',
  in_progress:'badge-blue',
  resolved:   'badge-green',
  closed:     'badge-grey',
  escalated:  'badge-red',
}

const PRIORITY_CLS = { low: 'badge-grey', medium: 'badge-blue', high: 'badge-amber', urgent: 'badge-red' }

function NewRequestModal({ onClose, onSaved }) {
  const contacts = useApi('/api/crm/contacts?limit=200')
  const [form, setForm] = useState({
    request_type: 'general', subject: '', description: '',
    priority: 'medium', cif_number: '', contact_id: '', sla_hours: '24',
  })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    await apiFetch('/api/crm/requests', {
      method: 'POST',
      body: JSON.stringify({
        ...form,
        contact_id: form.contact_id ? Number(form.contact_id) : null,
        sla_hours: Number(form.sla_hours),
      }),
    })
    setSaving(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-auto" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}>
      <div className="card w-full max-w-lg p-6 animate-fade-in my-4" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">New Request</h2>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Type *</label>
              <select className="form-input" value={form.request_type}
                onChange={e => setForm(f => ({ ...f, request_type: e.target.value }))}>
                {REQUEST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Priority</label>
              <select className="form-input" value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                {['low','medium','high','urgent'].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">Subject *</label>
            <input className="form-input" required value={form.subject}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Brief description of the issue" />
          </div>
          <div>
            <label className="form-label">Contact</label>
            <select className="form-input" value={form.contact_id}
              onChange={e => setForm(f => ({ ...f, contact_id: e.target.value }))}>
              <option value="">— No contact —</option>
              {(contacts.data?.data || []).map(c => (
                <option key={c.id} value={c.id}>{c.first_name} {c.last_name} — {c.phone}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">CIF Number (optional)</label>
              <input className="form-input" value={form.cif_number}
                onChange={e => setForm(f => ({ ...f, cif_number: e.target.value }))} placeholder="e.g. 001234" />
            </div>
            <div>
              <label className="form-label">SLA (hours)</label>
              <select className="form-input" value={form.sla_hours}
                onChange={e => setForm(f => ({ ...f, sla_hours: e.target.value }))}>
                {['4','8','24','48','72'].map(h => <option key={h} value={h}>{h}h</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">Description</label>
            <textarea className="form-input" rows={3} value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Full details of the request or issue…" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-60">
              {saving ? 'Creating…' : 'Create Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SlaBar({ hoursElapsed, slaHours, status }) {
  if (status === 'resolved' || status === 'closed') {
    return <span className="badge badge-green">Resolved</span>
  }
  const pct     = Math.min((hoursElapsed / slaHours) * 100, 100)
  const breached = pct >= 100
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{
          width: `${pct}%`,
          background: breached ? '#EF4444' : pct > 70 ? '#F59E0B' : '#10B981',
        }} />
      </div>
      <span className={`text-[11px] font-semibold whitespace-nowrap ${breached ? 'text-red-500' : 'text-slate-500'}`}>
        {breached ? 'Breached' : `${Math.round(hoursElapsed)}h/${slaHours}h`}
      </span>
    </div>
  )
}

export default function Requests() {
  const [statusFilter, setStatusFilter]   = useState('')
  const [typeFilter, setTypeFilter]       = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [showNew, setShowNew]             = useState(false)
  const [selected, setSelected]           = useState(null)

  const params = new URLSearchParams({ limit: '200' })
  if (statusFilter)   params.set('status', statusFilter)
  if (typeFilter)     params.set('request_type', typeFilter)
  if (priorityFilter) params.set('priority', priorityFilter)

  const { data: res, loading, refetch } = useApi(`/api/crm/requests?${params}`)
  const requests = res?.data || []

  async function updateStatus(id, status) {
    await apiFetch(`/api/crm/requests/${id}`, { method: 'PUT', body: JSON.stringify({ status }) })
    setSelected(null)
    refetch()
  }

  const open       = requests.filter(r => r.status === 'open').length
  const breached   = requests.filter(r => r.sla_breached).length

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Requests</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {open} open
            {breached > 0 && <span className="text-red-500 ml-2">· {breached} SLA breached</span>}
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn btn-primary gap-2">
          <span className="material-symbols-rounded text-[18px]">add</span>
          New Request
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700">
          {['open','in_progress','resolved','all'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s === 'all' ? '' : s)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                (s === 'all' ? !statusFilter : statusFilter === s)
                  ? 'bg-primary text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}>
              {s === 'all' ? 'All' : s.replace('_',' ')}
            </button>
          ))}
        </div>
        <select className="form-input w-auto text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {REQUEST_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
        </select>
        <select className="form-input w-auto text-sm" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          {['urgent','high','medium','low'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Subject</th>
                <th>Type</th>
                <th>Contact</th>
                <th>Priority</th>
                <th>Status</th>
                <th>SLA</th>
                <th>Assigned</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="text-center py-10 text-slate-400">
                  <div className="flex items-center justify-center gap-2"><div className="spinner" /> Loading…</div>
                </td></tr>
              ) : requests.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-10">
                  <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">support_agent</span>
                  <p className="text-sm text-slate-400">No requests found</p>
                </td></tr>
              ) : requests.map(r => (
                <tr key={r.id}>
                  <td>
                    <p className="font-medium text-slate-800 dark:text-slate-100">{r.subject}</p>
                    {r.description && <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{r.description}</p>}
                  </td>
                  <td><span className="badge badge-navy text-[10px]">{r.request_type?.replace(/_/g,' ')}</span></td>
                  <td className="text-slate-600 dark:text-slate-400">
                    {r.first_name ? `${r.first_name} ${r.last_name}` : r.cif_number || '—'}
                  </td>
                  <td><span className={`badge ${PRIORITY_CLS[r.priority] || 'badge-grey'}`}>{r.priority}</span></td>
                  <td><span className={`badge ${STATUS_CLS[r.status] || 'badge-grey'}`}>{r.status?.replace('_',' ')}</span></td>
                  <td>
                    <SlaBar
                      hoursElapsed={r.hours_elapsed || 0}
                      slaHours={r.sla_hours || 24}
                      status={r.status}
                    />
                  </td>
                  <td className="text-slate-500 text-xs">{r.assigned_name || '—'}</td>
                  <td className="text-slate-400 text-xs whitespace-nowrap">
                    {new Date(r.created_at).toLocaleDateString('en-GB')}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {r.status === 'open' && (
                        <button onClick={() => updateStatus(r.id, 'in_progress')}
                          className="text-[10px] px-2 py-0.5 rounded-full border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors whitespace-nowrap">
                          Start
                        </button>
                      )}
                      {['open','in_progress'].includes(r.status) && (
                        <button onClick={() => updateStatus(r.id, 'resolved')}
                          className="text-[10px] px-2 py-0.5 rounded-full border border-emerald-200 text-emerald-600 hover:bg-emerald-50 transition-colors whitespace-nowrap">
                          Resolve
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showNew && <NewRequestModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); refetch() }} />}
    </div>
  )
}
