import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, DataTable, ExpandableFilterBar,
  Modal, ConfirmModal, ErrBanner, Spinner, btnPrimary, DateFilter,
  NameCell, ActionRow, StatusBadge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
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
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.full, background: s.bg, color: s.color }}>
      {type}
    </span>
  )
}

function StatusDot({ isActive }: { isActive: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.sm, fontWeight: FW.semibold, color: isActive ? GREEN : 'var(--chart-lbl)' }}>
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
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [search, setSearch]   = useState('')
  const [fType, setFType]     = useState(new Set<string>())
  const [fStatus, setFStatus] = useState(new Set<string>())

  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deactivateEntry, setDeactivateEntry] = useState<WatchEntry | null>(null)
  const [deactivating, setDeactivating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('from', dateFrom)
      if (dateTo)   p.set('to', dateTo)
      const data = await apiFetch<WatchEntry[]>(`/api/compliance/watch-list?${p}`)
      setEntries(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['compliance'] })

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

  const filtered = useMemo(() => entries.filter(r => {
    if (fType.size && !fType.has(r.entity_type)) return false
    if (fStatus.size && !fStatus.has(r.is_active ? 'active' : 'inactive')) return false
    if (search) {
      const q = search.toLowerCase()
      if (![r.entity_name, r.entity_type, r.source].some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [entries, fType, fStatus, search])

  const cols: TableCol<WatchEntry>[] = [
    {
      key: 'entity_name', label: 'Entity',
      render: r => <NameCell name={r.entity_name} sub={r.entity_type ?? r.source} />,
    },
    {
      key: 'entity_type', label: 'Type',
      render: r => <TypePill type={r.entity_type} />,
    },
    {
      key: 'source', label: 'Source',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.source ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Added',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
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
      render: r => <StatusBadge status={r.is_active ? 'active' : 'inactive'} />,
    },
    {
      key: '_actions', label: '', sortable: false, width: 64,
      render: r => (
        <ActionRow actions={[
          { icon: 'visibility', label: 'View', onClick: () => {} },
          ...(r.is_active ? [{ icon: 'remove_circle', label: 'Remove', onClick: () => setDeactivateEntry(r), danger: true }] : []),
        ]} />
      ),
    },
  ]

  return (
    <Page
      title="AML Watchlist"
      subtitle="PEP, sanctions, and internal watchlist entries"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => { setForm(BLANK); setAddOpen(true) }} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            Add Entry
          </button>
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Watchlist Entries" badge={entries.length} padding={false} actions={
        <button onClick={() => exportWatchlistCsv(entries)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
          Export CSV
        </button>
      }>
        <ExpandableFilterBar
          search={search} onSearch={setSearch}
          groups={[
            {
              key: 'type', label: 'List Type',
              options: ['PEP', 'Sanction', 'Internal'].map(t => ({ value: t, color: TYPE_STYLE[t]?.color, count: entries.filter(r => r.entity_type === t).length })),
              selected: fType, onChange: (next: Set<string>) => setFType(next),
            },
            {
              key: 'status', label: 'Status',
              options: [
                { value: 'active',   label: 'Active',   color: GREEN,     count: entries.filter(r => r.is_active).length },
                { value: 'inactive', label: 'Inactive', color: '#6B7280', count: entries.filter(r => !r.is_active).length },
              ],
              selected: fStatus, onChange: (next: Set<string>) => setFStatus(next),
            },
          ]}
          onReset={() => { setSearch(''); setFType(new Set()); setFStatus(new Set()) }}
          resultCount={filtered.length} totalCount={entries.length}
          placeholder="Search entries…"
        />
        <DataTable<WatchEntry>
          cols={cols}
          rows={filtered}
          keyFn={r => r.id}
          emptyText="No watchlist entries found."
          skeletonRows={loading ? 6 : 0}
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
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>
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
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>{label}</label>
              <input
                value={form[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box' as const }}
              />
            </div>
          ))}
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Type</label>
            <select value={form.entity_type} onChange={e => setForm(f => ({ ...f, entity_type: e.target.value }))}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none' }}>
              <option value="PEP">PEP</option>
              <option value="Sanction">Sanction</option>
              <option value="Internal">Internal</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Reason</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              rows={3} placeholder="Reason for watchlisting…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const }} />
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
