import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ErrBanner, StatusBadge, ColDef, NAVY, RED,
} from '../../components/UI'

interface WatchEntry {
  id: string
  entity_type: string
  entity_name: string
  id_type: string
  id_value: string
  reason: string
  source: string
  is_active: boolean
  added_by: string
  created_at: string
}

export default function WatchList() {
  const [q, setQ] = useState('')
  const [isActive, setIsActive] = useState<string>('true')
  const [rows, setRows] = useState<WatchEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newForm, setNewForm] = useState({
    entity_type: 'individual', entity_name: '', id_type: 'BVN',
    id_value: '', reason: '', source: '',
  })

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams()
      if (q) p.set('q', q)
      if (isActive !== '') p.set('is_active', isActive)
      const res = await apiFetch(`/api/compliance/watch-list?${p}`)
      setRows(res.data ?? res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [q, isActive])

  useEffect(() => { load() }, [load])

  async function addEntry() {
    setSaving(true); setError('')
    try {
      await apiPost('/api/compliance/watch-list', newForm)
      setShowNew(false)
      setNewForm({ entity_type: 'individual', entity_name: '', id_type: 'BVN', id_value: '', reason: '', source: '' })
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  async function deactivate(id: string) {
    if (!confirm('Deactivate this watch list entry?')) return
    setSaving(true); setError('')
    try {
      await apiPut(`/api/compliance/watch-list/${id}/deactivate`, {})
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  const cols: ColDef<WatchEntry>[] = [
    { key: 'entity_name', label: 'Entity Name', render: r => (
      <span className="font-semibold text-slate-800">{r.entity_name}</span>
    )},
    { key: 'entity_type', label: 'Type', render: r => (
      <span className="text-[12px] text-slate-500 capitalize">{r.entity_type}</span>
    )},
    { key: 'id_type', label: 'ID', render: r => (
      <span className="text-[12px]">
        <span className="font-semibold text-slate-600">{r.id_type}</span>
        <span className="text-slate-400 ml-1">{r.id_value}</span>
      </span>
    )},
    { key: 'reason', label: 'Reason', render: r => (
      <span className="text-[12px] text-slate-600 max-w-[200px] block truncate">{r.reason}</span>
    )},
    { key: 'source', label: 'Source', render: r => (
      <span className="text-[12px] text-slate-400">{r.source || '—'}</span>
    )},
    { key: 'is_active', label: 'Status', render: r => (
      <StatusBadge status={r.is_active ? 'active' : 'inactive'} />
    )},
    { key: 'added_by', label: 'Added By', render: r => (
      <span className="text-[12px] text-slate-500">{r.added_by || '—'}</span>
    )},
    { key: 'created_at', label: 'Date Added', render: r => (
      <span className="text-[12px] text-slate-400 whitespace-nowrap">{fmtDate(r.created_at)}</span>
    )},
    { key: 'actions', label: '', sortable: false, render: r => (
      r.is_active ? (
        <button onClick={() => deactivate(r.id)} disabled={saving}
          className="text-[11px] font-medium px-2 py-1 rounded"
          style={{ background: 'rgba(192,0,0,0.07)', color: RED }}>
          Deactivate
        </button>
      ) : null
    )},
  ]

  return (
    <Page dept="Compliance" title="Watch List"
      subtitle="Entities flagged for enhanced due diligence"
      actions={
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: NAVY, color: '#fff' }}>
          <span className="material-symbols-rounded text-[15px]">add</span>
          Add to Watch List
        </button>
      }>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="search" placeholder="Search by name or ID…" value={q}
          onChange={e => setQ(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'rgba(15,23,42,0.15)', minWidth: 220 }} />
        <select value={isActive} onChange={e => setIsActive(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none bg-white"
          style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
          <option value="true">Active Only</option>
          <option value="false">Inactive Only</option>
          <option value="">All</option>
        </select>
      </div>

      <ErrBanner msg={error} />

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="card p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-[16px] font-bold mb-4" style={{ color: NAVY }}>Add to Watch List</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Entity Type</label>
                  <select value={newForm.entity_type} onChange={e => setNewForm(f => ({ ...f, entity_type: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none bg-white"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }}>
                    <option value="individual">Individual</option>
                    <option value="business">Business</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">ID Type</label>
                  <select value={newForm.id_type} onChange={e => setNewForm(f => ({ ...f, id_type: e.target.value }))}
                    className="w-full px-3 py-2 rounded border text-[13px] outline-none bg-white"
                    style={{ borderColor: 'rgba(15,23,42,0.2)' }}>
                    {['BVN','NIN','RC Number','Passport'].map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Entity Name</label>
                <input value={newForm.entity_name} onChange={e => setNewForm(f => ({ ...f, entity_name: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">ID Value</label>
                <input value={newForm.id_value} onChange={e => setNewForm(f => ({ ...f, id_value: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Reason</label>
                <textarea value={newForm.reason} onChange={e => setNewForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} rows={2} />
              </div>
              <div>
                <label className="text-[11px] font-semibold uppercase text-slate-400 block mb-1">Source</label>
                <input value={newForm.source} onChange={e => setNewForm(f => ({ ...f, source: e.target.value }))}
                  placeholder="e.g. NFIU, Internal, CBN"
                  className="w-full px-3 py-2 rounded border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowNew(false)}
                className="px-4 py-2 rounded text-[13px] font-medium" style={{ color: '#64748B' }}>Cancel</button>
              <button onClick={addEntry}
                disabled={saving || !newForm.entity_name || !newForm.id_value}
                className="px-4 py-2 rounded text-[13px] font-semibold disabled:opacity-50"
                style={{ background: NAVY, color: '#fff' }}>
                {saving ? 'Adding…' : 'Add Entry'}
              </button>
            </div>
          </div>
        </div>
      )}

      <SectionCard title="Watch List Entries" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="person_off" emptyMsg="No watch list entries" />
      </SectionCard>
    </Page>
  )
}
