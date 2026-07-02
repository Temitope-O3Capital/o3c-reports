import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ErrBanner, StatusBadge, ColDef, NAVY, RED, AMBER, GREEN,
} from '../../components/UI'

interface Finding {
  id: string
  finding_ref: string
  checklist_id: string
  finding_type: string
  severity: string
  description: string
  status: string
  assigned_to: string
  due_date: string
  created_at: string
}

const SEVERITY_COLORS: Record<string, { bg: string; color: string }> = {
  critical: { bg: 'rgba(192,0,0,0.09)', color: RED },
  high:     { bg: 'rgba(217,119,6,0.1)', color: AMBER },
  medium:   { bg: 'rgba(37,99,235,0.08)', color: '#2563EB' },
  low:      { bg: 'rgba(5,150,105,0.08)', color: GREEN },
}

const PAGE_SIZE = 50

export default function Findings() {
  const [severity, setSeverity] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<Finding[]>([])
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [responseText, setResponseText] = useState('')
  const [respondFinding, setRespondFinding] = useState<Finding | null>(null)
  const [closeId, setCloseId] = useState<string | null>(null)
  const [closeNotes, setCloseNotes] = useState('')
  const [newForm, setNewForm] = useState({
    checklist_id: '', finding_type: '', severity: 'medium',
    description: '', assigned_to: '', due_date: '',
  })

  const load = useCallback(async (off = 0) => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(off) })
      if (severity) p.set('severity', severity)
      if (status) p.set('status', status)
      const res = await apiFetch(`/api/compliance/findings?${p}`)
      setRows(res.data ?? res)
      setOffset(off)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [severity, status])

  useEffect(() => { load(0) }, [severity, status]) // eslint-disable-line react-hooks/exhaustive-deps

  async function createFinding() {
    setSaving(true); setError('')
    try {
      await apiPost('/api/compliance/findings', newForm)
      setShowNew(false)
      setNewForm({ checklist_id: '', finding_type: '', severity: 'medium', description: '', assigned_to: '', due_date: '' })
      load(0)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function addResponse(id: string) {
    setSaving(true); setError('')
    try {
      await apiPost(`/api/compliance/findings/${id}/response`, { response_text: responseText })
      setResponseText('')
      load(offset)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function closeFinding(id: string) {
    setSaving(true); setError('')
    try {
      await apiPut(`/api/compliance/findings/${id}/close`, { closing_notes: closeNotes })
      setCloseId(null); setCloseNotes('')
      load(offset)
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const cols: ColDef<Finding>[] = [
    { key: 'finding_ref', label: 'Ref', render: r => (
      <span className="font-mono text-[12px] font-semibold" style={{ color: NAVY }}>{r.finding_ref}</span>
    )},
    { key: 'finding_type', label: 'Type', render: r => (
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.finding_type || '—'}</span>
    )},
    { key: 'severity', label: 'Severity', render: r => {
      const s = SEVERITY_COLORS[r.severity?.toLowerCase()] ?? { bg: 'rgba(14,40,65,0.06)', color: 'var(--txt2)' }
      return (
        <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded"
          style={s}>
          {r.severity}
        </span>
      )
    }},
    { key: 'description', label: 'Description', render: r => (
      <span className="text-[12px] max-w-[240px] block truncate" style={{ color: 'var(--txt2)' }} title={r.description}>{r.description}</span>
    )},
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: 'assigned_to', label: 'Assigned To', render: r => (
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.assigned_to || '—'}</span>
    )},
    { key: 'due_date', label: 'Due', render: r => (
      <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>{fmtDate(r.due_date)}</span>
    )},
    { key: 'actions', label: 'Actions', sortable: false, render: r => (
      <div className="flex items-center gap-1.5 flex-wrap">
        {r.status !== 'closed' && (
          <button onClick={() => { setRespondFinding(r); setResponseText('') }}
            className="text-[11px] px-2 py-1 rounded font-medium"
            style={{ background: 'var(--chip-bg)', color: NAVY }}>
            Respond
          </button>
        )}
        {r.status !== 'closed' && closeId !== r.id && (
          <button onClick={() => { setCloseId(r.id); setCloseNotes('') }}
            className="text-[11px] px-2 py-1 rounded font-medium"
            style={{ background: 'rgba(5,150,105,0.08)', color: GREEN }}>
            Close
          </button>
        )}
        {closeId === r.id && (
          <span className="flex items-center gap-1">
            <input value={closeNotes} onChange={e => setCloseNotes(e.target.value)}
              placeholder="Closing notes…"
              className="px-2 py-1 rounded border text-[11px] outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', width: 120 }} />
            <button onClick={() => closeFinding(r.id)} disabled={saving}
              className="text-[11px] px-2 py-1 rounded" style={{ background: GREEN, color: '#fff' }}>OK</button>
            <button onClick={() => setCloseId(null)} className="text-[11px] px-1" style={{ color: 'var(--txt2)' }}>✕</button>
          </span>
        )}
      </div>
    )},
  ]

  return (
    <Page dept="Compliance" title="Audit Findings"
      subtitle="Track and resolve compliance findings from checklists and reviews"
      actions={
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: NAVY, color: '#fff' }}>
          <span className="material-symbols-rounded text-[15px]">add</span>
          New Finding
        </button>
      }>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={severity} onChange={e => setSeverity(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
          <option value="">All Severities</option>
          {['critical','high','medium','low'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
          <option value="">All Statuses</option>
          {['open','in_progress','closed'].map(s => (
            <option key={s} value={s}>{s.replace('_',' ')}</option>
          ))}
        </select>
      </div>

      <ErrBanner msg={error} />

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-[16px] font-bold mb-4" style={{ color: NAVY }}>New Finding</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Severity</label>
                  <select value={newForm.severity} onChange={e => setNewForm(f => ({ ...f, severity: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
                    {['critical','high','medium','low'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Due Date</label>
                  <input type="date" value={newForm.due_date}
                    onChange={e => setNewForm(f => ({ ...f, due_date: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Finding Type</label>
                <input value={newForm.finding_type} onChange={e => setNewForm(f => ({ ...f, finding_type: e.target.value }))}
                  placeholder="e.g. Policy Gap, Control Failure"
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Description</label>
                <textarea value={newForm.description} onChange={e => setNewForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} rows={3} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Assigned To</label>
                <input value={newForm.assigned_to} onChange={e => setNewForm(f => ({ ...f, assigned_to: e.target.value }))}
                  placeholder="Staff name or email"
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded text-[13px] font-medium" style={{ color: 'var(--txt2)' }}>Cancel</button>
              <button onClick={createFinding} disabled={saving || !newForm.description}
                className="px-4 py-2 rounded text-[13px] font-semibold disabled:opacity-50"
                style={{ background: NAVY, color: '#fff' }}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Compliance Findings" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="find_in_page" emptyMsg="No findings" />
        <div className="flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid var(--bdr)' }}>
          <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>Showing {offset + 1}–{offset + rows.length}</span>
          <div className="flex gap-2">
            <button disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
              className="px-3 py-1 rounded border text-[12px] disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: NAVY }}>Previous</button>
            <button disabled={rows.length < PAGE_SIZE} onClick={() => load(offset + PAGE_SIZE)}
              className="px-3 py-1 rounded border text-[12px] disabled:opacity-40"
              style={{ borderColor: 'var(--bdr)', color: NAVY }}>Next</button>
          </div>
        </div>
      </SectionCard>

      {/* Respond slide-over */}
      {respondFinding && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setRespondFinding(null)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md shadow-2xl flex flex-col" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--bdr)' }}>
              <div>
                <p className="text-[11px] uppercase tracking-wide font-bold" style={{ color: 'var(--txt2)' }}>Compliance Finding</p>
                <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>{respondFinding.finding_ref}</h2>
              </div>
              <button onClick={() => setRespondFinding(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[22px]">close</span>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="p-3 rounded-lg text-[13px]" style={{ background: 'var(--chip-bg)', color: 'var(--txt2)' }}>
                {respondFinding.description}
              </div>
              <ErrBanner msg={error} />
              <div>
                <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--txt2)' }}>Response / Management Action</label>
                <textarea
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] resize-none focus:outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  placeholder="Describe the corrective action taken or planned…"
                  value={responseText}
                  onChange={e => setResponseText(e.target.value)}
                />
              </div>
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-2" style={{ borderColor: 'var(--bdr)' }}>
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold"
                style={{ color: 'var(--txt)', background: 'var(--chip-bg)' }}
                onClick={() => setRespondFinding(null)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={saving || !responseText.trim()}
                onClick={async () => {
                  await addResponse(respondFinding.id)
                  setRespondFinding(null)
                }}>
                {saving ? 'Saving…' : 'Submit Response'}
              </button>
            </div>
          </div>
        </>
      )}
    </Page>
  )
}
