import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, SearchInput } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct } from '../../lib/fmt'
import { RED, GREEN, AMBER, BLUE, NAVY, INTER, SORA, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CreditReview {
  id: number
  ref: string
  cif_number: string
  customer_name: string
  card_type: string
  current_limit_kobo: number
  proposed_limit_kobo: number
  utilization_pct: number
  eye_score: number
  status: string
  recommended_by: string
  submitted_date: string
}

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  pending_review: { bg: 'rgba(107,114,128,.1)', txt: 'var(--chart-lbl)' },
  recommended:    { bg: 'rgba(37,99,235,.1)',   txt: BLUE },
  approved:       { bg: 'rgba(22,163,74,.1)',   txt: GREEN },
  declined:       { bg: 'rgba(192,0,0,.1)',     txt: RED },
}

const STATUS_LABELS: Record<string, string> = {
  pending_review: 'Pending Review',
  recommended:    'Recommended',
  approved:       'Approved',
  declined:       'Declined',
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: c.bg, color: c.txt, whiteSpace: 'nowrap',
    }}>{STATUS_LABELS[status] ?? status}</span>
  )
}

function EyeScoreBar({ score }: { score: number }) {
  const color = score >= 700 ? GREEN : score >= 550 ? AMBER : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{ width: 52, height: 5, borderRadius: 3, background: 'var(--bdr)', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(100, (score / 850) * 100)}%`, height: '100%', borderRadius: 3, background: color }} />
      </div>
      <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color }}>{score}</span>
    </div>
  )
}

// ── Decision actions ──────────────────────────────────────────────────────────

function ReviewActions({ review, onReload }: { review: CreditReview; onReload: () => void }) {
  const [busy, setBusy] = useState(false)

  async function decide(decision: string) {
    setBusy(true)
    try {
      await apiFetch(`/api/cards/credit-limits/${review.id}/decide`, {
        method: 'PATCH',
        body: JSON.stringify({ decision }),
      })
      toast.success(`Credit limit ${decision}`)
      onReload()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  if (review.status === 'pending_review') {
    return (
      <button onClick={e => { e.stopPropagation(); decide('recommended') }} disabled={busy}
        style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'rgba(37,99,235,.1)', color: BLUE, fontSize: 11.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
        Recommend
      </button>
    )
  }
  if (review.status === 'recommended') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={e => { e.stopPropagation(); decide('approved') }} disabled={busy}
          style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'rgba(22,163,74,.1)', color: GREEN, fontSize: 11.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
          Approve
        </button>
        <button onClick={e => { e.stopPropagation(); decide('declined') }} disabled={busy}
          style={{ padding: '3px 10px', borderRadius: 6, border: 'none', background: 'rgba(192,0,0,.07)', color: RED, fontSize: 11.5, fontWeight: 600, cursor: busy ? 'default' : 'pointer' }}>
          Decline
        </button>
      </div>
    )
  }
  return null
}

// ── New Credit Limit Review modal ─────────────────────────────────────────────

function NewReviewModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    cif_number: '', customer_name: '', card_type: 'Amex Naira',
    current_limit_kobo: '', proposed_limit_kobo: '',
    utilization_pct: '', eye_score: '', notes: '',
  })
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!form.customer_name.trim()) { toast.error('Customer name required'); return }
    setSaving(true)
    try {
      await apiFetch('/api/cards/credit-limits', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          current_limit_kobo:  Number(form.current_limit_kobo)  || 0,
          proposed_limit_kobo: Number(form.proposed_limit_kobo) || 0,
          utilization_pct:     Number(form.utilization_pct)     || 0,
          eye_score:           Number(form.eye_score)           || 0,
        }),
      })
      toast.success('Review submitted')
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
      <div style={{ background: 'var(--card)', borderRadius: 16, width: 500, padding: 28, boxShadow: '0 20px 60px rgba(0,0,0,.25)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--txt)' }}>Submit Credit Limit Review</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)' }}>
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Customer Name</label>
            <input value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} style={inputStyle} placeholder="Full name" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>CIF (optional)</label>
              <input value={form.cif_number} onChange={e => setForm(f => ({ ...f, cif_number: e.target.value }))} style={inputStyle} placeholder="CIF-00123" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Card Type</label>
              <select value={form.card_type} onChange={e => setForm(f => ({ ...f, card_type: e.target.value }))} style={inputStyle}>
                {['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Current Limit (kobo)</label>
              <input type="number" value={form.current_limit_kobo} onChange={e => setForm(f => ({ ...f, current_limit_kobo: e.target.value }))} style={inputStyle} placeholder="e.g. 50000000" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Proposed Limit (kobo)</label>
              <input type="number" value={form.proposed_limit_kobo} onChange={e => setForm(f => ({ ...f, proposed_limit_kobo: e.target.value }))} style={inputStyle} placeholder="e.g. 75000000" />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Utilization %</label>
              <input type="number" value={form.utilization_pct} onChange={e => setForm(f => ({ ...f, utilization_pct: e.target.value }))} style={inputStyle} placeholder="0–100" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Eye Score</label>
              <input type="number" value={form.eye_score} onChange={e => setForm(f => ({ ...f, eye_score: e.target.value }))} style={inputStyle} placeholder="300–850" />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2}
              style={{ ...inputStyle, resize: 'vertical' }} placeholder="Justification for limit change…" />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: INTER }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'default' : 'pointer', fontFamily: INTER }}>
            {saving ? 'Submitting…' : 'Submit Review'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCreditLimitCsv(rows: CreditReview[]) {
  const header = ['Review #', 'Customer', 'CIF Number', 'Card Type', 'Current Limit (₦)', 'Proposed Limit (₦)', 'Utilization %', 'Eye Score', 'Status', 'Recommended By', 'Submitted Date']
  const lines = rows.map(r => [
    `"${String(r.ref ?? '').replace(/"/g, '""')}"`,
    `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    `"${String(r.cif_number ?? '').replace(/"/g, '""')}"`,
    r.card_type ?? '',
    r.current_limit_kobo !== undefined ? (Number(r.current_limit_kobo) / 100).toFixed(2) : '',
    r.proposed_limit_kobo !== undefined ? (Number(r.proposed_limit_kobo) / 100).toFixed(2) : '',
    r.utilization_pct ?? '',
    r.eye_score ?? '',
    r.status ?? '',
    `"${String(r.recommended_by ?? '').replace(/"/g, '""')}"`,
    r.submitted_date ? r.submitted_date.slice(0, 10) : '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `credit-limit-reviews-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsCreditLimit() {
  const [rows,    setRows]    = useState<CreditReview[]>([])
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
      const data = await apiFetch<CreditReview[]>('/api/cards/credit-limits')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const cols: TableCol<CreditReview>[] = useMemo(() => [
    { key: 'ref', label: 'Review #',
      render: r => <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{r.ref}</span> },
    { key: 'customer_name', label: 'Customer',
      render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.customer_name}</span> },
    { key: 'current_limit_kobo', label: 'Current Limit', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtKobo(Number(r.current_limit_kobo))}</span> },
    { key: 'proposed_limit_kobo', label: 'Proposed', align: 'right',
      render: r => {
        const up = Number(r.proposed_limit_kobo) > Number(r.current_limit_kobo)
        return (
          <span style={{ ...NUM, fontWeight: 600, color: up ? GREEN : RED }}>
            {fmtKobo(Number(r.proposed_limit_kobo))}
            {up && <span style={{ fontSize: 10, marginLeft: 4 }}>↑</span>}
          </span>
        )
      },
    },
    { key: 'utilization_pct', label: 'Utilization', align: 'right',
      render: r => {
        const pct = Number(r.utilization_pct)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 40, height: 5, borderRadius: 3, background: 'var(--bdr)' }}>
              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: pct > 80 ? RED : pct > 60 ? AMBER : GREEN }} />
            </div>
            <span style={{ ...NUM, fontSize: 12 }}>{fmtPct(pct)}</span>
          </div>
        )
      },
    },
    { key: 'eye_score', label: 'Eye Score', render: r => <EyeScoreBar score={Number(r.eye_score)} /> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: '_actions', label: '', render: r => <ReviewActions review={r} onReload={load} /> },
  ], [load])

  const displayed = useMemo(() => rows.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false
    if (search && !r.customer_name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [rows, search, statusFilter])

  const pendingApproval = rows.filter(r => r.status === 'recommended').length
  const totalProposed   = rows.reduce((s, r) => s + Number(r.proposed_limit_kobo), 0)
  const approvedCount   = rows.filter(r => r.status === 'approved').length

  return (
    <Page
      title="Credit Limit Review"
      subtitle="Cards recommend · Risk approve / decline"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 9,
          border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: INTER,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Review
        </button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Awaiting Risk Decision', value: pendingApproval, color: AMBER },
          { label: 'Total Proposed Credit',  value: fmtKobo(totalProposed), color: 'var(--txt)' },
          { label: 'Approved',               value: approvedCount, color: GREEN },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
            <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <SectionCard title="Limit Reviews" badge={displayed.length} padding={false} actions={<button onClick={() => exportCreditLimitCsv(displayed)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}><span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>Export CSV</button>}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />
          <select
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: 12.5, color: 'var(--txt)', fontFamily: INTER, outline: 'none' }}
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_LABELS).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{displayed.length} reviews</span>
        </div>
        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No reviews submitted yet"
          pageSize={20}
          selectable
          selectedIds={sel}
          onSelect={setSel}
          bulkBar={sel.size > 0 ? (
            <>
              <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{sel.size} selected</span>
              <button onClick={() => setSel(new Set())} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: GREEN, color: 'white', cursor: 'pointer', fontSize: 12 }}>Approve Limit Change</button>
              <button onClick={() => setSel(new Set())} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', cursor: 'pointer', fontSize: 12 }}>Decline</button>
            </>
          ) : undefined}
        />
      </SectionCard>

      {showNew && <NewReviewModal onClose={() => setShowNew(false)} onCreated={load} />}
    </Page>
  )
}
