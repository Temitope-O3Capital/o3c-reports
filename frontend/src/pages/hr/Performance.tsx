import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import {
  Spinner, ErrBanner, StatusBadge, Page, SectionCard, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
interface ReviewCycle {
  id: string
  name: string
  period_start: string
  period_end: string
  status: string
  created_at: string
}

interface Appraisal {
  id: string
  cycle_id: string
  employee_id: string
  first_name: string
  last_name: string
  staff_id: string
  department_name: string
  overall_score: number | null
  status: string
  reviewer_id: string | null
  created_at: string
}

interface AppraisalItem {
  id: string
  competency: string
  score: number
  max_score: number
  comments: string
}

interface AppraisalDetail {
  appraisal: Appraisal
  items: AppraisalItem[]
}

export default function Performance() {
  // Cycles
  const [cycles, setCycles]         = useState<ReviewCycle[]>([])
  const [cyclesLoading, setCyclesL] = useState(true)
  const [cyclesErr, setCyclesErr]   = useState('')

  // Selected cycle
  const [selectedCycle, setSelectedCycle] = useState<ReviewCycle | null>(null)

  // Appraisals
  const [appraisals, setAppraisals] = useState<Appraisal[]>([])
  const [apprLoading, setApprL]     = useState(false)
  const [apprErr, setApprErr]       = useState('')
  const [statusF, setStatusF]       = useState('')

  // Detail modal
  const [detailId, setDetailId]       = useState<string | null>(null)
  const [detail, setDetail]           = useState<AppraisalDetail | null>(null)
  const [detailLoading, setDetailL]   = useState(false)

  // Create cycle modal
  const [showCreate, setShowCreate]   = useState(false)
  const [cycleName, setCycleName]     = useState('')
  const [cycleStart, setCycleStart]   = useState('')
  const [cycleEnd, setCycleEnd]       = useState('')
  const [creating, setCreating]       = useState(false)
  const [createErr, setCreateErr]     = useState('')

  const loadCycles = useCallback(async () => {
    setCyclesL(true); setCyclesErr('')
    try {
      const res = await apiFetch<{ data: ReviewCycle[] } | ReviewCycle[]>('/api/hr/review-cycles')
      setCycles(Array.isArray(res) ? res : (res.data ?? []))
    } catch (e: any) {
      setCyclesErr(e.message)
    } finally {
      setCyclesL(false)
    }
  }, [])

  useEffect(() => { loadCycles() }, [loadCycles])

  const loadAppraisals = useCallback(async (cycleId: string) => {
    setApprL(true); setApprErr('')
    try {
      const params = new URLSearchParams({ cycle_id: cycleId, ...(statusF ? { status: statusF } : {}) })
      const res = await apiFetch<{ data: Appraisal[] } | Appraisal[]>(`/api/hr/appraisals?${params}`)
      setAppraisals(Array.isArray(res) ? res : (res.data ?? []))
    } catch (e: any) {
      setApprErr(e.message)
    } finally {
      setApprL(false)
    }
  }, [statusF])

  useEffect(() => {
    if (selectedCycle) loadAppraisals(selectedCycle.id)
  }, [selectedCycle, loadAppraisals])

  async function openDetail(id: string) {
    setDetailId(id); setDetail(null); setDetailL(true)
    try {
      const res = await apiFetch<AppraisalDetail>(`/api/hr/appraisals/${id}`)
      setDetail(res)
    } finally {
      setDetailL(false)
    }
  }

  async function createCycle() {
    setCreating(true); setCreateErr('')
    try {
      await apiPost('/api/hr/review-cycles', { name: cycleName, period_start: cycleStart, period_end: cycleEnd })
      setShowCreate(false); setCycleName(''); setCycleStart(''); setCycleEnd('')
      loadCycles()
    } catch (e: any) {
      setCreateErr(e.message)
    } finally {
      setCreating(false)
    }
  }

  function scoreColor(score: number | null, max = 100): string {
    if (score == null) return '#94A3B8'
    const pct = score / max
    if (pct >= 0.8) return GREEN
    if (pct >= 0.6) return AMBER
    return RED
  }

  return (
    <Page
      dept="HR"
      title="Performance Appraisals"
      subtitle="Review cycles and employee appraisals"
    >
      <div className="flex gap-5">
        {/* Left: Cycles list */}
        <div className="w-72 flex-shrink-0 space-y-3">
          <SectionCard
            title="Review Cycles"
            actions={
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-white"
                style={{ background: NAVY }}>
                <span className="material-symbols-rounded text-[13px]">add</span>
                New Cycle
              </button>
            }
          >
            <ErrBanner msg={cyclesErr} />
            {cyclesLoading ? (
              <div className="flex items-center justify-center py-10"><Spinner size={24} /></div>
            ) : cycles.length === 0 ? (
              <p className="text-[13px] text-slate-400 px-5 py-8 text-center">No review cycles yet</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {cycles.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCycle(c)}
                    className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors"
                    style={{ background: selectedCycle?.id === c.id ? 'rgba(14,40,65,0.04)' : undefined }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[13px] font-semibold text-slate-800 truncate max-w-[70%]">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {fmtDate(c.period_start)} – {fmtDate(c.period_end)}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* Right: Appraisals */}
        <div className="flex-1 min-w-0">
          {!selectedCycle ? (
            <div className="flex flex-col items-center justify-center h-64 bg-white rounded-2xl border border-black/[0.06] shadow-sm">
              <span className="material-symbols-rounded text-[40px] text-slate-300 mb-3">grading</span>
              <p className="text-[13px] text-slate-400">Select a review cycle to view appraisals</p>
            </div>
          ) : (
            <SectionCard
              title={`Appraisals — ${selectedCycle.name}`}
              badge={appraisals.length}
              actions={
                <select className="px-2 py-1 rounded border border-slate-200 text-[12px] focus:outline-none"
                  value={statusF} onChange={e => setStatusF(e.target.value)}>
                  <option value="">All Statuses</option>
                  {['pending', 'in_progress', 'completed', 'approved'].map(s => (
                    <option key={s} value={s}>{snake(s)}</option>
                  ))}
                </select>
              }
            >
              <ErrBanner msg={apprErr} />
              {apprLoading ? (
                <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
              ) : appraisals.length === 0 ? (
                <div className="flex flex-col items-center py-16">
                  <span className="material-symbols-rounded text-[36px] text-slate-300 mb-2">person_search</span>
                  <p className="text-[13px] text-slate-400">No appraisals for this cycle</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr>
                        {['Employee', 'Staff ID', 'Department', 'Score', 'Status', ''].map(h => (
                          <th key={h}
                            className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em]"
                            style={{ background: NAVY, color: 'rgba(255,255,255,0.6)' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {appraisals.map((a, i) => (
                        <tr key={a.id}
                          className="hover:bg-slate-50 cursor-pointer transition-colors"
                          style={{ borderTop: i > 0 ? '1px solid rgba(15,23,42,0.05)' : undefined }}
                          onClick={() => openDetail(a.id)}>
                          <td className="px-5 py-3 font-semibold text-slate-800">{a.first_name} {a.last_name}</td>
                          <td className="px-5 py-3 font-mono text-[12px] text-slate-500">{a.staff_id}</td>
                          <td className="px-5 py-3 text-slate-600">{a.department_name ?? '—'}</td>
                          <td className="px-5 py-3">
                            {a.overall_score != null ? (
                              <span className="font-mono font-semibold text-[13px]"
                                style={{ color: scoreColor(a.overall_score) }}>
                                {a.overall_score}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-5 py-3"><StatusBadge status={a.status} /></td>
                          <td className="px-5 py-3">
                            <span className="material-symbols-rounded text-[18px] text-slate-400">chevron_right</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          )}
        </div>
      </div>

      {/* Detail modal */}
      {detailId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold text-slate-800">
                {detail ? `${detail.appraisal.first_name} ${detail.appraisal.last_name}` : 'Loading…'}
              </h2>
              <button onClick={() => { setDetailId(null); setDetail(null) }} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>

            {detailLoading ? (
              <div className="flex items-center justify-center py-12"><Spinner size={32} /></div>
            ) : detail ? (
              <>
                <div className="grid grid-cols-2 gap-3 mb-5 text-[13px]">
                  {[
                    ['Staff ID', detail.appraisal.staff_id],
                    ['Department', detail.appraisal.department_name],
                    ['Status', detail.appraisal.status],
                    ['Overall Score', detail.appraisal.overall_score != null ? String(detail.appraisal.overall_score) : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="bg-slate-50 rounded-lg px-3 py-2">
                      <p className="text-[11px] text-slate-400 mb-0.5">{k}</p>
                      <p className="font-semibold text-slate-800">{v}</p>
                    </div>
                  ))}
                </div>

                <p className="text-[12px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Competency Scores</p>
                {detail.items.length === 0 ? (
                  <p className="text-[13px] text-slate-400">No competency items recorded</p>
                ) : (
                  <div className="space-y-3">
                    {detail.items.map(item => (
                      <div key={item.id} className="border border-slate-100 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[13px] font-semibold text-slate-800">{item.competency}</span>
                          <span className="font-mono text-[13px] font-bold"
                            style={{ color: scoreColor(item.score, item.max_score) }}>
                            {item.score} / {item.max_score}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full mb-2" style={{ background: 'rgba(14,40,65,0.07)' }}>
                          <div className="h-full rounded-full"
                            style={{
                              width: `${item.max_score > 0 ? (item.score / item.max_score) * 100 : 0}%`,
                              background: scoreColor(item.score, item.max_score),
                            }} />
                        </div>
                        {item.comments && <p className="text-[12px] text-slate-500">{item.comments}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Create cycle modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreate(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="perf-create-title" className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 id="perf-create-title" className="text-[15px] font-bold text-slate-800">New Review Cycle</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={createErr} />
            <div className="space-y-3">
              <div>
                <label htmlFor="perf-cycle-name" className="block text-[12px] font-semibold text-slate-500 mb-1">Cycle Name *</label>
                <input id="perf-cycle-name" type="text" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                  placeholder="e.g. H1 2026"
                  value={cycleName} onChange={e => setCycleName(e.target.value)} />
              </div>
              <div>
                <label htmlFor="perf-cycle-start" className="block text-[12px] font-semibold text-slate-500 mb-1">Period Start *</label>
                <input id="perf-cycle-start" type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                  value={cycleStart} onChange={e => setCycleStart(e.target.value)} />
              </div>
              <div>
                <label htmlFor="perf-cycle-end" className="block text-[12px] font-semibold text-slate-500 mb-1">Period End *</label>
                <input id="perf-cycle-end" type="date" className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none"
                  value={cycleEnd} onChange={e => setCycleEnd(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05]" onClick={() => setShowCreate(false)}>Cancel</button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={creating || !cycleName || !cycleStart || !cycleEnd}
                onClick={createCycle}>
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
