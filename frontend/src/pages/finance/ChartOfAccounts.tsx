import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, StatusBadge, filterInputStyle, SearchInput, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, GREEN, AMBER, RED, BLUE, PURPLE, NUM, INTER, SORA } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

type AccountClass = 'Asset' | 'Liability' | 'Income' | 'Expense' | 'Equity'

interface GLAccount {
  id: number
  code: string
  name: string
  class: AccountClass
  parent_code?: string
  profit_centre?: string
  currency: string
  is_active: boolean
  normal_balance: 'Dr' | 'Cr'
}

// ── Class colours ──────────────────────────────────────────────────────────────

const CLASS_COLORS: Record<AccountClass, string> = {
  Asset:     BLUE,
  Liability: AMBER,
  Income:    GREEN,
  Expense:   RED,
  Equity:    PURPLE,
}

// Backend may return lowercase class values — normalise to title case
function normaliseClass(raw: string): AccountClass {
  const map: Record<string, AccountClass> = {
    asset: 'Asset', liability: 'Liability', income: 'Income', expense: 'Expense', equity: 'Equity',
    Asset: 'Asset', Liability: 'Liability', Income: 'Income', Expense: 'Expense', Equity: 'Equity',
  }
  return map[raw] ?? (raw as AccountClass)
}

// ── Columns ───────────────────────────────────────────────────────────────────

const COLS: TableCol<GLAccount>[] = [
  { key: 'code', label: 'Code', render: r => (
    <span style={{ ...NUM, fontWeight: 700, paddingLeft: r.parent_code ? 20 : 0 }}>{r.code}</span>
  )},
  { key: 'name', label: 'Account Name', sortable: true, render: r => (
    <span style={{ paddingLeft: r.parent_code ? 20 : 0, fontWeight: r.parent_code ? 400 : 600 }}>
      {!r.parent_code && <span className="material-symbols-rounded" style={{ fontSize: 13, marginRight: 6, verticalAlign: 'middle', color: 'var(--txt2)' }}>folder</span>}
      {r.name}
    </span>
  )},
  { key: 'class', label: 'Class', render: r => (
    <span style={{ ...NUM, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
      background: `${CLASS_COLORS[r.class]}18`, color: CLASS_COLORS[r.class] }}>
      {r.class}
    </span>
  )},
  { key: 'normal_balance', label: 'Normal', align: 'center', render: r => (
    <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, padding: '2px 7px', borderRadius: 20,
      background: r.normal_balance === 'Dr' ? 'rgba(37,99,235,.1)' : 'rgba(22,163,74,.1)',
      color: r.normal_balance === 'Dr' ? '#2563EB' : GREEN }}>
      {r.normal_balance}
    </span>
  )},
  { key: 'currency', label: 'CCY', align: 'center' },
  { key: 'profit_centre', label: 'Profit Centre', render: r => r.profit_centre ?? '—' },
  { key: 'is_active', label: 'Status', render: r => <StatusBadge status={r.is_active ? 'Active' : 'Inactive'} /> },
]

// ── Add account modal ──────────────────────────────────────────────────────────

function AddAccountModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [cls, setCls] = useState<AccountClass>('Asset')
  const [normalBalance, setNormalBalance] = useState<'Dr' | 'Cr'>('Dr')
  const [currency, setCurrency] = useState('NGN')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!code || !name) { toast.error('Code and name required'); return }
    setSaving(true)
    try {
      await apiPost('/api/finance/gl-accounts', { code, name, class: cls, normal_balance: normalBalance, currency })
      toast.success('GL account created')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Create failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: 14, padding: 24, width: 420, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>Add GL Account</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: 18 }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[['Account Code', code, setCode], ['Account Name', name, setName]].map(([label, val, setter]) => (
            <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>{label as string} *</label>
              <input value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)}
                style={{ ...filterInputStyle, height: 36 }} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Class</label>
              <select value={cls} onChange={e => setCls(e.target.value as AccountClass)} style={{ ...filterInputStyle, height: 36 }}>
                {(['Asset','Liability','Income','Expense','Equity'] as AccountClass[]).map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Normal Balance</label>
              <select value={normalBalance} onChange={e => setNormalBalance(e.target.value as 'Dr' | 'Cr')} style={{ ...filterInputStyle, height: 36 }}>
                <option value="Dr">Debit (Dr)</option>
                <option value="Cr">Credit (Cr)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)' }}>Currency</label>
              <select value={currency} onChange={e => setCurrency(e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
                <option>NGN</option><option>USD</option><option>GBP</option><option>EUR</option>
              </select>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Add Account'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinanceChartOfAccounts() {
  const [accounts, setAccounts] = useState<GLAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [classFilter, setClassFilter] = useState<AccountClass | ''>('')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const raw = await apiFetch<any[]>('/api/finance/gl-accounts')
      setAccounts((raw ?? []).map(a => ({ ...a, class: normaliseClass(a.class) })))
    } catch (e: any) {
      setError(e.message ?? 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const activeFilterCount = (classFilter ? 1 : 0)

  const filtered = useMemo(() => accounts.filter(a => {
    if (classFilter && a.class !== classFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (!a.name.toLowerCase().includes(q) && !a.code.includes(q)) return false
    }
    return true
  }), [accounts, classFilter, search])

  function resetFilters() { setClassFilter(''); setSearch('') }

  return (
    <Page
      title="Chart of Accounts"
      subtitle={`${accounts.length} accounts · Assets · Liabilities · Income · Expense · Equity`}
      actions={
        <button onClick={() => setShowAdd(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 14px', borderRadius: 8, border: 'none',
          background: NAVY, color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>Add Account
        </button>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <SectionCard title="GL Accounts" badge={filtered.length} padding={false}>

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
              {filtered.length} of {accounts.length}
            </div>
          </div>

          {/* Expandable filter panel */}
          {filterOpen && (
            <div style={{ borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

                {/* Class */}
                <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>CLASS</div>
                  {(['', 'Asset', 'Liability', 'Income', 'Expense', 'Equity'] as const).map(cls => {
                    const color = cls ? CLASS_COLORS[cls as AccountClass] : NAVY
                    const count = cls ? accounts.filter(a => a.class === cls).length : accounts.length
                    return (
                      <label key={cls || 'all'} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input type="radio" name="gl_class" value={cls} checked={classFilter === cls} onChange={() => setClassFilter(cls as any)}
                          style={{ accentColor: color, width: 14, height: 14, cursor: 'pointer' }} />
                        <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: cls ? `${color}18` : 'var(--chip-bg)', color: cls ? color : 'var(--chip-txt)' }}>
                          {cls || 'All classes'}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Summary */}
                <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: 12, fontFamily: INTER }}>SUMMARY</div>
                  {[
                    { label: 'Debit normal (Dr)',  count: accounts.filter(a => a.normal_balance === 'Dr').length,  color: BLUE },
                    { label: 'Credit normal (Cr)', count: accounts.filter(a => a.normal_balance === 'Cr').length,  color: GREEN },
                    { label: 'Active',             count: accounts.filter(a => a.is_active).length,                color: GREEN },
                  ].map(s => (
                    <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: SORA }}>{s.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: s.color, fontFamily: INTER }}>{s.count}</span>
                    </div>
                  ))}
                </div>

                <div style={{ paddingLeft: 20 }} />

              </div>

              <div style={{
                padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>
                  {activeFilterCount === 0
                    ? `No filters — showing all ${accounts.length} accounts`
                    : `${activeFilterCount} filter active`}
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
          {!filterOpen && classFilter && (
            <div style={{
              padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, fontSize: 11.5, fontWeight: 600, background: `${CLASS_COLORS[classFilter]}18`, color: CLASS_COLORS[classFilter] }}>
                {classFilter}
                <span className="material-symbols-rounded" style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => setClassFilter('')}>close</span>
              </span>
            </div>
          )}

          <DataTable
            cols={COLS}
            rows={filtered}
            keyFn={r => r.id}
            emptyText="No accounts match your filter"
          />

        </SectionCard>
      )}

      {showAdd && (
        <AddAccountModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
    </Page>
  )
}
