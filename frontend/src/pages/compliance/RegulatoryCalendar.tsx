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

interface CBNReport {
  id: number
  report_name: string
  regulatory_body: string
  due_date: string
  status: string
  owner_name?: string
  submitted_at?: string
  notes?: string
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function daysRemaining(due: string): number {
  return Math.ceil((new Date(due).getTime() - Date.now()) / 86_400_000)
}

function DaysRemaining({ due }: { due: string }) {
  const days = daysRemaining(due)
  if (days < 0) return <span style={{ fontSize: 12.5, fontWeight: 700, color: RED }}>{Math.abs(days)}d overdue</span>
  if (days <= 7)  return <span style={{ fontSize: 12.5, fontWeight: 700, color: AMBER }}>{days}d remaining</span>
  if (days <= 30) return <span style={{ fontSize: 12.5, fontWeight: 600, color: AMBER }}>{days}d remaining</span>
  return <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{days}d remaining</span>
}

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  pending:   { color: AMBER,  bg: `${AMBER}18`,         label: 'Upcoming' },
  submitted: { color: GREEN,  bg: 'rgba(22,163,74,.12)', label: 'Submitted' },
  overdue:   { color: RED,    bg: `${RED}12`,            label: 'Overdue' },
  signed_off:{ color: BLUE,   bg: `${BLUE}12`,           label: 'Signed Off' },
}

function StatusPill({ status, due }: { status: string; due: string }) {
  const autoStatus = daysRemaining(due) < 0 && status === 'pending' ? 'overdue' : status
  const s = STATUS_STYLE[autoStatus] ?? STATUS_STYLE.pending
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { report_name: '', regulatory_body: '', due_date: '', notes: '' }

export default function RegulatoryCalendar() {
  const [items, setItems] = useState<CBNReport[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [horizonFilter, setHorizonFilter] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [doneEntry, setDoneEntry] = useState<CBNReport | null>(null)
  const [doneing, setDoneing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<CBNReport[]>('/api/compliance/cbn-reports')
      let rows = Array.isArray(data) ? data : []
      // Client-side horizon filter
      if (horizonFilter) {
        const days = Number(horizonFilter)
        const limit = Date.now() + days * 86_400_000
        rows = rows.filter(r => new Date(r.due_date).getTime() <= limit)
      }
      if (statusFilter) {
        rows = rows.filter(r => {
          if (statusFilter === 'overdue') return daysRemaining(r.due_date) < 0 && r.status === 'pending'
          if (statusFilter === 'done') return r.status === 'submitted' || r.status === 'signed_off'
          return r.status === 'pending'
        })
      }
      // Sort by due date asc
      rows.sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
      setItems(rows)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [statusFilter, horizonFilter])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    if (!form.report_name || !form.due_date) { toast.error('Report name and due date are required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/cbn-reports', form)
      toast.success('Regulatory entry created')
      setAddOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleMarkDone() {
    if (!doneEntry) return
    setDoneing(true)
    try {
      await apiPut(`/api/compliance/cbn-reports/${doneEntry.id}/submit`, {})
      toast.success('Marked as submitted')
      setDoneEntry(null); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setDoneing(false) }
  }

  const cols: TableCol<CBNReport>[] = [
    {
      key: 'report_name', label: 'Requirement',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.report_name}</span>,
    },
    {
      key: 'regulatory_body', label: 'Regulatory Body',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.regulatory_body}</span>,
    },
    {
      key: 'due_date', label: 'Due Date',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{fmtDate(r.due_date)}</span>,
    },
    {
      key: 'owner_name', label: 'Owner',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.owner_name ?? '—'}</span>,
    },
    {
      key: 'status', label: 'Days Remaining',
      render: r => <DaysRemaining due={r.due_date} />,
    },
    {
      key: 'submitted_at', label: 'Status',
      render: r => <StatusPill status={r.status} due={r.due_date} />,
    },
    {
      key: 'id', label: '',
      render: r => r.status === 'pending' ? (
        <button
          onClick={e => { e.stopPropagation(); setDoneEntry(r) }}
          style={{ padding: '3px 10px', borderRadius: 6, border: `1.5px solid ${GREEN}40`, background: 'transparent', color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
        >
          Mark Done
        </button>
      ) : null,
    },
  ]

  return (
    <Page
      title="Regulatory Calendar"
      subtitle="CBN, NDIC, and regulatory submission deadlines"
      actions={
        <button onClick={() => { setForm(BLANK); setAddOpen(true) }} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Entry
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setStatusFilter(''); setHorizonFilter('') }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Statuses</option>
          <option value="upcoming">Upcoming</option>
          <option value="overdue">Overdue</option>
          <option value="done">Done</option>
        </select>
        <select value={horizonFilter} onChange={e => setHorizonFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Horizons</option>
          <option value="30">Next 30 days</option>
          <option value="60">Next 60 days</option>
          <option value="90">Next 90 days</option>
        </select>
      </FilterBar>

      <SectionCard title="Regulatory Requirements" badge={items.length} padding={false}>
        <DataTable<CBNReport>
          cols={cols}
          rows={items}
          keyFn={r => r.id}
          emptyText="No regulatory requirements found for the selected filters."
          skeletonRows={loading ? 5 : 0}
        />
      </SectionCard>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="New Regulatory Entry"
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
              Create
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Requirement *', key: 'report_name' as const, placeholder: 'e.g. Monthly Credit Risk Report' },
            { label: 'Regulatory Body', key: 'regulatory_body' as const, placeholder: 'e.g. CBN, NDIC, NFIU' },
          ].map(({ label, key, placeholder }) => (
            <div key={key}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>{label}</label>
              <input value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box' as const }} />
            </div>
          ))}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Due Date *</label>
            <input type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box' as const }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Additional context…"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7, fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' as const }} />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={!!doneEntry}
        title="Mark as submitted?"
        body={`Confirm that "${doneEntry?.report_name}" has been submitted to ${doneEntry?.regulatory_body ?? 'the regulator'}.`}
        confirmLabel="Mark Submitted"
        loading={doneing}
        onConfirm={handleMarkDone}
        onClose={() => setDoneEntry(null)}
      />
    </Page>
  )
}
