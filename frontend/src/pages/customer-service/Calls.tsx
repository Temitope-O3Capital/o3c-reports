import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, ColDef, ErrBanner, Spinner,
  NAVY, RED, GREEN, AMBER,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'

/* ── Types ─────────────────────────────────────────────────────── */

interface CallLog {
  id: number
  cif_number: string
  agent_id: number
  call_type: 'inbound' | 'outbound'
  duration_seconds: number
  outcome: string
  notes: string
  status: string
  created_at: string
}

interface LogForm {
  cif_number: string
  call_type: 'inbound' | 'outbound'
  duration_minutes: string
  outcome: string
  notes: string
}

const EMPTY_FORM: LogForm = {
  cif_number: '',
  call_type: 'inbound',
  duration_minutes: '',
  outcome: 'resolved',
  notes: '',
}

/* ── Helpers ───────────────────────────────────────────────────── */

function typeBadge(t: string) {
  const inbound = t === 'inbound'
  return (
    <span
      className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded capitalize"
      style={{
        background: inbound ? 'rgba(37,99,235,0.08)' : 'rgba(217,119,6,0.1)',
        color: inbound ? '#2563EB' : AMBER,
      }}
    >
      <span className="material-symbols-rounded text-[12px] mr-1">
        {inbound ? 'call_received' : 'call_made'}
      </span>
      {t}
    </span>
  )
}

function outcomeBadge(o: string) {
  const colors: Record<string, { bg: string; color: string }> = {
    resolved:   { bg: 'rgba(5,150,105,0.08)',  color: GREEN },
    escalated:  { bg: 'rgba(192,0,0,0.08)',    color: RED },
    callback:   { bg: 'rgba(217,119,6,0.1)',   color: AMBER },
  }
  const s = colors[o?.toLowerCase()] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  return (
    <span
      className="inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded capitalize"
      style={s}
    >
      {o || '—'}
    </span>
  )
}

function fmtDuration(secs: number): string {
  if (!secs) return '—'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/* ── Component ─────────────────────────────────────────────────── */

export default function Calls() {
  const [rows, setRows] = useState<CallLog[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [cifFilter, setCifFilter] = useState('')

  // Log call modal
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<LogForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')

  const load = useCallback(async (cif = cifFilter) => {
    setLoading(true)
    setErr('')
    try {
      const params = cif ? `?cif=${encodeURIComponent(cif)}` : ''
      const res = await apiFetch<CallLog[]>(`/api/customer-service/calls${params}`)
      setRows(Array.isArray(res) ? res : [])
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [cifFilter])

  useEffect(() => { load() }, [load])

  function setF(k: keyof LogForm, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function submitLog() {
    if (!form.cif_number.trim()) { setSaveErr('CIF number is required'); return }
    setSaving(true)
    setSaveErr('')
    try {
      await apiPost('/api/customer-service/calls', {
        cif_number: form.cif_number.trim(),
        call_type: form.call_type,
        duration_seconds: form.duration_minutes ? Math.round(parseFloat(form.duration_minutes) * 60) : 0,
        outcome: form.outcome,
        notes: form.notes,
      })
      setShowModal(false)
      setForm(EMPTY_FORM)
      load()
    } catch (e: any) {
      setSaveErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  const cols: ColDef<CallLog>[] = [
    {
      key: 'cif_number', label: 'CIF Number', render: r => (
        <Link
          to={`/customer360/${r.cif_number}`}
          className="font-mono text-[12px] font-semibold hover:underline"
          style={{ color: NAVY }}
        >
          {r.cif_number || '—'}
        </Link>
      ),
    },
    {
      key: 'agent_id', label: 'Agent', render: r => (
        <span className="text-[12px] text-slate-600">{r.agent_id || '—'}</span>
      ),
    },
    {
      key: 'call_type', label: 'Type', render: r => typeBadge(r.call_type),
    },
    {
      key: 'duration_seconds', label: 'Duration', right: true, render: r => (
        <span className="font-mono text-[12px] text-slate-700">{fmtDuration(r.duration_seconds)}</span>
      ),
    },
    {
      key: 'outcome', label: 'Outcome', render: r => outcomeBadge(r.outcome),
    },
    {
      key: 'notes', label: 'Notes', render: r => (
        <span className="text-[12px] text-slate-500 max-w-[200px] block truncate" title={r.notes}>
          {r.notes || '—'}
        </span>
      ),
    },
    {
      key: 'created_at', label: 'Date', render: r => (
        <span className="text-[12px] text-slate-400 whitespace-nowrap">{fmtDate(r.created_at)}</span>
      ),
    },
    {
      key: '_c360', label: 'C360', sortable: false, render: r => r.cif_number ? (
        <Link
          to={`/customer360/${r.cif_number}`}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded"
          style={{ background: `${NAVY}10`, color: NAVY }}
        >
          <span className="material-symbols-rounded text-[13px]">person_search</span>
          C360
        </Link>
      ) : null,
    },
  ]

  return (
    <Page
      dept="Customer Service"
      title="Call Log"
      subtitle="All customer interactions"
      actions={
        <>
          <div className="flex items-center gap-2">
            <input
              value={cifFilter}
              onChange={e => setCifFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load(cifFilter)}
              placeholder="Filter by CIF…"
              className="px-3 py-1.5 rounded-lg border text-[12px] outline-none bg-white"
              style={{ borderColor: 'rgba(15,23,42,0.15)', width: 160 }}
            />
            <button
              onClick={() => load(cifFilter)}
              className="px-3 py-1.5 rounded-lg border text-[12px] font-medium bg-white"
              style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#475569' }}
            >
              Search
            </button>
          </div>
          <button
            onClick={() => { setShowModal(true); setSaveErr('') }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
            style={{ background: NAVY, color: '#fff' }}
          >
            <span className="material-symbols-rounded text-[15px]">add_call</span>
            Log New Call
          </button>
        </>
      }
    >
      <ErrBanner msg={err} />

      <SectionCard title="Interactions" badge={rows.length}>
        {loading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : (
          <DataTable<CallLog>
            cols={cols}
            rows={rows}
            emptyIcon="call_missed"
            emptyMsg="No call logs found"
          />
        )}
      </SectionCard>

      {/* ── Log Call Modal ─────────────────────────────────────────── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}
        >
          <div className="card w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold text-slate-900">Log New Call</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>

            {saveErr && <ErrBanner msg={saveErr} />}

            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold text-slate-500 mb-1">CIF Number *</label>
                <input
                  value={form.cif_number}
                  onChange={e => setF('cif_number', e.target.value)}
                  placeholder="e.g. 1234567"
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-slate-500 mb-1">Call Type</label>
                <select
                  value={form.call_type}
                  onChange={e => setF('call_type', e.target.value as 'inbound' | 'outbound')}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none bg-white"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                >
                  <option value="inbound">Inbound</option>
                  <option value="outbound">Outbound</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-slate-500 mb-1">Duration (minutes)</label>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.duration_minutes}
                  onChange={e => setF('duration_minutes', e.target.value)}
                  placeholder="e.g. 5"
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                />
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-slate-500 mb-1">Outcome</label>
                <select
                  value={form.outcome}
                  onChange={e => setF('outcome', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none bg-white"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                >
                  <option value="resolved">Resolved</option>
                  <option value="escalated">Escalated</option>
                  <option value="callback">Callback Required</option>
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-semibold text-slate-500 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setF('notes', e.target.value)}
                  placeholder="Brief summary of the interaction…"
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
                  style={{ borderColor: 'rgba(15,23,42,0.2)' }}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-lg text-[13px] font-medium border"
                style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#64748B' }}
              >
                Cancel
              </button>
              <button
                onClick={submitLog}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold disabled:opacity-60"
                style={{ background: NAVY, color: '#fff' }}
              >
                {saving
                  ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving…</>
                  : 'Log Call'
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
