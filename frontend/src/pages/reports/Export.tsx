import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Sk, btnPrimary } from '../../components/UI'
import { apiFetch, apiExport } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { INTER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExportLog {
  id: number
  dataset: string
  format: string
  created_at: string
  row_count: number
}

// ── Dataset field map ─────────────────────────────────────────────────────────

const DATASET_FIELDS: Record<string, string[]> = {
  Loans: ['Loan ID', 'CIF', 'Customer Name', 'Product', 'Principal ₦', 'Outstanding ₦', 'DPD', 'Status', 'Disbursed Date', 'Maturity Date'],
  Applications: ['App Ref', 'CIF', 'Applicant Name', 'Product', 'Amount Requested ₦', 'Status', 'Stage', 'Eye Score', 'Submitted Date'],
  Customers: ['CIF', 'Name', 'Phone', 'Email', 'BVN Status', 'KYC Status', 'Account Status', 'Created Date'],
  Collections: ['CIF', 'Outstanding ₦', 'DPD', 'Agent', 'Last Contact', 'PTP Date', 'PTP Amount ₦'],
  Payments: ['Txn Ref', 'CIF', 'Amount ₦', 'Channel', 'Status', 'Date'],
  Transactions: ['Txn Ref', 'Account', 'Amount ₦', 'Type', 'Description', 'Date'],
  Settlements: ['Batch Ref', 'Amount ₦', 'Count', 'Status', 'Date'],
  'HR Staff': ['Employee ID', 'Name', 'Department', 'Role', 'Status', 'Join Date'],
  Cards: ['Card Ref', 'CIF', 'Card Type', 'Status', 'Limit ₦', 'Balance ₦'],
}

const DATASETS = Object.keys(DATASET_FIELDS)
const FORMATS = ['CSV', 'Excel (XLSX)', 'JSON']

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFileExt(format: string): string {
  if (format === 'CSV') return 'csv'
  if (format === 'Excel (XLSX)') return 'xlsx'
  return 'json'
}

function formatApiValue(format: string): string {
  if (format === 'CSV') return 'csv'
  if (format === 'Excel (XLSX)') return 'xlsx'
  return 'json'
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DataExport() {
  const [dataset, setDataset] = useState('Loans')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [format, setFormat] = useState('CSV')
  const [checkedFields, setCheckedFields] = useState<Set<string>>(new Set(DATASET_FIELDS['Loans']))
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState(false)
  const [logs, setLogs] = useState<ExportLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // When dataset changes, pre-check all fields
  useEffect(() => {
    setCheckedFields(new Set(DATASET_FIELDS[dataset] ?? []))
  }, [dataset])

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const res = await apiFetch<{ data: ExportLog[] }>('/api/reports/export-log')
      setLogs(res.data ?? [])
    } catch {
      // Non-critical — ignore silently
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => { loadLogs() }, [loadLogs])

  function toggleField(field: string) {
    setCheckedFields(prev => {
      const next = new Set(prev)
      if (next.has(field)) { next.delete(field) } else { next.add(field) }
      return next
    })
  }

  async function handleExport() {
    if (checkedFields.size === 0) {
      toast.error('Select at least one field')
      return
    }
    setExporting(true)
    setError(null)
    try {
      const fields = Array.from(checkedFields).join(',')
      const params = new URLSearchParams({ dataset, format: formatApiValue(format), fields })
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const filename = `${dataset.toLowerCase().replace(/\s+/g, '_')}_export.${formatFileExt(format)}`
      await apiExport(`/api/reports/export?${params.toString()}`, filename)
      setExportDone(true)
      toast.success('Export downloaded')
      loadLogs()
    } catch (e: any) {
      setError(e.message ?? 'Export failed')
      toast.error('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', width: '100%',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase',
    letterSpacing: 0.5, fontFamily: INTER, display: 'block', marginBottom: 6,
  }

  const availableFields = DATASET_FIELDS[dataset] ?? []

  return (
    <Page title="Data Export" subtitle="Download data in your preferred format">
      <ErrBanner error={error} />
      <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 120px)', minHeight: 500 }}>

        {/* Left config panel */}
        <div style={{
          width: 300, flexShrink: 0, borderRight: '1px solid var(--bdr)',
          background: 'var(--card)', padding: SP[5], overflow: 'auto', display: 'flex', flexDirection: 'column', gap: SP[5],
        }}>
          {/* Dataset */}
          <div>
            <label style={labelStyle}>Dataset</label>
            <select value={dataset} onChange={e => setDataset(e.target.value)} style={inputStyle}>
              {DATASETS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          {/* Date range */}
          <div>
            <label style={labelStyle}>Date Range</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} placeholder="From" />
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} placeholder="To" />
            </div>
          </div>

          {/* Format */}
          <div>
            <label style={labelStyle}>Format</label>
            <select value={format} onChange={e => setFormat(e.target.value)} style={inputStyle}>
              {FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          {/* Fields checklist */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>Fields</label>
              <div style={{ display: 'flex', gap: SP[2] }}>
                <button
                  onClick={() => setCheckedFields(new Set(availableFields))}
                  style={{ fontSize: TEXT.xs, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: INTER }}
                >
                  All
                </button>
                <button
                  onClick={() => setCheckedFields(new Set())}
                  style={{ fontSize: TEXT.xs, color: 'var(--txt2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: INTER }}
                >
                  None
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {availableFields.map(field => {
                const checked = checkedFields.has(field)
                return (
                  <label
                    key={field}
                    style={{
                      display: 'flex', alignItems: 'center', gap: SP[2], cursor: 'pointer',
                      padding: '5px 8px', borderRadius: RADIUS.md,
                      background: checked ? 'rgba(14,40,65,.04)' : 'transparent',
                    }}
                  >
                    <div
                      onClick={() => toggleField(field)}
                      style={{
                        width: 16, height: 16, borderRadius: RADIUS.xs, flexShrink: 0, cursor: 'pointer',
                        border: `1.5px solid ${checked ? '#0E2841' : 'var(--input-bdr)'}`,
                        background: checked ? '#0E2841' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {checked && <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, color: '#fff', lineHeight: 1 }}>check</span>}
                    </div>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: checked ? 500 : 400 }}>{field}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Export button */}
          <button
            onClick={handleExport}
            style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }}
            disabled={exporting}
          >
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>

        {/* Right side */}
        <div style={{ flex: 1, padding: SP[5], overflow: 'auto', display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {!exportDone && logs.length === 0 && !logsLoading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SP[3] }}>
              <div style={{ width: 56, height: 56, borderRadius: RADIUS['2xl'], background: 'rgba(14,40,65,.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: 'var(--txt3)' }}>download</span>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: SP[1] }}>No exports yet</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Configure your export on the left</div>
              </div>
            </div>
          )}

          {(exportDone || logs.length > 0 || logsLoading) && (
            <SectionCard title="Recent Exports" subtitle="Your export history">
              {logsLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Array.from({ length: 4 }).map((_, i) => <Sk key={i} h={24} />)}
                </div>
              ) : logs.length === 0 ? (
                <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', padding: '8px 0' }}>No exports found.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {logs.map(log => (
                    <div
                      key={log.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: `${SP[2]} ${SP[3]}`,
                        borderRadius: RADIUS.md, background: 'var(--bg)', border: '1px solid var(--bdr)',
                      }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: 'var(--txt3)', flexShrink: 0 }}>description</span>
                      <span style={{ flex: 1, fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>
                        {log.dataset} · {log.format.toUpperCase()}
                      </span>
                      <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                        {log.row_count.toLocaleString()} rows
                      </span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
                        {fmtDatetime(log.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}
        </div>
      </div>
    </Page>
  )
}
