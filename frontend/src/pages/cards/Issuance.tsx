import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IssuanceRequest {
  id: number
  ref: string
  cif_number: string
  customer_name: string
  card_type: string
  status: string
  submitted_date: string
  days_pending: number
}

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  pending:    { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  approved:   { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  rejected:   { bg: 'rgba(192,0,0,.1)',     txt: RED },
  processing: { bg: 'rgba(37,99,235,.1)',   txt: BLUE },
  dispatched: { bg: 'rgba(14,40,65,.1)',    txt: NAVY },
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{status}</span>
  )
}

// ── Action buttons per status ─────────────────────────────────────────────────

const NEXT_ACTIONS: Record<string, { label: string; status: string; color: string }[]> = {
  pending:    [{ label: 'Approve', status: 'approved', color: GREEN }, { label: 'Reject', status: 'rejected', color: RED }],
  approved:   [{ label: 'Processing', status: 'processing', color: BLUE }],
  processing: [{ label: 'Dispatch', status: 'dispatched', color: NAVY }],
}

function IssuanceActions({ row, onReload }: { row: IssuanceRequest; onReload: () => void }) {
  const [busy, setBusy] = useState(false)
  const actions = NEXT_ACTIONS[row.status] ?? []
  if (actions.length === 0) return null

  async function advance(status: string) {
    setBusy(true)
    try {
      await apiFetch(`/api/cards/issuance/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      toast.success(`Status → ${status}`)
      onReload()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 5 }}>
      {actions.map(a => (
        <button
          key={a.status}
          onClick={e => { e.stopPropagation(); advance(a.status) }}
          disabled={busy}
          style={{
            padding: '3px 10px', borderRadius: 6, border: 'none', cursor: busy ? 'default' : 'pointer',
            background: `${a.color}18`, color: a.color, fontSize: 11.5, fontWeight: 600,
          }}
        >{a.label}</button>
      ))}
    </div>
  )
}

// ── New Issuance modal ────────────────────────────────────────────────────────

function NewIssuanceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ cif_number: '', customer_name: '', card_type: 'PREP', notes: '' })
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!form.customer_name.trim()) { toast.error('Customer name is required'); return }
    setSaving(true)
    try {
      await apiFetch('/api/cards/issuance', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      toast.success('Issuance request submitted')
      onCreated()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 460, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>New Issuance Request</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Customer Name</label>
            <input
              value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
              style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
              placeholder="Full name"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>CIF Number (optional)</label>
            <input
              value={form.cif_number} onChange={e => setForm(f => ({ ...f, cif_number: e.target.value }))}
              style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
              placeholder="e.g. CIF-00123"
            />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Card Type</label>
            <select
              value={form.card_type} onChange={e => setForm(f => ({ ...f, card_type: e.target.value }))}
              style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none' }}
            >
              <option value="PREP">Prepaid (PREP)</option>
              <option value="Amex Naira">Amex Naira</option>
              <option value="Amex USD">Amex USD</option>
              <option value="Classic Accounts">Classic Accounts</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Notes</label>
            <textarea
              value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              style={{ display: 'block', width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box', outline: 'none', resize: 'vertical' }}
              placeholder="Optional notes…"
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: INTER }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsIssuance() {
  const [rows,    setRows]    = useState<IssuanceRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [search,  setSearch]  = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<IssuanceRequest[]>('/api/cards/issuance')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const cols: TableCol<IssuanceRequest>[] = useMemo(() => [
    { key: 'ref', label: 'Request #',
      render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.ref}</span> },
    { key: 'customer_name', label: 'Customer',
      render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name}</span> },
    { key: 'card_type', label: 'Card Type',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.card_type}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'submitted_date', label: 'Submitted', sortable: true,
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.submitted_date)}</span> },
    { key: 'days_pending', label: 'Days', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontWeight: 700, color: r.days_pending > 10 ? RED : r.days_pending > 5 ? AMBER : GREEN }}>
          {r.days_pending}d
        </span>
      ),
    },
    { key: '_actions', label: '', render: r => <IssuanceActions row={r} onReload={load} /> },
  ], [load])

  const displayed = useMemo(() => rows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return r.customer_name.toLowerCase().includes(q) || r.ref.toLowerCase().includes(q) || r.cif_number.toLowerCase().includes(q)
    }
    return true
  }), [rows, search, statusFilter])

  return (
    <Page
      title="Issuance Queue"
      subtitle="Card issuance requests and status tracking"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
          border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Issuance
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <SectionCard title="Issuance Requests" badge={displayed.length} padding={false}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_COLORS).map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} requests</span>
        </div>
        <DataTable cols={cols} rows={displayed} keyFn={r => r.id} loading={loading} emptyText="No issuance requests yet" />
      </SectionCard>

      {showNew && <NewIssuanceModal onClose={() => setShowNew(false)} onCreated={load} />}
    </Page>
  )
}
