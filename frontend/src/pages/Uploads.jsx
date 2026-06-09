import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'

/* ── helpers ─────────────────────────────────────────────────────────────── */
function relTime(ts) {
  if (!ts) return '—'
  const diff = (Date.now() - new Date(ts)) / 1000
  if (diff < 60)   return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatCounts(raw) {
  if (!raw) return '—'
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(' · ')
  } catch {
    return String(raw)
  }
}

/* ── Upload zone ─────────────────────────────────────────────────────────── */
function UploadZone({ label: sectionLabel, accept, hint, endpoint, onDone }) {
  const [files,   setFiles]   = useState([])
  const [label,   setLabel]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState('')
  const inputRef = useRef()

  function onDrop(e) {
    e.preventDefault()
    setFiles(f => [...f, ...Array.from(e.dataTransfer?.files || [])])
  }

  async function upload() {
    if (!files.length) return
    setLoading(true); setError(''); setSuccess('')
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      fd.append('cycle_label', label)
      const token = localStorage.getItem('o3c_token')
      const API   = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const res   = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const counts = Object.entries(data.loaded).map(([k, v]) => `${k}: ${v}`).join(' · ')
      setSuccess(`"${data.label}" loaded — ${counts}`)
      setFiles([])
      setLabel('')
      onDone?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div
        className="border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 hover:bg-primary-50/30 transition-colors mb-4"
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <span className="material-symbols-rounded text-[36px] text-slate-300 dark:text-slate-600 block mb-2">upload_file</span>
        <p className="text-sm text-slate-500">
          {files.length > 0
            ? <span className="text-primary dark:text-primary-100 font-medium">{files.length} file{files.length > 1 ? 's' : ''} selected</span>
            : <><span className="font-medium text-slate-600 dark:text-slate-300">Click or drag files here</span><br /><span className="text-xs mt-1 block">{hint}</span></>
          }
        </p>
        <input ref={inputRef} type="file" multiple className="hidden"
          accept={accept}
          onChange={e => setFiles(f => [...f, ...Array.from(e.target.files)])} />
      </div>

      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {files.map((f, i) => (
            <span key={i} className="badge badge-grey gap-1 text-xs">
              {f.name}
              <button className="ml-0.5 hover:text-red-500"
                onClick={e => { e.stopPropagation(); setFiles(fs => fs.filter((_, j) => j !== i)) }}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="form-label">Cycle / Period Label (optional)</label>
          <input className="form-input" placeholder="e.g. May 2026" value={label}
            onChange={e => setLabel(e.target.value)} />
        </div>
        <button
          onClick={upload}
          disabled={loading || !files.length}
          className="btn btn-primary gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading
            ? <><div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'rgba(255,255,255,0.9)', borderColor: 'rgba(255,255,255,0.25)' }} /> Processing…</>
            : <><span className="material-symbols-rounded text-[17px]">upload</span> Load Files</>}
        </button>
      </div>

      {error   && <div className="mt-3 flex items-center gap-2 text-red-600 text-sm bg-red-50 dark:bg-red-900/15 border border-red-100 dark:border-red-900/30 rounded-xl px-4 py-3"><span className="material-symbols-rounded text-[16px]">error</span>{error}</div>}
      {success && <div className="mt-3 flex items-center gap-2 text-emerald-700 dark:text-emerald-400 text-sm bg-emerald-50 dark:bg-emerald-900/15 border border-emerald-100 dark:border-emerald-900/30 rounded-xl px-4 py-3"><span className="material-symbols-rounded text-[16px]">check_circle</span>{success}</div>}
    </div>
  )
}

/* ── Main page ───────────────────────────────────────────────────────────── */
export default function Uploads() {
  const [audit,       setAudit]       = useState([])
  const [auditLoad,   setAuditLoad]   = useState(true)
  const [filterType,  setFilterType]  = useState('')

  async function loadAudit() {
    setAuditLoad(true)
    try {
      const params = filterType ? `?report_type=${filterType}` : ''
      const data = await apiFetch(`/api/uploads/audit${params}`)
      setAudit(data)
    } finally {
      setAuditLoad(false)
    }
  }

  useEffect(() => { loadAudit() }, [filterType])

  const REPORT_TYPES = [
    {
      key:      'income',
      label:    'Income Cycle Files',
      icon:     'payments',
      desc:     'Upload cyc_int_rpt, cyc_chg_rpt, cyc_bal_rpt, cyc_loc_rpt and/or cust_file for a billing cycle.',
      hint:     'cyc_int_rpt · cyc_chg_rpt · cyc_bal_rpt · cyc_loc_rpt · cust_file',
      endpoint: '/api/income/upload',
      accept:   '.csv,application/octet-stream',
    },
    // Add more report types here as the platform grows
  ]

  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Data Uploads</h1>
        <p className="text-sm text-slate-500 mt-0.5">Upload source files for each report. All uploads are logged below.</p>
      </div>

      {/* Upload sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10">
        {REPORT_TYPES.map(rt => (
          <div key={rt.key} className="card p-6">
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: '#0E284112' }}>
                <span className="material-symbols-rounded text-[18px]" style={{ color: '#0E2841' }}>{rt.icon}</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{rt.label}</p>
                <p className="text-xs text-slate-400 mt-0.5">{rt.desc}</p>
              </div>
            </div>
            <UploadZone
              label={rt.label}
              accept={rt.accept}
              hint={rt.hint}
              endpoint={rt.endpoint}
              onDone={loadAudit}
            />
          </div>
        ))}
      </div>

      {/* Audit log */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700/50 flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Upload History</p>
            <p className="text-xs text-slate-400 mt-0.5">All file uploads across all report types</p>
          </div>
          <select
            className="form-input w-auto text-sm"
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
          >
            <option value="">All types</option>
            {REPORT_TYPES.map(rt => (
              <option key={rt.key} value={rt.key}>{rt.label}</option>
            ))}
          </select>
          <button onClick={loadAudit} className="btn btn-ghost btn-sm gap-1.5">
            <span className="material-symbols-rounded text-[16px]">refresh</span>
            Refresh
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Uploaded By</th>
                <th>Report</th>
                <th>Cycle / Label</th>
                <th>Files</th>
                <th>Rows Loaded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {auditLoad ? (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    <div className="flex items-center justify-center gap-2"><div className="spinner" /> Loading…</div>
                  </td>
                </tr>
              ) : audit.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12">
                    <span className="material-symbols-rounded text-[40px] text-slate-300 dark:text-slate-600 block mb-2">history</span>
                    <p className="text-sm text-slate-400">No uploads recorded yet</p>
                  </td>
                </tr>
              ) : audit.map(row => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap text-xs text-slate-500 font-mono" title={row.uploaded_at}>
                    {relTime(row.uploaded_at)}
                  </td>
                  <td>
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 leading-tight">
                      {row.uploaded_by_name || '—'}
                    </p>
                    <p className="text-[11px] text-slate-400 leading-tight">{row.uploaded_by_email || ''}</p>
                  </td>
                  <td>
                    <span className="badge badge-grey capitalize text-xs">{row.report_type}</span>
                  </td>
                  <td className="text-sm text-slate-700 dark:text-slate-300">{row.cycle_label || '—'}</td>
                  <td className="text-xs text-slate-500 max-w-[220px] truncate" title={row.file_names}>
                    {row.file_names || '—'}
                  </td>
                  <td className="text-xs text-slate-500 whitespace-nowrap">{formatCounts(row.row_counts)}</td>
                  <td>
                    <span className={`badge text-xs ${
                      row.status === 'success'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                        : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                    }`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
