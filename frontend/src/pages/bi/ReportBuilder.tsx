import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, INTER, MONO } from '../../lib/design'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { toast } from 'sonner'

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULES = ['LOS', 'Collections', 'CRM', 'Finance', 'HR', 'Helpdesk', 'Campaigns', 'Compliance']

const DATE_RANGES = [
  { value: 'today',         label: 'Today' },
  { value: 'last_7_days',   label: 'Last 7 Days' },
  { value: 'last_30_days',  label: 'Last 30 Days' },
  { value: 'this_month',    label: 'This Month' },
  { value: 'last_3_months', label: 'Last 3 Months' },
  { value: 'this_year',     label: 'This Year' },
]

const MODULE_METRICS: Record<string, string[]> = {
  LOS:         ['applications', 'approvals', 'disbursement_kobo'],
  Collections: ['accounts', 'outstanding_kobo'],
  CRM:         ['count', 'value_kobo'],
  Finance:     ['count', 'amount_kobo'],
  HR:          ['headcount'],
  Helpdesk:    ['tickets', 'avg_csat'],
  Campaigns:   ['campaigns', 'sent', 'opened', 'clicked'],
  Compliance:  ['findings', 'closed'],
}

const MODULE_DIMS: Record<string, string> = {
  LOS:         'Stage',
  Collections: 'DPD Bucket',
  CRM:         'Deal Stage',
  Finance:     'Transaction Type',
  HR:          'Department',
  Helpdesk:    'Status',
  Campaigns:   'Campaign Type',
  Compliance:  'Severity',
}

const KOBO_METRICS = new Set(['disbursement_kobo', 'outstanding_kobo', 'value_kobo', 'amount_kobo'])

type Row = Record<string, string | number>

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewTable({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return (
    <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: 13 }}>No results for selected range</div>
  )
  const cols = Object.keys(rows[0])
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '8px 12px', background: 'var(--th-bg)',
                fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--txt2)',
                borderBottom: '1px solid var(--bdr)' }}>
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }} className="tr-hvr">
              {cols.map(c => {
                const v = row[c]
                const isKobo = KOBO_METRICS.has(c)
                const isNum = typeof v === 'number'
                return (
                  <td key={c} style={{ padding: '8px 12px', textAlign: isNum ? 'right' : 'left',
                    fontFamily: isNum ? MONO : undefined }}>
                    {isKobo ? fmtKobo(Number(v)) : isNum ? fmtNum(Number(v)) : String(v ?? '—')}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && (
        <div style={{ textAlign: 'center', padding: 12, fontSize: 12, color: 'var(--txt3)' }}>
          Showing 100 of {rows.length} rows — export CSV for full data
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ReportBuilder() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()

  const [name,       setName]       = useState('')
  const [description, setDesc]      = useState('')
  const [module,     setModule]     = useState('LOS')
  const [dateRange,  setDateRange]  = useState('last_30_days')
  const [isPublic,   setIsPublic]   = useState(false)
  const [fromDate,   setFromDate]   = useState('')
  const [toDate,     setToDate]     = useState('')

  const [preview,    setPreview]    = useState<Row[] | null>(null)
  const [running,    setRunning]    = useState(false)
  const [saving,     setSaving]     = useState(false)
  const [loading,    setLoading]    = useState(!!id)
  const [error,      setError]      = useState<string | null>(null)

  // Load existing report if editing
  useEffect(() => {
    if (!id) return
    apiFetch<any>('/api/bi/reports').then(list => {
      const found = (list ?? []).find((r: any) => String(r.id) === id)
      if (found) {
        setName(found.name ?? '')
        setDesc(found.description ?? '')
        setModule(found.module ?? 'LOS')
        setDateRange(found.date_range ?? 'last_30_days')
        setIsPublic(found.is_public ?? false)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [id])

  const runPreview = useCallback(async () => {
    if (!id) { toast.error('Save the report first, then run a preview'); return }
    setRunning(true); setError(null)
    try {
      const qs = new URLSearchParams()
      if (fromDate) qs.set('from', fromDate)
      if (toDate)   qs.set('to', toDate)
      const res = await apiFetch<{ rows: Row[] }>(`/api/bi/reports/${id}/run?${qs}`, { method: 'POST', body: '{}' })
      setPreview(res?.rows ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setRunning(false) }
  }, [id, fromDate, toDate])

  const save = async () => {
    if (!name.trim()) { toast.error('Report name is required'); return }
    setSaving(true)
    try {
      const payload = { name: name.trim(), description, module, date_range: dateRange, is_public: isPublic, dimensions: [], metrics: MODULE_METRICS[module] ?? [], filters: {} }
      if (id) {
        await apiFetch(`/api/bi/reports/${id}`, { method: 'PUT', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })
        toast.success('Report updated')
      } else {
        const created = await apiPost<{ id: number }>('/api/bi/reports', payload)
        toast.success('Report saved')
        navigate(`/bi/builder/${created.id}`, { replace: true })
      }
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inpStyle: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
  }

  if (loading) return (
    <Page title="Report Builder"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>
  )

  const metrics = MODULE_METRICS[module] ?? []
  const dimLabel = MODULE_DIMS[module] ?? 'Dimension'

  return (
    <Page
      title={id ? 'Edit Report' : 'New Report'}
      subtitle="Define module, date range, and metrics — then preview and save"
      back={{ label: 'All Reports', to: '/bi' }}
    >
      <ErrBanner error={error} onRetry={() => setError(null)} />

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20, alignItems: 'start' }}>
        {/* ── Config panel ── */}
        <SectionCard title="Report Configuration">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Report Name *
              </label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="e.g. Monthly LOS Summary" style={{ ...inpStyle, width: '100%', boxSizing: 'border-box' }} />
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Description
              </label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={description} onChange={e => setDesc(e.target.value)} rows={2}
                placeholder="Optional description" style={{ ...inpStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Module *
              </label>
              <select value={module} onChange={e => setModule(e.target.value)}
                style={{ ...inpStyle, width: '100%', boxSizing: 'border-box' }}>
                {MODULES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
                Default Date Range
              </label>
              <select value={dateRange} onChange={e => setDateRange(e.target.value)}
                style={{ ...inpStyle, width: '100%', boxSizing: 'border-box' }}>
                {DATE_RANGES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>

            {/* Metrics preview */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 8 }}>
                Metrics (auto for module)
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                  background: `${NAVY}12`, color: NAVY }}>date</span>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                  background: `${BLUE}12`, color: BLUE }}>{dimLabel}</span>
                {metrics.map(m => (
                  <span key={m} style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
                    background: `${GREEN}12`, color: GREEN }}>
                    {m.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: NAVY }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>Make public to all users</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
              <button onClick={() => navigate('/bi')} style={{ ...btnSecondary, flex: 1, justifyContent: 'center' }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ ...btnPrimary, flex: 1, justifyContent: 'center' }}>
                {saving ? 'Saving…' : id ? 'Update' : 'Save Report'}
              </button>
            </div>
          </div>
        </SectionCard>

        {/* ── Preview panel ── */}
        <div>
          <SectionCard title="Preview" actions={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                style={{ ...inpStyle, padding: '5px 8px', fontSize: 12 }} />
              <span style={{ fontSize: 12, color: 'var(--txt3)' }}>→</span>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                style={{ ...inpStyle, padding: '5px 8px', fontSize: 12 }} />
              <button onClick={runPreview} disabled={running || !id} style={{ ...btnPrimary, padding: '6px 14px', fontSize: 12 }}>
                {running ? 'Running…' : 'Run Preview'}
              </button>
              {id && (
                <button onClick={() => window.open(`/api/bi/reports/${id}/export`, '_blank')}
                  style={{ ...btnSecondary, padding: '6px 14px', fontSize: 12 }}>
                  Export CSV
                </button>
              )}
            </div>
          }>
            {!id ? (
              <div style={{ textAlign: 'center', padding: 48, color: 'var(--txt3)', fontSize: 13 }}>
                Save the report first to run a preview.
              </div>
            ) : running ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spinner size={28} /></div>
            ) : preview ? (
              <>
                <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--txt3)', ...NUM }}>
                  {preview.length} row{preview.length !== 1 ? 's' : ''}
                </div>
                <PreviewTable rows={preview} />
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: 48, color: 'var(--txt3)', fontSize: 13 }}>
                Click "Run Preview" to see data for this report.
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </Page>
  )
}
