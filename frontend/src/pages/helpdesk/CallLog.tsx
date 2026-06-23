import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter, NAVY, GREEN, AMBER, RED } from '../../components/UI'
import { today, monthStart, fmtDate } from '../../lib/fmt'
import { toast } from 'sonner'

const BLUE = '#2563EB'

interface CallRecord {
  id:           number
  ticket_id:    number | null
  ticket_ref:   string | null
  agent_name:   string
  customer_name: string
  customer_phone: string
  direction:    'inbound' | 'outbound'
  duration_sec: number | null
  outcome:      string
  notes:        string | null
  started_at:   string
}

interface CallStats {
  total:    number
  inbound:  number
  outbound: number
  avg_duration_sec: number | null
}

function formatDuration(sec: number | null) {
  if (sec == null) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const OUTCOME_COLOR: Record<string, string> = {
  resolved:       GREEN,
  escalated:      '#F59E0B',
  callback:       BLUE,
  no_answer:      '#94a3b8',
  voicemail:      '#94a3b8',
  transferred:    NAVY,
}

function OutcomePill({ outcome }: { outcome: string }) {
  const color = OUTCOME_COLOR[outcome] ?? '#64748b'
  const label = outcome.replace(/_/g, ' ')
  return (
    <span className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full text-white capitalize"
      style={{ background: color }}>{label}</span>
  )
}

function LogCallModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    customer_name:  '',
    customer_phone: '',
    direction:      'inbound',
    duration_sec:   '',
    outcome:        'resolved',
    notes:          '',
    ticket_ref:     '',
  })
  const [saving, setSaving] = useState(false)

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch('/api/helpdesk/calls', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          duration_sec: form.duration_sec ? parseInt(form.duration_sec) : null,
        }),
      })
      toast.success('Call logged')
      onSaved(); onClose()
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const INPUT = 'w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none bg-white'
  const IBRD  = { borderColor: 'rgba(15,23,42,0.15)' }
  const LABEL = 'block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-bold text-slate-800">Log a Call</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[18px] text-slate-400">close</span>
          </button>
        </div>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Customer Name</label>
              <input required value={form.customer_name} onChange={e => set('customer_name', e.target.value)}
                className={INPUT} style={IBRD} placeholder="Full name" />
            </div>
            <div>
              <label className={LABEL}>Phone</label>
              <input value={form.customer_phone} onChange={e => set('customer_phone', e.target.value)}
                className={INPUT} style={IBRD} placeholder="+234..." />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Direction</label>
              <select value={form.direction} onChange={e => set('direction', e.target.value)}
                className={`${INPUT} appearance-none`} style={IBRD}>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Duration (seconds)</label>
              <input type="number" min="0" value={form.duration_sec} onChange={e => set('duration_sec', e.target.value)}
                className={INPUT} style={IBRD} placeholder="e.g. 180" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Outcome</label>
              <select value={form.outcome} onChange={e => set('outcome', e.target.value)}
                className={`${INPUT} appearance-none`} style={IBRD}>
                <option value="resolved">Resolved</option>
                <option value="escalated">Escalated</option>
                <option value="callback">Callback Required</option>
                <option value="no_answer">No Answer</option>
                <option value="voicemail">Left Voicemail</option>
                <option value="transferred">Transferred</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Linked Ticket (opt.)</label>
              <input value={form.ticket_ref} onChange={e => set('ticket_ref', e.target.value)}
                className={INPUT} style={IBRD} placeholder="TKT-001" />
            </div>
          </div>
          <div>
            <label className={LABEL}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
              rows={3} className={INPUT} style={IBRD} placeholder="Call summary…" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold border text-slate-600"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : 'Log Call'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function CallLog() {
  const [calls,   setCalls]   = useState<CallRecord[]>([])
  const [stats,   setStats]   = useState<CallStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [modal,   setModal]   = useState(false)

  async function load() {
    setLoading(true); setErr('')
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    try {
      const [c, s] = await Promise.all([
        apiFetch(`/api/helpdesk/calls?${qs}`),
        apiFetch(`/api/helpdesk/calls/stats?${qs}`),
      ])
      setCalls((c as any) ?? [])
      setStats(((s as any)?.data ?? s ?? null) as CallStats | null)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [dateFrom, dateTo])

  return (
    <Page dept="Helpdesk" title="Call Log"
      subtitle="All inbound and outbound customer calls"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
          <button onClick={() => setModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[16px]">add_call</span>
            Log Call
          </button>
        </div>
      }
    >
      <ErrBanner msg={err} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <KpiCard loading={loading} label="Total Calls"    value={String(stats?.total ?? 0)}    icon="call"         accent={NAVY}  />
        <KpiCard loading={loading} label="Inbound"        value={String(stats?.inbound ?? 0)}  icon="call_received" accent={GREEN} />
        <KpiCard loading={loading} label="Outbound"       value={String(stats?.outbound ?? 0)} icon="call_made"    accent={BLUE}  />
        <KpiCard loading={loading} label="Avg Duration"   value={formatDuration(stats?.avg_duration_sec ?? null)} icon="timer" accent={AMBER} />
      </div>

      <SectionCard title="Calls" badge={calls.length}>
        {loading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
        ) : calls.length === 0 ? (
          <div className="py-16 text-center text-slate-400">
            <span className="material-symbols-rounded text-[40px] block mb-2">call_end</span>
            <p className="text-[13px]">No calls in this period</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: '#F8FAFC', borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
                  {['Time', 'Agent', 'Customer', 'Direction', 'Duration', 'Outcome', 'Ticket'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-slate-400 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calls.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }} className="hover:bg-slate-50">
                    <td className="px-5 py-3 whitespace-nowrap text-slate-500 text-[12px]">{fmtDate(c.started_at)}</td>
                    <td className="px-5 py-3 font-medium text-slate-800">{c.agent_name}</td>
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-800">{c.customer_name}</p>
                      {c.customer_phone && <p className="text-[11px] text-slate-400 font-mono">{c.customer_phone}</p>}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-1 text-[12px]"
                        style={{ color: c.direction === 'inbound' ? GREEN : BLUE }}>
                        <span className="material-symbols-rounded text-[14px]">
                          {c.direction === 'inbound' ? 'call_received' : 'call_made'}
                        </span>
                        {c.direction}
                      </span>
                    </td>
                    <td className="px-5 py-3 font-mono text-slate-600">{formatDuration(c.duration_sec)}</td>
                    <td className="px-5 py-3"><OutcomePill outcome={c.outcome} /></td>
                    <td className="px-5 py-3">
                      {c.ticket_ref
                        ? <a href={`/helpdesk/${c.ticket_id}`}
                            className="font-mono text-[12px] underline text-blue-600">{c.ticket_ref}</a>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {modal && <LogCallModal onClose={() => setModal(false)} onSaved={load} />}
    </Page>
  )
}
