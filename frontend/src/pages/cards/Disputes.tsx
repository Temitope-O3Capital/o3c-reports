import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Dispute {
  id: number
  ref: string
  cif_number: string
  customer_name: string
  card_type: string
  amount_kobo: number
  dispute_type: string
  status: string
  filed_date: string
  days_open: number
}

// ── Status flow: Filed → Investigating → Provisional Credit → Resolved ────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  filed:               { bg: 'rgba(107,114,128,.1)', txt: 'var(--chart-lbl)' },
  investigating:       { bg: 'rgba(37,99,235,.1)',   txt: BLUE },
  provisional_credit:  { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  resolved:            { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  declined:            { bg: 'rgba(192,0,0,.1)',     txt: RED },
}

const STATUS_LABELS: Record<string, string> = {
  filed:              'Filed',
  investigating:      'Investigating',
  provisional_credit: 'Provisional Credit',
  resolved:           'Resolved',
  declined:           'Declined',
}

const DISPUTE_TYPES = ['Unauthorised Transaction', 'Double Charge', 'Wrong Amount', 'Merchant Dispute', 'ATM Dispute', 'Card Not Present']

const STATUS_FLOW = ['filed', 'investigating', 'provisional_credit', 'resolved']

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap',
    }}>{STATUS_LABELS[status] ?? status}</span>
  )
}

// ── Advance button ────────────────────────────────────────────────────────────

function AdvanceBtn({ dispute, onReload }: { dispute: Dispute; onReload: () => void }) {
  const [busy, setBusy] = useState(false)
  const idx = STATUS_FLOW.indexOf(dispute.status)
  if (idx === -1 || idx === STATUS_FLOW.length - 1) return null

  const nextStatus = STATUS_FLOW[idx + 1]

  async function advance() {
    setBusy(true)
    try {
      await apiFetch(`/api/cards/disputes/${dispute.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      })
      toast.success(`Status → ${STATUS_LABELS[nextStatus]}`)
      onReload()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button onClick={e => { e.stopPropagation(); advance() }} disabled={busy} style={{
      padding: '3px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'transparent',
      color: 'var(--txt2)', fontSize: 11.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer',
    }}>
      → {STATUS_LABELS[nextStatus]}
    </button>
  )
}

// ── New Dispute modal ─────────────────────────────────────────────────────────

function NewDisputeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    cif_number: '', customer_name: '', card_type: 'PREP', amount_kobo: '', dispute_type: DISPUTE_TYPES[0], notes: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!form.customer_name.trim()) { toast.error('Customer name required'); return }
    setSaving(true)
    try {
      await apiFetch('/api/cards/disputes', {
        method: 'POST',
        body: JSON.stringify({ ...form, amount_kobo: Number(form.amount_kobo) || 0 }),
      })
      toast.success('Dispute filed')
      onCreated()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    display: 'block' as const, width: '100%', marginTop: 6, padding: '8px 12px',
    borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)',
    fontSize: 13, color: 'var(--txt)', fontFamily: SORA, boxSizing: 'border-box' as const, outline: 'none',
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 480, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>File New Dispute</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            { label: 'Customer Name', key: 'customer_name', placeholder: 'Full name' },
            { label: 'CIF Number (optional)', key: 'cif_number', placeholder: 'e.g. CIF-00123' },
          ].map(({ label, key, placeholder }) => (
            <div key={key}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</label>
              <input value={(form as any)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} style={inputStyle} placeholder={placeholder} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Card Type</label>
              <select value={form.card_type} onChange={e => setForm(f => ({ ...f, card_type: e.target.value }))} style={inputStyle}>
                {['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Amount (kobo)</label>
              <input type="number" value={form.amount_kobo} onChange={e => setForm(f => ({ ...f, amount_kobo: e.target.value }))} style={inputStyle} placeholder="e.g. 1500000" />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Dispute Type</label>
            <select value={form.dispute_type} onChange={e => setForm(f => ({ ...f, dispute_type: e.target.value }))} style={inputStyle}>
              {DISPUTE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              style={{ ...inputStyle, resize: 'vertical' }} placeholder="Optional details…" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: INTER }}>
            {saving ? 'Filing…' : 'File Dispute'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportDisputesCsv(rows: Dispute[]) {
  const header = ['Dispute #', 'Customer', 'CIF Number', 'Card Type', 'Amount (₦)', 'Type', 'Status', 'Filed Date', 'Days Open']
  const lines = rows.map(r => [
    `"${String(r.ref ?? '').replace(/"/g, '""')}"`,
    `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    `"${String(r.cif_number ?? '').replace(/"/g, '""')}"`,
    r.card_type ?? '',
    r.amount_kobo !== undefined ? (r.amount_kobo / 100).toFixed(2) : '',
    `"${String(r.dispute_type ?? '').replace(/"/g, '""')}"`,
    r.status ?? '',
    r.filed_date ? r.filed_date.slice(0, 10) : '',
    r.days_open ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `disputes-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsDisputes() {
  const [rows,    setRows]    = useState<Dispute[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [search,  setSearch]  = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Dispute[]>('/api/cards/disputes')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const cols: TableCol<Dispute>[] = useMemo(() => [
    { key: 'ref', label: 'Dispute #',
      render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.ref}</span> },
    { key: 'customer_name', label: 'Customer',
      render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name}</span> },
    { key: 'amount_kobo', label: 'Amount', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'dispute_type', label: 'Type',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{r.dispute_type}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'filed_date', label: 'Filed', sortable: true,
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.filed_date)}</span> },
    { key: 'days_open', label: 'Days Open', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontWeight: 700, color: r.days_open > 20 ? RED : r.days_open > 10 ? AMBER : 'var(--txt)' }}>
          {r.status === 'resolved' || r.status === 'declined' ? '—' : `${r.days_open}d`}
        </span>
      ),
    },
    { key: '_actions', label: '', render: r => <AdvanceBtn dispute={r} onReload={load} /> },
  ], [load])

  const displayed = useMemo(() => rows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return r.customer_name.toLowerCase().includes(q) || r.ref.toLowerCase().includes(q)
    }
    return true
  }), [rows, search, statusFilter])

  const openCount   = rows.filter(d => d.status !== 'resolved' && d.status !== 'declined').length
  const totalAmount = rows.reduce((s, d) => s + Number(d.amount_kobo), 0)
  const openRows    = rows.filter(d => d.status !== 'resolved' && d.status !== 'declined')
  const avgDays     = openRows.length > 0 ? Math.round(openRows.reduce((s, d) => s + Number(d.days_open), 0) / openRows.length) : 0
  const resolvedCount = rows.filter(d => d.status === 'resolved').length

  return (
    <Page
      title="Disputes"
      subtitle="Card dispute tracking and resolution workflow"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
          border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          File Dispute
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Open Disputes',  value: openCount, color: AMBER },
          { label: 'Total Amount',   value: fmtKobo(totalAmount), color: 'var(--txt)' },
          { label: 'Avg Days Open',  value: `${avgDays}d`, color: avgDays > 15 ? RED : 'var(--txt)' },
          { label: 'Resolved',       value: resolvedCount, color: GREEN },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="All Disputes" badge={displayed.length} padding={false} actions={<button onClick={() => exportDisputesCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_LABELS).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} disputes</span>
        </div>
        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No disputes filed yet"
          pageSize={20}
          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={sel.size > 0 ? (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{sel.size} selected</span>
              <button onClick={() => setSel(new Set())} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: GREEN, color: 'white', cursor: 'pointer', fontSize: 12 }}>Resolve</button>
              <button onClick={() => setSel(new Set())} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: 'pointer', fontSize: 12 }}>Escalate</button>
            </>
          ) : undefined}
        />
      </SectionCard>

      <SectionCard title="Status Flow" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {STATUS_FLOW.map((s, i) => (
            <>
              <span key={s} style={{ padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, background: STATUS_COLORS[s].bg, color: STATUS_COLORS[s].txt }}>
                {STATUS_LABELS[s]}
              </span>
              {i < STATUS_FLOW.length - 1 && (
                <span key={`arr-${i}`} className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>arrow_forward</span>
              )}
            </>
          ))}
        </div>
      </SectionCard>

      {showNew && <NewDisputeModal onClose={() => setShowNew(false)} onCreated={load} />}
    </Page>
  )
}

