import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, StatusBadge, filterInputStyle, ExpandableFilterBar, ErrBanner, Spinner, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime, monthStart, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

function exportPostingsCsv(rows: Posting[]) {
  const header = ['Date', 'Initiated By', 'DR Account', 'CR Account', 'Amount (NGN)', 'Narrative', 'Status']
  const lines = rows.map(r => [
    r.initiated_at ?? '',
    `"${String(r.initiated_by_name ?? '').replace(/"/g, '""')}"`,
    r.dr_account ?? '',
    r.cr_account ?? '',
    (r.amount_kobo / 100).toFixed(2),
    `"${String(r.narrative ?? '').replace(/"/g, '""')}"`,
    r.status ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `manual-postings-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Posting {
  id: number
  initiated_at: string
  initiated_by_name?: string
  dr_account: string
  cr_account: string
  amount_kobo: number
  narrative: string
  status: 'pending' | 'approved' | 'rejected'
  approved_by_name?: string
  approved_at?: string
  rejection_reason?: string
}

// ── Columns ───────────────────────────────────────────────────────────────────

function PostingCols(onApprove: (id: number) => void, onReject: (id: number) => void): TableCol<Posting>[] {
  return [
    { key: 'initiated_at', label: 'Date', sortable: true, width: 150,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(r.initiated_at)}</span> },
    { key: 'narrative', label: 'Description',
      render: r => <NameCell name={r.narrative || '—'} sub={r.initiated_by_name} avatar={false} /> },
    { key: 'dr_account', label: 'DR Account', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.dr_account}</span> },
    { key: 'cr_account', label: 'CR Account', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.cr_account}</span> },
    { key: 'amount_kobo', label: 'Amount NGN', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: '_actions', label: '', sortable: false, render: r => (
      <ActionRow actions={[
        ...(r.status === 'pending' ? [
          { icon: 'check_circle', label: 'Approve', onClick: () => onApprove(r.id) },
          { icon: 'cancel', label: 'Reject', onClick: () => onReject(r.id), danger: true },
        ] as RowAction[] : []),
        { icon: 'download', label: 'Download', onClick: () => exportPostingsCsv([r]) },
      ] satisfies RowAction[]} />
    )},
  ]
}

// ── Propose modal ─────────────────────────────────────────────────────────────

interface ProposeForm {
  dr_account: string
  cr_account: string
  amount: string
  narrative: string
}

function ProposeModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ProposeForm>({ dr_account: '', cr_account: '', amount: '', narrative: '' })
  const [saving, setSaving] = useState(false)

  const field = (label: string, key: keyof ProposeForm, type = 'text') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label} *</label>
      <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )

  async function submit() {
    if (!form.dr_account || !form.cr_account || !form.amount || !form.narrative) {
      toast.error('All fields required')
      return
    }
    const amount_kobo = Math.round(parseFloat(form.amount) * 100)
    if (isNaN(amount_kobo) || amount_kobo <= 0) { toast.error('Enter a valid amount'); return }
    setSaving(true)
    try {
      await apiPost('/api/finance/manual-postings', {
        dr_account: form.dr_account,
        cr_account: form.cr_account,
        amount_kobo,
        narrative: form.narrative,
      })
      toast.success('Posting submitted for approval')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Submit failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: RADIUS.xl, padding: SP[6], width: 460, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>Propose Manual Posting</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.xl }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {field('DR Account (debit)', 'dr_account')}
          {field('CR Account (credit)', 'cr_account')}
          {field('Amount (NGN)', 'amount', 'number')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Narrative *</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={form.narrative}
              onChange={e => setForm(f => ({ ...f, narrative: e.target.value }))}
              rows={3}
              placeholder="Describe the reason for this manual posting…"
              style={{ ...filterInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical' }}
            />
          </div>
        </div>

        <div style={{
          marginTop: 14, padding: '10px 14px', borderRadius: RADIUS.md,
          background: 'rgba(14,40,65,0.06)', border: '1px solid rgba(14,40,65,0.12)',
          fontSize: TEXT.sm, color: 'var(--txt2)',
        }}>
          This posting will require Finance Head approval before the GL entry is posted.
        </div>

        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[5] }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceManualPosting() {
  const [rows, setRows] = useState<Posting[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [fStatuses, setFStatuses] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [showPropose, setShowPropose] = useState(false)
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (fStatuses.size) params.set('status', [...fStatuses].join(','))
      params.set('limit', '200')
      params.set('date_from', dateFrom)
      params.set('date_to', dateTo)
      const res = await apiFetch<{ data: Posting[]; total: number }>(`/api/finance/manual-postings?${params}`)
      setRows(res?.data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load postings')
    } finally {
      setLoading(false)
    }
  }, [fStatuses, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function handleBulkApprove() {
    const ids = [...sel].filter(id => rows.find(r => r.id === id)?.status === 'pending')
    if (!ids.length) { toast.error('No pending postings selected'); return }
    try {
      await Promise.all(ids.map(id => apiFetch(`/api/finance/manual-postings/${id}/approve`, { method: 'PATCH', body: JSON.stringify({}) })))
      toast.success(`${ids.length} posting${ids.length !== 1 ? 's' : ''} approved`)
      setSel(new Set())
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Bulk approve failed')
    }
  }

  async function handleApprove(id: number) {
    try {
      await apiFetch(`/api/finance/manual-postings/${id}/approve`, { method: 'PATCH', body: JSON.stringify({}) })
      toast.success('Posting approved and GL entry posted')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Approve failed')
    }
  }

  async function handleReject(id: number) {
    const reason = window.prompt('Rejection reason (optional):') ?? ''
    try {
      await apiFetch(`/api/finance/manual-postings/${id}/reject`, { method: 'PATCH', body: JSON.stringify({ reason }) })
      toast.success('Posting rejected')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Reject failed')
    }
  }

  const filtered = useMemo(() => rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.narrative.toLowerCase().includes(q) && !r.dr_account.includes(q) && !r.cr_account.includes(q)) return false
    }
    return true
  }), [rows, search])

  const cols = PostingCols(handleApprove, handleReject)

  function resetFilters() { setSearch(''); setFStatuses(new Set()) }

  return (
    <Page
      title="Manual Postings"
      subtitle="Approval queue for GL manual entries"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => exportPostingsCsv(filtered)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export CSV
          </button>
          <button onClick={() => setShowPropose(true)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: RADIUS.md, border: 'none',
            background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>Propose Posting
          </button>
        </div>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <SectionCard title="Postings" badge={filtered.length} padding={false}>

          <ExpandableFilterBar
            search={search}
            onSearch={setSearch}
            groups={[{
              key: 'status', label: 'Status',
              options: [
                { value: 'pending',  label: 'Pending',  color: AMBER },
                { value: 'approved', label: 'Approved', color: GREEN },
                { value: 'rejected', label: 'Rejected', color: RED   },
              ],
              selected: fStatuses,
              onChange: setFStatuses,
            }]}
            onReset={resetFilters}
            onApply={() => load()}
            resultCount={filtered.length}
            totalCount={rows.length}
            placeholder="Search narrative, accounts…"
          />

          <DataTable
            cols={cols}
            rows={filtered}
            keyFn={r => r.id}
            emptyText="No manual postings pending approval"
            pageSize={20}
            selectable
            selectedIds={sel}
            onSelect={setSel}
            bulkBar={
              <button onClick={handleBulkApprove} style={{ padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', background: '#16A34A', color: 'white', cursor: 'pointer', fontSize: TEXT.sm }}>
                Bulk Approve
              </button>
            }
          />

        </SectionCard>
      )}

      {showPropose && (
        <ProposeModal
          onClose={() => setShowPropose(false)}
          onSaved={() => { setShowPropose(false); load() }}
        />
      )}
    </Page>
  )
}
