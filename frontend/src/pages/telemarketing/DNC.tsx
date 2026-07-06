import { useEffect, useState, useCallback } from 'react'
import {
  Page, SectionCard, DataTable,
  ErrBanner, Modal, ConfirmModal, btnPrimary, btnDanger, DateFilter, KpiCard,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { INTER, NAVY, NUM, GREEN, AMBER, RED } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DNCEntry {
  id: number
  phone: string
  reason: string
  added_by: string
  added_at: string
}

interface DncKPIs {
  total_dnc: number
  added_this_month: number
  bulk_removes: number
}

// ── Field style ───────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TelemarketingDNC() {
  const [rows, setRows] = useState<DNCEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [kpis, setKpis] = useState<DncKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string | number>>(new Set())

  // Add modal
  const [addOpen, setAddOpen] = useState(false)
  const [addPhone, setAddPhone] = useState('')
  const [addReason, setAddReason] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)

  // Remove confirm
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [removeLoading, setRemoveLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const params = new URLSearchParams({ limit: '200' })
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    try {
      const res = await apiFetch<{ data: DNCEntry[] }>(`/api/telemarketing/dnc?${params}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load DNC list')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: DncKPIs }>('/api/telemarketing/dnc-kpis')
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [])

  async function handleAdd() {
    if (!addPhone.trim() || !addReason.trim()) return
    setAddLoading(true)
    setAddErr(null)
    try {
      await apiPost('/api/telemarketing/dnc', { phone: addPhone.trim(), reason: addReason.trim() })
      toast.success('Number added to DNC list')
      setAddPhone('')
      setAddReason('')
      setAddOpen(false)
      load()
    } catch (e: any) {
      setAddErr(e.message ?? 'Failed to add to DNC')
    } finally {
      setAddLoading(false)
    }
  }

  async function handleRemove() {
    setRemoveLoading(true)
    try {
      const phones = rows
        .filter(r => selectedIds.has(r.id))
        .map(r => r.phone)
      await apiPost('/api/telemarketing/dnc/bulk-remove', { phones })
      toast.success(`${phones.length} number(s) removed from DNC`)
      setSelectedIds(new Set())
      setRemoveConfirm(false)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to remove from DNC')
    } finally {
      setRemoveLoading(false)
    }
  }

  function exportDncCsv(data: DNCEntry[]) {
    const header = ['Phone', 'Reason', 'Added By', 'Added Date']
    const lines = data.map(r => [
      r.phone ?? '',
      `"${String(r.reason ?? '').replace(/"/g, '""')}"`,
      `"${String(r.added_by ?? '').replace(/"/g, '""')}"`,
      r.added_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `dnc-list-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<DNCEntry>[] = [
    {
      key: 'phone',
      label: 'Phone',
      sortable: true,
      render: r => (
        <span style={{ fontFamily: INTER, fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>
          {r.phone}
        </span>
      ),
    },
    {
      key: 'reason',
      label: 'Reason',
      sortable: true,
      render: r => (
        <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.reason || '—'}</span>
      ),
    },
    {
      key: 'added_by',
      label: 'Added By',
      sortable: true,
      render: r => (
        <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.added_by || '—'}</span>
      ),
    },
    {
      key: 'added_at',
      label: 'Added Date',
      sortable: true,
      render: r => (
        <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.added_at)}</span>
      ),
    },
  ]

  const bulkBar = selectedIds.size > 0 ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 14px', background: '#F0F4FF',
      borderBottom: '1px solid var(--bdr)',
    }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>
        {selectedIds.size} selected
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <button
          onClick={() => setRemoveConfirm(true)}
          style={{ ...btnDanger, padding: '4px 12px', fontSize: 12 }}
        >
          Remove from DNC
        </button>
        <button
          onClick={() => setSelectedIds(new Set())}
          style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%' }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
        </button>
      </div>
    </div>
  ) : undefined

  return (
    <Page
      title="Do Not Call List"
      subtitle="Manage numbers excluded from outbound telemarketing"
      actions={
        <button onClick={() => setAddOpen(true)} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Add to DNC
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Page-level filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 20 }}>
        <KpiCard label="Total DNC" value={kpis ? fmtNum(kpis.total_dnc) : '—'} icon="do_not_disturb_on" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Added This Month" value={kpis ? fmtNum(kpis.added_this_month) : '—'} icon="add_circle" accent={AMBER} loading={kpiLoading} />
        <KpiCard label="Bulk Removes" value={kpis ? fmtNum(kpis.bulk_removes) : '—'} icon="remove_circle" accent={RED} loading={kpiLoading} />
      </div>

      <SectionCard title="DNC Entries" badge={rows.length} padding={false} actions={<button onClick={() => exportDncCsv(rows)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No DNC entries found"
          selectable
          selectedIds={selectedIds}
          onSelect={setSelectedIds}
          bulkBar={bulkBar}
          skeletonRows={8}
          searchKeys={['phone', 'reason', 'added_by']}
          searchPlaceholder="Search phone, reason…"
          pageSize={20}
        />
      </SectionCard>

      {/* Add to DNC modal */}
      <Modal
        open={addOpen}
        onClose={() => { setAddOpen(false); setAddPhone(''); setAddReason(''); setAddErr(null) }}
        title="Add to DNC List"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setAddOpen(false); setAddPhone(''); setAddReason(''); setAddErr(null) }}
              style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={addLoading || !addPhone.trim() || !addReason.trim()}
              style={{
                ...btnPrimary,
                opacity: addLoading || !addPhone.trim() || !addReason.trim() ? 0.6 : 1,
                cursor: addLoading || !addPhone.trim() || !addReason.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {addLoading ? 'Adding…' : 'Add to DNC'}
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ErrBanner error={addErr} />
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Phone Number <span style={{ color: '#C00000' }}>*</span>
            </label>
            <input
              type="text"
              value={addPhone}
              onChange={e => setAddPhone(e.target.value)}
              placeholder="e.g. 08012345678"
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Reason <span style={{ color: '#C00000' }}>*</span>
            </label>
            <input
              type="text"
              value={addReason}
              onChange={e => setAddReason(e.target.value)}
              placeholder="e.g. Customer requested opt-out"
              style={{ ...fieldStyle, height: 36 }}
            />
          </div>
        </div>
      </Modal>

      {/* Remove confirm modal */}
      <ConfirmModal
        open={removeConfirm}
        title="Remove from DNC"
        body={`Remove ${selectedIds.size} number(s) from the DNC list? They will be eligible for outbound calls again.`}
        confirmLabel="Remove"
        danger
        loading={removeLoading}
        onConfirm={handleRemove}
        onClose={() => setRemoveConfirm(false)}
      />
    </Page>
  )
}
