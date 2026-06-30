import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmt, fmtDate, fmtExact } from '../../lib/fmt'
import { Spinner, ErrBanner, Page, ConfirmModal, NAVY, RED, AMBER, GREEN } from '../../components/UI'
import { useAuth } from '../../hooks/useAuth'
import { toast } from 'sonner'
import { StageBadge } from './components'

// ── Types ─────────────────────────────────────────────────────────
interface Application {
  id: string; reference: string; applicant_name: string; product_type: string
  amount_requested_kobo: number; tenor_months: number; stage: string
  phone?: string; email?: string; cif?: string; purpose?: string
  employer?: string; monthly_income_kobo?: number; created_at: string
  updated_at?: string; assigned_to_name?: string; assigned_to_user_id?: string
  request_info_count?: number; decline_reason?: string
}

interface AppEvent {
  id: string; stage_from?: string; stage_to: string; actor_name: string
  notes?: string; created_at: string
}

interface Condition {
  id: string; description: string; is_met: boolean; met_by_name?: string; met_at?: string
}

interface Note {
  id: string; body: string; author_name: string; is_internal: boolean; created_at: string
}

interface DetailResponse {
  application: Application
  events: AppEvent[]
  conditions: Condition[]
  notes: Note[]
}

function timeAgo(s: string) {
  const diff = Date.now() - new Date(s).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return fmtDate(s)
}

const TABS = ['Summary', 'Conditions', 'Notes', 'Timeline'] as const
type Tab = typeof TABS[number]

// ── Advance stage transitions ─────────────────────────────────────
const ADVANCE_MAP: Record<string, { label: string; to_stage: string }> = {
  submitted:           { label: 'Mark Documents Received', to_stage: 'document_collection' },
  document_collection: { label: 'Send to Risk Review',      to_stage: 'risk_review' },
  risk_review:         { label: 'Risk Approved',             to_stage: 'risk_head_review' },
  risk_head_review:    { label: 'Risk Head Approved',        to_stage: 'pending_conditions' },
  pending_conditions:  { label: 'All Conditions Met — Send to Finance', to_stage: 'finance_approval' },
  finance_approval:    { label: 'Finance Approved',          to_stage: 'booking' },
  booking:             { label: 'Application Booked',        to_stage: 'active' },
}

export default function ApplicationDetail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const { user } = useAuth()

  const [detail, setDetail]   = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('Summary')

  // action state
  const [working, setWorking] = useState(false)
  const [actionErr, setActionErr] = useState('')

  // Decline modal
  const [showDecline, setShowDecline] = useState(false)
  const [declineReason, setDeclineReason] = useState('')

  // Request info modal
  const [showReqInfo, setShowReqInfo] = useState(false)
  const [reqInfoNotes, setReqInfoNotes] = useState('')

  // Add note form
  const [noteBody, setNoteBody] = useState('')
  const [noteInternal, setNoteInternal] = useState(false)
  const [addingNote, setAddingNote] = useState(false)

  // confirm modal
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setError('')
    try {
      const res = await apiFetch<{ data: DetailResponse }>(`/api/los/${id}`)
      setDetail(res.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  async function advance(to_stage: string, notes?: string) {
    const doAdvance = async () => {
      setWorking(true); setActionErr('')
      try {
        await apiPut(`/api/los/${id}/advance`, { to_stage, notes })
        toast.success(`Application moved to ${to_stage}`)
        load()
      } catch (e: any) { setActionErr(e.message) }
      finally { setWorking(false) }
    }
    const terminalStages = ['booking', 'active']
    if (terminalStages.includes(to_stage)) {
      setConfirm({
        title: 'Advance Application',
        message: `Move to "${to_stage}"? This step cannot be undone.`,
        onConfirm: doAdvance,
      })
    } else {
      doAdvance()
    }
  }

  async function decline() {
    if (!declineReason.trim()) return
    setWorking(true); setActionErr('')
    try {
      await apiPut(`/api/los/${id}/decline`, { reason: declineReason })
      toast.success('Application declined')
      setShowDecline(false); load()
    } catch (e: any) { setActionErr(e.message) }
    finally { setWorking(false) }
  }

  async function requestInfo() {
    setWorking(true); setActionErr('')
    try {
      await apiPut(`/api/los/${id}/request-info`, { notes: reqInfoNotes })
      toast.success('Information requested from applicant')
      setShowReqInfo(false); load()
    } catch (e: any) { setActionErr(e.message) }
    finally { setWorking(false) }
  }

  async function addNote() {
    if (!noteBody.trim()) return
    setAddingNote(true)
    try {
      await apiPost(`/api/los/${id}/notes`, { body: noteBody, is_internal: noteInternal })
      toast.success('Note added')
      setNoteBody(''); load()
    } catch (e: any) { setActionErr(e.message) }
    finally { setAddingNote(false) }
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]"><Spinner size={36} /></div>
  )
  if (error || !detail) return (
    <Page title="Application Detail"><ErrBanner msg={error || 'Failed to load'} /></Page>
  )

  const app = detail.application
  const advAction = ADVANCE_MAP[app.stage]
  const canDecline = ['submitted','document_collection','risk_review','risk_head_review','finance_approval'].includes(app.stage)
  const canReqInfo = canDecline && (app.request_info_count ?? 0) < 2

  return (
    <Page
      dept="LOS"
      title={app.reference}
      subtitle={app.applicant_name}
      actions={
        <button
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]"
          onClick={() => window.history.length > 1 ? nav(-1) : nav('/sales/applications')}
        >
          ← Back
        </button>
      }
    >
      {/* Header strip */}
      <div className="card p-5 mb-5 flex flex-wrap gap-4 items-center justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <StageBadge stage={app.stage} />
          <span className="text-[13.5px] font-semibold text-slate-700">{app.applicant_name}</span>
          <span className="text-slate-300">·</span>
          <span className="text-[13px] text-slate-500 capitalize">{snake(app.product_type)}</span>
          <span className="text-slate-300">·</span>
          <span className="text-[13px] font-mono text-slate-700">{fmt(app.amount_requested_kobo / 100)}</span>
          <span className="text-slate-300">·</span>
          <span className="text-[13px] text-slate-500">{app.tenor_months}m</span>
        </div>
        <span className="text-[12px] text-slate-400">Created {fmtDate(app.created_at)}</span>
      </div>

      <div className="flex gap-5 flex-col xl:flex-row">
        {/* Left — main content (70%) */}
        <div className="flex-1 min-w-0">
          {/* Tabs */}
          <div className="flex gap-0 border-b border-slate-200 mb-5">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className="px-4 py-2.5 text-[13px] font-semibold border-b-2 -mb-px transition-colors"
                style={{
                  borderColor: activeTab === t ? NAVY : 'transparent',
                  color: activeTab === t ? NAVY : '#94A3B8',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Summary */}
          {activeTab === 'Summary' && (
            <div className="card p-5">
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-400 mb-4">Application Details</h3>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {[
                  ['Reference', app.reference],
                  ['Applicant', app.applicant_name],
                  ['Phone', app.phone ?? '—'],
                  ['Email', app.email ?? '—'],
                  ['CIF', app.cif ?? '—'],
                  ['Product', snake(app.product_type ?? '—')],
                  ['Amount Requested', fmtExact(app.amount_requested_kobo / 100)],
                  ['Tenor', `${app.tenor_months} months`],
                  ['Purpose', app.purpose ?? '—'],
                  ['Employer', app.employer ?? '—'],
                  ['Monthly Income', app.monthly_income_kobo ? fmtExact(app.monthly_income_kobo / 100) : '—'],
                  ['Assigned To', app.assigned_to_name ?? '—'],
                  ['Created', fmtDate(app.created_at)],
                  ...(app.decline_reason ? [['Decline Reason', app.decline_reason]] : []),
                ].map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">{k}</p>
                    <p className="text-[13.5px] text-slate-800 capitalize">{v}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Conditions */}
          {activeTab === 'Conditions' && (
            <div className="card overflow-hidden">
              {detail.conditions.length === 0 ? (
                <div className="p-8 text-center">
                  <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">checklist</span>
                  <p className="text-[13px] text-slate-400">No conditions recorded</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {detail.conditions.map(c => (
                    <div key={c.id} className="flex items-start gap-3 px-5 py-4">
                      <span
                        className="material-symbols-rounded text-[20px] mt-0.5 flex-shrink-0"
                        style={{ color: c.is_met ? GREEN : '#D1D5DB' }}
                      >
                        {c.is_met ? 'check_circle' : 'radio_button_unchecked'}
                      </span>
                      <div className="flex-1">
                        <p className="text-[13.5px] text-slate-800">{c.description}</p>
                        {c.is_met && (
                          <p className="text-[11px] text-slate-400 mt-0.5">Met by {c.met_by_name} · {fmtDate(c.met_at)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          {activeTab === 'Notes' && (
            <div className="space-y-3">
              <div className="card overflow-hidden">
                {detail.notes.length === 0 ? (
                  <div className="p-6 text-center text-[13px] text-slate-400">No notes yet</div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {detail.notes.map(n => (
                      <div key={n.id} className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[12px] font-semibold text-slate-700">{n.author_name}</span>
                          {n.is_internal && (
                            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.1)', color: '#7C3AED' }}>Internal</span>
                          )}
                          <span className="text-[11px] text-slate-400 ml-auto">{timeAgo(n.created_at)}</span>
                        </div>
                        <p className="text-[13px] text-slate-600">{n.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Add note form */}
              <div className="card p-4">
                <textarea
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20 resize-none"
                  rows={3}
                  placeholder="Add a note…"
                  value={noteBody}
                  onChange={e => setNoteBody(e.target.value)}
                />
                <div className="flex items-center gap-3 mt-2">
                  <label className="flex items-center gap-2 text-[12px] text-slate-600 cursor-pointer">
                    <input type="checkbox" checked={noteInternal} onChange={e => setNoteInternal(e.target.checked)} />
                    Internal note
                  </label>
                  <button
                    className="ml-auto px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                    style={{ background: NAVY }}
                    disabled={!noteBody.trim() || addingNote}
                    onClick={addNote}
                  >
                    {addingNote ? 'Adding…' : 'Add Note'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Timeline */}
          {activeTab === 'Timeline' && (
            <div className="card p-5">
              {detail.events.length === 0 ? (
                <p className="text-center text-[13px] text-slate-400 py-6">No events recorded</p>
              ) : (
                <div className="relative space-y-4">
                  <div className="absolute left-4 top-2 bottom-2 w-px bg-slate-200" />
                  {[...detail.events].reverse().map(ev => (
                    <div key={ev.id} className="relative pl-10 flex gap-3">
                      <div className="absolute left-0 top-0.5 w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: 'rgba(14,40,65,0.07)' }}>
                        <span className="material-symbols-rounded text-[15px]" style={{ color: NAVY }}>swap_horiz</span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12px] font-semibold text-slate-700">{ev.actor_name}</span>
                          {ev.stage_from && (
                            <>
                              <span className="text-[11px] text-slate-400">moved from</span>
                              <span className="text-[11px] text-slate-600 capitalize">{snake(ev.stage_from)}</span>
                              <span className="text-[11px] text-slate-400">to</span>
                            </>
                          )}
                          <span className="text-[11px] font-semibold text-slate-700 capitalize">{snake(ev.stage_to)}</span>
                          <span className="text-[11px] text-slate-400 ml-auto">{timeAgo(ev.created_at)}</span>
                        </div>
                        {ev.notes && <p className="text-[12px] text-slate-500 mt-1">{ev.notes}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right sidebar (30%) */}
        <div className="w-full xl:w-72 space-y-4 flex-shrink-0">
          {/* Actions panel */}
          <div className="card p-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-400 mb-3">Actions</h3>
            <ErrBanner msg={actionErr} />
            {app.stage === 'declined' && (
              <p className="text-[13px] text-slate-400 text-center py-2">Application declined</p>
            )}
            {app.stage === 'active' && (
              <p className="text-[13px] text-slate-500 text-center py-2">Application is active</p>
            )}
            {advAction && app.stage !== 'active' && app.stage !== 'declined' && (
              <button
                className="w-full mb-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: GREEN }}
                disabled={working}
                onClick={() => advance(advAction.to_stage)}
              >
                <span className="material-symbols-rounded text-[15px] align-middle mr-1">arrow_forward</span>
                {advAction.label}
              </button>
            )}
            {canReqInfo && (
              <button
                className="w-full mb-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-60"
                disabled={working}
                onClick={() => setShowReqInfo(true)}
              >
                <span className="material-symbols-rounded text-[15px] align-middle mr-1">info</span>
                Request More Info ({2 - (app.request_info_count ?? 0)} left)
              </button>
            )}
            {canDecline && (
              <button
                className="w-full px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: RED }}
                disabled={working}
                onClick={() => setShowDecline(true)}
              >
                <span className="material-symbols-rounded text-[15px] align-middle mr-1">cancel</span>
                Decline
              </button>
            )}
          </div>

          {/* Assignment info */}
          <div className="card p-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-400 mb-3">Assignment</h3>
            <p className="text-[13px] text-slate-700">{app.assigned_to_name ?? 'Unassigned'}</p>
          </div>

          {/* Key dates */}
          <div className="card p-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-400 mb-3">Key Dates</h3>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-[12px] text-slate-500">Created</span>
                <span className="text-[12px] text-slate-700">{fmtDate(app.created_at)}</span>
              </div>
              {app.updated_at && (
                <div className="flex justify-between">
                  <span className="text-[12px] text-slate-500">Last Updated</span>
                  <span className="text-[12px] text-slate-700">{fmtDate(app.updated_at)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-[12px] text-slate-500">Info Requests</span>
                <span className="text-[12px] text-slate-700">{app.request_info_count ?? 0} / 2</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Decline modal */}
      {showDecline && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold text-slate-800">Decline Application</h2>
              <button onClick={() => setShowDecline(false)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <label className="block text-[12px] font-semibold text-slate-500 mb-1">Decline Reason *</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20 resize-none mb-4"
              rows={4}
              placeholder="State the reason for declining this application…"
              value={declineReason}
              onChange={e => setDeclineReason(e.target.value)}
            />
            <div className="flex gap-2 justify-end">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowDecline(false)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: RED }}
                disabled={!declineReason.trim() || working}
                onClick={decline}
              >
                {working ? 'Declining…' : 'Confirm Decline'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Request info modal */}
      {showReqInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold text-slate-800">Request More Information</h2>
              <button onClick={() => setShowReqInfo(false)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <label className="block text-[12px] font-semibold text-slate-500 mb-1">Notes for Applicant</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20 resize-none mb-4"
              rows={4}
              placeholder="Describe what information is needed…"
              value={reqInfoNotes}
              onChange={e => setReqInfoNotes(e.target.value)}
            />
            <p className="text-[11px] text-slate-400 mb-4">
              This is request {(app.request_info_count ?? 0) + 1} of 2. Max 2 info requests allowed per application.
            </p>
            <div className="flex gap-2 justify-end">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]" onClick={() => setShowReqInfo(false)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={working}
                onClick={requestInfo}
              >
                {working ? 'Sending…' : 'Send Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Yes, proceed"
          danger
          onConfirm={() => { confirm.onConfirm(); setConfirm(null) }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Page>
  )
}
