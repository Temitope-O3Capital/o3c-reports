import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { snake } from '../../lib/labels'
import {
  Page, SectionCard, DataTable, ErrBanner, StatusBadge, ColDef, NAVY, AMBER, RED,
} from '../../components/UI'

interface SarRow {
  id: string
  sar_ref: string
  subject_name: string
  account_number: string
  amount_kobo: number
  transaction_date: string
  status: string
  nfiu_ref: string
  created_at: string
}

const STATUS_FLOW: Record<string, string> = {
  draft: 'under_review',
  under_review: 'md_review',
  md_review: 'submitted_to_nfiu',
  submitted_to_nfiu: 'closed',
}

const ID_TYPES = ['NIN', 'BVN', 'Passport']

function fmtKobo(k: number) {
  return (k / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })
}

export default function Sars() {
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<SarRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [escalateId, setEscalateId] = useState<string | null>(null)
  const [escalateNotes, setEscalateNotes] = useState('')
  const [newForm, setNewForm] = useState({
    subject_name: '', subject_id_type: 'NIN', subject_id: '',
    account_number: '', amount: '', transaction_date: '', summary: '',
  })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams()
      if (status) p.set('status', status)
      const res = await apiFetch(`/api/compliance/sars?${p}`)
      setRows(res.data ?? res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [status])

  useEffect(() => { load() }, [load])

  async function createSar() {
    if (!newForm.amount || !newForm.transaction_date) return
    setSaving(true); setError('')
    try {
      await apiPost('/api/compliance/sars', {
        subject_name_encrypted: newForm.subject_name,
        subject_id_type: newForm.subject_id_type,
        subject_id_encrypted: newForm.subject_id,
        account_number: newForm.account_number,
        amount_kobo: Math.round(parseFloat(newForm.amount) * 100),
        transaction_date: newForm.transaction_date,
        summary_encrypted: newForm.summary,
      })
      setShowNew(false)
      setNewForm({ subject_name: '', subject_id_type: 'NIN', subject_id: '', account_number: '', amount: '', transaction_date: '', summary: '' })
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function escalate(id: string, toStatus: string) {
    setSaving(true); setError('')
    try {
      await apiPut(`/api/compliance/sars/${id}/escalate`, { to_status: toStatus, notes: escalateNotes })
      setEscalateId(null); setEscalateNotes('')
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const cols: ColDef<SarRow>[] = [
    { key: 'sar_ref', label: 'SAR Ref', render: r => (
      <span className="font-mono text-[12px] font-semibold" style={{ color: NAVY }}>{r.sar_ref}</span>
    )},
    { key: 'subject_name', label: 'Subject', render: r => (
      <span className="text-[12px] text-slate-500 italic">{r.subject_name}</span>
    )},
    { key: 'account_number', label: 'Account', render: r => (
      <span className="font-mono text-[12px]">{r.account_number}</span>
    )},
    { key: 'amount_kobo', label: 'Amount', right: true, render: r => (
      <span className="font-mono font-semibold text-[12px]">{fmtKobo(r.amount_kobo)}</span>
    )},
    { key: 'transaction_date', label: 'Txn Date', render: r => (
      <span className="text-[12px] text-slate-500 whitespace-nowrap">{fmtDate(r.transaction_date)}</span>
    )},
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: 'nfiu_ref', label: 'NFIU Ref', render: r => (
      <span className="font-mono text-[11px] text-slate-400">{r.nfiu_ref || '—'}</span>
    )},
    { key: 'escalate', label: 'Escalate', sortable: false, render: r => {
      const next = STATUS_FLOW[r.status]
      if (!next) return <span className="text-[11px] text-slate-300">—</span>
      return escalateId === r.id ? (
        <span className="flex items-center gap-1">
          <input value={escalateNotes} onChange={e => setEscalateNotes(e.target.value)}
            placeholder="Notes…"
            className="px-2 py-1 rounded border text-[11px] outline-none"
            style={{ borderColor: 'rgba(15,23,42,0.2)', width: 110 }} />
          <button onClick={() => escalate(r.id, next)} disabled={saving}
            className="text-[11px] px-2 py-1 rounded font-semibold"
            style={{ background: AMBER, color: '#fff' }}>OK</button>
          <button onClick={() => setEscalateId(null)}
            className="text-[11px] px-1 py-1 rounded" style={{ color: '#64748B' }}>✕</button>
        </span>
      ) : (
        <button onClick={() => { setEscalateId(r.id); setEscalateNotes('') }}
          className="text-[11px] font-medium px-2 py-1 rounded"
          style={{ background: 'rgba(217,119,6,0.1)', color: AMBER }}>
          → {snake(next)}
        </button>
      )
    }},
  ]

  return (
    <Page dept="Compliance" title="Suspicious Activity Reports"
      subtitle="SARs filed and escalated to NFIU"
      actions={
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: RED, color: '#fff' }}>
          <span className="material-symbols-rounded text-[15px]">add</span>
          New SAR
        </button>
      }>

      <div className="flex gap-2 mb-4">
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none bg-white"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
          <option value="">All Statuses</option>
          {['draft','under_review','md_review','submitted_to_nfiu','closed'].map(s => (
            <option key={s} value={s}>{snake(s)}</option>
          ))}
        </select>
      </div>

      <ErrBanner msg={error} />

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-[16px] font-bold mb-1" style={{ color: RED }}>New SAR</h2>
            <p className="text-[12px] text-slate-500 mb-4 p-3 rounded" style={{ background: 'rgba(192,0,0,0.05)' }}>
              Subject details are stored encrypted. Enter plaintext — it will be sent as-is and stored encrypted on the server.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Subject Full Name</label>
                <input value={newForm.subject_name} onChange={e => setNewForm(f => ({ ...f, subject_name: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">ID Type</label>
                  <select value={newForm.subject_id_type} onChange={e => setNewForm(f => ({ ...f, subject_id_type: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none bg-white"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }}>
                    {ID_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">ID Number</label>
                  <input value={newForm.subject_id} onChange={e => setNewForm(f => ({ ...f, subject_id: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Account Number</label>
                  <input value={newForm.account_number} onChange={e => setNewForm(f => ({ ...f, account_number: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Amount (₦)</label>
                  <input type="number" value={newForm.amount} onChange={e => setNewForm(f => ({ ...f, amount: e.target.value }))}
                    placeholder="0.00"
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Transaction Date</label>
                <input type="date" value={newForm.transaction_date}
                  onChange={e => setNewForm(f => ({ ...f, transaction_date: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Summary</label>
                <textarea value={newForm.summary} onChange={e => setNewForm(f => ({ ...f, summary: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} rows={4} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded text-[13px] font-medium" style={{ color: '#64748B' }}>Cancel</button>
              <button onClick={createSar} disabled={saving}
                className="px-4 py-2 rounded text-[13px] font-semibold disabled:opacity-50"
                style={{ background: RED, color: '#fff' }}>
                {saving ? 'Submitting…' : 'Submit SAR'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Suspicious Activity Reports" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="security" emptyMsg="No SARs found" />
      </SectionCard>
    </Page>
  )
}
