import { useState } from 'react'

const SYNC_URL = import.meta.env.VITE_SYNC_URL || 'http://localhost:5001'

export default function SyncPanel({ onClose, onSynced }) {
  const [status, setStatus] = useState('idle') // idle | syncing | done | error
  const [msg, setMsg]       = useState('')

  async function triggerSync() {
    setStatus('syncing')
    setMsg('')
    try {
      const res = await fetch(`${SYNC_URL}/sync`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setStatus('done')
      setMsg(data.message || 'Sync completed successfully.')
      onSynced && onSynced(new Date().toISOString())
    } catch (e) {
      setStatus('error')
      setMsg(e.message)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="modal-title">Manual Sync</div>
        <div className="modal-body">
          This will trigger an immediate MSSQL → Supabase sync from the office PC.
          The sync engine must be running on the office network for this to work.
        </div>

        {status === 'error' && (
          <div className="error-msg" style={{ marginBottom: 16 }}>
            {msg || 'Could not reach the sync engine. Is it running?'}
          </div>
        )}
        {status === 'done' && (
          <div style={{ background: '#DCFCE7', color: '#166534', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 16 }}>
            {msg}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-navy"
            onClick={triggerSync}
            disabled={status === 'syncing'}
          >
            {status === 'syncing' ? <><div className="spinner" style={{ width:14, height:14, borderWidth:2 }} /> Syncing…</> : '↻ Start Sync'}
          </button>
        </div>
      </div>
    </div>
  )
}
