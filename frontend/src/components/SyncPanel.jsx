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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary dark:text-primary-100">sync</span>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Manual Sync</h2>
          </div>
          <button onClick={onClose} className="icon-btn">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
          Triggers an immediate MSSQL → Railway PostgreSQL sync from the office PC.
          The sync engine must be running on the office network.
        </p>

        {status === 'error' && (
          <div className="flex items-start gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
            <span className="material-symbols-outlined text-[18px] flex-shrink-0 mt-0.5">error</span>
            {msg || 'Could not reach the sync engine. Is it running?'}
          </div>
        )}

        {status === 'done' && (
          <div className="flex items-start gap-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-sm rounded-lg px-4 py-3 mb-4">
            <span className="material-symbols-outlined text-[18px] flex-shrink-0 mt-0.5">check_circle</span>
            {msg}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={triggerSync}
            disabled={status === 'syncing'}
            className="flex items-center gap-2 px-5 py-2 text-sm font-semibold bg-primary hover:bg-primary-light text-white rounded-lg transition-colors disabled:opacity-60"
          >
            {status === 'syncing' ? (
              <><div className="spinner !w-4 !h-4 !border-white/30 !border-t-white" /> Syncing…</>
            ) : (
              <><span className="material-symbols-outlined text-[18px]">sync</span> Start Sync</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
