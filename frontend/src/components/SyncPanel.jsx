import { useState } from 'react'

const SYNC_URL = import.meta.env.VITE_SYNC_URL || 'http://localhost:5001'

export default function SyncPanel({ onClose, onSynced }) {
  const [status, setStatus] = useState('idle')
  const [msg,    setMsg]    = useState('')

  async function triggerSync() {
    setStatus('syncing')
    setMsg('')
    try {
      const res  = await fetch(`${SYNC_URL}/sync`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
      setStatus('done')
      setMsg(data.message || 'Sync completed successfully.')
      onSynced?.(new Date().toISOString())
    } catch (e) {
      setStatus('error')
      setMsg(e.message)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-md animate-fade-in"
        style={{
          background: 'rgb(var(--bg-surface))',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid rgb(var(--border) / 0.08)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5"
          style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Manual Sync</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Triggers an immediate MSSQL → Supabase sync from the office PC
            </p>
          </div>
          <button onClick={onClose} className="btn-icon -mt-0.5 -mr-0.5">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Info */}
          <div className="flex items-start gap-3 rounded-lg px-4 py-3 text-xs"
            style={{
              background: 'rgb(var(--bg-subtle))',
              border: '1px solid rgb(var(--border) / 0.06)',
              color: 'rgb(var(--fg-2))',
            }}>
            <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5 text-slate-400">info</span>
            <span>
              The sync engine must be running on the office network at{' '}
              <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{SYNC_URL}</span>
            </span>
          </div>

          {/* Status messages */}
          {status === 'error' && (
            <div className="flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm"
              style={{
                background: 'rgb(239 68 68 / 0.06)',
                border: '1px solid rgb(239 68 68 / 0.15)',
                color: '#DC2626',
              }}>
              <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5">error</span>
              {msg || 'Could not reach the sync engine. Is it running?'}
            </div>
          )}

          {status === 'done' && (
            <div className="flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm"
              style={{
                background: 'rgb(16 185 129 / 0.06)',
                border: '1px solid rgb(16 185 129 / 0.15)',
                color: '#059669',
              }}>
              <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5">check_circle</span>
              {msg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-3 px-6 py-4 rounded-b-xl"
          style={{
            borderTop: '1px solid rgb(var(--border) / 0.08)',
            background: 'rgb(var(--bg-subtle))',
          }}
        >
          <button onClick={onClose} className="btn btn-ghost text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={triggerSync}
            disabled={status === 'syncing'}
            className="btn btn-primary gap-2 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {status === 'syncing' ? (
              <>
                <div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} />
                Syncing…
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-[16px]">sync</span>
                {status === 'done' ? 'Sync Again' : 'Start Sync'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
