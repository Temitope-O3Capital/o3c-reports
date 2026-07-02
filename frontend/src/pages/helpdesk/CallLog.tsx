import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend,
} from 'recharts'
import { apiFetch, apiPost } from '../../lib/api'
import { Page, SectionCard, KpiCard, Spinner, ErrBanner, DateFilter, NAVY, GREEN, AMBER, RED } from '../../components/UI'
import { today, monthStart, fmtDate } from '../../lib/fmt'
import { toast } from 'sonner'

const BLUE = '#2563EB'

// ── Types ─────────────────────────────────────────────────────────────────────
interface CallRecord {
  id:             number
  ticket_id:      number | null
  ticket_ref:     string | null
  agent_name:     string
  customer_name:  string
  customer_phone: string
  direction:      'inbound' | 'outbound'
  duration_sec:   number | null
  outcome:        string
  notes:          string | null
  started_at:     string
}

interface SummaryRow {
  total:             number
  inbound:           number
  outbound:          number
  missed:            number
  resolved:          number
  avg_duration_sec:  number | null
  avg_inbound_sec:   number | null
  avg_outbound_sec:  number | null
}

interface OutcomeRow  { outcome: string; count: number }
interface DayRow      { day: string; total: number; inbound: number; outbound: number }
interface AgentRow    { agent_name: string; total: number; inbound: number; outbound: number; resolved: number; avg_duration_sec: number | null }

interface CallStatsData {
  summary:    SummaryRow
  by_outcome: OutcomeRow[]
  by_day:     DayRow[]
  by_agent:   AgentRow[]
}

interface CallImportResult {
  imported: number
  skipped: number
  failed: number
  date_from?: string
  date_to?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDur(sec: number | null): string {
  if (sec == null || sec === 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtDurShort(sec: number | null): string {
  if (sec == null || sec === 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return fmtDate(iso)
}

const OUTCOME_META: Record<string, { color: string; label: string; icon: string }> = {
  resolved:    { color: GREEN,      label: 'Resolved',          icon: 'check_circle' },
  escalated:   { color: AMBER,      label: 'Escalated',         icon: 'arrow_upward' },
  callback:    { color: BLUE,       label: 'Callback Required', icon: 'call_missed_outgoing' },
  no_answer:   { color: 'var(--txt2)',  label: 'No Answer',         icon: 'phone_missed' },
  voicemail:   { color: 'var(--txt2)',  label: 'Voicemail',         icon: 'voicemail' },
  transferred: { color: NAVY,       label: 'Transferred',       icon: 'call_split' },
}
const OUTCOME_COLORS = [GREEN, AMBER, BLUE, '#94A3B8', '#94A3B8', NAVY, RED, '#8B5CF6']

function OutcomePill({ outcome }: { outcome: string }) {
  const m = OUTCOME_META[outcome] ?? { color: 'var(--txt2)', label: outcome.replace(/_/g, ' '), icon: 'call' }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize"
      style={{ background: m.color + '1A', color: m.color }}>
      <span className="material-symbols-rounded text-[12px]">{m.icon}</span>
      {m.label}
    </span>
  )
}

function Avatar({ name }: { name: string }) {
  const initials = name.split(' ').map(w => w[0] ?? '').slice(0, 2).join('').toUpperCase()
  const hue = (name.charCodeAt(0) * 37 + name.charCodeAt(1 % name.length) * 13) % 360
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold text-white flex-shrink-0"
      style={{ background: `hsl(${hue},60%,42%)` }}>
      {initials || '?'}
    </span>
  )
}

// ── Log Call Modal ────────────────────────────────────────────────────────────
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
        body: JSON.stringify({ ...form, duration_sec: form.duration_sec ? parseInt(form.duration_sec) : null }),
      })
      toast.success('Call logged')
      onSaved(); onClose()
    } catch (err: any) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const INPUT = 'w-full rounded-xl border px-3 py-2.5 text-[13px] outline-none transition-colors focus:border-navy'
  const IBRD  = { background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }
  const LABEL = 'block text-[11px] font-bold text-[color:var(--txt2)] uppercase tracking-wide mb-1.5'

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div className="rounded-2xl shadow-2xl w-full max-w-md" style={{ background: 'var(--card)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4"
          style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div>
            <h3 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>Log a Call</h3>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Record a customer call manually</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--chip-bg)] transition-colors">
            <span className="material-symbols-rounded text-[18px]" style={{ color: 'var(--txt2)' }}>close</span>
          </button>
        </div>
        <form onSubmit={save} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Customer Name *</label>
              <input required value={form.customer_name} onChange={e => set('customer_name', e.target.value)}
                className={INPUT} style={IBRD} placeholder="Full name" />
            </div>
            <div>
              <label className={LABEL}>Phone</label>
              <input value={form.customer_phone} onChange={e => set('customer_phone', e.target.value)}
                className={INPUT} style={IBRD} placeholder="+234…" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Direction</label>
              <select value={form.direction} onChange={e => set('direction', e.target.value)}
                className={`${INPUT} appearance-none`} style={IBRD}>
                <option value="inbound">📞 Inbound</option>
                <option value="outbound">📲 Outbound</option>
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
                <option value="resolved">✅ Resolved</option>
                <option value="escalated">⬆️ Escalated</option>
                <option value="callback">📅 Callback Required</option>
                <option value="no_answer">🔕 No Answer</option>
                <option value="voicemail">📬 Left Voicemail</option>
                <option value="transferred">↗️ Transferred</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Linked Ticket (opt.)</label>
              <input value={form.ticket_ref} onChange={e => set('ticket_ref', e.target.value)}
                className={INPUT} style={IBRD} placeholder="TKT-001" />
            </div>
          </div>
          <div>
            <label className={LABEL}>Call Notes</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
              rows={3} className={INPUT} style={{ ...IBRD, resize: 'none' }} placeholder="Summary of the call…" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold border transition-colors"
              style={{ borderColor: 'var(--bdr)', color: 'var(--txt)' }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60 transition-opacity"
              style={{ background: NAVY }}>
              {saving ? 'Saving…' : 'Log Call'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Custom tooltip ────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border shadow-xl px-3 py-2.5 text-[12px]"
      style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
      {label && <p className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>{label}</p>}
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
          <span className="capitalize" style={{ color: 'var(--txt2)' }}>{p.name}:</span>
          <span className="font-bold" style={{ color: 'var(--txt)' }}>{p.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
type Tab = 'all' | 'inbound' | 'outbound' | 'missed'

export default function CallLog() {
  const [calls,      setCalls]   = useState<CallRecord[]>([])
  const [stats,      setStats]   = useState<CallStatsData | null>(null)
  const [loading,    setLoading] = useState(true)
  const [err,        setErr]     = useState('')
  const [dateFrom,   setDateFrom] = useState(monthStart())
  const [dateTo,     setDateTo]   = useState(today())
  const [modal,           setModal]          = useState(false)
  const [tab,             setTab]            = useState<Tab>('all')
  const [search,          setSearch]         = useState('')
  const [importingVoice,  setImportingVoice] = useState(false)

  async function load() {
    setLoading(true); setErr('')
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
    try {
      const [rCalls, rStats] = await Promise.allSettled([
        apiFetch<CallRecord[]>(`/api/helpdesk/calls?${qs}`),
        apiFetch<CallStatsData>(`/api/helpdesk/calls/stats?${qs}`),
      ])
      if (rCalls.status === 'fulfilled') setCalls(Array.isArray(rCalls.value) ? rCalls.value : [])
      if (rStats.status === 'fulfilled') setStats(rStats.value ?? null)
      if (rCalls.status === 'rejected' && rStats.status === 'rejected') setErr((rCalls as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [dateFrom, dateTo]) // eslint-disable-line react-hooks/exhaustive-deps

  function applyImportRange(res: CallImportResult): boolean {
    if (!res.date_from || !res.date_to) return false
    const changed = res.date_from !== dateFrom || res.date_to !== dateTo
    if (changed) {
      setDateFrom(res.date_from)
      setDateTo(res.date_to)
      toast.info(`Showing imported call range: ${fmtDate(res.date_from)} to ${fmtDate(res.date_to)}`)
    }
    return changed
  }

  async function importZohoVoice() {
    setImportingVoice(true)
    try {
      const res = await apiPost<CallImportResult>('/api/zoho/voice/import-logs', {})
      toast.success(`Imported ${res.imported} voice call records${res.skipped ? ` (${res.skipped} already existed)` : ''}`)
      if (!applyImportRange(res)) load()
    } catch (e: any) {
      toast.error(e.message || 'Failed to import from Zoho Voice')
    } finally {
      setImportingVoice(false)
    }
  }

  const sm = stats?.summary
  const byDay = (stats?.by_day ?? []).map(d => ({
    day: new Date(d.day).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }),
    Inbound:  d.inbound,
    Outbound: d.outbound,
    Total:    d.total,
  }))
  const byOutcome = (stats?.by_outcome ?? []).map(d => ({
    name:  OUTCOME_META[d.outcome]?.label ?? d.outcome.replace(/_/g, ' '),
    value: d.count,
    color: OUTCOME_META[d.outcome]?.color ?? '#94A3B8',
  }))

  const filtered = calls.filter(c => {
    if (tab === 'inbound'  && c.direction !== 'inbound')  return false
    if (tab === 'outbound' && c.direction !== 'outbound') return false
    if (tab === 'missed'   && !['no_answer','voicemail'].includes(c.outcome)) return false
    if (search && !c.customer_name.toLowerCase().includes(search.toLowerCase()) &&
        !c.agent_name.toLowerCase().includes(search.toLowerCase()) &&
        !(c.customer_phone ?? '').includes(search) &&
        !(c.ticket_ref ?? '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const resolutionRate = sm && sm.total > 0 ? Math.round((sm.resolved / sm.total) * 100) : 0

  const TABS: { key: Tab; label: string; color: string; count: number }[] = [
    { key: 'all',      label: 'All Calls',  color: NAVY,       count: sm?.total    ?? 0 },
    { key: 'inbound',  label: 'Inbound',    color: GREEN,      count: sm?.inbound  ?? 0 },
    { key: 'outbound', label: 'Outbound',   color: BLUE,       count: sm?.outbound ?? 0 },
    { key: 'missed',   label: 'Missed',     color: 'var(--txt2)',  count: sm?.missed   ?? 0 },
  ]

  return (
    <Page
      dept="Helpdesk"
      title="Call Analytics"
      subtitle="Complete call history and performance metrics"
      actions={
        <div className="flex items-center gap-2">
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
          <button
            onClick={importZohoVoice}
            disabled={importingVoice}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold border transition-all disabled:opacity-50"
            style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}
            title="Pull telephony logs from Zoho Voice"
          >
            {importingVoice ? <Spinner size={14} /> : <span className="material-symbols-rounded text-[16px]">phone_in_talk</span>}
            Zoho Voice
          </button>
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

      {/* ── KPI Row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <KpiCard loading={loading} label="Total Calls"   value={String(sm?.total    ?? 0)} icon="call"              accent={NAVY}  />
        <KpiCard loading={loading} label="Inbound"       value={String(sm?.inbound  ?? 0)} icon="call_received"     accent={GREEN} />
        <KpiCard loading={loading} label="Outbound"      value={String(sm?.outbound ?? 0)} icon="call_made"         accent={BLUE}  />
        <KpiCard loading={loading} label="Missed"        value={String(sm?.missed   ?? 0)} icon="phone_missed"      accent={'var(--txt3)'} />
        <KpiCard loading={loading} label="Resolution"    value={`${resolutionRate}%`}       icon="check_circle"     accent={GREEN} />
        <KpiCard loading={loading} label="Avg Duration"  value={fmtDur(sm?.avg_duration_sec ?? null)} icon="timer"  accent={AMBER} />
      </div>

      {/* ── Charts Row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Daily call volume — takes 2/3 */}
        <SectionCard title="Daily Call Volume" className="lg:col-span-2">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex items-center justify-center h-48"><Spinner size={24} /></div>
            ) : byDay.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-[13px]" style={{ color: 'var(--txt2)' }}>No data for this period</div>
            ) : (
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }} barSize={byDay.length > 14 ? 6 : 12}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                    <Bar dataKey="Inbound"  fill={GREEN} radius={[2, 2, 0, 0]} stackId="a" />
                    <Bar dataKey="Outbound" fill={BLUE}  radius={[2, 2, 0, 0]} stackId="a" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </SectionCard>

        {/* Outcome breakdown */}
        <SectionCard title="Outcome Breakdown">
          <div className="px-5 py-4">
            {loading ? (
              <div className="flex items-center justify-center h-48"><Spinner size={24} /></div>
            ) : byOutcome.length === 0 ? (
              <div className="flex items-center justify-center h-48 text-[13px]" style={{ color: 'var(--txt2)' }}>No data</div>
            ) : (
              <>
                <div style={{ height: 130 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={byOutcome} cx="50%" cy="50%" innerRadius={38} outerRadius={58}
                        dataKey="value" paddingAngle={2} startAngle={90} endAngle={450}>
                        {byOutcome.map((d, i) => (
                          <Cell key={i} fill={d.color ?? OUTCOME_COLORS[i % OUTCOME_COLORS.length]} stroke="none" />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-1.5 mt-1">
                  {byOutcome.map((d, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-sm" style={{ background: d.color ?? OUTCOME_COLORS[i % OUTCOME_COLORS.length] }} />
                        <span className="text-[11px] capitalize" style={{ color: 'var(--txt2)' }}>{d.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold" style={{ color: 'var(--txt)' }}>{d.value}</span>
                        {(sm?.total ?? 0) > 0 && (
                          <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>
                            ({Math.round((d.value / (sm?.total ?? 1)) * 100)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </SectionCard>
      </div>

      {/* ── Agent Leaderboard ── */}
      {(stats?.by_agent ?? []).length > 0 && (
        <SectionCard title="Agent Performance" subtitle="This period" badge={(stats?.by_agent ?? []).length} className="mb-6">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                  {['#', 'Agent', 'Total', 'Inbound', 'Outbound', 'Resolved', 'Avg Duration'].map(h => (
                    <th key={h} style={{ background: 'var(--th-bg)', color: 'var(--txt2)', fontFamily: "'Inter', ui-sans-serif, sans-serif", fontSize: 10 }}
                      className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(stats?.by_agent ?? []).map((a, i) => {
                  const maxTotal = Math.max(...(stats?.by_agent ?? []).map(x => x.total), 1)
                  const pct = Math.round((a.total / maxTotal) * 100)
                  return (
                    <tr key={a.agent_name} style={{ borderTop: '1px solid var(--bdr)' }}
                      className="hover:bg-[var(--row-hvr)]">
                      <td className="px-4 py-3 text-[13px] font-bold w-8" style={{ color: 'var(--txt2)' }}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Avatar name={a.agent_name} />
                          <div>
                            <p className="font-semibold" style={{ color: 'var(--txt)' }}>{a.agent_name}</p>
                            <div className="mt-1 h-1 rounded-full w-24" style={{ background: 'var(--chip-bg)' }}>
                              <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: NAVY }} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-bold font-mono" style={{ color: 'var(--txt)' }}>{a.total}</td>
                      <td className="px-4 py-3 font-mono" style={{ color: GREEN }}>{a.inbound}</td>
                      <td className="px-4 py-3 font-mono" style={{ color: BLUE }}>{a.outbound}</td>
                      <td className="px-4 py-3">
                        <span className="font-semibold" style={{ color: a.resolved > 0 ? GREEN : 'var(--txt3)' }}>
                          {a.resolved}
                          {a.total > 0 && (
                            <span className="text-[11px] font-normal ml-1" style={{ color: 'var(--txt2)' }}>
                              ({Math.round((a.resolved / a.total) * 100)}%)
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono" style={{ color: 'var(--txt)' }}>{fmtDur(a.avg_duration_sec)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* ── Call Log Table ── */}
      <SectionCard title="Call Log">
        {/* Tabs + Search */}
        <div className="flex items-center gap-2 px-5 pt-3 pb-0 flex-wrap"
          style={{ borderBottom: '1px solid var(--bdr)' }}>
          <div className="flex items-center gap-1">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-semibold transition-all border-b-2"
                style={{
                  borderColor: tab === t.key ? t.color : 'transparent',
                  color: tab === t.key ? t.color : 'var(--txt2)',
                  background: 'none',
                }}
              >
                {t.label}
                <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: tab === t.key ? t.color + '1A' : 'transparent', color: tab === t.key ? t.color : 'var(--txt2)' }}>
                  {t.count}
                </span>
              </button>
            ))}
          </div>
          <div className="ml-auto relative mb-1" style={{ minWidth: 200 }}>
            <span className="material-symbols-rounded text-[15px] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--txt2)' }}>search</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search calls…"
              className="pl-8 pr-3 py-1.5 rounded-lg border text-[12px] outline-none w-full"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <span className="material-symbols-rounded text-[40px] block mb-2" style={{ color: 'var(--txt3)' }}>call_end</span>
            <p className="text-[13px] font-medium" style={{ color: 'var(--txt2)' }}>No calls found</p>
            <p className="text-[12px] mt-1" style={{ color: 'var(--txt2)' }}>Try adjusting your date range or filter</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                  {['Time', 'Direction', 'Agent', 'Customer', 'Duration', 'Outcome', 'Notes', 'Ticket'].map(h => (
                    <th key={h} style={{ background: 'var(--th-bg)', color: 'var(--txt2)', fontFamily: "'Inter', ui-sans-serif, sans-serif", fontSize: 10 }}
                      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--bdr)' }}
                    className="hover:bg-[var(--bg)] transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <p className="text-[12px] font-medium" style={{ color: 'var(--txt)' }}>
                        {new Date(c.started_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: 'var(--txt2)' }}>{relativeTime(c.started_at)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-[12px] font-semibold"
                        style={{ color: c.direction === 'inbound' ? GREEN : BLUE }}>
                        <span className="material-symbols-rounded text-[15px]">
                          {c.direction === 'inbound' ? 'call_received' : 'call_made'}
                        </span>
                        {c.direction === 'inbound' ? 'In' : 'Out'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Avatar name={c.agent_name} />
                        <span className="font-medium text-[12px]" style={{ color: 'var(--txt)' }}>{c.agent_name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium" style={{ color: 'var(--txt)' }}>{c.customer_name}</p>
                      {c.customer_phone && (
                        <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--txt2)' }}>{c.customer_phone}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono whitespace-nowrap text-[12px]" style={{ color: 'var(--txt)' }}>
                      {fmtDurShort(c.duration_sec)}
                    </td>
                    <td className="px-4 py-3"><OutcomePill outcome={c.outcome} /></td>
                    <td className="px-4 py-3 max-w-[200px]">
                      {c.notes ? (
                        <p className="text-[12px] truncate" title={c.notes} style={{ color: 'var(--txt2)' }}>{c.notes}</p>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--txt3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {c.ticket_ref ? (
                        <a href={`/helpdesk/${c.ticket_id}`}
                          className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold hover:underline"
                          style={{ color: NAVY }}>
                          <span className="material-symbols-rounded text-[13px]">confirmation_number</span>
                          {c.ticket_ref}
                        </a>
                      ) : (
                        <span style={{ color: 'var(--txt3)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="px-5 py-2.5 text-[11px]"
            style={{ borderTop: '1px solid var(--bdr)', color: 'var(--txt2)' }}>
            Showing {filtered.length} of {calls.length} calls
          </div>
        )}
      </SectionCard>

      {modal && <LogCallModal onClose={() => setModal(false)} onSaved={load} />}
    </Page>
  )
}
