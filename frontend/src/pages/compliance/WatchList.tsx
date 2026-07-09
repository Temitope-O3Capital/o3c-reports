import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WatchEntry {
  id: number
  entity_name: string
  entity_type: string
  source?: string
  reason?: string
  is_active: boolean
  created_at: string
  matched_transactions_count?: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const TYPE_STYLE: Record<string, { color: string; bg: string }> = {
  PEP:      { color: RED,    bg: `${RED}12` },
  Sanction: { color: AMBER,  bg: `${AMBER}18` },
  Internal: { color: BLUE,   bg: `${BLUE}12` },
}

function TypePill({ type }: { type: string }) {
  const s = TYPE_STYLE[type] ?? TYPE_STYLE.Internal
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {type}
    </span>
  )
}

function StatusDot({ isActive }: { isActive: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600, color: isActive ? GREEN : 'var(--chart-lbl)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: isActive ? GREEN : 'var(--chart-lbl)', display: 'inline-block' }} />
      {isActive ? 'Active' : 'Inactive'}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { entity_name: '', entity_type: 'Internal', source: '', reason: '' }

export default function Watchlist() {
  const [entries, setEntries] = useState<WatchEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deactivateEntry, setDeactivateEntry] = useState<WatchEntry | null>(null)
  const [deactivating, setDeactivating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (typeFilter)   p.set('entity_type', typeFilter)
      if (statusFilter) p.set('is_active', statusFilter)
      const data = await apiFetch<WatchEntry[]>(`/api/compliance/watch-list?${p}`)
      setEntries(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [typeFilter, statusFilter])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    if (!form.entity_name) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/watch-list', form)
      toast.success('Added to watchlist')
      setAddOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleDeactivate() {
    if (!deactivateEntry) return
    setDeactivating(true)
    try {
      await apiPut(`/api/compliance/watch-list/${deactivateEntry.id}/deactivate`, {})
      toast.success('Entry deactivated')
      setDeactivateEntry(null); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setDeactivating(false) }
  }

  function exportWatchlistCsv(data: WatchEntry[]) {
    const header = ['Name', 'Type', 'Source', 'Status', 'Matched Txns', 'Added']
    const lines = data.map(r => [
      `"${String(r.entity_name ?? '').replace(/"/g, '""')}"`,
      r.entity_type ?? '',
      `"${String(r.source ?? '').replace(/"/g, '""')}"`,
      r.is_active ? 'Active' : 'Inactive',
      r.matched_transactions_count ?? 0,
      r.created_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `watchlist-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const cols: TableCol<WatchEntry>[] = [
    {
      key: 'entity_name', label: 'Name',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.entity_name}</span>,
    },
    {
      key: 'entity_type', label: 'Type',
      render: r => <TypePill type={r.entity_type} />,
    },
    {
      key: 'source', label: 'Source',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.source ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Added',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'matched_transactions_count', label: 'Matched Txns', align: 'right',
      render: r => {
        const n = r.matched_transactions_count ?? 0
        return <span style={{ ...NUM, color: n > 0 ? RED : 'var(--txt3)', fontWeight: n > 0 ? 700 : 400 }}>{n}</span>
      },
    },
    {
      key: 'is_active', label: 'Status',
      render: r => <StatusDot isActive={r.is_active} />,
    },
    {
      key: 'id', label: '',
      render: r => (
        <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
          {r.is_active && (
            <button
              onClick={() => setDeactivateEntry(r)}
              style={{ padding: '3px 10px', borderRadius: 6, border: '1.5px solid rgba(220,38,38,.3)', background: 'transparent', color: RED, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Deactivate
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <Page
      title="AML Watchlist"
      subtitle="PEP, sanctions, and internal watchlist entries"
      actions={
        <button onClick={() => { setForm(BLANK); setAddOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          Add Entry
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setTypeFilter(''); setStatusFilter('') }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Types</option>
          <option value="PEP">PEP</option>
          <option value="Sanction">Sanction</option>
          <option value="Internal">Internal</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </FilterBar>

      <SectionCard title="Watchlist Entries" badge={entries.length} padding={false} actions={
        <button onClick={() => exportWatchlistCsv(entries)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
          Export CSV
        </button>
      }>
        <DataTable<WatchEntry>
          cols={cols}
          rows={entries}
          keyFn={r => r.id}
          emptyText="No watchlist entries found."
          skeletonRows={loading ? 6 : 0}
          searchKeys={['entity_name', 'entity_type', 'source']}
          searchPlaceholder="Search entries…"
          pageSize={20}
        />
      </SectionCard>

      {/* Add modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add to Watchlist"
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAddOpen(false)}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleAdd} disabled={saving}
              style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Add Entry
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Full Name *', key: 'entity_name' as const, placeholder: 'Full name of individual or entity' },
            { label: 'Source', key: 'source' as const, placeholder: 'e.g. OFAC, UN Sanctions, Internal' },
          ].map(({ label, key, placeholder }) => (
            <div key={key}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>{label}</label>
              <input
                value={form[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box' as const }}
              />
            </div>
          ))}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Type</label>
            <select value={form.entity_type} onChange={e => setForm(f => ({ ...f, entity_type: e.target.value }))}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none' }}>
              <option value="PEP">PEP</option>
              <option value="Sanction">Sanction</option>
              <option value="Internal">Internal</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Reason</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              rows={3} placeholder="Reason for watchlisting…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const }} />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deactivateEntry}
        title="Deactivate watchlist entry?"
        body={`Remove "${deactivateEntry?.entity_name}" from the active watchlist? You can reactivate it later.`}
        confirmLabel="Deactivate"
        danger
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateEntry(null)}
      />
    </Page>
  )
}
