import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { snake } from '../../lib/labels'
import {
  Page, SectionCard, DataTable, ErrBanner, StatusBadge, ColDef, NAVY, GREEN,
} from '../../components/UI'

interface CbnReport {
  id: string
  report_type: string
  period_start: string
  period_end: string
  status: string
  signed_off_by: string
  notes: string
  submitted_at: string
  created_at: string
}

const REPORT_TYPES = ['STR', 'CTR', 'Large Cash', 'E-money']
const CAN_SIGN = ['draft', 'pending']
const CAN_SUBMIT = ['signed_off']

export default function CbnReports() {
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<CbnReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState({ report_type: 'STR', period_start: '', period_end: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [signOffId, setSignOffId] = useState<string | null>(null)
  const [signNotes, setSignNotes] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams({ year })
      if (status) p.set('status', status)
      const res = await apiFetch(`/api/compliance/cbn-reports?${p}`)
      setRows(res.data ?? res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [year, status])

  useEffect(() => { load() }, [load])

  async function createReport() {
    setSaving(true); setError('')
    try {
      await apiPost('/api/compliance/cbn-reports', newForm)
      setShowNew(false)
      setNewForm({ report_type: 'STR', period_start: '', period_end: '', notes: '' })
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function signOff(id: string) {
    setSaving(true); setError('')
    try {
      await apiPut(`/api/compliance/cbn-reports/${id}/sign-off`, { notes: signNotes })
      setSignOffId(null); setSignNotes('')
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function submit(id: string) {
    if (!confirm('Submit this report to CBN? This cannot be undone.')) return
    setSaving(true); setError('')
    try {
      await apiPut(`/api/compliance/cbn-reports/${id}/submit`, {})
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const cols: ColDef<CbnReport>[] = [
    { key: 'report_type', label: 'Type', render: r => (
      <span className="font-semibold text-[12px]" style={{ color: NAVY }}>{r.report_type}</span>
    )},
    { key: 'period_start', label: 'Period', render: r => (
      <span className="text-[12px] whitespace-nowrap">{fmtDate(r.period_start)} – {fmtDate(r.period_end)}</span>
    )},
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: 'notes', label: 'Notes', render: r => (
      <span className="text-[12px] max-w-[200px] block truncate" style={{ color: 'var(--txt2)' }}>{r.notes || '—'}</span>
    )},
    { key: 'submitted_at', label: 'Submitted', render: r => (
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.submitted_at ? fmtDate(r.submitted_at) : '—'}</span>
    )},
    { key: 'actions', label: 'Actions', sortable: false, render: r => (
      <div className="flex items-center gap-2">
        {CAN_SIGN.includes(r.status) && signOffId !== r.id && (
          <button onClick={() => setSignOffId(r.id)}
            className="text-[11px] font-medium px-2 py-1 rounded"
            style={{ background: 'rgba(5,150,105,0.08)', color: GREEN }}>
            Sign Off
          </button>
        )}
        {signOffId === r.id && (
          <span className="flex items-center gap-1">
            <input value={signNotes} onChange={e => setSignNotes(e.target.value)}
              placeholder="Notes…"
              className="px-2 py-1 rounded border text-[12px] outline-none"
              style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', width: 120 }} />
            <button onClick={() => signOff(r.id)} disabled={saving}
              className="text-[11px] px-2 py-1 rounded font-medium"
              style={{ background: GREEN, color: '#fff' }}>OK</button>
            <button onClick={() => setSignOffId(null)}
              className="text-[11px] px-2 py-1 rounded"
              style={{ color: 'var(--txt2)' }}>Cancel</button>
          </span>
        )}
        {CAN_SUBMIT.includes(r.status) && (
          <button onClick={() => submit(r.id)} disabled={saving}
            className="text-[11px] font-medium px-2 py-1 rounded"
            style={{ background: 'var(--chip-bg)', color: NAVY }}>
            Submit
          </button>
        )}
      </div>
    )},
  ]

  return (
    <Page dept="Compliance" title="CBN Reports"
      subtitle="Statutory CBN reporting — STR, CTR, Large Cash, E-money"
      actions={
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: NAVY, color: '#fff' }}>
          <span className="material-symbols-rounded text-[15px]">add</span>
          New Report
        </button>
      }>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="number" value={year} onChange={e => setYear(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none w-24"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
          <option value="">All Statuses</option>
          {['draft','pending','signed_off','submitted','rejected'].map(s => (
            <option key={s} value={s}>{snake(s)}</option>
          ))}
        </select>
      </div>

      <ErrBanner msg={error} />

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-[16px] font-bold mb-4" style={{ color: NAVY }}>New CBN Report</h2>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Report Type</label>
                <select value={newForm.report_type} onChange={e => setNewForm(f => ({ ...f, report_type: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
                  {REPORT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Period Start</label>
                  <input type="date" value={newForm.period_start}
                    onChange={e => setNewForm(f => ({ ...f, period_start: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Period End</label>
                  <input type="date" value={newForm.period_end}
                    onChange={e => setNewForm(f => ({ ...f, period_end: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase block mb-1" style={{ color: 'var(--txt2)' }}>Notes</label>
                <textarea value={newForm.notes} onChange={e => setNewForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }} rows={3} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded text-[13px] font-medium"
                style={{ color: 'var(--txt2)' }}>Cancel</button>
              <button onClick={createReport} disabled={saving || !newForm.period_start || !newForm.period_end}
                className="px-4 py-2 rounded text-[13px] font-semibold disabled:opacity-50"
                style={{ background: NAVY, color: '#fff' }}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="CBN Reports" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="description" emptyMsg="No CBN reports found" />
      </SectionCard>
    </Page>
  )
}
