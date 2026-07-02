import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

type Lead = {
  id: number
  customer_name: string
  customer_phone: string | null
  employer: string | null
  lead_score: number
  status: string
  campaign_name: string | null
  last_outcome: string | null
  callback_at: string | null
  notes: string | null
  assigned_to: number | null
  agent_name: string | null
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#d97706', called: '#2563eb', converted: '#16a34a',
  no_answer: '#6b7280', callback: '#7c3aed', dnc: '#dc2626',
}

const OUTCOMES = ['interested', 'not_interested', 'callback', 'no_answer', 'voicemail', 'dnc', 'converted']

export default function OutboundQueue() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [disposing, setDisposing] = useState<number | null>(null)
  const [dispOutcome, setDispOutcome] = useState('')
  const [dispNotes, setDispNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search, s = statusFilter) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (q) params.set('search', q)
    if (s) params.set('status', s)
    apiFetch(`/api/telemarketing/leads?${params}`).then(r => r.json()).then(setLeads).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v, statusFilter), 300)
  }

  const openDispose = (id: number) => {
    setDisposing(id)
    setDispOutcome('')
    setDispNotes('')
  }

  const submitDisposition = async () => {
    if (!disposing || !dispOutcome) return
    setSaving(true)
    await apiFetch(`/api/telemarketing/leads/${disposing}/disposition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: dispOutcome, notes: dispNotes || undefined }),
    })
    setSaving(false)
    setDisposing(null)
    load()
  }

  return (
    <div style={{ padding: '24px 32px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>Outbound Queue</h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search name, phone, employer…"
          style={{ flex: 1, maxWidth: 300, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); load(search, e.target.value) }}
          style={{ padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}
        >
          <option value="">All Statuses</option>
          {['pending', 'called', 'callback', 'no_answer', 'converted', 'dnc'].map(s => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--th-bg)' }}>
            <tr>
              {['Customer', 'Phone', 'Employer', 'Score', 'Campaign', 'Last Outcome', 'Status', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
            ) : leads.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>No leads found.</td></tr>
            ) : leads.map(l => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--txt)' }}>{l.customer_name}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{l.customer_phone ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.employer ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)', fontFamily: 'DM Mono, monospace' }}>{l.lead_score}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.campaign_name ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{l.last_outcome ?? '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 99,
                    fontSize: 11, fontWeight: 600,
                    background: (STATUS_COLORS[l.status] ?? '#6b7280') + '22',
                    color: STATUS_COLORS[l.status] ?? '#6b7280',
                  }}>{l.status.replace('_', ' ')}</span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <button
                    onClick={() => openDispose(l.id)}
                    style={{ padding: '4px 12px', border: '1px solid var(--bdr)', borderRadius: 6, background: 'var(--bg)', color: 'var(--txt)', fontSize: 12, cursor: 'pointer' }}
                  >
                    Log Call
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Disposition Modal */}
      {disposing !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>Log Disposition</h3>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Outcome *</label>
              <select
                value={dispOutcome}
                onChange={e => setDispOutcome(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)' }}
              >
                <option value="">Select outcome…</option>
                {OUTCOMES.map(o => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Notes</label>
              <textarea
                value={dispNotes}
                onChange={e => setDispNotes(e.target.value)}
                rows={3}
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', resize: 'vertical', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDisposing(null)} style={{ padding: '8px 18px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg)', color: 'var(--txt)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button
                onClick={submitDisposition}
                disabled={!dispOutcome || saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: !dispOutcome || saving ? 0.5 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
