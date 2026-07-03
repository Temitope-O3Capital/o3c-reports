import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, StatusBadge, filterInputStyle, SearchInput, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

function exportPostingsCsv(rows: Posting[]) {
  const header = ['Date', 'Initiated By', 'DR Account', 'CR Account', 'Amount (₦)', 'Narrative', 'Status']
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
      render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDatetime(r.initiated_at)}</span> },
    { key: 'initiated_by_name', label: 'Initiated by',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.initiated_by_name || '—'}</span> },
    { key: 'dr_account', label: 'DR Account', render: r => <span style={{ ...NUM, fontSize: 12 }}>{r.dr_account}</span> },
    { key: 'cr_account', label: 'CR Account', render: r => <span style={{ ...NUM, fontSize: 12 }}>{r.cr_account}</span> },
    { key: 'amount_kobo', label: 'Amount ₦', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'narrative', label: 'Narrative',
      render: r => <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240, fontSize: 12.5 }}>{r.narrative || '—'}</span> },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    { key: '_actions', label: '', render: r => r.status === 'pending' ? (
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={e => { e.stopPropagation(); onApprove(r.id) }} style={{
          padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(22,163,74,.12)',
          color: GREEN, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>Approve</button>
        <button onClick={e => { e.stopPropagation(); onReject(r.id) }} style={{
          padding: '4px 10px', borderRadius: 6, border: 'none', background: 'rgba(192,0,0,.08)',
          color: RED, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>Reject</button>
      </div>
    ) : null},
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>{label} *</label>
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
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: 14, padding: 24, width: 460, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>Propose Manual Posting</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {field('DR Account (debit)', 'dr_account')}
          {field('CR Account (credit)', 'cr_account')}
          {field('Amount (₦)', 'amount', 'number')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Narrative *</label>
            <textarea
              value={form.narrative}
              onChange={e => setForm(f => ({ ...f, narrative: e.target.value }))}
              rows={3}
              placeholder="Describe the reason for this manual posting…"
              style={{ ...filterInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical' }}
            />
          </div>
        </div>

        <div style={{
          marginTop: 14, padding: '10px 14px', borderRadius: 8,
          background: 'rgba(14,40,65,0.06)', border: '1px solid rgba(14,40,65,0.12)',
          fontSize: 12, color: 'var(--txt2)',
        }}>
          This posting will require Finance Head approval before the GL entry is posted.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Submitting…' : 'Submit for Approval'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  pending:  { bg: 'rgba(217,119,6,.12)',  txt: '#D97706' },
  approved: { bg: 'rgba(22,163,74,.12)',  txt: '#16A34A' },
  rejected: { bg: 'rgba(192,0,0,.08)',    txt: '#C00000' },
}

export default function FinanceManualPosting() {
  const [rows, setRows] = useState<Posting[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [showPropose, setShowPropose] = useState(false)
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      params.set('limit', '200')
      const res = await apiFetch<{ data: Posting[]; total: number }>(`/api/finance/manual-postings?${params}`)
      setRows(res?.data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load postings')
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

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

  const activeFilterCount = statusFilter ? 1 : 0

  const filtered = useMemo(() => rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.narrative.toLowerCase().includes(q) && !r.dr_account.includes(q) && !r.cr_account.includes(q)) return false
    }
    return true
  }), [rows, search])

  const cols = PostingCols(handleApprove, handleReject)

  function resetFilters() { setSearch(''); setStatusFilter('') }

  return (
    <Page
      title="Manual Postings"
      subtitle="Approval queue for GL manual entries"
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => exportPostingsCsv(filtered)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>Export CSV
          </button>
          <button onClick={() => setShowPropose(true)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
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

          {/* Filter bar */}
          <div style={{
            padding: '12px 18px',
            borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

            <button
              onClick={() => setFilterOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
                background: 'transparent',
                color: activeFilterCount > 0 ? RED : 'var(--txt2)',
                cursor: 'pointer', fontFamily: SORA, position: 'relative',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
              Filters
              {activeFilterCount > 0 && (
                <span style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 16, height: 16, borderRadius: '50%',
                  background: RED, color: '#fff',
                  fontSize: 9, fontWeight: 700, fontFamily: INTER,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{activeFilterCount}</span>
              )}
            </button>

            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {rows.length}
            </div>
          </div>

          {/* Expandable filter panel */}
          {filterOpen && (
            <div style={{ borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

                {/* Status */}
                <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>STATUS</div>
                  {[
                    { value: '',         label: 'All statuses', color: NAVY },
                    { value: 'pending',  label: 'Pending',      color: AMBER },
                    { value: 'approved', label: 'Approved',     color: GREEN },
                    { value: 'rejected', label: 'Rejected',     color: RED },
                  ].map(opt => {
                    const sc = STATUS_COLORS[opt.value]
                    const count = opt.value ? rows.filter(r => r.status === opt.value).length : rows.length
                    return (
                      <label key={opt.value || 'all'} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input type="radio" name="posting_status" value={opt.value} checked={statusFilter === opt.value} onChange={() => setStatusFilter(opt.value)}
                          style={{ accentColor: opt.color, width: 14, height: 14, cursor: 'pointer' }} />
                        <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: sc?.bg ?? 'var(--chip-bg)', color: sc?.txt ?? 'var(--chip-txt)', textTransform: 'capitalize' }}>
                          {opt.label}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }} />
                <div style={{ paddingLeft: 20 }} />

              </div>

              <div style={{
                padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
                  {activeFilterCount === 0
                    ? `No filters — showing all ${rows.length} postings`
                    : `1 filter active`}
                </span>
                <button onClick={resetFilters} style={{
                  padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  border: '1.5px solid var(--input-bdr)', background: 'transparent',
                  color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
                }}>Reset</button>
                <button onClick={() => setFilterOpen(false)} style={{
                  marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                  fontSize: 12, fontWeight: 600, border: 'none', background: RED, color: '#fff',
                  cursor: 'pointer', fontFamily: SORA,
                }}>Apply · {filtered.length} results</button>
              </div>
            </div>
          )}

          {/* Active chips */}
          {!filterOpen && statusFilter && (
            <div style={{
              padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {(() => {
                const sc = STATUS_COLORS[statusFilter]
                return (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: sc.bg, color: sc.txt, textTransform: 'capitalize' }}>
                    {statusFilter}
                    <span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setStatusFilter('')}>close</span>
                  </span>
                )
              })()}
            </div>
          )}

          <DataTable
            cols={cols}
            rows={filtered}
            keyFn={r => r.id}
            emptyText="No manual postings pending approval"
            searchKeys={['narrative', 'dr_account', 'cr_account', 'status']}
            searchPlaceholder="Search narrative, accounts, status…"
            pageSize={20}
            selectable
            selectedIds={sel}
            onSelect={setSel}
            bulkBar={
              <button onClick={handleBulkApprove} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#16A34A', color: 'white', cursor: 'pointer', fontSize: 12 }}>
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
