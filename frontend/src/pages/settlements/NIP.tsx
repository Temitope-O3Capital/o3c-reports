import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, FilterBar, filterInputStyle, StatusBadge, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { DataTable } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NUM } from '../../lib/design'
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
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Add resolution notes…" rows={4} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', resize: 'vertical', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' }} />
        </div>
      </div>
    </Modal>
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
    toast.info('Exporting exceptions…')
  }

  function handleMarkResolved() {
    toast.info('Marked as resolved')
    setCheckedIds(new Set())
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
    <Page title="NIP Reconciliation" subtitle="Match and resolve NIP settlement entries">
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="NIP Entries" badge={sorted.length} padding={false}>
        <div style={{ padding: '12px 16px 0' }}>
          <FilterBar onReset={() => { setDateFilter(today()); setStatusFilter('') }}>
            <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} style={filterInputStyle} />
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
