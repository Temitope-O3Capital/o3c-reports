import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, filterInputStyle, ExpandableFilterBar, ErrBanner, Spinner, DateFilter, NameCell, ActionRow } from '../../components/UI'
import type { TableCol, RowAction } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, today, monthStart } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
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

// ── Export helper ─────────────────────────────────────────────────────────────

function exportCostsCsv(data: CostEntry[]) {
  const header = ['Date', 'Department', 'Category', 'Description', 'Actual NGN', 'Budget NGN', 'Recorded By']
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

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<CostEntry>[] = [
  { key: 'entry_date', label: 'Date', sortable: true, width: 110,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.entry_date)}</span> },
  { key: 'description', label: 'Description',
    render: r => <NameCell name={r.description || '—'} sub={r.department} avatar={false} /> },
  { key: 'category', label: 'Category',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.category}</span> },
  { key: 'amount_kobo', label: 'Actual ₦', align: 'right', sortable: true,
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.amount_kobo)}</span> },
  { key: 'budget_amount_kobo', label: 'Budget ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.budget_amount_kobo)}</span> },
  { key: '_variance', label: 'Variance ₦', align: 'right', render: r => {
    const v = r.budget_amount_kobo - r.amount_kobo
    return <span style={{ ...NUM, fontWeight: FW.semibold, color: v >= 0 ? GREEN : RED }}>{fmtKobo(Math.abs(v))}{v < 0 ? ' over' : ''}</span>
  }},
  { key: 'recorded_by_name', label: 'Recorded by',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.recorded_by_name || '—'}</span> },
  { key: '_actions', label: '', sortable: false, render: r => (
    <ActionRow actions={[
      { icon: 'download', label: 'Download', onClick: () => exportCostsCsv([r]) },
    ] satisfies RowAction[]} />
  )},
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
      <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label}</label>
      <input type={type} value={form[key]} onChange={e => update(key, e.target.value)} style={{ ...filterInputStyle, height: 36 }} />
    </div>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: RADIUS.xl, padding: SP[6], width: 480, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>Add Cost Entry</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.xl }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          {row('Date', 'entry_date', 'date')}
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Department</label>
            <select value={form.department} onChange={e => update('department', e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
              {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Category</label>
            <select value={form.category} onChange={e => update('category', e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          {row('Actual Amount (NGN)', 'amount', 'number')}
          {row('Budget Amount (NGN)', 'budget_amount', 'number')}
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Description *</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={form.description} onChange={e => update('description', e.target.value)} rows={2}
              style={{ ...filterInputStyle, height: 'auto', padding: '8px 10px', resize: 'vertical', width: '100%', marginTop: 4 }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[5] }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
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
  const [fDepts, setFDepts] = useState<Set<string>>(new Set())
  const [fCats,  setFCats]  = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [showNew, setShowNew] = useState(false)
  const [sel, setSel] = useState<Set<string | number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (fDepts.size) params.set('department', [...fDepts].join(','))
      if (fCats.size)  params.set('category',   [...fCats].join(','))
      params.set('limit', '500')
      params.set('date_from', dateFrom)
      params.set('date_to', dateTo)
      const res = await apiFetch<{ data: CostEntry[]; total: number }>(`/api/finance/costs?${params}`)
      setRows(res?.data ?? [])
    } catch (e: any) {
      setError(e.message ?? 'Failed to load costs')
    } finally {
      setLoading(false)
    }
  }, [fDepts, fCats, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

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

  function resetFilters() { setSearch(''); setFDepts(new Set()); setFCats(new Set()) }

  return (
    <Page
      title="Cost Tracking"
      subtitle="Departmental operational costs vs budget"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={() => setShowNew(true)} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: RADIUS.md, border: 'none',
            background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>Add Entry
          </button>
        </div>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <>
          {/* Summary strip */}
          {filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[4], marginBottom: SP[5] }}>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Total Actual</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: RED }}>{fmtKobo(totalActual)}</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Total Budget</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtKobo(totalBudget)}</div>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '16px 18px' }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', marginBottom: 6 }}>Variance</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: variance >= 0 ? GREEN : RED }}>{fmtKobo(Math.abs(variance))}{variance < 0 ? ' over' : ' under'}</div>
              </div>
            </div>
          )}

          <SectionCard title="Cost Entries" badge={filtered.length} padding={false} actions={
            <button onClick={() => exportCostsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
              Export CSV
            </button>
          }>

            <ExpandableFilterBar
              search={search}
              onSearch={setSearch}
              groups={[
                {
                  key: 'dept', label: 'Department',
                  options: DEPARTMENTS.map(d => ({ value: d, label: d })),
                  selected: fDepts,
                  onChange: setFDepts,
                },
                {
                  key: 'cat', label: 'Category',
                  options: CATEGORIES.map(c => ({ value: c, label: c })),
                  selected: fCats,
                  onChange: setFCats,
                },
              ]}
              onReset={resetFilters}
              onApply={() => load()}
              resultCount={filtered.length}
              totalCount={rows.length}
              placeholder="Search description, department…"
            />

            <DataTable
              cols={COLS}
              rows={filtered}
              keyFn={r => r.id}
              emptyText="No cost entries yet — click 'Add Entry' to record costs"
              pageSize={20}
              selectable
              selectedIds={sel}
              onSelect={setSel}
              bulkBar={sel.size > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{sel.size} selected</span>
                  <button onClick={() => exportCostsCsv(filtered.filter(r => sel.has(r.id)))}
                    style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
                    Export CSV
                  </button>
                </div>
              ) : undefined}
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
