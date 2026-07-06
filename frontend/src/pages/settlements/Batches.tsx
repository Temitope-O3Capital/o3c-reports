import React, { useEffect, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, ErrBanner, FilterBar, filterInputStyle, StatusBadge, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime, fmtNum, today, monthStart } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Batch {
  id: number
  batch_ref: string
  batch_date: string
  txn_count: number
  total_amount_kobo: number
  status: string
  generated_by: string | null
}

interface BatchTxn {
  id: number
  txn_ref: string
  amount_kobo: number
  customer_name: string | null
  status: string
  created_at: string
}

interface KPIs {
  settled_today_kobo: number
  pending_kobo: number
  failed_count: number
  success_rate_pct: number
}

// ── Status pill for batch ─────────────────────────────────────────────────────

function BatchStatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  let bg: string, txt: string
  if (s === 'settled') { bg = 'rgba(22,163,74,.12)'; txt = GREEN }
  else if (s === 'failed') { bg = 'rgba(192,0,0,.1)'; txt = RED }
  else { bg = 'rgba(217,119,6,.12)'; txt = AMBER }
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: bg, color: txt, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

// ── Table base styles ─────────────────────────────────────────────────────────

const tdBase: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 13,
  color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)',
  verticalAlign: 'middle',
}

const thBase: React.CSSProperties = {
  padding: '10px 14px',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--txt2)',
  textAlign: 'left',
  borderBottom: '1px solid var(--bdr)',
  whiteSpace: 'nowrap',
}

// ── Sub-table for expanded batch transactions ─────────────────────────────────

function BatchTxnTable({ txns }: { txns: BatchTxn[] }) {
  if (!txns.length) {
    return <div style={{ fontSize: 13, color: 'var(--txt2)', padding: '12px 0' }}>No transactions in this batch.</div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
      <thead>
        <tr style={{ background: 'var(--th-bg)' }}>
          <th style={thBase}>Txn Ref</th>
          <th style={{ ...thBase, textAlign: 'right' }}>Amount ₦</th>
          <th style={thBase}>Customer</th>
          <th style={thBase}>Status</th>
          <th style={thBase}>Timestamp</th>
        </tr>
      </thead>
      <tbody>
        {txns.map(t => (
          <tr key={t.id} style={{ background: 'var(--card)' }}>
            <td style={tdBase}><span style={{ ...NUM, fontSize: 12, color: NAVY, fontWeight: 600 }}>{t.txn_ref}</span></td>
            <td style={{ ...tdBase, textAlign: 'right' }}><span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(t.amount_kobo)}</span></td>
            <td style={tdBase}><span style={{ color: 'var(--txt)' }}>{t.customer_name ?? '—'}</span></td>
            <td style={tdBase}><StatusBadge status={t.status} size="sm" /></td>
            <td style={tdBase}><span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(t.created_at)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettlementBatches() {
  const [kpis, setKpis] = useState<KPIs | null>(null)
  const [rows, setRows] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedData, setExpandedData] = useState<Record<number, BatchTxn[] | 'loading'>>({})
  const [hoveredId, setHoveredId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (statusFilter) p.set('status', statusFilter)
      p.set('date_from', dateFrom)
      p.set('date_to', dateTo)
      p.set('limit', '100')
      const [kpisRes, batchesRes] = await Promise.all([
        apiFetch<{ data: KPIs }>('/api/settlements/kpis'),
        apiFetch<{ data: Batch[] }>(`/api/settlements?${p.toString()}`),
      ])
      setKpis(kpisRes.data)
      // Sort: date desc default
      const sorted = [...(batchesRes.data ?? [])].sort((a, b) =>
        new Date(b.batch_date).getTime() - new Date(a.batch_date).getTime()
      )
      setRows(sorted)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load settlement batches'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function toggleExpand(id: number) {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (expandedData[id]) return
    setExpandedData(prev => ({ ...prev, [id]: 'loading' }))
    try {
      const res = await apiFetch<{ data: BatchTxn[] }>(`/api/settlements/${id}/transactions`)
      setExpandedData(prev => ({ ...prev, [id]: res.data ?? [] }))
    } catch {
      setExpandedData(prev => ({ ...prev, [id]: [] }))
    }
  }

  function handleReset() {
    setStatusFilter('')
    setDateFrom(monthStart())
    setDateTo(today())
  }

  const kpiLoading = loading && !kpis

  return (
    <Page title="Settlement Batches" subtitle="Review and track settlement batch activity">
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Settled Today ₦" value={fmtKobo(kpis?.settled_today_kobo)} icon="check_circle" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Pending ₦" value={fmtKobo(kpis?.pending_kobo)} icon="hourglass_empty" accent={AMBER} loading={kpiLoading} />
        <KpiCard label="Failed Count" value={fmtNum(kpis?.failed_count)} icon="cancel" accent={RED} loading={kpiLoading} />
        <KpiCard label="Success Rate" value={kpis ? `${Number(kpis.success_rate_pct).toFixed(1)}%` : '—'} icon="trending_up" accent={NAVY} loading={kpiLoading} />
      </div>

      <SectionCard title="Batches" badge={rows.length} padding={false}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={handleReset}>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All statuses</option>
              <option value="Pending">Pending</option>
              <option value="Settled">Settled</option>
              <option value="Failed">Failed</option>
            </select>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
            <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
          </FilterBar>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>No batches found</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                <th style={thBase}>Batch Ref</th>
                <th style={thBase}>Date</th>
                <th style={{ ...thBase, textAlign: 'right' }}>Txn Count</th>
                <th style={{ ...thBase, textAlign: 'right' }}>Total Amount ₦</th>
                <th style={thBase}>Status</th>
                <th style={thBase}>Generated By</th>
                <th style={{ ...thBase, width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <React.Fragment key={row.id}>
                  <tr
                    onClick={() => toggleExpand(row.id)}
                    onMouseEnter={() => setHoveredId(row.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      cursor: 'pointer',
                      background: hoveredId === row.id ? 'var(--row-hvr)' : expandedId === row.id ? 'var(--th-bg)' : 'transparent',
                      transition: 'background 120ms',
                    }}
                  >
                    <td style={tdBase}><span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: NAVY }}>{row.batch_ref}</span></td>
                    <td style={tdBase}><span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(row.batch_date)}</span></td>
                    <td style={{ ...tdBase, textAlign: 'right' }}><span style={{ ...NUM }}>{fmtNum(row.txn_count)}</span></td>
                    <td style={{ ...tdBase, textAlign: 'right' }}><span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(row.total_amount_kobo)}</span></td>
                    <td style={tdBase}><BatchStatusPill status={row.status} /></td>
                    <td style={tdBase}><span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{row.generated_by ?? '—'}</span></td>
                    <td style={{ ...tdBase, textAlign: 'right' }}>
                      <span
                        className="material-symbols-rounded"
                        style={{ fontSize: 16, color: 'var(--txt2)', transition: 'transform .2s', transform: expandedId === row.id ? 'rotate(90deg)' : 'none', display: 'inline-block' }}
                      >
                        chevron_right
                      </span>
                    </td>
                  </tr>
                  {expandedId === row.id && (
                    <tr key={`${row.id}-exp`}>
                      <td colSpan={7} style={{ padding: '0 24px 16px', background: 'var(--th-bg)' }}>
                        {expandedData[row.id] === 'loading' ? (
                          <div style={{ padding: '16px 0', fontSize: 13, color: 'var(--txt2)' }}>Loading transactions…</div>
                        ) : Array.isArray(expandedData[row.id]) ? (
                          <BatchTxnTable txns={expandedData[row.id] as BatchTxn[]} />
                        ) : null}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </Page>
  )
}
