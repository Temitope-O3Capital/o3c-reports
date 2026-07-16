import { useState, useCallback } from 'react'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, RED, AMBER, SORA, FW, RADIUS, SP, TEXT } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CBNReportData {
  period_from: string
  period_to: string
  total_complaints: number
  resolved: number
  past_sla: number
  avg_resolution_hours: number | null
  by_type: Array<{ type: string; total: number; resolved: number }>
  by_channel: Array<{ channel: string; n: number }>
}

// ── CSV export ─────────────────────────────────────────────────────────────────

function exportByTypeCsv(data: CBNReportData) {
  const total = data.by_type.reduce((s, r) => s + r.total, 0)
  const header = ['Complaint Type', 'Total', 'Resolved', 'Resolution Rate %']
  const lines = data.by_type.map(r => [
    `"${r.type.replace(/"/g, '""')}"`,
    r.total,
    r.resolved,
    total > 0 ? ((r.resolved / r.total) * 100).toFixed(1) : '0.0',
  ].join(','))
  const csv = [header.join(','), ...lines].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `cbn-report-${data.period_from}-${data.period_to}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(to.getTime() - 90 * 86400_000)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CBNReport() {
  const defaults = defaultDateRange()
  const [dateFrom, setDateFrom] = useState(defaults.from)
  const [dateTo, setDateTo] = useState(defaults.to)

  const [data, setData] = useState<CBNReportData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ from: dateFrom, to: dateTo }).toString()
      const resp = await apiFetch<CBNReportData>(`/api/helpdesk/reports/cbn-consumer-protection?${qs}`)
      setData(resp)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  const inputStyle: React.CSSProperties = {
    height: 36, padding: '0 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: SORA,
    boxSizing: 'border-box',
  }

  const totalComplaints = data?.total_complaints ?? 0
  const resolutionRate = totalComplaints > 0 ? (data!.resolved / totalComplaints) * 100 : 0
  const channelTotal = data?.by_channel.reduce((s, r) => s + r.n, 0) ?? 0

  return (
    <Page
      title="CBN Consumer Protection Report"
      subtitle="Quarterly complaint summary for regulatory submission"
      actions={
        <div style={{ display: 'flex', gap: SP[2] }}>
          {data && (
            <>
              <button
                onClick={() => exportByTypeCsv(data)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>download</span>
                Export CSV
              </button>
              <button
                onClick={() => window.print()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>print</span>
                Print
              </button>
            </>
          )}
        </div>
      }
    >
      {/* Date range controls */}
      <SectionCard title="Report Parameters">
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={inputStyle} />
          </div>
          <button
            onClick={generate}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: loading ? 'wait' : 'pointer', fontFamily: SORA, opacity: loading ? 0.7 : 1 }}
          >
            {loading && <Spinner size={14} color="#fff" />}
            Generate Report
          </button>
        </div>
      </SectionCard>

      <ErrBanner error={error} onRetry={generate} />

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spinner size={32} />
        </div>
      )}

      {!loading && data && (
        <>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 14, marginBottom: SP[5], marginTop: SP[1] }}>
            <KpiCard label="Total Complaints" value={fmtNum(data.total_complaints)} icon="inbox" accent={NAVY} />
            <KpiCard label="Resolved" value={fmtNum(data.resolved)} icon="check_circle" accent={GREEN} />
            <KpiCard label="Resolution Rate" value={`${resolutionRate.toFixed(1)}%`} icon="percent" accent={resolutionRate >= 80 ? GREEN : resolutionRate >= 60 ? AMBER : RED} />
            <KpiCard label="Avg Resolution (hrs)" value={data.avg_resolution_hours != null ? fmtNum(data.avg_resolution_hours) : '—'} icon="schedule" accent={AMBER} />
            <KpiCard label="Past SLA" value={fmtNum(data.past_sla)} icon="alarm" accent={RED} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
            {/* By Complaint Type table */}
            <SectionCard title="By Complaint Type" padding={false}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Type', 'Total', 'Resolved', 'Resolution Rate'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Type' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.by_type.length === 0 ? (
                    <tr><td colSpan={4} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No complaint data</td></tr>
                  ) : data.by_type.map((row, i) => {
                    const rate = row.total > 0 ? (row.resolved / row.total) * 100 : 0
                    return (
                      <tr key={row.type} style={{ borderTop: i > 0 ? '1px solid var(--bdr)' : 'none' }}>
                        <td style={{ padding: '9px 14px', color: 'var(--txt)', fontWeight: FW.medium }}>{row.type}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(row.total)}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: GREEN, fontWeight: FW.semibold }}>{fmtNum(row.resolved)}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: FW.bold, color: rate >= 80 ? GREEN : rate >= 60 ? AMBER : RED }}>
                          {fmtPct(rate / 100)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </SectionCard>

            {/* By Channel table */}
            <SectionCard title="By Channel" padding={false}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Channel', 'Count', '% of Total'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Channel' ? 'left' : 'right', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.by_channel.length === 0 ? (
                    <tr><td colSpan={3} style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No channel data</td></tr>
                  ) : data.by_channel.map((row, i) => {
                    const pct = channelTotal > 0 ? row.n / channelTotal : 0
                    return (
                      <tr key={row.channel} style={{ borderTop: i > 0 ? '1px solid var(--bdr)' : 'none' }}>
                        <td style={{ padding: '9px 14px', color: 'var(--txt)', fontWeight: FW.medium, textTransform: 'capitalize' }}>{row.channel}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(row.n)}</td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtPct(pct)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </SectionCard>
          </div>
        </>
      )}

      {!loading && !data && !error && (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
          Select a date range and click "Generate Report" to view the CBN compliance summary.
        </div>
      )}
    </Page>
  )
}
