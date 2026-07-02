import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, KpiCard, Page, SectionCard, DataTable, NAVY, RED, GREEN, AMBER } from '../../components/UI'
import type { ColDef } from '../../components/UI'

interface DisciplinaryRow {
  id: string; employee_id: string; first_name: string; last_name: string; staff_id: string
  case_ref: string; incident_type: string; severity: string; incident_date: string
  description: string; status: string; sanction: string | null; resolved_at: string | null; created_at: string
}
interface CaseDetail { case: DisciplinaryRow; events: any[] }
interface AddForm {
  employee_id: string; incident_type: string; severity: string
  incident_date: string; description: string; evidence_urls: string
}
interface UpdateForm { status: string; sanction: string; notes: string }

const SEVERITIES = ['verbal_warning', 'written_warning', 'suspension', 'termination']
const STATUSES   = ['open', 'under_review', 'closed']
const EMPTY_ADD: AddForm = { employee_id: '', incident_type: '', severity: 'verbal_warning', incident_date: '', description: '', evidence_urls: '' }
const EMPTY_UPD: UpdateForm = { status: 'under_review', sanction: '', notes: '' }

const SEV_COLOR: Record<string, string> = {
  verbal_warning:  AMBER,
  written_warning: '#D97706',
  suspension:      RED,
  termination:     '#7F1D1D',
}

export default function Disciplinary() {
  const [rows, setRows]         = useState<DisciplinaryRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [statusF, setStatusF]   = useState('')
  const [severityF, setSeverityF] = useState('')

  const [detail, setDetail]     = useState<CaseDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [showAdd, setShowAdd]   = useState(false)
  const [addForm, setAddForm]   = useState<AddForm>(EMPTY_ADD)
  const [adding, setAdding]     = useState(false)
  const [addErr, setAddErr]     = useState('')

  const [updateTarget, setUpdateTarget] = useState<DisciplinaryRow | null>(null)
  const [updateForm, setUpdateForm]     = useState<UpdateForm>(EMPTY_UPD)
  const [updating, setUpdating]         = useState(false)
  const [updateErr, setUpdateErr]       = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (statusF)   params.set('status', statusF)
      if (severityF) params.set('severity', severityF)
      const res = await apiFetch<{ data: DisciplinaryRow[] }>(`/api/hr/disciplinary?${params}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [statusF, severityF])

  useEffect(() => { load() }, [load])

  async function openDetail(row: DisciplinaryRow) {
    setDetailLoading(true)
    try {
      const res = await apiFetch<CaseDetail>(`/api/hr/disciplinary/${row.id}`)
      setDetail(res)
    } catch { setDetail({ case: row, events: [] }) }
    finally { setDetailLoading(false) }
  }

  async function submitAdd() {
    setAdding(true); setAddErr('')
    try {
      const evidence_urls = addForm.evidence_urls
        ? addForm.evidence_urls.split('\n').map(s => s.trim()).filter(Boolean)
        : []
      await apiPost('/api/hr/disciplinary', { ...addForm, evidence_urls })
      setShowAdd(false)
      setAddForm(EMPTY_ADD)
      load()
    } catch (e: any) {
      setAddErr(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function submitUpdate() {
    if (!updateTarget) return
    setUpdating(true); setUpdateErr('')
    try {
      await apiPut(`/api/hr/disciplinary/${updateTarget.id}/status`, updateForm)
      setUpdateTarget(null)
      load()
    } catch (e: any) {
      setUpdateErr(e.message)
    } finally {
      setUpdating(false)
    }
  }

  const openCount   = rows.filter(r => r.status === 'open').length
  const reviewCount = rows.filter(r => r.status === 'under_review').length
  const closedCount = rows.filter(r => r.status === 'closed').length

  const cols: ColDef<DisciplinaryRow>[] = [
    { key: 'case_ref',      label: 'Case Ref',  render: r => <span className="font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{r.case_ref}</span> },
    { key: 'name',          label: 'Employee',  render: r => <span className="font-semibold" style={{ color: 'var(--txt)' }}>{r.first_name} {r.last_name}</span> },
    { key: 'incident_type', label: 'Incident' },
    {
      key: 'severity', label: 'Severity',
      render: r => (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
          style={{ background: `${SEV_COLOR[r.severity] ?? '#64748B'}15`, color: SEV_COLOR[r.severity] ?? 'var(--txt2)' }}>
          {snake(r.severity)}
        </span>
      ),
    },
    { key: 'incident_date', label: 'Date',       render: r => fmtDate(r.incident_date) },
    { key: 'status',        label: 'Status',     render: r => <StatusBadge status={r.status} /> },
    { key: 'sanction',      label: 'Sanction',   render: r => r.sanction ?? '—' },
    {
      key: 'actions', label: '', sortable: false,
      render: r => (
        <div className="flex gap-1.5">
          <button onClick={() => openDetail(r)}
            className="p-1.5 rounded-lg" style={{ color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded text-[16px]">visibility</span>
          </button>
          <button onClick={() => { setUpdateTarget(r); setUpdateForm({ status: r.status, sanction: r.sanction ?? '', notes: '' }) }}
            className="p-1.5 rounded-lg" style={{ color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded text-[16px]">edit</span>
          </button>
        </div>
      ),
    },
  ]

  return (
    <Page
      dept="HR"
      title="Disciplinary Cases"
      actions={
        <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white" style={{ background: NAVY }}
          onClick={() => { setShowAdd(true); setAddForm(EMPTY_ADD) }}>
          <span className="material-symbols-rounded text-[15px] align-middle mr-1">add</span>
          New Case
        </button>
      }
    >
      <ErrBanner msg={error} />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <KpiCard label="Open Cases"       value={String(openCount)}   icon="gavel"            accent={RED}   loading={loading && !rows.length} />
        <KpiCard label="Under Review"     value={String(reviewCount)} icon="manage_search"    accent={AMBER} loading={loading && !rows.length} />
        <KpiCard label="Closed"           value={String(closedCount)} icon="task_alt"         accent={GREEN} loading={loading && !rows.length} />
      </div>

      <SectionCard
        title="Case Register"
        actions={
          <div className="flex gap-2">
            <select className="px-3 py-1.5 rounded-lg text-[12px] focus:outline-none" style={{ border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={statusF} onChange={e => setStatusF(e.target.value)}>
              <option value="">All Statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
            </select>
            <select className="px-3 py-1.5 rounded-lg text-[12px] focus:outline-none" style={{ border: '1px solid var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
              value={severityF} onChange={e => setSeverityF(e.target.value)}>
              <option value="">All Severities</option>
              {SEVERITIES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
            </select>
          </div>
        }
      >
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="gavel" emptyMsg="No disciplinary cases found" />
      </SectionCard>

      {/* Case detail drawer */}
      {(detail || detailLoading) && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
          <div className="w-full max-w-md h-full overflow-y-auto shadow-2xl flex flex-col" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--bdr)' }}>
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>Case Detail</h2>
              <button onClick={() => setDetail(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            {detailLoading ? (
              <div className="flex items-center justify-center flex-1"><Spinner size={32} /></div>
            ) : detail && (
              <div className="p-5 space-y-5">
                <div className="space-y-2">
                  {[
                    ['Case Ref',    detail.case.case_ref],
                    ['Employee',    `${detail.case.first_name} ${detail.case.last_name} (${detail.case.staff_id})`],
                    ['Incident',    detail.case.incident_type],
                    ['Severity',    snake(detail.case.severity)],
                    ['Date',        fmtDate(detail.case.incident_date)],
                    ['Status',      detail.case.status],
                    ['Sanction',    detail.case.sanction ?? '—'],
                    ['Resolved',    detail.case.resolved_at ? fmtDate(detail.case.resolved_at) : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{k}</span>
                      <span className="text-[12px] text-right max-w-[60%]" style={{ color: 'var(--txt)' }}>{v}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--txt2)' }}>Description</p>
                  <p className="text-[13px]" style={{ color: 'var(--txt)' }}>{detail.case.description}</p>
                </div>
                {detail.events.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--txt2)' }}>Timeline</p>
                    <div className="space-y-3">
                      {detail.events.map((ev, i) => (
                        <div key={i} className="flex gap-3">
                          <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: NAVY }} />
                          <div>
                            <p className="text-[12px]" style={{ color: 'var(--txt)' }}>{ev.notes ?? ev.event ?? JSON.stringify(ev)}</p>
                            <p className="text-[11px] mt-0.5" style={{ color: 'var(--txt2)' }}>{fmtDate(ev.created_at)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Update status modal */}
      {updateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setUpdateTarget(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="disc-update-title" className="rounded-2xl shadow-xl p-6 w-full max-w-md" style={{ background: 'var(--card)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 id="disc-update-title" className="text-[16px] font-bold" style={{ color: 'var(--txt)' }}>Update Case Status</h2>
              <button onClick={() => setUpdateTarget(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <p className="text-[12px] mb-4" style={{ color: 'var(--txt2)' }}>{updateTarget.case_ref} — {updateTarget.first_name} {updateTarget.last_name}</p>
            <ErrBanner msg={updateErr} />
            <div className="space-y-3">
              <div>
                <label htmlFor="disc-status" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Status</label>
                <select id="disc-status" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={updateForm.status} onChange={e => setUpdateForm(f => ({ ...f, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="disc-sanction" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Sanction</label>
                <input id="disc-sanction" type="text" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={updateForm.sanction} onChange={e => setUpdateForm(f => ({ ...f, sanction: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="disc-notes" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Notes</label>
                <textarea id="disc-notes" rows={3} className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={updateForm.notes} onChange={e => setUpdateForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setUpdateTarget(null)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}
                disabled={updating} onClick={submitUpdate}>
                {updating ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New case modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAdd(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="disc-add-title" className="rounded-2xl shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{ background: 'var(--card)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 id="disc-add-title" className="text-[16px] font-bold" style={{ color: 'var(--txt)' }}>Open Disciplinary Case</h2>
              <button onClick={() => setShowAdd(false)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={addErr} />
            <div className="space-y-3">
              <div>
                <label htmlFor="disc-emp-id" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Employee ID *</label>
                <input id="disc-emp-id" type="text" placeholder="UUID"
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.employee_id} onChange={e => setAddForm(f => ({ ...f, employee_id: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="disc-incident-type" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Incident Type *</label>
                <input id="disc-incident-type" type="text" placeholder="e.g. Tardiness, Misconduct"
                  className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.incident_type} onChange={e => setAddForm(f => ({ ...f, incident_type: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="disc-severity" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Severity *</label>
                <select id="disc-severity" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.severity} onChange={e => setAddForm(f => ({ ...f, severity: e.target.value }))}>
                  {SEVERITIES.map(s => <option key={s} value={s}>{snake(s)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="disc-incident-date" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Incident Date *</label>
                <input id="disc-incident-date" type="date" className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.incident_date} onChange={e => setAddForm(f => ({ ...f, incident_date: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="disc-description" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Description *</label>
                <textarea id="disc-description" rows={4} className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="disc-evidence" className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Evidence URLs (one per line)</label>
                <textarea id="disc-evidence" rows={2} className="w-full px-3 py-2 rounded-lg text-[13px] focus:outline-none" style={{ border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={addForm.evidence_urls} onChange={e => setAddForm(f => ({ ...f, evidence_urls: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}
                disabled={adding || !addForm.employee_id || !addForm.incident_type || !addForm.incident_date || !addForm.description}
                onClick={submitAdd}>
                {adding ? 'Opening…' : 'Open Case'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
