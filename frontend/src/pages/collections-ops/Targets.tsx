import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPut } from '../../lib/api'
import { fmt, fmtDate, today } from '../../lib/fmt'
import {
  Spinner, ErrBanner, Page, SectionCard, NAVY, RED, GREEN, AMBER,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
interface Target {
  id: string
  agent_user_id: string
  agent_name: string
  target_date: string
  target_amount_kobo: number
  collected_amount_kobo: number
  contacts_made: number
  promises_obtained: number
}

// Compute the Monday of the current week
function weekStart(): string {
  const d = new Date()
  const day = d.getDay()
  const mon = new Date(d)
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return mon.toISOString().slice(0, 10)
}

export default function Targets() {
  const [targets, setTargets]   = useState<Target[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  const [from, setFrom] = useState(weekStart())
  const [to, setTo]     = useState(today())

  // Inline editing state: key = target id, value = edited target amount string
  const [editing, setEditing]       = useState<Record<string, string>>({})
  const [saving, setSaving]         = useState<Record<string, boolean>>({})
  const [saveErr, setSaveErr]       = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ date_from: from, date_to: to })
      const res = await apiFetch<{ data: Target[] } | Target[]>(`/api/collections-ops/targets?${params}`)
      setTargets(Array.isArray(res) ? res : (res.data ?? []))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  function startEdit(t: Target) {
    setEditing(prev => ({ ...prev, [t.id]: String((t.target_amount_kobo / 100).toFixed(2)) }))
  }

  function cancelEdit(id: string) {
    setEditing(prev => { const next = { ...prev }; delete next[id]; return next })
    setSaveErr(prev => { const next = { ...prev }; delete next[id]; return next })
  }

  async function saveTarget(t: Target) {
    const newAmtStr = editing[t.id]
    if (!newAmtStr) return
    setSaving(prev => ({ ...prev, [t.id]: true }))
    setSaveErr(prev => { const next = { ...prev }; delete next[t.id]; return next })
    try {
      await apiPut('/api/collections-ops/targets', {
        agent_user_id: t.agent_user_id,
        target_date: t.target_date,
        target_amount_kobo: Math.round(parseFloat(newAmtStr) * 100),
        contacts_made: t.contacts_made,
        promises_obtained: t.promises_obtained,
        collected_amount_kobo: t.collected_amount_kobo,
      })
      cancelEdit(t.id)
      load()
    } catch (e: any) {
      setSaveErr(prev => ({ ...prev, [t.id]: e.message }))
    } finally {
      setSaving(prev => { const next = { ...prev }; delete next[t.id]; return next })
    }
  }

  function pct(collected: number, target: number): number {
    if (!target) return 0
    return Math.min(100, Math.round((collected / target) * 100))
  }

  return (
    <Page
      dept="Collections Ops"
      title="Daily Targets"
      subtitle="Agent targets vs actual collections"
      actions={
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-slate-500 font-medium">From</label>
          <input type="date" className="px-3 py-1.5 rounded-lg border border-slate-200 text-[12px] focus:outline-none"
            value={from} onChange={e => setFrom(e.target.value)} />
          <label className="text-[12px] text-slate-500 font-medium">To</label>
          <input type="date" className="px-3 py-1.5 rounded-lg border border-slate-200 text-[12px] focus:outline-none"
            value={to} onChange={e => setTo(e.target.value)} />
        </div>
      }
    >
      <ErrBanner msg={error} />

      <SectionCard title="Targets Board" badge={targets.length}>
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : targets.length === 0 ? (
          <div className="flex flex-col items-center py-16">
            <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">flag</span>
            <p className="text-[13px] text-slate-400">No targets found for this period</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {['Agent', 'Date', 'Target', 'Collected', 'Progress', 'Contacts', 'Promises', ''].map(h => (
                    <th key={h}
                      className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap"
                      style={{ background: NAVY, color: 'rgba(255,255,255,0.6)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {targets.map((t, i) => {
                  const progress = pct(t.collected_amount_kobo, t.target_amount_kobo)
                  const isEditing = t.id in editing
                  const isSaving = saving[t.id]
                  const err = saveErr[t.id]
                  return (
                    <tr key={t.id} className="transition-colors hover:bg-slate-50"
                      style={{ borderTop: i > 0 ? '1px solid rgba(15,23,42,0.05)' : undefined }}>
                      <td className="px-5 py-3 font-semibold text-slate-800">{t.agent_name}</td>
                      <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{fmtDate(t.target_date)}</td>

                      {/* Editable target cell */}
                      <td className="px-5 py-3">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <span className="text-slate-400 text-[12px]">₦</span>
                            <input
                              type="number" min="0" step="0.01"
                              className="w-28 px-2 py-1 rounded border border-slate-300 text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
                              value={editing[t.id]}
                              onChange={e => setEditing(prev => ({ ...prev, [t.id]: e.target.value }))}
                              autoFocus
                            />
                          </div>
                        ) : (
                          <button
                            className="font-mono font-semibold text-slate-800 hover:underline cursor-pointer"
                            title="Click to edit target"
                            onClick={() => startEdit(t)}>
                            {fmt(t.target_amount_kobo / 100)}
                          </button>
                        )}
                        {err && <p className="text-[11px] text-red-600 mt-0.5">{err}</p>}
                      </td>

                      <td className="px-5 py-3 font-mono font-semibold" style={{ color: progress >= 100 ? GREEN : progress >= 50 ? AMBER : RED }}>
                        {fmt(t.collected_amount_kobo / 100)}
                      </td>

                      {/* Progress bar */}
                      <td className="px-5 py-3" style={{ minWidth: 120 }}>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 rounded-full" style={{ background: 'rgba(14,40,65,0.07)' }}>
                            <div className="h-full rounded-full transition-all"
                              style={{
                                width: `${progress}%`,
                                background: progress >= 100 ? GREEN : progress >= 50 ? AMBER : RED,
                              }} />
                          </div>
                          <span className="text-[11px] font-semibold w-10 text-right"
                            style={{ color: progress >= 100 ? GREEN : progress >= 50 ? AMBER : RED }}>
                            {progress}%
                          </span>
                        </div>
                      </td>

                      <td className="px-5 py-3 text-center font-mono text-slate-700">{t.contacts_made}</td>
                      <td className="px-5 py-3 text-center font-mono text-slate-700">{t.promises_obtained}</td>

                      <td className="px-5 py-3">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <button
                              disabled={isSaving}
                              onClick={() => saveTarget(t)}
                              className="px-2 py-1 rounded text-[11px] font-semibold text-white disabled:opacity-60"
                              style={{ background: GREEN }}>
                              {isSaving ? '…' : 'Save'}
                            </button>
                            <button onClick={() => cancelEdit(t.id)}
                              className="px-2 py-1 rounded text-[11px] font-semibold text-slate-600 bg-black/[0.05]">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => startEdit(t)}
                            className="text-slate-400 hover:text-slate-700">
                            <span className="material-symbols-rounded text-[16px]">edit</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
