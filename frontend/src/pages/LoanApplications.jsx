import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { useAuth } from '../hooks/useAuth.js'
import PageShell from '../components/PageShell.jsx'

/* ── Stage config ── */
const STAGES = [
  { key: 'new',            label: 'New',            color: '#6B7280', bg: '#F3F4F6' },
  { key: 'submitted',      label: 'Submitted',      color: '#3B82F6', bg: '#EFF6FF' },
  { key: 'doc_collection', label: 'Docs Needed',    color: '#F59E0B', bg: '#FFFBEB' },
  { key: 'under_review',   label: 'Under Review',   color: '#8B5CF6', bg: '#F5F3FF' },
  { key: 'finance_review', label: 'Finance Review', color: '#0EA5E9', bg: '#F0F9FF' },
  { key: 'approved',       label: 'Approved',       color: '#059669', bg: '#F0FDF4' },
  { key: 'rejected',       label: 'Rejected',       color: '#C00000', bg: '#FFF0F0' },
  { key: 'on_hold',        label: 'On Hold',        color: '#D97706', bg: '#FFFBEB' },
]
const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]))

function StageBadge({ stage }) {
  const s = STAGE_MAP[stage] || STAGES[0]
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
      padding: '2px 8px', borderRadius: 999,
      color: s.color, background: s.bg, border: `1px solid ${s.color}33`,
    }}>{s.label}</span>
  )
}

function Initials({ name, size = 28 }) {
  if (!name) return null
  const parts = name.trim().split(' ')
  const init  = (parts[0]?.[0] || '') + (parts[1]?.[0] || '')
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: '#0E2841',
      color: '#fff', fontSize: size * 0.38, fontWeight: 700, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      textTransform: 'uppercase',
    }}>{init.toUpperCase()}</div>
  )
}

function fmtAmt(n) {
  if (!n) return '—'
  return '₦' + Number(n).toLocaleString()
}

/* ── Kanban card ── */
function AppCard({ app, selected, onClick }) {
  const docPct = app.doc_count > 0
    ? Math.round((app.confirmed_count / app.doc_count) * 100) : 0
  return (
    <div onClick={onClick} className="card card-hover"
      style={{
        padding: '12px 14px', cursor: 'pointer', marginBottom: 8,
        border: selected ? '1.5px solid #0E2841' : undefined,
        background: selected ? 'rgba(14,40,65,0.03)' : undefined,
      }}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <p style={{ fontSize: 13, fontWeight: 600, color: 'rgb(var(--fg-1))', lineHeight: 1.3 }}>
          {app.first_name} {app.last_name}
        </p>
        {app.assigned_to_name && <Initials name={app.assigned_to_name} size={22} />}
      </div>
      <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginBottom: 6 }}>
        {app.ref_no} · {app.loan_type}
      </p>
      {app.loan_amount && (
        <p style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#0E2841', marginBottom: 8 }}>
          {fmtAmt(app.loan_amount)}
        </p>
      )}
      {app.doc_count > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1" style={{ fontSize: 10, color: 'rgb(var(--fg-3))' }}>
            <span>Docs</span>
            <span>{app.confirmed_count}/{app.doc_count}</span>
          </div>
          <div style={{ height: 3, background: 'rgb(var(--bg-muted))', borderRadius: 2 }}>
            <div style={{
              width: `${docPct}%`, height: '100%', borderRadius: 2,
              background: docPct === 100 ? '#059669' : '#F59E0B',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Kanban column ── */
function KanbanCol({ stage, apps, selectedId, onSelect }) {
  const s = STAGE_MAP[stage.key]
  const total = apps.reduce((sum, a) => sum + (Number(a.loan_amount) || 0), 0)
  return (
    <div style={{ minWidth: 220, width: 220, flexShrink: 0 }}>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0, display: 'inline-block' }} />
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-2))' }}>
          {s.label}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, background: 'rgb(var(--bg-muted))',
          color: 'rgb(var(--fg-3))', borderRadius: 999, padding: '1px 7px',
        }}>{apps.length}</span>
        {total > 0 && (
          <span style={{ fontSize: 10, color: 'rgb(var(--fg-3))', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
            ₦{(total / 1_000_000).toFixed(1)}M
          </span>
        )}
      </div>
      <div style={{ minHeight: 120, overflowY: 'auto', maxHeight: 'calc(100vh - 320px)' }}>
        {apps.map(a => (
          <AppCard key={a.id} app={a} selected={selectedId === a.id} onClick={() => onSelect(a)} />
        ))}
        {apps.length === 0 && (
          <div style={{
            padding: '24px 12px', textAlign: 'center', borderRadius: 8,
            border: '1.5px dashed rgb(var(--border) / 0.15)',
          }}>
            <p style={{ fontSize: 11, color: 'rgb(var(--fg-4))' }}>Empty</p>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Activity timeline entry ── */
function ActivityEntry({ entry }) {
  const icons = {
    created: 'add_circle', stage_changed: 'swap_horiz', status_changed: 'flag',
    doc_added: 'attach_file', doc_confirmed: 'check_circle', doc_rejected: 'cancel',
    doc_removed: 'delete', doc_resubmitted: 'refresh', assigned: 'person',
    note_added: 'sticky_note_2', comment_added: 'chat_bubble',
  }
  const when = entry.created_at ? new Date(entry.created_at).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : ''
  return (
    <div className="flex gap-3 mb-4">
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: 'rgb(var(--bg-subtle))', border: '2px solid rgb(var(--bg-muted))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 13, color: '#0E2841' }}>
          {icons[entry.action] || 'circle'}
        </span>
      </div>
      <div style={{ flex: 1 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-1))' }}>{entry.user_name || 'System'}</span>
          <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{(entry.action || '').replace(/_/g, ' ')}</span>
          {entry.old_value && entry.new_value && (
            <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>
              <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{entry.old_value}</span>
              {' → '}
              <span style={{ fontWeight: 600, color: 'rgb(var(--fg-1))' }}>{entry.new_value}</span>
            </span>
          )}
        </div>
        {entry.note && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 1 }}>{entry.note}</p>}
        <p style={{ fontSize: 10, color: 'rgb(var(--fg-4))', marginTop: 1 }}>{when}</p>
      </div>
    </div>
  )
}

/* ── Document row ── */
function DocRow({ doc, isRisk, isSales, onConfirm, onReject, onDelete }) {
  const SC = { submitted: '#F59E0B', confirmed: '#059669', rejected: '#C00000' }
  const st = doc.status || 'submitted'
  return (
    <div className="flex items-start gap-3 py-3" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18, color: '#0E2841', marginTop: 1, flexShrink: 0 }}>description</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'rgb(var(--fg-1))' }}>{doc.doc_type}</p>
        {doc.filename && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{doc.filename}</p>}
        {doc.notes    && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', fontStyle: 'italic' }}>{doc.notes}</p>}
        {doc.confirmed_by_name && <p style={{ fontSize: 11, color: '#059669' }}>Confirmed by {doc.confirmed_by_name}</p>}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
          padding: '2px 7px', borderRadius: 999,
          color: SC[st], background: SC[st] + '18',
        }}>{st}</span>
        {isRisk && st === 'submitted' && (
          <>
            <button onClick={() => onConfirm(doc.id)} className="btn btn-icon btn-ghost" style={{ color: '#059669' }} title="Confirm">
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check</span>
            </button>
            <button onClick={() => onReject(doc.id)} className="btn btn-icon btn-ghost" style={{ color: '#C00000' }} title="Reject">
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
            </button>
          </>
        )}
        {isSales && (
          <button onClick={() => onDelete(doc.id)} className="btn btn-icon btn-ghost" style={{ color: 'rgb(var(--fg-3))' }} title="Remove">
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>delete</span>
          </button>
        )}
      </div>
    </div>
  )
}

/* ── Detail panel ── */
const NEXT_STAGES = {
  new:            ['submitted'],
  submitted:      ['doc_collection', 'under_review'],
  doc_collection: ['submitted', 'under_review'],
  under_review:   ['finance_review', 'approved', 'rejected', 'on_hold'],
  finance_review: ['approved', 'rejected', 'on_hold'],
  approved:       [],
  rejected:       [],
  on_hold:        ['under_review', 'finance_review', 'approved', 'rejected'],
}

function DetailPanel({ app, meta, users, user, onRefresh, onClose }) {
  const [tab, setTab]         = useState('docs')
  const [docForm, setDocForm] = useState({ doc_type: '', filename: '', notes: '' })
  const [comment, setComment] = useState('')
  const [saving,  setSaving]  = useState(false)

  const isRisk  = ['admin','head_it','management','md','coo','cfo','head_recovery','recovery'].includes(user?.role)
  const isSales = ['sales','head_sales','admin','head_it','management','md','coo'].includes(user?.role)

  const patch = async (body) => {
    await apiFetch(`/api/loans/applications/${app.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    onRefresh()
  }

  const addDoc = async (e) => {
    e.preventDefault()
    if (!docForm.doc_type) return
    setSaving(true)
    try {
      await apiFetch(`/api/loans/applications/${app.id}/documents`, { method: 'POST', body: JSON.stringify(docForm) })
      setDocForm({ doc_type: '', filename: '', notes: '' })
      onRefresh()
    } finally { setSaving(false) }
  }

  const sendComment = async (e) => {
    e.preventDefault()
    if (!comment.trim()) return
    setSaving(true)
    try {
      await apiFetch(`/api/loans/applications/${app.id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) })
      setComment('')
      onRefresh()
    } finally { setSaving(false) }
  }

  const nextStages = NEXT_STAGES[app.stage] || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 style={{ fontSize: 15, fontWeight: 700, color: 'rgb(var(--fg-1))' }}>
                {app.first_name} {app.last_name}
              </h2>
              <StageBadge stage={app.stage} />
            </div>
            <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>
              {app.ref_no} · {app.loan_type}{app.cif ? ` · CIF ${app.cif}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="btn btn-icon btn-ghost">
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        {/* Stage advance buttons */}
        {nextStages.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            <span style={{ fontSize: 10, color: 'rgb(var(--fg-3))', fontWeight: 600 }}>MOVE TO</span>
            {nextStages.map(sk => {
              const st = STAGE_MAP[sk]
              return (
                <button key={sk} onClick={() => patch({ stage: sk })}
                  style={{
                    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                    border: `1px solid ${st.color}44`, color: st.color, background: st.bg, cursor: 'pointer',
                  }}>
                  {st.label}
                </button>
              )
            })}
          </div>
        )}

        {/* Assign to */}
        <div className="flex items-center gap-2 mt-2">
          <span className="material-symbols-rounded" style={{ fontSize: 13, color: 'rgb(var(--fg-3))' }}>person</span>
          <select style={{ fontSize: 11, border: 'none', background: 'transparent', color: 'rgb(var(--fg-2))', cursor: 'pointer' }}
            value={app.assigned_to || ''}
            onChange={e => e.target.value && patch({ assigned_to: Number(e.target.value) })}>
            <option value="">Unassigned</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select>
        </div>
      </div>

      {/* Info grid */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          {[
            ['Amount',   app.loan_amount ? fmtAmt(app.loan_amount) : '—'],
            ['Submitted', app.created_at  ? new Date(app.created_at).toLocaleDateString('en-GB') : '—'],
            ['Created by', app.created_by_name  || '—'],
            ['Reviewer',   app.reviewed_by_name || '—'],
            ['Phone', app.phone || '—'],
            ['Email', app.email || '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>{k}</p>
              <p style={{ fontSize: 12, color: 'rgb(var(--fg-1))' }}>{v}</p>
            </div>
          ))}
        </div>
        {app.purpose && (
          <div className="mt-2">
            <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>Purpose</p>
            <p style={{ fontSize: 12, color: 'rgb(var(--fg-2))' }}>{app.purpose}</p>
          </div>
        )}
        {app.notes && (
          <div className="mt-2 p-2 rounded-lg" style={{ background: 'rgb(var(--bg-subtle))' }}>
            <p style={{ fontSize: 11, color: 'rgb(var(--fg-2))' }}>{app.notes}</p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)', padding: '0 20px' }}>
        {[
          { key: 'docs',     label: 'Documents', count: app.documents?.length  },
          { key: 'activity', label: 'Activity',  count: app.activity?.length   },
          { key: 'comments', label: 'Comments',  count: app.comments?.length   },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            fontSize: 12, fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? '#0E2841' : 'rgb(var(--fg-3))',
            padding: '9px 12px',
            borderBottom: tab === t.key ? '2px solid #0E2841' : '2px solid transparent',
            background: 'none', cursor: 'pointer',
          }}>
            {t.label}{t.count ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>

      {/* Tab body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>

        {tab === 'docs' && (
          <>
            {(app.documents || []).map(d => (
              <DocRow key={d.id} doc={d}
                isRisk={isRisk} isSales={isSales}
                onConfirm={id => apiFetch(`/api/loans/applications/${app.id}/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) }).then(onRefresh)}
                onReject={id  => apiFetch(`/api/loans/applications/${app.id}/documents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected'  }) }).then(onRefresh)}
                onDelete={id  => { if (confirm('Remove this document?')) apiFetch(`/api/loans/applications/${app.id}/documents/${id}`, { method: 'DELETE' }).then(onRefresh) }}
              />
            ))}
            {isSales && (
              <form onSubmit={addDoc} className="mt-4 p-3 rounded-lg" style={{ background: 'rgb(var(--bg-subtle))' }}>
                <p style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: 'rgb(var(--fg-2))' }}>Add Document</p>
                <select className="form-input mb-2" style={{ fontSize: 12 }}
                  value={docForm.doc_type}
                  onChange={e => setDocForm(f => ({ ...f, doc_type: e.target.value }))} required>
                  <option value="">Document type…</option>
                  {(meta?.doc_types || []).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input className="form-input mb-2" style={{ fontSize: 12 }} placeholder="Filename (optional)"
                  value={docForm.filename} onChange={e => setDocForm(f => ({ ...f, filename: e.target.value }))} />
                <input className="form-input mb-2" style={{ fontSize: 12 }} placeholder="Notes (optional)"
                  value={docForm.notes} onChange={e => setDocForm(f => ({ ...f, notes: e.target.value }))} />
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !docForm.doc_type}>
                  {saving ? 'Adding…' : 'Add Document'}
                </button>
              </form>
            )}
          </>
        )}

        {tab === 'activity' && (
          <>
            {(app.activity || []).length === 0
              ? <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))', textAlign: 'center', padding: '24px 0' }}>No activity yet</p>
              : (app.activity || []).map(a => <ActivityEntry key={a.id} entry={a} />)
            }
          </>
        )}

        {tab === 'comments' && (
          <>
            {(app.comments || []).map(c => (
              <div key={c.id} className="flex gap-3 mb-4">
                <Initials name={c.user_name} size={28} />
                <div style={{ flex: 1 }}>
                  <div className="flex items-baseline gap-2">
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--fg-1))' }}>{c.user_name}</span>
                    <span style={{ fontSize: 10, color: 'rgb(var(--fg-4))' }}>
                      {c.created_at ? new Date(c.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, color: 'rgb(var(--fg-1))', marginTop: 3, lineHeight: 1.5 }}>{c.body}</p>
                </div>
              </div>
            ))}
            <form onSubmit={sendComment} className="flex gap-2 mt-2">
              <input className="form-input" style={{ flex: 1, fontSize: 13 }}
                placeholder="Add a comment…" value={comment}
                onChange={e => setComment(e.target.value)} />
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !comment.trim()}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>send</span>
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

/* ── New Application modal ── */
function NewAppModal({ meta, users, onClose, onCreated }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', cif: '', phone: '', email: '',
    loan_type: 'Personal Loan', loan_amount: '', purpose: '', assigned_to: '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const app = await apiFetch('/api/loans/applications', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          loan_amount: form.loan_amount ? Number(form.loan_amount) : null,
          assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
          cif:   form.cif   || null,
          phone: form.phone || null,
          email: form.email || null,
        }),
      })
      onCreated(app)
    } catch (e) {
      setError(e.message || 'Failed to create')
    } finally { setSaving(false) }
  }

  const F = (field) => ({ value: form[field], onChange: e => setForm(f => ({ ...f, [field]: e.target.value })) })

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto' }}>
        <div className="flex items-center justify-between p-5" style={{ borderBottom: '1px solid rgb(var(--border) / 0.1)' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>New Loan Application</h2>
          <button onClick={onClose} className="btn btn-icon btn-ghost">
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>
        <form onSubmit={submit} style={{ padding: 20 }}>
          {error && <p style={{ color: '#C00000', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="form-label">First Name *</label><input className="form-input" required {...F('first_name')} /></div>
            <div><label className="form-label">Last Name *</label><input className="form-input" required {...F('last_name')} /></div>
            <div><label className="form-label">CIF Number</label><input className="form-input" placeholder="If existing customer" {...F('cif')} /></div>
            <div><label className="form-label">Phone</label><input className="form-input" {...F('phone')} /></div>
            <div><label className="form-label">Email</label><input className="form-input" type="email" {...F('email')} /></div>
            <div>
              <label className="form-label">Loan Type *</label>
              <select className="form-input" required {...F('loan_type')}>
                {(meta?.loan_types || []).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><label className="form-label">Amount (₦)</label><input className="form-input" type="number" min="0" {...F('loan_amount')} /></div>
            <div>
              <label className="form-label">Assign To</label>
              <select className="form-input" {...F('assigned_to')}>
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-4">
            <label className="form-label">Purpose</label>
            <textarea className="form-input" rows={3} placeholder="Brief purpose…" {...F('purpose')} />
          </div>
          <div className="flex justify-end gap-3 mt-5">
            <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ── Main page ── */
export default function LoanApplications() {
  const { user } = useAuth()
  const [apps,    setApps]    = useState([])
  const [detail,  setDetail]  = useState(null)
  const [meta,    setMeta]    = useState(null)
  const [users,   setUsers]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [showNew, setShowNew] = useState(false)
  const [filter,  setFilter]  = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [appList, metaData, userList] = await Promise.all([
        apiFetch('/api/loans/applications?limit=500'),
        apiFetch('/api/loans/meta'),
        apiFetch('/api/loans/users'),
      ])
      setApps(appList || [])
      setMeta(metaData)
      setUsers(userList || [])
    } catch (e) {
      setError(e.message || 'Failed to load')
    } finally { setLoading(false) }
  }, [])

  const loadDetail = useCallback(async (id) => {
    try {
      const d = await apiFetch(`/api/loans/applications/${id}`)
      setDetail(d)
    } catch {/* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const refresh = useCallback(async () => {
    await load()
    if (detail) await loadDetail(detail.id)
  }, [load, loadDetail, detail])

  const grouped = STAGES.reduce((acc, s) => {
    acc[s.key] = apps.filter(a => {
      const st = a.stage || 'new'
      return st === s.key &&
        (!filter || `${a.first_name} ${a.last_name} ${a.ref_no}`.toLowerCase().includes(filter.toLowerCase()))
    })
    return acc
  }, {})

  const stats = {
    total:    apps.length,
    active:   apps.filter(a => !['approved','rejected'].includes(a.stage)).length,
    approved: apps.filter(a => a.stage === 'approved').length,
    value:    apps.reduce((s, a) => s + (Number(a.loan_amount) || 0), 0),
  }

  return (
    <PageShell
      title="Loan Applications"
      subtitle="Track each application through the full review pipeline"
      error={error}
      actions={
        <div className="flex items-center gap-2">
          <div style={{ position: 'relative' }}>
            <span className="material-symbols-rounded" style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 16, color: 'rgb(var(--fg-3))', pointerEvents: 'none',
            }}>search</span>
            <input className="form-input" style={{ paddingLeft: 32, width: 220 }}
              placeholder="Search…" value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>add</span>
            New Application
          </button>
        </div>
      }
    >
      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total',       value: stats.total,    icon: 'folder_open',  color: '#0E2841' },
          { label: 'In Progress', value: stats.active,   icon: 'pending',      color: '#F59E0B' },
          { label: 'Approved',    value: stats.approved, icon: 'check_circle', color: '#059669' },
          { label: 'Total Value', value: '₦' + (stats.value / 1_000_000).toFixed(1) + 'M', icon: 'payments', color: '#8B5CF6' },
        ].map(k => (
          <div key={k.label} className="card p-4 flex items-center gap-3">
            <div style={{ width: 36, height: 36, borderRadius: 8, background: k.color + '14', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: k.color }}>{k.icon}</span>
            </div>
            <div>
              <p style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'rgb(var(--fg-3))' }}>{k.label}</p>
              <p style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'rgb(var(--fg-1))' }}>{k.value}</p>
            </div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><div className="spinner" /></div>
      ) : (
        <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 290px)' }}>
          {/* Board */}
          <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', display: 'flex', gap: 16, paddingBottom: 8 }}>
            {STAGES.map(stage => (
              <KanbanCol key={stage.key} stage={stage}
                apps={grouped[stage.key] || []}
                selectedId={detail?.id}
                onSelect={a => { setDetail(null); loadDetail(a.id) }}
              />
            ))}
          </div>

          {/* Detail */}
          {detail && (
            <div className="card" style={{ width: 400, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <DetailPanel
                app={detail} meta={meta} users={users} user={user}
                onRefresh={refresh}
                onClose={() => setDetail(null)}
              />
            </div>
          )}
        </div>
      )}

      {showNew && (
        <NewAppModal meta={meta} users={users}
          onClose={() => setShowNew(false)}
          onCreated={async (app) => { setShowNew(false); await refresh(); loadDetail(app.id) }}
        />
      )}
    </PageShell>
  )
}
