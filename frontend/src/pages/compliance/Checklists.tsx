import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Page, SectionCard, DataTable, ErrBanner, StatusBadge, ColDef, NAVY, GREEN,
} from '../../components/UI'

interface Checklist {
  id: string
  checklist_ref: string
  template_name: string
  period: string
  due_date: string
  status: string
  total_items: number
  completed_items: number
  created_at: string
}

interface ChecklistItem {
  id: string
  item_text: string
  is_required: boolean
  response: string | null
  responded_by: string | null
  responded_at: string | null
}

interface ChecklistDetail {
  checklist: Checklist
  items: ChecklistItem[]
}

export default function Checklists() {
  const [period, setPeriod] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<Checklist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<ChecklistDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [responses, setResponses] = useState<Record<string, { response: string; evidence_url: string }>>({})
  const [submitting, setSubmitting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams()
      if (period) p.set('period', period)
      if (status) p.set('status', status)
      const res = await apiFetch(`/api/compliance/checklists?${p}`)
      setRows(res.data ?? res)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [period, status])

  useEffect(() => { load() }, [load])

  async function expandRow(id: string) {
    if (expanded === id) { setExpanded(null); setDetail(null); return }
    setExpanded(id); setDetailLoading(true); setDetail(null)
    try {
      const res = await apiFetch(`/api/compliance/checklists/${id}`)
      setDetail(res.data ?? res)
    } catch (e: any) { setError(e.message) }
    finally { setDetailLoading(false) }
  }

  async function respondItem(checklistId: string, itemId: string) {
    const r = responses[itemId]
    if (!r?.response) return
    setSubmitting(itemId); setError('')
    try {
      await apiPost(`/api/compliance/checklists/${checklistId}/respond`, {
        item_id: itemId,
        response: r.response,
        evidence_url: r.evidence_url || null,
      })
      // Refresh detail
      const res = await apiFetch(`/api/compliance/checklists/${checklistId}`)
      setDetail(res.data ?? res)
      setResponses(prev => { const n = { ...prev }; delete n[itemId]; return n })
      load()
    } catch (e: any) { setError(e.message) }
    finally { setSubmitting(null) }
  }

  const cols: ColDef<Checklist>[] = [
    { key: 'checklist_ref', label: 'Ref', render: r => (
      <button onClick={() => expandRow(r.id)}
        className="font-mono text-[12px] font-semibold text-left hover:underline"
        style={{ color: NAVY }}>
        {r.checklist_ref}
        <span className="material-symbols-rounded text-[14px] ml-1 align-middle"
          style={{ color: expanded === r.id ? NAVY : 'var(--txt2)' }}>
          {expanded === r.id ? 'expand_less' : 'expand_more'}
        </span>
      </button>
    )},
    { key: 'template_name', label: 'Template', render: r => (
      <span className="text-[13px]" style={{ color: 'var(--txt)' }}>{r.template_name}</span>
    )},
    { key: 'period', label: 'Period', render: r => (
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{r.period || '—'}</span>
    )},
    { key: 'due_date', label: 'Due', render: r => (
      <span className="text-[12px] whitespace-nowrap" style={{ color: 'var(--txt2)' }}>{fmtDate(r.due_date)}</span>
    )},
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: 'progress', label: 'Progress', render: r => {
      const pct = r.total_items > 0 ? Math.round((r.completed_items / r.total_items) * 100) : 0
      return (
        <div className="flex items-center gap-2 min-w-[120px]">
          <div className="flex-1 h-1.5 rounded-full" style={{ background: 'var(--chip-bg)' }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: pct === 100 ? GREEN : NAVY }} />
          </div>
          <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: 'var(--txt2)' }}>
            {r.completed_items}/{r.total_items}
          </span>
        </div>
      )
    }},
  ]

  return (
    <Page dept="Compliance" title="Compliance Checklists"
      subtitle="Periodic compliance checklists and responses">

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="text" placeholder="Filter by period…" value={period}
          onChange={e => setPeriod(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', minWidth: 160 }} />
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="px-3 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}>
          <option value="">All Statuses</option>
          {['pending','in_progress','complete','overdue'].map(s => (
            <option key={s} value={s}>{s.replace('_',' ')}</option>
          ))}
        </select>
      </div>

      <ErrBanner msg={error} />

      <SectionCard title="Checklists" badge={rows.length}>
        <DataTable cols={cols} rows={rows} loading={loading} emptyIcon="checklist" emptyMsg="No checklists found" />

        {expanded && (
          <div className="border-t px-5 py-5" style={{ borderColor: 'var(--bdr)', background: 'var(--bg)' }}>
            {detailLoading ? (
              <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--txt2)' }}>
                <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--bdr)', borderTopColor: 'var(--txt)' }} />
                Loading items…
              </div>
            ) : detail ? (
              <div>
                <p className="text-[13px] font-semibold mb-3" style={{ color: NAVY }}>
                  Checklist Items — {detail.checklist.template_name}
                </p>
                <div className="space-y-3">
                  {detail.items.map(item => (
                    <div key={item.id} className="card p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <p className="text-[13px]" style={{ color: 'var(--txt)' }}>
                            {item.is_required && (
                              <span className="text-[11px] font-bold uppercase mr-1.5"
                                style={{ color: '#C00000' }}>Required</span>
                            )}
                            {item.item_text}
                          </p>
                          {item.response ? (
                            <div className="mt-2 text-[12px]" style={{ color: 'var(--txt2)' }}>
                              <span className="font-semibold" style={{ color: GREEN }}>Responded: </span>
                              {item.response}
                              <span className="ml-2" style={{ color: 'var(--txt2)' }}>by {item.responded_by} · {fmtDate(item.responded_at)}</span>
                            </div>
                          ) : (
                            <div className="mt-2 flex flex-col gap-1.5">
                              <textarea
                                value={responses[item.id]?.response || ''}
                                onChange={e => setResponses(prev => ({
                                  ...prev,
                                  [item.id]: { ...prev[item.id], response: e.target.value, evidence_url: prev[item.id]?.evidence_url || '' },
                                }))}
                                placeholder="Enter response…"
                                rows={2}
                                className="w-full px-3 py-2 rounded border text-[12px] outline-none resize-none"
                                style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', maxWidth: 480 }} />
                              <div className="flex items-center gap-2">
                                <input
                                  value={responses[item.id]?.evidence_url || ''}
                                  onChange={e => setResponses(prev => ({
                                    ...prev,
                                    [item.id]: { ...prev[item.id], evidence_url: e.target.value, response: prev[item.id]?.response || '' },
                                  }))}
                                  placeholder="Evidence URL (optional)"
                                  className="px-3 py-1.5 rounded border text-[12px] outline-none"
                                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', width: 260 }} />
                                <button
                                  onClick={() => respondItem(expanded, item.id)}
                                  disabled={submitting === item.id || !responses[item.id]?.response}
                                  className="px-3 py-1.5 rounded text-[12px] font-semibold disabled:opacity-50"
                                  style={{ background: NAVY, color: '#fff' }}>
                                  {submitting === item.id ? 'Saving…' : 'Submit'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
