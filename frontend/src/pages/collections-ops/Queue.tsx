import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import {
  Spinner, ErrBanner, StatusBadge, KpiCard, Page, SectionCard,
  DataTable, ColDef, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
interface QueueItem {
  id: string
  account_cif: string
  agent_user_id: string
  agent_name: string
  assignment_date: string
  dpd_bucket: string
  outstanding_kobo: number
  current_stage: string
  notes?: string
  created_at: string
  last_contact_at?: string
}

interface Dashboard {
  total_assigned: number
  overdue_promises: number
  honoured_today: number
  collected_today_kobo: number
  contacts_today: number
}

const DPD_STYLE: Record<string, { bg: string; color: string }> = {
  current:  { bg: 'rgba(5,150,105,0.09)',  color: '#059669' },
  '1-30':   { bg: 'rgba(217,119,6,0.1)',   color: AMBER },
  '31-60':  { bg: 'rgba(234,88,12,0.1)',   color: '#EA580C' },
  '61-90':  { bg: 'rgba(220,38,38,0.1)',   color: '#C00000' },
  '91+':    { bg: 'rgba(127,29,29,0.12)',  color: '#7F1D1D' },
}

function DpdBadge({ bucket }: { bucket: string }) {
  const s = DPD_STYLE[bucket] ?? { bg: 'rgba(14,40,65,0.07)', color: 'var(--txt2)' }
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      {bucket}
    </span>
  )
}

const STAGES = ['', 'new', 'in_progress', 'escalated', 'legal', 'closed']
const DPD_BUCKETS = ['', 'current', '1-30', '31-60', '61-90', '91+']
const CONTACT_TYPES = ['call', 'sms', 'visit', 'email']
const OUTCOMES = ['no_answer', 'promised_payment', 'dispute', 'rtp', 'paid', 'not_found']

export default function CollectionsQueue() {
  const [queue, setQueue]     = useState<QueueItem[]>([])
  const [dash, setDash]       = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  // filters
  const [dpdF, setDpdF]     = useState('')
  const [stageF, setStageF] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage]     = useState(0)
  const limit = 50

  // contact modal (step 1 = log contact, step 2 = log promise when outcome=promised_payment)
  const [contactRow, setContactRow]     = useState<QueueItem | null>(null)
  const [contactStep, setContactStep]   = useState(1)
  const [contactType, setContactType]   = useState('call')
  const [contactOutcome, setOutcome]    = useState('no_answer')
  const [contactNotes, setContactNotes] = useState('')
  const [contactting, setContactting]   = useState(false)
  const [contactErr, setContactErr]     = useState('')

  // promise modal
  const [promiseRow, setPromiseRow]     = useState<QueueItem | null>(null)
  const [promiseDate, setPromiseDate]   = useState('')
  const [promiseAmt, setPromiseAmt]     = useState('')
  const [promising, setPromising]       = useState(false)
  const [promiseErr, setPromiseErr]     = useState('')

  // reassign modal
  const [reassignRow, setReassignRow]   = useState<QueueItem | null>(null)
  const [agentId, setAgentId]           = useState('')
  const [reassignNotes, setReassignNotes] = useState('')
  const [reassigning, setReassigning]   = useState(false)
  const [reassignErr, setReassignErr]   = useState('')

  // user list for reassign dropdown
  const [agents, setAgents] = useState<{ id: string; full_name: string }[]>([])
  useEffect(() => {
    apiFetch<{ id: string; full_name: string; role: string }[]>('/api/admin/users')
      .then(rows => setAgents(rows.filter(u => u.role?.includes('collection'))))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        ...(dpdF   ? { dpd_bucket: dpdF }   : {}),
        ...(stageF ? { stage: stageF }       : {}),
        ...(search ? { q: search }           : {}),
      })
      const [rQ, rDash] = await Promise.allSettled([
        apiFetch<{ data: QueueItem[] }>(`/api/collections-ops/queue?${params}`),
        apiFetch<Dashboard>('/api/collections-ops/dashboard'),
      ])
      if (rQ.status === 'fulfilled') setQueue(Array.isArray(rQ.value) ? rQ.value : (rQ.value.data ?? []))
      if (rDash.status === 'fulfilled') setDash(rDash.value)
      if (rQ.status === 'rejected' && rDash.status === 'rejected') setError((rQ as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dpdF, stageF, search, page])

  useEffect(() => { load() }, [load])

  function resetContactModal() {
    setContactRow(null); setContactStep(1)
    setContactNotes(''); setContactType('call'); setOutcome('no_answer')
    setContactErr('')
  }

  async function submitContact() {
    if (!contactRow) return
    setContactting(true); setContactErr('')
    try {
      await apiPost(`/api/collections-ops/${contactRow.id}/contact`, {
        contact_type: contactType,
        outcome: contactOutcome,
        notes: contactNotes,
      })
      if (contactOutcome === 'promised_payment') {
        setContactStep(2)
        setContactErr('')
      } else {
        resetContactModal()
        load()
      }
    } catch (e: any) {
      setContactErr(e.message)
    } finally {
      setContactting(false)
    }
  }

  async function submitPromise(row?: QueueItem | null) {
    const target = row ?? promiseRow
    if (!target) return
    setPromising(true); setPromiseErr('')
    try {
      await apiPost(`/api/collections-ops/${target.id}/promise`, {
        promise_date: promiseDate,
        amount_kobo: Math.round(parseFloat(promiseAmt) * 100),
      })
      setPromiseRow(null); setPromiseDate(''); setPromiseAmt('')
      // also close combined modal if we came from step 2
      if (row) resetContactModal()
      load()
    } catch (e: any) {
      setPromiseErr(e.message)
    } finally {
      setPromising(false)
    }
  }

  async function submitReassign() {
    if (!reassignRow) return
    setReassigning(true); setReassignErr('')
    try {
      await apiPut(`/api/collections-ops/${reassignRow.id}/assign`, {
        agent_id: agentId,
        notes: reassignNotes,
      })
      setReassignRow(null); setAgentId(''); setReassignNotes('')
      load()
    } catch (e: any) {
      setReassignErr(e.message)
    } finally {
      setReassigning(false)
    }
  }

  function lastContactedCell(ts?: string) {
    if (!ts) return <span className="text-[11px] text-[color:var(--txt2)]">Never</span>
    const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000)
    const color = days >= 7 ? RED : days >= 3 ? AMBER : '#059669'
    return (
      <span className="text-[11px] font-medium whitespace-nowrap" style={{ color }}>
        {days === 0 ? 'Today' : `${days}d ago`}
      </span>
    )
  }

  const cols: ColDef<QueueItem>[] = [
    { key: 'account_cif', label: 'CIF', render: r => <span className="font-mono text-[12px] text-[color:var(--txt2)]">{r.account_cif}</span> },
    { key: 'agent_name', label: 'Agent' },
    { key: 'outstanding_kobo', label: 'Outstanding', right: true, render: r => <span className="font-mono font-semibold">{fmt(r.outstanding_kobo / 100)}</span> },
    { key: 'dpd_bucket', label: 'DPD', render: r => <DpdBadge bucket={r.dpd_bucket} /> },
    { key: 'current_stage', label: 'Stage', render: r => <StatusBadge status={r.current_stage} /> },
    { key: 'assignment_date', label: 'Assigned', render: r => fmtDate(r.assignment_date) },
    { key: 'last_contact_at', label: 'Last Contacted', render: r => lastContactedCell(r.last_contact_at) },
    {
      key: '_actions', label: '', sortable: false,
      render: r => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={e => { e.stopPropagation(); setContactRow(r); setContactStep(1) }}
            className="px-2 py-1 rounded text-[11px] font-semibold text-white"
            style={{ background: NAVY }}>
            Log Contact
          </button>
          <button
            onClick={e => { e.stopPropagation(); setPromiseRow(r) }}
            className="px-2 py-1 rounded text-[11px] font-semibold"
            style={{ background: 'var(--chip-bg)', color: NAVY }}>
            Log Promise
          </button>
          <button
            onClick={e => { e.stopPropagation(); setReassignRow(r) }}
            className="px-2 py-1 rounded text-[11px] font-semibold"
            style={{ background: 'rgba(220,38,38,0.07)', color: RED }}>
            Reassign
          </button>
        </div>
      ),
    },
  ]

  const d = dash

  return (
    <Page
      dept="Collections Ops"
      title="Assignment Queue"
      subtitle="Active collections assignments and contact log"
    >
      <ErrBanner msg={error} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <KpiCard label="Total Assigned"      value={String(d?.total_assigned ?? '—')}                         icon="assignment"      accent={NAVY}   loading={loading && !d} />
        <KpiCard label="Overdue Promises"    value={String(d?.overdue_promises ?? '—')}                       icon="warning"         accent={RED}    loading={loading && !d} />
        <KpiCard label="Honoured Today"      value={String(d?.honoured_today ?? '—')}                         icon="check_circle"    accent={GREEN}  loading={loading && !d} />
        <KpiCard label="Collected Today"     value={d ? fmt(d.collected_today_kobo / 100) : '—'}              icon="payments"        accent={GREEN}  loading={loading && !d} />
        <KpiCard label="Contacts Today"      value={String(d?.contacts_today ?? '—')}                         icon="phone_in_talk"   accent={AMBER}  loading={loading && !d} />
      </div>

      {/* Filters */}
      <div className="rounded-2xl border shadow-sm p-4 mb-4" style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
        <div className="flex flex-wrap gap-3">
          <input
            className="w-full max-w-xs px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
            style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            placeholder="Search by CIF or agent…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0) }}
          />
          <select
            className="px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
            style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            value={dpdF} onChange={e => { setDpdF(e.target.value); setPage(0) }}>
            <option value="">All DPD Buckets</option>
            {DPD_BUCKETS.filter(Boolean).map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <select
            className="px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
            style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
            value={stageF} onChange={e => { setStageF(e.target.value); setPage(0) }}>
            <option value="">All Stages</option>
            {STAGES.filter(Boolean).map(s => <option key={s} value={s}>{snake(s)}</option>)}
          </select>
        </div>
      </div>

      <SectionCard title="Queue" badge={queue.length}>
        <DataTable cols={cols} rows={queue} loading={loading} emptyIcon="assignment" emptyMsg="No items in queue" />
        <div className="flex justify-between items-center px-5 py-3 border-t" style={{ borderColor: 'var(--bdr)' }}>
          <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>Page {page + 1}</span>
          <div className="flex gap-2">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-black/[0.05] disabled:opacity-40" style={{ color: 'var(--txt)' }}>Prev</button>
            <button disabled={queue.length < limit} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-black/[0.05] disabled:opacity-40" style={{ color: 'var(--txt)' }}>Next</button>
          </div>
        </div>
      </SectionCard>

      {/* Log Contact / Promise combined modal */}
      {contactRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl shadow-xl p-6 w-full max-w-md" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>
                {contactStep === 1 ? `Log Contact — ${contactRow.account_cif}` : `Log Promise — ${contactRow.account_cif}`}
              </h2>
              <button onClick={resetContactModal} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-4">
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                style={{ background: contactStep === 1 ? NAVY : 'rgba(14,40,65,0.1)', color: contactStep === 1 ? '#fff' : '#64748b' }}>
                1 Contact
              </span>
              <span className="text-[color:var(--txt3)] text-[12px]">→</span>
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                style={{ background: contactStep === 2 ? '#059669' : 'rgba(0,0,0,0.06)', color: contactStep === 2 ? '#fff' : '#94a3b8' }}>
                2 Promise
              </span>
            </div>
            <ErrBanner msg={contactErr} />

            {contactStep === 1 ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Contact Type</label>
                  <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    value={contactType} onChange={e => setContactType(e.target.value)}>
                    {CONTACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Outcome</label>
                  <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    value={contactOutcome} onChange={e => setOutcome(e.target.value)}>
                    {OUTCOMES.map(o => <option key={o} value={o}>{snake(o)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Notes</label>
                  <textarea rows={3} className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none resize-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    value={contactNotes} onChange={e => setContactNotes(e.target.value)} />
                </div>
                {contactOutcome === 'promised_payment' && (
                  <p className="text-[11px] text-[color:var(--txt2)]">
                    Outcome is "Promised Payment" — next step will capture promise details.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <ErrBanner msg={promiseErr} />
                <div>
                  <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Promise Date</label>
                  <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    value={promiseDate} onChange={e => setPromiseDate(e.target.value)} />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Amount (₦)</label>
                  <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                    style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                    placeholder="0.00"
                    value={promiseAmt} onChange={e => setPromiseAmt(e.target.value)} />
                </div>
              </div>
            )}

            <div className="flex justify-between gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-black/[0.05]" style={{ color: 'var(--txt)' }}
                onClick={contactStep === 2 ? () => setContactStep(1) : resetContactModal}>
                {contactStep === 2 ? '← Back' : 'Cancel'}
              </button>
              {contactStep === 1 ? (
                <button
                  className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                  style={{ background: NAVY }}
                  disabled={contactting}
                  onClick={submitContact}>
                  {contactting ? 'Saving…' : contactOutcome === 'promised_payment' ? 'Save & Add Promise →' : 'Save'}
                </button>
              ) : (
                <button
                  className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                  style={{ background: '#059669' }}
                  disabled={promising || !promiseDate || !promiseAmt}
                  onClick={() => submitPromise(contactRow)}>
                  {promising ? 'Saving…' : 'Save Promise'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log Promise modal */}
      {promiseRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>Log Promise — {promiseRow.account_cif}</h2>
              <button onClick={() => setPromiseRow(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={promiseErr} />
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Promise Date</label>
                <input type="date" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={promiseDate} onChange={e => setPromiseDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Amount (₦)</label>
                <input type="number" min="0" step="0.01" className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  placeholder="0.00"
                  value={promiseAmt} onChange={e => setPromiseAmt(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-black/[0.05]" style={{ color: 'var(--txt)' }} onClick={() => setPromiseRow(null)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: GREEN }}
                disabled={promising || !promiseDate || !promiseAmt}
                onClick={() => submitPromise(contactRow)}>
                {promising ? 'Saving…' : 'Save Promise'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reassign modal */}
      {reassignRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ background: 'var(--card)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>Reassign — {reassignRow.account_cif}</h2>
              <button onClick={() => setReassignRow(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={reassignErr} />
            <div className="space-y-3">
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Agent</label>
                <select className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={agentId} onChange={e => setAgentId(e.target.value)}>
                  <option value="">— Select agent —</option>
                  {agents.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Notes</label>
                <textarea rows={2} className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none resize-none"
                  style={{ borderColor: 'var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)' }}
                  value={reassignNotes} onChange={e => setReassignNotes(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold bg-black/[0.05]" style={{ color: 'var(--txt)' }} onClick={() => setReassignRow(null)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={reassigning || !agentId}
                onClick={submitReassign}>
                {reassigning ? 'Saving…' : 'Reassign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
