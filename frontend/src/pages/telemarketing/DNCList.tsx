import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'

type DNCEntry = {
  id: number
  phone: string
  reason: string | null
  added_at: string
  added_by_name: string | null
}

export default function DNCList() {
  const [entries, setEntries] = useState<DNCEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const searchRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = (q = search) => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '200' })
    if (q) params.set('search', q)
    apiFetch(`/api/telemarketing/dnc?${params}`).then(r => r.json()).then(setEntries).finally(() => setLoading(false))
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (v: string) => {
    setSearch(v)
    if (searchRef.current) clearTimeout(searchRef.current)
    searchRef.current = setTimeout(() => load(v), 300)
  }

  const addEntry = async () => {
    if (!phone.trim()) return
    setSaving(true)
    await apiFetch('/api/telemarketing/dnc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone.trim(), reason: reason || undefined }),
    })
    setSaving(false)
    setShowAdd(false)
    setPhone('')
    setReason('')
    load()
  }

  const removeEntry = async (id: number) => {
    if (!confirm('Remove this number from the DNC list?')) return
    setRemoving(id)
    await apiFetch(`/api/telemarketing/dnc/${id}`, { method: 'DELETE' })
    setRemoving(null)
    load()
  }

  const fmt = (dt: string) => new Date(dt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>Do Not Call List</h1>
        <button
          onClick={() => setShowAdd(true)}
          style={{ padding: '8px 18px', background: '#0E2841', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          + Add Number
        </button>
      </div>

      <input
        value={search}
        onChange={e => onSearch(e.target.value)}
        placeholder="Search phone number…"
        style={{ marginBottom: 16, width: 280, padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--txt)' }}
      />

      <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ background: 'var(--th-bg)' }}>
            <tr>
              {['Phone', 'Reason', 'Added By', 'Added On', ''].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>Loading…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)' }}>No DNC entries found.</td></tr>
            ) : entries.map(e => (
              <tr key={e.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                <td style={{ padding: '10px 14px', fontFamily: 'DM Mono, monospace', color: 'var(--txt)', fontWeight: 600 }}>{e.phone}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{e.reason ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{e.added_by_name ?? '—'}</td>
                <td style={{ padding: '10px 14px', color: 'var(--txt2)' }}>{fmt(e.added_at)}</td>
                <td style={{ padding: '10px 14px' }}>
                  <button
                    onClick={() => removeEntry(e.id)}
                    disabled={removing === e.id}
                    style={{ padding: '4px 10px', border: '1px solid #dc2626', borderRadius: 6, background: 'transparent', color: '#dc2626', fontSize: 11, cursor: 'pointer', opacity: removing === e.id ? 0.5 : 1 }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'var(--card)', borderRadius: 14, padding: 28, width: 380, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: 'var(--txt)' }}>Add to DNC List</h3>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Phone Number *</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 08012345678"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Reason</label>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional reason"
                style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, background: 'var(--bg)', color: 'var(--txt)', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowAdd(false)} style={{ padding: '8px 18px', border: '1px solid var(--bdr)', borderRadius: 8, background: 'var(--bg)', color: 'var(--txt)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={addEntry} disabled={!phone.trim() || saving}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', cursor: 'pointer', fontSize: 13, opacity: !phone.trim() || saving ? 0.5 : 1 }}>
                {saving ? 'Saving…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
