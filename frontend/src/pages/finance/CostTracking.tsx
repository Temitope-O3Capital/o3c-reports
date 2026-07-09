import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, filterInputStyle, SearchInput, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, today } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CostEntry {
  id: number
  entry_date: string
  department: string
  category: string
  description: string
  amount_kobo: number
  budget_amount_kobo: number
  recorded_by_name?: string
}

const DEPARTMENTS = [
  'Finance', 'Operations', 'IT', 'HR', 'Sales & BD',
  'Collections', 'Recovery', 'Compliance', 'Customer Service', 'Cards',
]

const CATEGORIES = [
  'Staff Costs', 'Rent & Utilities', 'IT Infrastructure', 'Marketing',
  'Professional Fees', 'Regulatory', 'Travel & Logistics', 'Other',
]

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<CostEntry>[] = [
  { key: 'entry_date', label: 'Date', sortable: true, width: 110,
    render: r => <span style={{ fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(r.entry_date)}</span> },
  { key: 'department', label: 'Department', sortable: true,
    render: r => <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{r.department}</span> },
  { key: 'category', label: 'Category',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.category}</span> },
  { key: 'description', label: 'Description',
    render: r => <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240, fontSize: 12.5 }}>{r.description}</span> },
  { key: 'amount_kobo', label: 'Actual ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.amount_kobo)}</span> },
  { key: 'budget_amount_kobo', label: 'Budget ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.budget_amount_kobo)}</span> },
  { key: '_variance', label: 'Variance ₦', align: 'right', render: r => {
    const v = r.budget_amount_kobo - r.amount_kobo
    return <span style={{ ...NUM, fontWeight: 600, color: v >= 0 ? GREEN : RED }}>{fmtKobo(Math.abs(v))}{v < 0 ? ' over' : ''}</span>
  }},
  { key: 'recorded_by_name', label: 'Recorded by',
    render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.recorded_by_name || '—'}</span> },
]

// ── New entry modal ────────────────────────────────────────────────────────────

interface EntryForm {
  entry_date: string
  department: string
  category: string
  description: string
  amount: string
  budget_amount: string
}

function NewEntryModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<EntryForm>({
    entry_date: today(), department: DEPARTMENTS[0], category: CATEGORIES[0],
    description: '', amount: '', budget_amount: '',
  })
  const [saving, setSaving] = useState(false)

  function update(k: keyof EntryForm, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!form.description || !form.amount) { toast.error('Description and amount required'); return }
    const amount_kobo = Math.round(parseFloat(form.amount) * 100)
    if (isNaN(amount_kobo) || amount_kobo <= 0) { toast.error('Enter a valid amount'); return }
    const budget_amount_kobo = form.budget_amount ? Math.round(parseFloat(form.budget_amount) * 100) : 0
    setSaving(true)
    try {
      await apiPost('/api/finance/costs', {
        entry_date: form.entry_date,
        department: form.department,
        category: form.category,
        description: form.description,
        amount_kobo,
        budget_amount_kobo,
      })
      toast.success('Cost entry recorded')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const row = (label: string, key: keyof EntryForm, type = 'text') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={form[key]} onChange={e => update(key, e.target.value)} style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: 14, padding: 24, width: 480, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>Add Cost Entry</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: 18 }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {row('Date', 'entry_date', 'date')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Department</label>
            <select value={form.department} onChange={e => update('department', e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Category</label>
            <select value={form.category} onChange={e => update('category', e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          {row('Actual Amount (₦)', 'amount', 'number')}
          {row('Budget Amount (₦)', 'budget_amount', 'number')}
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Description *</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.description} onChange={e => update('description', e.target.value)} rows={2}
              style={{ ...filterInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical', width: '100%', marginTop: 4 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Add Entry'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceCostTracking() {
  const [rows, setRows] = useState<CostEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [deptFilter, setDeptFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (deptFilter) params.set('department', deptFilter)
      if (catFilter) params.set('category', catFilter)
      params.set('limit', '500')
      const res = await apiFetch<{ data: CostEntry[]; total: number }>(`/api/finance/costs?${params}`)
      setRows(res?.data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load costs')
    } finally {
      setLoading(false)
    }
  }, [deptFilter, catFilter])

  useEffect(() => { load() }, [load])

  const activeFilterCount = (deptFilter ? 1 : 0) + (catFilter ? 1 : 0)

  const filtered = useMemo(() => rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.description.toLowerCase().includes(q) && !r.department.toLowerCase().includes(q)) return false
    }
    return true
  }), [rows, search])

  const totalActual = filtered.reduce((s, r) => s + r.amount_kobo, 0)
  const totalBudget = filtered.reduce((s, r) => s + r.budget_amount_kobo, 0)
  const variance    = totalBudget - totalActual

  function resetFilters() { setSearch(''); setDeptFilter(''); setCatFilter('') }

  function exportCostsCsv(data: CostEntry[]) {
    const header = ['Date', 'Department', 'Category', 'Description', 'Actual ₦', 'Budget ₦', 'Recorded By']
    const lines = data.map(r => [
      r.entry_date ?? '',
      r.department ?? '',
      r.category ?? '',
      `"${String(r.description ?? '').replace(/"/g, '""')}"`,
      (r.amount_kobo / 100).toFixed(2),
      (r.budget_amount_kobo / 100).toFixed(2),
      `"${String(r.recorded_by_name ?? '').replace(/"/g, '""')}"`,
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `cost-tracking-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Cost Tracking"
      subtitle="Departmental operational costs vs budget"
      actions={
        <button onClick={() => setShowNew(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 14px', borderRadius: 8, border: 'none',
          background: NAVY, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>Add Entry
        </button>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <>
          {/* Summary strip */}
          {filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Total Actual</div>
                <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: RED }}>{fmtKobo(totalActual)}</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Total Budget</div>
                <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(totalBudget)}</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Variance</div>
                <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: variance >= 0 ? GREEN : RED }}>{fmtKobo(Math.abs(variance))}{variance < 0 ? ' over' : ' under'}</div>
              </div>
            </div>
          )}

          <SectionCard title="Cost Entries" badge={filtered.length} padding={false} actions={
            <button onClick={() => exportCostsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: 12, color: 'var(--txt2)', fontFamily: 'inherit' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
              Export CSV
            </button>
          }>

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

                  {/* Department */}
                  <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>DEPARTMENT</div>
                    {DEPARTMENTS.map(d => {
                      const count = rows.filter(r => r.department === d).length
                      return (
                        <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                          <input type="checkbox" checked={deptFilter === d} onChange={() => setDeptFilter(deptFilter === d ? '' : d)}
                            style={{ accentColor: NAVY, width: 14, height: 14, cursor: 'pointer' }} />
                          <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{d}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                        </label>
                      )
                    })}
                  </div>

                  {/* Category */}
                  <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>CATEGORY</div>
                    {CATEGORIES.map(c => {
                      const count = rows.filter(r => r.category === c).length
                      return (
                        <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                          <input type="checkbox" checked={catFilter === c} onChange={() => setCatFilter(catFilter === c ? '' : c)}
                            style={{ accentColor: AMBER, width: 14, height: 14, cursor: 'pointer' }} />
                          <span style={{ fontSize: 12.5, color: 'var(--txt)', fontFamily: SORA }}>{c}</span>
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                        </label>
                      )
                    })}
                  </div>

                  <div style={{ paddingLeft: 20 }} />

                </div>

                <div style={{
                  padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
                    {activeFilterCount === 0
                      ? `No filters — showing all ${rows.length} entries`
                      : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
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
            {!filterOpen && activeFilterCount > 0 && (
              <div style={{
                padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
                display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              }}>
                {deptFilter && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${NAVY}12`, color: NAVY }}>
                    {deptFilter}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setDeptFilter('')}>close</span>
                  </span>
                )}
                {catFilter && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${AMBER}18`, color: AMBER }}>
                    {catFilter}<span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setCatFilter('')}>close</span>
                  </span>
                )}
                <button onClick={resetFilters} style={{ marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
              </div>
            )}

            <DataTable
              cols={COLS}
              rows={filtered}
              keyFn={r => r.id}
              emptyText="No cost entries yet — click 'Add Entry' to record costs"
              pageSize={20}
            />

          </SectionCard>
        </>
      )}

      {showNew && (
        <NewEntryModal
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); load() }}
        />
      )}
    </Page>
  )
}
