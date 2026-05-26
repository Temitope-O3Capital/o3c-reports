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
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl w-full max-w-md p-6 animate-fade-in"
        style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-white">Manual Sync</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Triggers an immediate MSSQL → PostgreSQL sync from the office PC
            </p>
          </div>
          <button onClick={onClose} className="btn-icon -mt-1 -mr-1">
            <span className="material-symbols-rounded text-[20px]">close</span>
          </button>
        </div>

        <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl px-4 py-3 mb-4 text-xs text-slate-500">
          The sync engine must be running on the office network at <span className="font-mono text-slate-700 dark:text-slate-300">{SYNC_URL}</span>
        </div>

        {status === 'error' && (
          <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/40 text-red-600 dark:text-red-400 text-sm rounded-xl px-4 py-3 mb-4">
            <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5">error</span>
            {msg || 'Could not reach the sync engine. Is it running?'}
          </div>
        )}

        {status === 'done' && (
          <div className="flex items-start gap-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-400 text-sm rounded-xl px-4 py-3 mb-4">
            <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5">check_circle</span>
            {msg}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-2">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button
            onClick={triggerSync}
            disabled={status === 'syncing'}
            className="btn btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {status === 'syncing' ? (
              <>
                <div className="spinner" style={{ borderTopColor: 'rgba(255,255,255,0.8)', borderColor: 'rgba(255,255,255,0.2)', width: 15, height: 15 }} />
                Syncing…
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-[16px]">sync</span>
                Start Sync
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
