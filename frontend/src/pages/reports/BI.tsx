import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Modal, Sk, btnPrimary, btnSecondary } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, today, monthStart } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, INTER } from '../../lib/design'
import { toast } from 'sonner'
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReportResult {
  columns: string[]
  rows: Record<string, number | string>[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MODULE_METRICS: Record<string, string[]> = {
  'All Modules': ['Total Disbursements', 'NPL Ratio', 'Active Customers', 'Revenue'],
  LOS: ['Applications', 'Approvals', 'Declines', 'Avg Processing Days', 'Disbursements ₦'],
  Collections: ['Recovery Rate', 'PTPs', 'Kept PTPs', 'Avg DPD', 'Write-offs'],
  Recovery: ['Recovered ₦', 'Success Rate', 'Field Visits', 'Legal Cases'],
  Risk: ['PAR30', 'NPL Ratio', 'Avg Eye Score', 'Declined Count'],
  Finance: ['Revenue ₦', 'Expenses ₦', 'Net Income ₦', 'FD Volume'],
  Settlements: ['Settled ₦', 'Failed Count', 'NIP Exceptions'],
  HR: ['Headcount', 'Attrition Rate', 'Avg Salary ₦', 'Leave Days'],
  Compliance: ['Open Findings', 'SARs Filed', 'Watchlist Hits'],
  Cards: ['Active Cards', 'Transactions ₦', 'Open Disputes'],
  Telemarketing: ['Calls Made', 'PTPs', 'Conversion Rate'],
}

const MODULES = Object.keys(MODULE_METRICS)

const METRIC_COLORS = [NAVY, BLUE, GREEN, AMBER, RED, PURPLE, '#6D8FAF', '#F59E0B']

// ── Custom tooltip ────────────────────────────────────────────────────────────

function Tip({ active, payload, label, isKobo }: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  isKobo?: boolean
}) {
  if (!active || !payload?.length) return null
  const f = isKobo ? (v: number) => fmtKobo(v) : (v: number) => fmtNum(v)
  return (
    <div style={{ background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)' }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)', fontFamily: INTER,
          marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color ?? '#fff', flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', fontFamily: INTER }}>{f(p.value)}</span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: INTER }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ReportsBI() {
  // Config state
  const [selectedModule, setSelectedModule] = useState('All Modules')
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [granularity, setGranularity] = useState<'daily' | 'weekly' | 'monthly'>('monthly')

  // Output state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReportResult | null>(null)
  const [hasRun, setHasRun] = useState(false)

  // Modal state
  const [saveOpen, setSaveOpen] = useState(false)
  const [schedOpen, setSchedOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')
  const [schedFreq, setSchedFreq] = useState('monthly')
  const [schedRecipients, setSchedRecipients] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [schedLoading, setSchedLoading] = useState(false)

  // When module changes, clear selected metrics
  useEffect(() => {
    setSelectedMetrics([])
  }, [selectedModule])

  const availableMetrics = MODULE_METRICS[selectedModule] ?? []

  function toggleMetric(m: string) {
    setSelectedMetrics(prev =>
      prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]
    )
  }

  const runReport = useCallback(async () => {
    if (selectedMetrics.length === 0) {
      toast.error('Select at least one metric')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await apiPost<{ data: ReportResult }>('/api/reports/run', {
        module: selectedModule,
        metrics: selectedMetrics,
        date_from: dateFrom,
        date_to: dateTo,
        granularity,
      })
      setResult(res.data)
      setHasRun(true)
    } catch (e: any) {
      setError(e.message ?? 'Failed to run report')
    } finally {
      setLoading(false)
    }
  }, [selectedModule, selectedMetrics, dateFrom, dateTo, granularity])

  async function handleExport() {
    try {
      await apiPost('/api/reports/export', {
        module: selectedModule,
        metrics: selectedMetrics,
        date_from: dateFrom,
        date_to: dateTo,
        granularity,
      })
      toast.success('Export queued')
    } catch (e: any) {
      toast.error(e.message ?? 'Export failed')
    }
  }

  async function handleSave() {
    if (!saveName.trim()) { toast.error('Report name is required'); return }
    setSaveLoading(true)
    try {
      await apiPost('/api/reports/saved', {
        name: saveName,
        description: saveDesc,
        module: selectedModule,
        metrics: selectedMetrics,
        date_from: dateFrom,
        date_to: dateTo,
        granularity,
      })
      toast.success('Report saved')
      setSaveOpen(false)
      setSaveName('')
      setSaveDesc('')
    } catch (e: any) {
      toast.error(e.message ?? 'Save failed')
    } finally {
      setSaveLoading(false)
    }
  }

  async function handleSchedule() {
    if (!schedRecipients.trim()) { toast.error('Add at least one recipient'); return }
    setSchedLoading(true)
    try {
      await apiPost('/api/reports/schedules', {
        frequency: schedFreq,
        recipients: schedRecipients.split(',').map(s => s.trim()).filter(Boolean),
        module: selectedModule,
        metrics: selectedMetrics,
        date_from: dateFrom,
        date_to: dateTo,
        granularity,
      })
      toast.success('Schedule created')
      setSchedOpen(false)
      setSchedRecipients('')
    } catch (e: any) {
      toast.error(e.message ?? 'Schedule failed')
    } finally {
      setSchedLoading(false)
    }
  }

  // Build table cols from result
  const tableCols: TableCol<Record<string, number | string>>[] = result
    ? result.columns.map((col) => ({
        key: col,
        label: col,
        align: col === 'period' ? 'left' : 'right',
        render: (row) => {
          const val = row[col]
          if (col === 'period') return <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{String(val)}</span>
          if (typeof val === 'number') {
            const formatted = col.includes('₦') ? fmtKobo(val) : fmtNum(val)
            return <span style={{ fontFamily: INTER, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatted}</span>
          }
          return <span>{String(val ?? '—')}</span>
        },
      }))
    : []

  // Build chart data
  const chartData = result
    ? result.rows.map(row => {
        const obj: Record<string, string | number> = { period: String(row['period'] ?? '') }
        for (const m of selectedMetrics) {
          obj[m] = typeof row[m] === 'number' ? row[m] as number : 0
        }
        return obj
      })
    : []

  const singleMetric = selectedMetrics.length === 1
  const hasKoboMetric = selectedMetrics.some(m => m.includes('₦'))

  const inputStyle: React.CSSProperties = {
    height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)',
    borderRadius: 7, fontSize: 12.5, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', width: '100%',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase',
    letterSpacing: 0.5, fontFamily: INTER, display: 'block', marginBottom: 6,
  }

  return (
    <Page title="Reports & BI" subtitle="Cross-module report builder">
      <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 120px)', minHeight: 500 }}>

        {/* Left config panel */}
        <div style={{
          width: 300, flexShrink: 0, borderRight: '1px solid var(--bdr)',
          background: 'var(--card)', padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 20,
        }}>
          {/* Module select */}
          <div>
            <label style={labelStyle}>Module</label>
            <select
              value={selectedModule}
              onChange={e => setSelectedModule(e.target.value)}
              style={inputStyle}
            >
              {MODULES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          {/* Metrics multi-select */}
          <div>
            <label style={labelStyle}>Metrics</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {availableMetrics.map(m => {
                const checked = selectedMetrics.includes(m)
                return (
                  <label
                    key={m}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      padding: '5px 8px', borderRadius: 7,
                      background: checked ? 'rgba(14,40,65,0.06)' : 'transparent',
                    }}
                  >
                    <div
                      onClick={() => toggleMetric(m)}
                      style={{
                        width: 16, height: 16, borderRadius: 4, flexShrink: 0, cursor: 'pointer',
                        border: `1.5px solid ${checked ? NAVY : 'var(--input-bdr)'}`,
                        background: checked ? NAVY : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {checked && <span className="material-symbols-rounded" style={{ fontSize: 12, color: '#fff', lineHeight: 1 }}>check</span>}
                    </div>
                    <span style={{ fontSize: 12.5, color: checked ? 'var(--txt)' : 'var(--txt2)', fontWeight: checked ? 600 : 400 }}>{m}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Date range */}
          <div>
            <label style={labelStyle}>Date Range</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
            </div>
          </div>

          {/* Granularity */}
          <div>
            <label style={labelStyle}>Granularity</label>
            <div style={{ display: 'flex', gap: 12 }}>
              {(['daily', 'weekly', 'monthly'] as const).map(g => (
                <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12.5, color: 'var(--txt)' }}>
                  <input
                    type="radio"
                    name="granularity"
                    value={g}
                    checked={granularity === g}
                    onChange={() => setGranularity(g)}
                    style={{ accentColor: NAVY }}
                  />
                  {g.charAt(0).toUpperCase() + g.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {/* Run button */}
          <button
            onClick={runReport}
            style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }}
            disabled={loading}
          >
            {loading ? 'Running…' : 'Run Report'}
          </button>

          {/* Save & Schedule */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setSaveOpen(true)}
              style={{ ...btnSecondary, flex: 1, justifyContent: 'center', opacity: hasRun ? 1 : 0.45, cursor: hasRun ? 'pointer' : 'not-allowed' }}
              disabled={!hasRun}
            >
              Save Report
            </button>
            <button
              onClick={() => setSchedOpen(true)}
              style={{ ...btnSecondary, flex: 1, justifyContent: 'center', opacity: hasRun ? 1 : 0.45, cursor: hasRun ? 'pointer' : 'not-allowed' }}
              disabled={!hasRun}
            >
              Schedule
            </button>
          </div>
        </div>

        {/* Right output area */}
        <div style={{ flex: 1, padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ErrBanner error={error} onRetry={runReport} />

          {!hasRun && !loading && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(14,40,65,.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 28, color: 'var(--txt3)' }}>analytics</span>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)', marginBottom: 4 }}>No report yet</div>
                <div style={{ fontSize: 12.5, color: 'var(--txt2)' }}>Configure a report on the left and click Run Report</div>
              </div>
            </div>
          )}

          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => <Sk key={i} h={28} />)}
            </div>
          )}

          {!loading && hasRun && result && (
            <>
              {/* Chart */}
              <SectionCard title={`${selectedModule} — ${selectedMetrics.join(', ')}`}>
                <ResponsiveContainer width="100%" height={200}>
                  {singleMetric ? (
                    <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="biAreaGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={NAVY} stopOpacity={0.18} />
                          <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#E8EBF2" strokeDasharray="0" vertical={false} strokeWidth={1} />
                      <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }} axisLine={false} tickLine={false} />
                      <Tooltip content={(p: any) => <Tip {...p} isKobo={hasKoboMetric} />} />
                      <Area
                        type="monotone"
                        dataKey={selectedMetrics[0]}
                        stroke={NAVY}
                        strokeWidth={2.2}
                        fill="url(#biAreaGrad)"
                        dot={{ r: 3, fill: NAVY, strokeWidth: 0 }}
                        activeDot={{ r: 5, fill: NAVY, stroke: '#fff', strokeWidth: 2 }}
                        name={selectedMetrics[0]}
                      />
                    </AreaChart>
                  ) : (
                    <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <CartesianGrid stroke="#E8EBF2" strokeDasharray="0" vertical={false} strokeWidth={1} />
                      <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#9AA4B8', fontFamily: INTER }} axisLine={false} tickLine={false} />
                      <Tooltip content={(p: any) => <Tip {...p} isKobo={hasKoboMetric} />} />
                      {selectedMetrics.map((m, i) => (
                        <Line
                          key={m}
                          type="monotone"
                          dataKey={m}
                          stroke={METRIC_COLORS[i % METRIC_COLORS.length]}
                          strokeWidth={2.2}
                          dot={{ r: 3, fill: METRIC_COLORS[i % METRIC_COLORS.length], strokeWidth: 0 }}
                          activeDot={{ r: 5, stroke: '#fff', strokeWidth: 2 }}
                          name={m}
                        />
                      ))}
                    </LineChart>
                  )}
                </ResponsiveContainer>

                {/* Line legend for multi-metric */}
                {!singleMetric && (
                  <div style={{ display: 'flex', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                    {selectedMetrics.map((m, i) => (
                      <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--txt2)', fontFamily: INTER }}>
                        <div style={{ width: 16, height: 2.5, borderRadius: 2, background: METRIC_COLORS[i % METRIC_COLORS.length] }} />
                        {m}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>

              {/* Export + Table */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                  <button onClick={handleExport} style={btnSecondary}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
                    Export CSV
                  </button>
                </div>
                <SectionCard padding={false}>
                  <DataTable
                    cols={tableCols}
                    rows={result.rows}
                    keyFn={(_, i) => i}
                    emptyText="No data returned"
                  />
                </SectionCard>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Save Report Modal */}
      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save Report" width={480}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setSaveOpen(false)} style={btnSecondary}>Cancel</button>
            <button onClick={handleSave} style={btnPrimary} disabled={saveLoading}>
              {saveLoading ? 'Saving…' : 'Save Report'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ ...labelStyle, marginBottom: 6 }}>Report Name</label>
            <input
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              placeholder="e.g. Monthly Collections Summary"
              style={{ height: 36, padding: '0 12px', border: '1px solid var(--input-bdr)', borderRadius: 8, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', width: '100%', boxSizing: 'border-box', outline: 'none' }}
            />
          </div>
          <div>
            <label style={{ ...labelStyle, marginBottom: 6 }}>Description</label>
            <textarea
              value={saveDesc}
              onChange={e => setSaveDesc(e.target.value)}
              placeholder="Optional description…"
              rows={3}
              style={{ padding: '8px 12px', border: '1px solid var(--input-bdr)', borderRadius: 8, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', width: '100%', boxSizing: 'border-box', outline: 'none', resize: 'vertical', fontFamily: "'Sora', sans-serif" }}
            />
          </div>
        </div>
      </Modal>

      {/* Schedule Modal */}
      <Modal open={schedOpen} onClose={() => setSchedOpen(false)} title="Schedule Report" width={480}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setSchedOpen(false)} style={btnSecondary}>Cancel</button>
            <button onClick={handleSchedule} style={btnPrimary} disabled={schedLoading}>
              {schedLoading ? 'Scheduling…' : 'Create Schedule'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ ...labelStyle, marginBottom: 6 }}>Frequency</label>
            <select
              value={schedFreq}
              onChange={e => setSchedFreq(e.target.value)}
              style={{ height: 36, padding: '0 12px', border: '1px solid var(--input-bdr)', borderRadius: 8, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', width: '100%', boxSizing: 'border-box', outline: 'none' }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div>
            <label style={{ ...labelStyle, marginBottom: 6 }}>Recipients (comma-separated emails)</label>
            <textarea
              value={schedRecipients}
              onChange={e => setSchedRecipients(e.target.value)}
              placeholder="john@o3capital.com, jane@o3capital.com"
              rows={3}
              style={{ padding: '8px 12px', border: '1px solid var(--input-bdr)', borderRadius: 8, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', width: '100%', boxSizing: 'border-box', outline: 'none', resize: 'vertical', fontFamily: "'Sora', sans-serif" }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
