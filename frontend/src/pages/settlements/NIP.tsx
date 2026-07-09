import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, FilterBar, filterInputStyle, StatusBadge, Modal, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPut, apiPost } from '../../lib/api'
import { fmtKobo, fmtKoboExact, fmtNum, fmtDate, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface NIPRow {
  id: number
  nip_ref: string
  amount_kobo: number
  value_date: string
  customer_name: string | null
  core_banking_credited: boolean
  match_status: string
  exception_type: string | null
}

// ── Status sort weight ────────────────────────────────────────────────────────

function matchWeight(status: string): number {
  const s = status.toLowerCase()
  if (s === 'exception') return 0
  if (s === 'unmatched') return 1
  return 2
}

// ── Match Status pill ─────────────────────────────────────────────────────────

function MatchStatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  let bg: string, txt: string
  if (s === 'matched') { bg = 'rgba(22,163,74,.12)'; txt = GREEN }
  else if (s === 'exception') { bg = 'rgba(192,0,0,.1)'; txt = RED }
  else { bg = 'rgba(217,119,6,.12)'; txt = AMBER }
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: bg, color: txt, whiteSpace: 'nowrap' }}>
      {status}
    </span>
  )
}

// ── Resolve Modal ─────────────────────────────────────────────────────────────

interface ResolveModalProps {
  open: boolean
  rowId: number | null
  onClose: () => void
  onSuccess: () => void
}

function ResolveModal({ open, rowId, onClose, onSuccess }: ResolveModalProps) {
  const [resolutionType, setResolutionType] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    if (!rowId || !resolutionType) return
    setSaving(true)
    try {
      await apiPut(`/api/settlements/nip/${rowId}/resolve`, { resolution_type: resolutionType, notes })
      toast.success('NIP exception resolved')
      onSuccess()
      onClose()
      setResolutionType('')
      setNotes('')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to resolve exception'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Resolve Exception"
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !resolutionType} style={{ padding: '7px 15px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving || !resolutionType ? 'not-allowed' : 'pointer', opacity: saving || !resolutionType ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Resolve'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Resolution Type</label>
          <select value={resolutionType} onChange={e => setResolutionType(e.target.value)} style={{ ...filterInputStyle, width: '100%', height: 36 }}>
            <option value="">Select resolution type…</option>
            <option value="Manual Match">Manual Match</option>
            <option value="Reversal">Reversal</option>
            <option value="Escalate to Finance">Escalate to Finance</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 6 }}>Notes</label>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add resolution notes…" rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
        </div>
      </div>
    </Modal>
  )
}

// ── KPI strip ─────────────────────────────────────────────────────────────────

function NipKpis({ rows }: { rows: NIPRow[] }) {
  const total   = rows.length
  const matched = rows.filter(r => r.match_status.toLowerCase() === 'matched').length
  const unmatched = rows.filter(r => r.match_status.toLowerCase() === 'unmatched').length
  const exceptions = rows.filter(r => r.match_status.toLowerCase() === 'exception').length
  const rate = total > 0 ? (matched / total) * 100 : 100
  const rateColor = rate >= 99 ? GREEN : rate >= 95 ? AMBER : RED

  const nipTotal = rows.reduce((s, r) => s + r.amount_kobo, 0)
  const cbTotal  = rows.filter(r => r.core_banking_credited).reduce((s, r) => s + r.amount_kobo, 0)
  const delta    = nipTotal - cbTotal
  const deltaColor = delta === 0 ? GREEN : delta < 500000 ? AMBER : RED

  // Exception aging (computed from value_date)
  const now = new Date()
  const aging = { same: 0, d1: 0, d2_7: 0, gt7: 0 }
  rows.filter(r => r.match_status.toLowerCase() === 'exception').forEach(r => {
    const days = (now.getTime() - new Date(r.value_date).getTime()) / 86400000
    if (days < 1) aging.same++
    else if (days < 2) aging.d1++
    else if (days <= 7) aging.d2_7++
    else aging.gt7++
  })

  const kpis = [
    { label: 'Total Entries', value: fmtNum(total), icon: 'receipt_long', accent: NAVY },
    { label: 'Matched', value: fmtNum(matched), icon: 'check_circle', accent: GREEN },
    { label: 'Unmatched', value: fmtNum(unmatched), icon: 'hourglass_empty', accent: AMBER },
    { label: 'Exceptions', value: fmtNum(exceptions), icon: 'warning', accent: RED },
    { label: 'Recon Rate', value: `${rate.toFixed(1)}%`, icon: 'analytics', accent: rateColor },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 11, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 7 }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)' }}>{k.label}</span>
              <div style={{ width: 24, height: 24, borderRadius: 6, background: `${k.accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13, color: k.accent }}>{k.icon}</span>
              </div>
            </div>
            <div style={{ ...NUM, fontSize: 19, fontWeight: 700, color: 'var(--txt)' }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Volume comparison + exception aging */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {/* Volume comparison */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 11, padding: '12px 14px' }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)', margin: '0 0 10px' }}>Volume Comparison</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { label: 'NIP Total', value: nipTotal, color: NAVY },
              { label: 'Core Banking Credited', value: cbTotal, color: GREEN },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: 'inline-block' }} />
                  <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{row.label}</span>
                </div>
                <span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: row.color }}>{fmtKoboExact(row.value)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)' }}>Delta (at risk)</span>
              <span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: deltaColor }}>{delta === 0 ? '₦0.00' : fmtKoboExact(delta)}</span>
            </div>
          </div>
          {/* Recon rate bar */}
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${rate}%`, background: rateColor, borderRadius: 3, transition: 'width 0.5s ease' }} />
            </div>
          </div>
        </div>

        {/* Exception aging */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 11, padding: '12px 14px' }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt)', margin: '0 0 10px' }}>Exception Aging</p>
          {exceptions === 0 ? (
            <div style={{ textAlign: 'center', padding: '10px 0', color: GREEN }}>
              <span className="material-symbols-rounded" style={{ fontSize: 24, display: 'block', marginBottom: 4 }}>check_circle</span>
              <span style={{ fontSize: 12 }}>No open exceptions</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                { label: 'Today (< 1 day)', count: aging.same, color: AMBER },
                { label: '1–2 days', count: aging.d1, color: AMBER },
                { label: '2–7 days', count: aging.d2_7, color: RED },
                { label: '> 7 days (stale)', count: aging.gt7, color: RED },
              ].map(b => b.count > 0 && (
                <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{b.label}</span>
                  <span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: b.color }}>{b.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NIPReconciliation() {
  const [rows, setRows] = useState<NIPRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateFilter, setDateFilter] = useState(today())
  const [statusFilter, setStatusFilter] = useState('')

  const [checkedIds, setCheckedIds] = useState<Set<string | number>>(new Set())
  const [resolveRow, setResolveRow] = useState<NIPRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      if (dateFilter) p.set('date', dateFilter)
      if (statusFilter) p.set('status', statusFilter)
      p.set('limit', '100')
      const res = await apiFetch<{ data: NIPRow[] }>(`/api/settlements/nip?${p.toString()}`)
      setRows(res.data ?? [])
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load NIP reconciliation data'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [dateFilter, statusFilter])

  useEffect(() => { load() }, [load])

  // Sort: Exception → Unmatched → Matched, then value_date desc within groups
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const wa = matchWeight(a.match_status)
      const wb = matchWeight(b.match_status)
      if (wa !== wb) return wa - wb
      return new Date(b.value_date).getTime() - new Date(a.value_date).getTime()
    })
  }, [rows])

  function handleExportExceptions() {
    const header = ['NIP Ref', 'Amount ₦', 'Value Date', 'Customer', 'Core Banking Credited', 'Match Status', 'Exception Type']
    const lines = sorted.map(r => [
      r.nip_ref ?? '',
      (r.amount_kobo / 100).toFixed(2),
      r.value_date ?? '',
      `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
      r.core_banking_credited ? 'Yes' : 'No',
      r.match_status ?? '',
      r.exception_type ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `nip-records-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  async function handleMarkResolved() {
    const ids = Array.from(checkedIds)
    try {
      await apiPost('/api/settlements/nip/bulk-resolve', { ids, resolution_type: 'Manual Match' })
      toast.success(`${ids.length} exception${ids.length > 1 ? 's' : ''} resolved`)
      setCheckedIds(new Set())
      load()
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Bulk resolve failed')
    }
  }

  const cols: TableCol<NIPRow>[] = [
    {
      key: 'nip_ref', label: 'NIP Ref',
      render: r => <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: '#0E2841' }}>{r.nip_ref}</span>,
    },
    {
      key: 'amount_kobo', label: 'Amount ₦', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span>,
    },
    {
      key: 'value_date', label: 'Value Date',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.value_date)}</span>,
    },
    {
      key: 'customer_name', label: 'Customer',
      render: r => <span style={{ color: 'var(--txt)' }}>{r.customer_name ?? '—'}</span>,
    },
    {
      key: 'core_banking_credited', label: 'Core Banking Credit', align: 'center',
      render: r => r.core_banking_credited
        ? <span className="material-symbols-rounded" style={{ fontSize: 18, color: GREEN }}>check_circle</span>
        : <span style={{ color: 'var(--txt3)', fontSize: 13 }}>—</span>,
    },
    {
      key: 'match_status', label: 'Match Status',
      render: r => <MatchStatusPill status={r.match_status} />,
    },
    {
      key: 'exception_type', label: 'Exception Type',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.exception_type ?? '—'}</span>,
    },
    {
      key: '_actions', label: '', sortable: false, width: 100,
      render: r => {
        const ms = r.match_status.toLowerCase()
        if (ms !== 'exception' && ms !== 'unmatched') return null
        return (
          <div style={{ display: 'flex', gap: 5 }} onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setResolveRow(r)}
              style={{ padding: '4px 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Resolve
            </button>
          </div>
        )
      },
    },
  ]

  const bulkBar = checkedIds.size > 0 ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{checkedIds.size} selected</span>
      <button onClick={handleExportExceptions} style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        Export Exceptions
      </button>
      <button onClick={handleMarkResolved} style={{ padding: '5px 12px', borderRadius: 7, border: 'none', background: '#0E2841', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
        Mark Resolved
      </button>
    </div>
  ) : undefined

  return (
    <Page title="NIP Reconciliation" subtitle="Match and resolve NIP settlement entries against core banking credits">
      <ErrBanner error={error} onRetry={load} />

      <NipKpis rows={rows} />

      <SectionCard title="NIP Entries" badge={sorted.length} padding={false} actions={<button onClick={handleExportExceptions} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setDateFilter(today()); setStatusFilter('') }}>
            <DateFilter from={dateFilter} to={dateFilter} onChange={(f) => setDateFilter(f)} />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
              <option value="">All statuses</option>
              <option value="Matched">Matched</option>
              <option value="Unmatched">Unmatched</option>
              <option value="Exception">Exception</option>
            </select>
            <button onClick={load} style={{ height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Apply</button>
          </FilterBar>
        </div>
        <DataTable
          cols={cols}
          rows={sorted}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No NIP records found"
          selectable
          selectedIds={checkedIds}
          onSelect={setCheckedIds}
          bulkBar={bulkBar}
          searchKeys={['nip_ref', 'customer_name', 'match_status', 'exception_type']}
          searchPlaceholder="Search ref, customer, status…"
          pageSize={20}
        />
      </SectionCard>

      <ResolveModal
        open={resolveRow !== null}
        rowId={resolveRow?.id ?? null}
        onClose={() => setResolveRow(null)}
        onSuccess={load}
      />
    </Page>
  )
}
