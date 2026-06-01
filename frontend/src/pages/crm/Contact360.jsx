import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../hooks/useApi.js'
import { fmt, fmtNum } from '../../components/Charts.jsx'

const ACTIVITY_ICONS = {
  call:      { icon: 'call',           color: '#3B82F6' },
  email:     { icon: 'email',          color: '#8B5CF6' },
  visit:     { icon: 'location_on',    color: '#10B981' },
  note:      { icon: 'sticky_note_2',  color: '#F59E0B' },
  whatsapp:  { icon: 'chat',           color: '#25D366' },
  sms:       { icon: 'sms',            color: '#64748B' },
}

const OUTCOME_CLS = {
  interested:     'badge-green',
  converted:      'badge-green',
  not_interested: 'badge-red',
  callback:       'badge-amber',
  no_answer:      'badge-grey',
  voicemail:      'badge-grey',
}

const STATUS_CLS = {
  lead: 'badge-grey', prospect: 'badge-blue', customer: 'badge-green',
  churned: 'badge-red', inactive: 'badge-amber',
}

function Tab({ label, active, onClick, count }) {
  return (
    <button onClick={onClick} className={`pb-3 text-sm font-medium transition-colors border-b-2 mr-6 ${
      active
        ? 'border-primary text-slate-900 dark:text-white'
        : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
    }`}>
      {label}
      {count != null && (
        <span className={`ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full ${active ? 'bg-primary/10 text-primary' : 'bg-slate-100 dark:bg-slate-700 text-slate-500'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

function LogActivityModal({ contactId, onClose, onSaved }) {
  const [form, setForm] = useState({ type: 'call', direction: 'outbound', subject: '', body: '', outcome: '', duration_mins: '', next_follow_up: '' })
  const [saving, setSaving] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    await apiFetch('/api/crm/activities', {
      method: 'POST',
      body: JSON.stringify({ ...form, contact_id: contactId, duration_mins: form.duration_mins ? Number(form.duration_mins) : null }),
    })
    setSaving(false)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }}>
      <div className="card w-full max-w-md p-6 animate-fade-in" style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Log Activity</h2>
          <button onClick={onClose} className="btn-icon"><span className="material-symbols-rounded text-[20px]">close</span></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Type</label>
              <select className="form-input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                {Object.keys(ACTIVITY_ICONS).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Direction</label>
              <select className="form-input" value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}>
                <option value="outbound">Outbound</option>
                <option value="inbound">Inbound</option>
              </select>
            </div>
          </div>
          <div>
            <label className="form-label">Subject</label>
            <input className="form-input" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Brief description" />
          </div>
          <div>
            <label className="form-label">Notes / Body</label>
            <textarea className="form-input" rows={3} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="form-label">Outcome</label>
              <select className="form-input" value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}>
                <option value="">—</option>
                {['interested','not_interested','callback','converted','no_answer','voicemail'].map(o => (
                  <option key={o} value={o}>{o.replace(/_/g,' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label">Duration (mins)</label>
              <input className="form-input" type="number" value={form.duration_mins} onChange={e => setForm(f => ({ ...f, duration_mins: e.target.value }))} placeholder="0" />
            </div>
          </div>
          <div>
            <label className="form-label">Next Follow-up</label>
            <input className="form-input" type="datetime-local" value={form.next_follow_up} onChange={e => setForm(f => ({ ...f, next_follow_up: e.target.value }))} />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-60">{saving ? 'Saving…' : 'Log Activity'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function Contact360() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [data, setData]   = useState(null)
  const [tab, setTab]     = useState('overview')
  const [modal, setModal] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/crm/contacts/${id}/360`)
      setData(res)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  if (loading) return <div className="px-6 py-8 flex items-center gap-3 text-slate-400"><div className="spinner" /> Loading…</div>
  if (!data) return <div className="px-6 py-8 text-slate-400">Contact not found.</div>

  const { contact: c, account_info, deals, activities, tasks, requests, transactions, collections } = data
  const ai = ACTIVITY_ICONS

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      {/* Back */}
      <button onClick={() => navigate('/crm/contacts')} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 mb-5 transition-colors">
        <span className="material-symbols-rounded text-[18px]">arrow_back</span> Contacts
      </button>

      {/* Profile header */}
      <div className="card p-6 mb-5">
        <div className="flex items-start gap-5">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
            style={{ background: `hsl(${(c.id * 47) % 360} 55% 45%)` }}>
            {[(c.first_name||'?')[0],(c.last_name||'')[0]].join('').toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{c.first_name} {c.last_name}</h1>
              <span className={`badge ${STATUS_CLS[c.status] || 'badge-grey'}`}>{c.status}</span>
              {c.cif_number && <span className="badge badge-navy font-mono">{c.cif_number}</span>}
            </div>
            <div className="flex flex-wrap gap-4 mt-2">
              {c.phone && <span className="flex items-center gap-1 text-sm text-slate-500"><span className="material-symbols-rounded text-[16px]">phone</span>{c.phone}</span>}
              {c.email && <span className="flex items-center gap-1 text-sm text-slate-500"><span className="material-symbols-rounded text-[16px]">email</span>{c.email}</span>}
              {c.state && <span className="flex items-center gap-1 text-sm text-slate-500"><span className="material-symbols-rounded text-[16px]">location_on</span>{c.city ? `${c.city}, ` : ''}{c.state}</span>}
              {c.source && <span className="flex items-center gap-1 text-sm text-slate-500"><span className="material-symbols-rounded text-[16px]">source</span>{c.source.replace(/_/g,' ')}</span>}
            </div>
          </div>
          <button onClick={() => setModal('activity')} className="btn btn-primary gap-1.5 flex-shrink-0">
            <span className="material-symbols-rounded text-[17px]">add</span> Log Activity
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 dark:border-slate-700 mb-5">
        <Tab label="Overview"      active={tab==='overview'}  onClick={() => setTab('overview')} />
        <Tab label="Activity"      active={tab==='activity'}  onClick={() => setTab('activity')}  count={activities.length} />
        <Tab label="Deals"         active={tab==='deals'}     onClick={() => setTab('deals')}     count={deals.length} />
        <Tab label="Tasks"         active={tab==='tasks'}     onClick={() => setTab('tasks')}     count={tasks.length} />
        <Tab label="Requests"      active={tab==='requests'}  onClick={() => setTab('requests')}  count={requests.length} />
        {transactions.length > 0 && <Tab label="Transactions" active={tab==='transactions'} onClick={() => setTab('transactions')} count={transactions.length} />}
        {collections.length > 0  && <Tab label="Collections"  active={tab==='collections'}  onClick={() => setTab('collections')}  count={collections.length} />}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Contact details */}
          <div className="card p-5 lg:col-span-1">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Contact Details</p>
            {[
              { label: 'Occupation', value: c.occupation },
              { label: 'Employer', value: c.employer },
              { label: 'Income Range', value: c.income_range },
              { label: 'ID Type', value: c.id_type },
              { label: 'ID Number', value: c.id_number },
              { label: 'DOB', value: c.date_of_birth ? new Date(c.date_of_birth).toLocaleDateString('en-GB') : null },
              { label: 'Gender', value: c.gender },
              { label: 'Assigned To', value: c.assigned_name },
              { label: 'Added', value: new Date(c.created_at).toLocaleDateString('en-GB') },
            ].map(({ label, value }) => value && (
              <div key={label} className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                <span className="text-xs text-slate-500">{label}</span>
                <span className="text-xs font-medium text-slate-800 dark:text-slate-200">{value}</span>
              </div>
            ))}
            {c.notes && (
              <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700/50">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Notes</p>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{c.notes}</p>
              </div>
            )}
          </div>

          {/* Card / account info if linked */}
          <div className="lg:col-span-2 space-y-4">
            {account_info && (
              <div className="card p-5">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Card Account (Live)</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Product', value: account_info['Product Name'] },
                    { label: 'Status', value: account_info['Account Status'] },
                    { label: 'Account Manager', value: account_info['Account Manager'] },
                    { label: 'Opened', value: account_info['Account Created Date'] ? new Date(account_info['Account Created Date']).toLocaleDateString('en-GB') : null },
                    { label: 'Job Title', value: account_info['Job Title'] },
                  ].map(({ label, value }) => value && (
                    <div key={label} className="bg-slate-50 dark:bg-slate-900/40 rounded-lg p-3">
                      <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">{label}</p>
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent activity preview */}
            {activities.length > 0 && (
              <div className="card p-5">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Recent Activity</p>
                <div className="space-y-3">
                  {activities.slice(0, 4).map(a => {
                    const { icon, color } = ai[a.type] || { icon: 'history', color: '#94A3B8' }
                    return (
                      <div key={a.id} className="flex items-start gap-3">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${color}18` }}>
                          <span className="material-symbols-rounded text-[15px]" style={{ color }}>{icon}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-[13px] font-medium text-slate-700 dark:text-slate-200">{a.subject || a.type}</p>
                            {a.outcome && <span className={`badge ${OUTCOME_CLS[a.outcome] || 'badge-grey'}`}>{a.outcome.replace(/_/g,' ')}</span>}
                          </div>
                          <p className="text-xs text-slate-400">{a.agent_name} · {new Date(a.created_at).toLocaleDateString('en-GB')}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'activity' && (
        <div className="space-y-3">
          {activities.length === 0 && <div className="card p-10 text-center text-slate-400">No activities logged yet.</div>}
          {activities.map(a => {
            const { icon, color } = ai[a.type] || { icon: 'history', color: '#94A3B8' }
            return (
              <div key={a.id} className="card p-4 flex items-start gap-4">
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: `${color}18` }}>
                  <span className="material-symbols-rounded text-[18px]" style={{ color }}>{icon}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{a.subject || a.type}</p>
                    {a.outcome && <span className={`badge ${OUTCOME_CLS[a.outcome] || 'badge-grey'}`}>{a.outcome.replace(/_/g,' ')}</span>}
                    {a.direction && <span className="badge badge-grey">{a.direction}</span>}
                    {a.duration_mins && <span className="text-[11px] text-slate-400">{a.duration_mins} min</span>}
                  </div>
                  {a.body && <p className="text-sm text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{a.body}</p>}
                  {a.next_follow_up && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                      Follow up: {new Date(a.next_follow_up).toLocaleString('en-GB')}
                    </p>
                  )}
                  <p className="text-xs text-slate-400 mt-1.5">{a.agent_name} · {new Date(a.created_at).toLocaleString('en-GB')}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'deals' && (
        <div className="space-y-3">
          {deals.length === 0 && <div className="card p-10 text-center text-slate-400">No deals yet.</div>}
          {deals.map(d => (
            <div key={d.id} className="card p-4 flex items-center gap-4">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: d.stage_color || '#94A3B8' }} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{d.title}</p>
                <p className="text-xs text-slate-400">{d.stage_name} · {d.assigned_name || 'Unassigned'}</p>
              </div>
              {d.product && <span className="badge badge-navy">{d.product}</span>}
              {d.expected_value && <span className="text-sm font-bold text-emerald-600">{fmt(d.expected_value)}</span>}
              <span className="text-xs text-slate-400">{d.probability}%</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="space-y-3">
          {tasks.length === 0 && <div className="card p-10 text-center text-slate-400">No tasks.</div>}
          {tasks.map(t => (
            <div key={t.id} className={`card p-4 flex items-center gap-3 ${t.status === 'done' ? 'opacity-60' : ''}`}>
              <span className={`material-symbols-rounded text-[20px] ${t.status === 'done' ? 'text-emerald-500' : 'text-slate-400'}`}>
                {t.status === 'done' ? 'check_circle' : 'radio_button_unchecked'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{t.title}</p>
                {t.description && <p className="text-xs text-slate-400">{t.description}</p>}
              </div>
              <span className={`badge ${t.priority === 'urgent' ? 'badge-red' : t.priority === 'high' ? 'badge-amber' : 'badge-grey'}`}>
                {t.priority}
              </span>
              {t.due_date && (
                <span className={`text-xs ${new Date(t.due_date) < new Date() && t.status !== 'done' ? 'text-red-500 font-semibold' : 'text-slate-400'}`}>
                  {new Date(t.due_date).toLocaleDateString('en-GB')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'requests' && (
        <div className="space-y-3">
          {requests.length === 0 && <div className="card p-10 text-center text-slate-400">No requests.</div>}
          {requests.map(r => (
            <div key={r.id} className="card p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{r.subject}</p>
                    <span className={`badge ${r.status === 'open' ? 'badge-amber' : r.status === 'resolved' ? 'badge-green' : 'badge-grey'}`}>
                      {r.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">{r.request_type?.replace(/_/g,' ')} · {new Date(r.created_at).toLocaleDateString('en-GB')}</p>
                </div>
                <span className={`badge ${r.priority === 'urgent' ? 'badge-red' : r.priority === 'high' ? 'badge-amber' : 'badge-grey'}`}>{r.priority}</span>
              </div>
              {r.description && <p className="text-sm text-slate-600 dark:text-slate-400 mt-2">{r.description}</p>}
            </div>
          ))}
        </div>
      )}

      {tab === 'transactions' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Description</th><th>Merchant</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {transactions.map((t, i) => (
                  <tr key={i}>
                    <td className="text-slate-500 text-xs whitespace-nowrap">{t['Transaction Date'] ? new Date(t['Transaction Date']).toLocaleDateString('en-GB') : '—'}</td>
                    <td className="text-slate-700 dark:text-slate-300">{t.Description || '—'}</td>
                    <td className="text-slate-500">{t.Merchant_Name || '—'}</td>
                    <td className="text-right font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100">{fmt(t.Amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'collections' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Mode</th><th>Agent</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
              <tbody>
                {collections.map((col, i) => (
                  <tr key={i}>
                    <td className="text-slate-500 text-xs whitespace-nowrap">{col.Date ? new Date(col.Date).toLocaleDateString('en-GB') : '—'}</td>
                    <td><span className="badge badge-blue">{col['Mode Of Payment'] || '—'}</span></td>
                    <td className="text-slate-500">{col.Agent || '—'}</td>
                    <td className="font-mono text-xs text-slate-500">{col['Payment Receipt'] || '—'}</td>
                    <td className="text-right font-mono tabular-nums font-semibold text-emerald-600">{fmt(col.Amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal === 'activity' && (
        <LogActivityModal
          contactId={Number(id)}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); setTab('activity') }}
        />
      )}
    </div>
  )
}
