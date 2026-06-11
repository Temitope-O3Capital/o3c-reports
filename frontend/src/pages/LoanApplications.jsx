import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import PageShell from '../components/PageShell.jsx'
import { useAuth } from '../hooks/useAuth.js'

const STATUS_STYLE = {
  pending:      { bg: '#FEF9C3', fg: '#854D0E', label: 'Pending' },
  under_review: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'Under Review' },
  approved:     { bg: '#DCFCE7', fg: '#166534', label: 'Approved' },
  rejected:     { bg: '#FEE2E2', fg: '#991B1B', label: 'Rejected' },
}
const DOC_STATUS_STYLE = {
  submitted:  { bg: '#F1F5F9', fg: '#475569', label: 'Submitted' },
  confirmed:  { bg: '#DCFCE7', fg: '#166534', label: 'Confirmed' },
  rejected:   { bg: '#FEE2E2', fg: '#991B1B', label: 'Rejected' },
}
function StatusBadge({ status, map }) {
  const s = (map || STATUS_STYLE)[status] || { bg: '#F1F5F9', fg: '#64748B', label: status }
  return <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: s.bg, color: s.fg }}>{s.label}</span>
}

export default function LoanApplications() {
  const { user } = useAuth()
  const isRisk   = ['admin','head_it','head_recovery','recovery','management','md','coo','cfo'].includes(user?.role)

  const [apps,       setApps]       = useState([])
  const [meta,       setMeta]       = useState({ loan_types: [], doc_types: [], statuses: [] })
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // ── Detail panel
  const [selected,   setSelected]   = useState(null)
  const [detail,     setDetail]     = useState(null)
  const [detailLoad, setDetailLoad] = useState(false)

  // ── Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [form,       setForm]       = useState({ first_name:'',last_name:'',cif:'',phone:'',email:'',loan_type:'Personal Loan',loan_amount:'',purpose:'' })
  const [saving,     setSaving]     = useState(false)

  // ── Add document
  const [docForm,    setDocForm]    = useState({ doc_type:'', filename:'', notes:'' })
  const [addingDoc,  setAddingDoc]  = useState(false)

  const loadApps = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [a, m] = await Promise.all([
        apiFetch(`/api/loans/applications${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiFetch('/api/loans/meta'),
      ])
      setApps(a || [])
      setMeta(m || { loan_types: [], doc_types: [], statuses: [] })
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [statusFilter])

  useEffect(() => { loadApps() }, [loadApps])

  async function loadDetail(id) {
    setDetailLoad(true)
    try { setDetail(await apiFetch(`/api/loans/applications/${id}`)) }
    catch { /* non-critical */ }
    finally { setDetailLoad(false) }
  }

  function selectApp(app) { setSelected(app.id); loadDetail(app.id) }

  async function createApp() {
    if (!form.first_name.trim() || !form.last_name.trim()) return
    setSaving(true)
    try {
      await apiFetch('/api/loans/applications', { method: 'POST', body: JSON.stringify({ ...form, loan_amount: form.loan_amount ? Number(form.loan_amount) : null }) })
      setShowCreate(false)
      setForm({ first_name:'',last_name:'',cif:'',phone:'',email:'',loan_type:'Personal Loan',loan_amount:'',purpose:'' })
      loadApps()
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function updateStatus(id, status) {
    try {
      await apiFetch(`/api/loans/applications/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      loadApps(); if (selected === id) loadDetail(id)
    } catch (e) { setError(e.message) }
  }

  async function addDoc() {
    if (!docForm.doc_type) return
    setAddingDoc(true)
    try {
      await apiFetch(`/api/loans/applications/${selected}/documents`, { method: 'POST', body: JSON.stringify(docForm) })
      setDocForm({ doc_type:'', filename:'', notes:'' })
      loadDetail(selected); loadApps()
    } catch (e) { setError(e.message) }
    finally { setAddingDoc(false) }
  }

  async function confirmDoc(docId, status) {
    try {
      await apiFetch(`/api/loans/applications/${selected}/documents/${docId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      loadDetail(selected)
    } catch (e) { setError(e.message) }
  }

  async function removeDoc(docId) {
    try {
      await apiFetch(`/api/loans/applications/${selected}/documents/${docId}`, { method: 'DELETE' })
      loadDetail(selected); loadApps()
    } catch (e) { setError(e.message) }
  }

  const STATUSES = ['pending','under_review','approved','rejected']

  return (
    <PageShell
      title="Loan Applications"
      subtitle="Sales submits customer documents · Risk reviews and approves"
      error={error}
      actions={
        <div className="flex items-center gap-2">
          {/* Status filter */}
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="form-input py-1.5 text-sm">
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_STYLE[s]?.label || s}</option>)}
          </select>
          <button onClick={() => setShowCreate(true)} className="btn btn-primary gap-2 text-sm">
            <span className="material-symbols-rounded text-[17px]">add</span>New Application
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4" style={{ minHeight: 500 }}>

        {/* ── Applications list (left) ── */}
        <div className="lg:col-span-2 card overflow-hidden flex flex-col">
          <div className="px-4 py-3" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Applications <span className="ml-1.5 text-xs font-normal text-slate-400">{apps.length}</span>
            </p>
          </div>
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex justify-center py-12"><div className="spinner" /></div>
            ) : apps.length === 0 ? (
              <div className="flex flex-col items-center py-12 gap-2" style={{ color: 'rgb(var(--fg-3))' }}>
                <span className="material-symbols-rounded text-[36px] opacity-30">folder_open</span>
                <p className="text-sm">No applications</p>
              </div>
            ) : apps.map(app => (
              <button key={app.id} onClick={() => selectApp(app)}
                className={`w-full text-left px-4 py-3 transition-colors ${selected === app.id ? 'bg-primary/5 dark:bg-primary/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                style={{ borderBottom: '1px solid rgb(var(--border) / 0.05)' }}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">
                    {app.first_name} {app.last_name}
                  </p>
                  <StatusBadge status={app.status} />
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <span className="font-mono">{app.ref_no}</span>
                  <span>·</span>
                  <span>{app.loan_type}</span>
                  {app.loan_amount && <><span>·</span><span>₦{Number(app.loan_amount).toLocaleString()}</span></>}
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-slate-400">
                    {app.doc_count} doc{app.doc_count !== 1 ? 's' : ''}
                  </span>
                  {app.confirmed_count > 0 && (
                    <span className="text-xs font-medium text-emerald-600">{app.confirmed_count} confirmed</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Detail panel (right) ── */}
        <div className="lg:col-span-3 card overflow-hidden flex flex-col">
          {!selected ? (
            <div className="flex flex-col items-center justify-center h-full py-16 gap-3" style={{ color: 'rgb(var(--fg-3))' }}>
              <span className="material-symbols-rounded text-[48px] opacity-20">description</span>
              <p className="text-sm">Select an application to view details</p>
            </div>
          ) : detailLoad ? (
            <div className="flex justify-center py-16"><div className="spinner" /></div>
          ) : detail ? (
            <div className="flex flex-col h-full overflow-y-auto">
              {/* Header */}
              <div className="px-5 py-4 flex items-start justify-between" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
                <div>
                  <p className="text-base font-bold text-slate-900 dark:text-white">{detail.first_name} {detail.last_name}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400">
                    <span className="font-mono">{detail.ref_no}</span>
                    {detail.cif && <><span>·</span><span>CIF: {detail.cif}</span></>}
                    {detail.phone && <><span>·</span><span>{detail.phone}</span></>}
                  </div>
                </div>
                <StatusBadge status={detail.status} />
              </div>

              {/* Loan info */}
              <div className="px-5 py-4 grid grid-cols-2 gap-3 text-sm" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
                <div><p className="text-xs text-slate-400 mb-0.5">Loan Type</p><p className="font-medium">{detail.loan_type}</p></div>
                {detail.loan_amount && <div><p className="text-xs text-slate-400 mb-0.5">Amount</p><p className="font-medium font-mono">₦{Number(detail.loan_amount).toLocaleString()}</p></div>}
                {detail.purpose && <div className="col-span-2"><p className="text-xs text-slate-400 mb-0.5">Purpose</p><p>{detail.purpose}</p></div>}
                <div><p className="text-xs text-slate-400 mb-0.5">Submitted by</p><p className="font-medium">{detail.created_by_name || '—'}</p></div>
                <div><p className="text-xs text-slate-400 mb-0.5">Reviewed by</p><p className="font-medium">{detail.reviewed_by_name || '—'}</p></div>
              </div>

              {/* Risk actions */}
              {isRisk && detail.status !== 'approved' && detail.status !== 'rejected' && (
                <div className="px-5 py-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
                  <p className="text-xs font-semibold text-slate-500 mr-1">Risk decision:</p>
                  <button onClick={() => updateStatus(detail.id, 'under_review')} className="btn btn-ghost text-xs px-3 py-1.5 gap-1">
                    <span className="material-symbols-rounded text-[14px]">visibility</span>Mark Under Review
                  </button>
                  <button onClick={() => updateStatus(detail.id, 'approved')}
                    className="btn text-xs px-3 py-1.5 gap-1 font-semibold text-white"
                    style={{ background: '#059669', borderRadius: 'var(--r-md)' }}>
                    <span className="material-symbols-rounded text-[14px]">check_circle</span>Approve
                  </button>
                  <button onClick={() => updateStatus(detail.id, 'rejected')}
                    className="btn text-xs px-3 py-1.5 gap-1 font-semibold text-white"
                    style={{ background: '#C00000', borderRadius: 'var(--r-md)' }}>
                    <span className="material-symbols-rounded text-[14px]">cancel</span>Reject
                  </button>
                </div>
              )}

              {/* Documents */}
              <div className="px-5 py-4 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgb(var(--fg-3))' }}>
                  Documents ({detail.documents?.length || 0})
                </p>
                <div className="space-y-2">
                  {(detail.documents || []).map(doc => (
                    <div key={doc.id} className="rounded-lg px-3 py-2.5 flex items-center justify-between gap-3"
                      style={{ background: 'rgb(var(--bg-subtle))', border: '1px solid rgb(var(--border) / 0.06)' }}>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="material-symbols-rounded text-[18px] text-slate-400 flex-shrink-0">description</span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{doc.doc_type}</p>
                          {doc.filename && <p className="text-xs text-slate-400 truncate">{doc.filename}</p>}
                          {doc.notes && <p className="text-xs text-slate-400 italic truncate">{doc.notes}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <StatusBadge status={doc.status} map={DOC_STATUS_STYLE} />
                        {isRisk && doc.status === 'submitted' && (
                          <>
                            <button onClick={() => confirmDoc(doc.id, 'confirmed')} title="Confirm document"
                              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">
                              <span className="material-symbols-rounded text-[16px] text-emerald-600">check</span>
                            </button>
                            <button onClick={() => confirmDoc(doc.id, 'rejected')} title="Reject document"
                              className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                              <span className="material-symbols-rounded text-[16px] text-red-500">close</span>
                            </button>
                          </>
                        )}
                        {!isRisk && (
                          <button onClick={() => removeDoc(doc.id)} title="Remove document"
                            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-50 transition-colors">
                            <span className="material-symbols-rounded text-[15px] text-slate-400 hover:text-red-500">delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add document (Sales) */}
                {!isRisk && (
                  <div className="mt-3 rounded-lg p-3" style={{ border: '1px dashed rgb(var(--border) / 0.2)' }}>
                    <p className="text-xs font-semibold text-slate-400 mb-2">Add Document</p>
                    <div className="grid grid-cols-1 gap-2">
                      <select value={docForm.doc_type} onChange={e => setDocForm(f => ({...f, doc_type: e.target.value}))} className="form-input text-sm py-1.5">
                        <option value="">Select document type…</option>
                        {(meta.doc_types || []).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <input value={docForm.filename} onChange={e => setDocForm(f => ({...f, filename: e.target.value}))}
                        placeholder="Filename / reference (optional)" className="form-input text-sm py-1.5" />
                      <input value={docForm.notes} onChange={e => setDocForm(f => ({...f, notes: e.target.value}))}
                        placeholder="Notes (optional)" className="form-input text-sm py-1.5" />
                      <button onClick={addDoc} disabled={addingDoc || !docForm.doc_type}
                        className="btn btn-primary text-sm py-1.5 gap-1.5 disabled:opacity-50">
                        <span className="material-symbols-rounded text-[15px]">attach_file</span>
                        {addingDoc ? 'Adding…' : 'Add Document'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Create Application Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => e.target === e.currentTarget && setShowCreate(false)}>
          <div className="w-full max-w-lg rounded-xl overflow-hidden" style={{ background: 'rgb(var(--bg-surface))', boxShadow: 'var(--shadow-xl)' }}>
            <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">New Loan Application</h2>
            </div>
            <div className="px-6 py-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">First Name *</label>
                  <input value={form.first_name} onChange={e => setForm(f=>({...f,first_name:e.target.value}))} className="form-input" />
                </div>
                <div>
                  <label className="form-label">Last Name *</label>
                  <input value={form.last_name} onChange={e => setForm(f=>({...f,last_name:e.target.value}))} className="form-input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">CIF Number</label>
                  <input value={form.cif} onChange={e => setForm(f=>({...f,cif:e.target.value}))} className="form-input" placeholder="If existing customer" />
                </div>
                <div>
                  <label className="form-label">Phone</label>
                  <input value={form.phone} onChange={e => setForm(f=>({...f,phone:e.target.value}))} className="form-input" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">Loan Type</label>
                  <select value={form.loan_type} onChange={e => setForm(f=>({...f,loan_type:e.target.value}))} className="form-input">
                    {(meta.loan_types || []).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label">Loan Amount (₦)</label>
                  <input type="number" value={form.loan_amount} onChange={e => setForm(f=>({...f,loan_amount:e.target.value}))} className="form-input" placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="form-label">Purpose</label>
                <input value={form.purpose} onChange={e => setForm(f=>({...f,purpose:e.target.value}))} className="form-input" placeholder="Brief description of loan purpose" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4" style={{ borderTop: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--bg-subtle))' }}>
              <button onClick={() => setShowCreate(false)} className="btn btn-ghost text-sm px-4 py-2">Cancel</button>
              <button onClick={createApp} disabled={saving || !form.first_name.trim() || !form.last_name.trim()}
                className="btn btn-primary gap-2 disabled:opacity-50">
                {saving ? 'Creating…' : 'Create Application'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}
