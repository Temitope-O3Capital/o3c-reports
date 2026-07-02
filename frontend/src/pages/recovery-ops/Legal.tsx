import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Spinner, ErrBanner, StatusBadge, Page, SectionCard, ColDef, DataTable,
  NAVY, RED,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
// There is no dedicated global legal-proceedings list endpoint.
// We fetch cases (up to 200) and aggregate their legal_proceedings.
// Each case detail endpoint returns { case, legal_proceedings, ... }.
// For a scalable production setup, a dedicated endpoint is recommended.

interface LegalRow {
  _caseId: string
  _lid: string
  case_ref: string
  court_name: string
  case_number: string
  proceeding_type: string
  filing_date: string
  next_hearing_date: string | null
  status: string
}

interface CaseListItem {
  id: string
  case_ref: string
}

interface CaseDetail {
  case: CaseListItem
  legal_proceedings: Array<{
    id: string
    court_name: string
    case_number: string
    proceeding_type: string
    filing_date: string
    next_hearing_date: string | null
    status: string
    notes?: string
  }>
}

const PROCEEDING_TYPES = ['', 'letter_of_demand', 'court_filing', 'hearing', 'garnishee', 'judgment']
const LEGAL_STATUSES   = ['', 'pending', 'active', 'adjourned', 'concluded', 'dismissed']

export default function Legal() {
  const [rows, setRows]       = useState<LegalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const [typeF, setTypeF]     = useState('')
  const [statusF, setStatusF] = useState('')

  // Update status modal
  const [updateRow, setUpdateRow]     = useState<LegalRow | null>(null)
  const [newStatus, setNewStatus]     = useState('')
  const [nextHearing, setNextHearing] = useState('')
  const [updateNotes, setUpdateNotes] = useState('')
  const [updating, setUpdating]       = useState(false)
  const [updateErr, setUpdateErr]     = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // Fetch case list, then load each case detail to get legal proceedings.
      // NOTE: This approach works for moderate volumes. A dedicated
      // GET /api/recovery-ops/legal endpoint would be more efficient at scale.
      const casesRes = await apiFetch<{ data: CaseListItem[] } | CaseListItem[]>(
        '/api/recovery-ops/cases?limit=200'
      )
      const caseList: CaseListItem[] = Array.isArray(casesRes) ? casesRes : (casesRes.data ?? [])

      const details = await Promise.all(
        caseList.map(c => apiFetch<CaseDetail>(`/api/recovery-ops/cases/${c.id}`).catch(() => null))
      )

      const flat: LegalRow[] = []
      for (const d of details) {
        if (!d) continue
        for (const lp of d.legal_proceedings ?? []) {
          flat.push({
            _caseId: d.case.id,
            _lid: lp.id,
            case_ref: d.case.case_ref,
            court_name: lp.court_name,
            case_number: lp.case_number,
            proceeding_type: lp.proceeding_type,
            filing_date: lp.filing_date,
            next_hearing_date: lp.next_hearing_date ?? null,
            status: lp.status,
          })
        }
      }
      setRows(flat)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function submitUpdate() {
    if (!updateRow) return
    setUpdating(true); setUpdateErr('')
    try {
      await apiPut(`/api/recovery-ops/legal/${updateRow._lid}/status`, {
        status: newStatus,
        next_hearing_date: nextHearing || undefined,
        notes: updateNotes,
      })
      setUpdateRow(null); setNewStatus(''); setNextHearing(''); setUpdateNotes('')
      load()
    } catch (e: any) {
      setUpdateErr(e.message)
    } finally {
      setUpdating(false)
    }
  }

  function openUpdate(row: LegalRow) {
    setUpdateRow(row)
    setNewStatus(row.status)
    setNextHearing(row.next_hearing_date ?? '')
    setUpdateNotes('')
    setUpdateErr('')
  }

  const filtered = rows.filter(r => {
    if (typeF   && r.proceeding_type !== typeF) return false
    if (statusF && r.status          !== statusF) return false
    return true
  })

  const cols: ColDef<LegalRow>[] = [
    { key: 'case_ref',        label: 'Case Ref',        render: r => <span className="font-mono text-[12px]">{r.case_ref}</span> },
    { key: 'proceeding_type', label: 'Type',            render: r => <span className="text-[13px]">{snake(r.proceeding_type)}</span> },
    { key: 'court_name',      label: 'Court' },
    { key: 'case_number',     label: 'Case No.',        render: r => <span className="font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>#{r.case_number}</span> },
    { key: 'filing_date',     label: 'Filed',           render: r => fmtDate(r.filing_date) },
    { key: 'next_hearing_date', label: 'Next Hearing',  render: r => r.next_hearing_date ? fmtDate(r.next_hearing_date) : <span style={{ color: 'var(--txt2)' }}>—</span> },
    { key: 'status',          label: 'Status',          render: r => <StatusBadge status={r.status} /> },
    {
      key: '_action', label: '', sortable: false,
      render: r => (
        <button
          onClick={() => openUpdate(r)}
          className="px-2 py-1 rounded text-[11px] font-semibold"
          style={{ background: 'var(--chip-bg)', color: NAVY }}>
          Update Status
        </button>
      ),
    },
  ]

  return (
    <Page
      dept="Recovery Ops"
      title="Legal Proceedings"
      subtitle="Track court filings, hearings, garnishees and judgments across all recovery cases"
    >
      <ErrBanner msg={error} />

      {/* Filters */}
      <div className="rounded-2xl border border-black/[0.06] shadow-sm p-4 mb-4" style={{ background: 'var(--card)' }}>
        <div className="flex flex-wrap gap-3">
          <select className="px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
            style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            value={typeF} onChange={e => setTypeF(e.target.value)}>
            <option value="">All Proceeding Types</option>
            {PROCEEDING_TYPES.filter(Boolean).map(t => <option key={t} value={t}>{snake(t)}</option>)}
          </select>
          <select className="px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
            style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            value={statusF} onChange={e => setStatusF(e.target.value)}>
            <option value="">All Statuses</option>
            {LEGAL_STATUSES.filter(Boolean).map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
        </div>
      </div>

      <SectionCard title="Legal Proceedings" badge={filtered.length}>
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : (
          <DataTable
            cols={cols}
            rows={filtered}
            emptyIcon="gavel"
            emptyMsg="No legal proceedings found"
          />
        )}
      </SectionCard>

      {/* Update status modal */}
      {updateRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>Update Legal Status</h2>
              <button onClick={() => setUpdateRow(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <p className="text-[12px] mb-4" style={{ color: 'var(--txt2)' }}>{updateRow.case_ref} · #{updateRow.case_number} · {updateRow.court_name}</p>
            <ErrBanner msg={updateErr} />
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>New Status</label>
                <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                  style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={newStatus} onChange={e => setNewStatus(e.target.value)}>
                  {LEGAL_STATUSES.filter(Boolean).map(s => <option key={s} value={s}>{snake(s)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Next Hearing Date</label>
                <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                  style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={nextHearing} onChange={e => setNextHearing(e.target.value)} />
              </div>
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Notes</label>
                <textarea rows={2} className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none resize-none"
                  style={{ borderColor: 'var(--bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={updateNotes} onChange={e => setUpdateNotes(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-black/[0.05]" style={{ color: 'var(--txt)' }} onClick={() => setUpdateRow(null)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={updating || !newStatus}
                onClick={submitUpdate}>
                {updating ? 'Saving…' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
