import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, ExpandableFilterBar, Modal, btnPrimary, btnSecondary } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, INTER, NUM } from '../../lib/design'
import { toast } from 'sonner'

interface Submission {
  id:           number
  month:        string
  bureau:       string
  submitted_by: string | null
  submitted_at: string
  file_name:    string | null
  row_count:    number | null
  notes:        string | null
  status:       'submitted' | 'acknowledged' | 'rejected'
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  submitted:    { bg: `${AMBER}18`,  color: AMBER },
  acknowledged: { bg: `${GREEN}18`,  color: GREEN },
  rejected:     { bg: `${RED}15`,    color: RED   },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.submitted
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px',
      borderRadius: RADIUS.md, textTransform: 'capitalize', ...s }}>
      {status}
    </span>
  )
}

function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function CreditBureau() {
  const [logs,      setLogs]      = useState<Submission[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [showLog,   setShowLog]   = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [dlMonth,   setDlMonth]   = useState(currentMonth())

  const [search, setSearch]       = useState('')
  const [fBureau, setFBureau]     = useState(new Set<string>())
  const [fStatus, setFStatus]     = useState(new Set<string>())

  // Log submission form
  const [formMonth,  setFormMonth]  = useState(currentMonth())
  const [formBureau, setFormBureau] = useState('CRC')
  const [formFile,   setFormFile]   = useState('')
  const [formRows,   setFormRows]   = useState('')
  const [formNotes,  setFormNotes]  = useState('')
  const [saving,     setSaving]     = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const res = await apiFetch<any>('/api/compliance/bureau-submissions')
      setLogs(Array.isArray(res) ? res : (res?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['compliance'] })

  const download = async () => {
    if (!dlMonth) { toast.error('Select a month first'); return }
    setDownloading(true)
    try {
      const token = localStorage.getItem('o3c_token') ?? ''
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? ''}/api/compliance/credit-bureau-export?month=${dlMonth}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) { toast.error('Export failed'); return }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `credit_bureau_${dlMonth}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Downloaded credit_bureau_${dlMonth}.csv`)
    } catch (e: any) { toast.error(e.message) }
    finally { setDownloading(false) }
  }

  const logSubmission = async () => {
    if (!formMonth) { toast.error('Month is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/bureau-submissions', {
        month: formMonth, bureau: formBureau,
        file_name: formFile || null,
        row_count: formRows ? parseInt(formRows, 10) : null,
        notes: formNotes || null,
      })
      toast.success('Submission logged')
      setShowLog(false)
      setFormFile(''); setFormRows(''); setFormNotes('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const filtered = useMemo(() => logs.filter(r => {
    if (fBureau.size && !fBureau.has(r.bureau)) return false
    if (fStatus.size && !fStatus.has(r.status)) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.month, r.bureau, r.submitted_by, r.status].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [logs, fBureau, fStatus, search])

  const COLS: TableCol<Submission>[] = [
    { key: 'month',        label: 'Month',     render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{r.month}</span> },
    { key: 'bureau',       label: 'Bureau',    render: r => <span style={{ fontWeight: FW.semibold }}>{r.bureau}</span> },
    { key: 'status',       label: 'Status',    render: r => <StatusPill status={r.status} /> },
    { key: 'submitted_by', label: 'Submitted By', render: r => <span style={{ fontSize: TEXT.sm }}>{r.submitted_by ?? '—'}</span> },
    { key: 'submitted_at', label: 'Date',      render: r => <span style={{ fontSize: TEXT.sm, ...NUM }}>{fmtDatetime(r.submitted_at)}</span> },
    { key: 'row_count',    label: 'Records',   render: r => r.row_count != null
      ? <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.row_count.toLocaleString()}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span>
    },
    { key: 'file_name',    label: 'File',      render: r => r.file_name
      ? <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: 'monospace' }}>{r.file_name}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span>
    },
    { key: 'notes',        label: 'Notes',     render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.notes ?? '—'}</span> },
  ]

  const inp: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    fontFamily: INTER, width: '100%', boxSizing: 'border-box',
  }

  return (
    <Page
      title="Credit Bureau"
      subtitle="Monthly CRC / FirstCentral submission files and submission log"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setShowLog(true)} style={btnSecondary}>Log Submission</button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Download panel */}
      <SectionCard title="Generate Submission File" style={{ marginBottom: SP[5] }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: SP[3] }}>
          <div style={{ flex: '0 0 200px' }}>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Reporting Month
            </label>
            <input
              type="month"
              value={dlMonth}
              max={today().slice(0, 7)}
              onChange={e => setDlMonth(e.target.value)}
              style={inp}
            />
          </div>
          <button onClick={download} disabled={downloading} style={btnPrimary}>
            {downloading ? 'Generating…' : 'Download CSV'}
          </button>
        </div>
        <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[3] }}>
          Generates a CRC/FirstCentral-format CSV of all active and closed loan accounts for the selected month.
          After downloading, submit to the bureau and click <strong>Log Submission</strong> to record it.
        </p>
      </SectionCard>

      {/* Submission log */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Submission Log" badge={logs.length} padding={false}>
          <ExpandableFilterBar
            search={search} onSearch={setSearch}
            groups={[
              {
                key: 'bureau', label: 'Bureau',
                options: ['CRC', 'FirstCentral', 'CreditRegistry'].map(b => ({ value: b, count: logs.filter(r => r.bureau === b).length })),
                selected: fBureau, onChange: (next: Set<string>) => setFBureau(next),
              },
              {
                key: 'status', label: 'Status',
                options: [
                  { value: 'submitted',    label: 'Submitted',    color: AMBER, count: logs.filter(r => r.status === 'submitted').length },
                  { value: 'acknowledged', label: 'Acknowledged', color: GREEN, count: logs.filter(r => r.status === 'acknowledged').length },
                  { value: 'rejected',     label: 'Rejected',     color: RED,   count: logs.filter(r => r.status === 'rejected').length },
                ],
                selected: fStatus, onChange: (next: Set<string>) => setFStatus(next),
              },
            ]}
            onReset={() => { setSearch(''); setFBureau(new Set()); setFStatus(new Set()) }}
            resultCount={filtered.length} totalCount={logs.length}
            placeholder="Search by month, bureau or status…"
          />
          <DataTable
            cols={COLS}
            rows={filtered}
            keyFn={r => r.id}
            emptyText="No submissions recorded yet"
          />
        </SectionCard>
      )}

      {/* Log submission modal */}
      {showLog && (
        <Modal open title="Log Bureau Submission" onClose={() => setShowLog(false)} width={520}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                  Reporting Month *
                </label>
                <input type="month" value={formMonth} onChange={e => setFormMonth(e.target.value)} style={inp} />
              </div>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                  Bureau
                </label>
                <select value={formBureau} onChange={e => setFormBureau(e.target.value)} style={inp}>
                  <option value="CRC">CRC</option>
                  <option value="FirstCentral">FirstCentral</option>
                  <option value="CreditRegistry">CreditRegistry</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                  File Name
                </label>
                <input value={formFile} onChange={e => setFormFile(e.target.value)}
                  placeholder={`credit_bureau_${formMonth}.csv`} style={inp} />
              </div>
              <div>
                <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                  Record Count
                </label>
                <input type="number" min={0} value={formRows} onChange={e => setFormRows(e.target.value)}
                  placeholder="e.g. 1240" style={inp} />
              </div>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Notes
              </label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
                value={formNotes} onChange={e => setFormNotes(e.target.value)} rows={3}
                placeholder="Portal reference number, acknowledgement code, etc." style={{ ...inp, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLog(false)} style={btnSecondary}>Cancel</button>
              <button onClick={logSubmission} disabled={saving} style={btnPrimary}>
                {saving ? 'Saving…' : 'Log Submission'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  )
}
