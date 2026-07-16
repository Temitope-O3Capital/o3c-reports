import { useState, useMemo, useEffect, useCallback } from 'react'
import { Page, SectionCard, DataTable, StatusBadge, filterInputStyle, SearchInput, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { NAVY, GREEN, AMBER, RED, BLUE, PURPLE, NUM, INTER, SORA, TEXT, FW, SP, RADIUS } from '../../lib/design'
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

// ── Edit account modal ─────────────────────────────────────────────────────────

function EditAccountModal({ account, onClose, onSaved }: { account: GLAccount; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(account.name)
  const [cls, setCls] = useState<AccountClass>(account.class)
  const [normalBalance, setNormalBalance] = useState<'Dr' | 'Cr'>(account.normal_balance)
  const [currency, setCurrency] = useState(account.currency)
  const [isActive, setIsActive] = useState(account.is_active)
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!name) { toast.error('Name is required'); return }
    setSaving(true)
    try {
      await apiFetch(`/api/finance/gl-accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, class: cls, normal_balance: normalBalance, currency, is_active: isActive }),
      })
      toast.success('GL account updated')
      onSaved()
    } catch (e: any) {
      toast.error(e.message ?? 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: RADIUS.xl, padding: SP[6], width: 440, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>Edit GL Account</h3>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{account.code}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.xl }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
            <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Account Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} style={{ ...filterInputStyle, height: 36 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Class</label>
              <select value={cls} onChange={e => setCls(e.target.value as AccountClass)} style={{ ...filterInputStyle, height: 36 }}>
                {(['Asset','Liability','Income','Expense','Equity'] as AccountClass[]).map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Normal Balance</label>
              <select value={normalBalance} onChange={e => setNormalBalance(e.target.value as 'Dr' | 'Cr')} style={{ ...filterInputStyle, height: 36 }}>
                <option value="Dr">Debit (Dr)</option>
                <option value="Cr">Credit (Cr)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Currency</label>
              <select value={currency} onChange={e => setCurrency(e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
                <option>NGN</option><option>USD</option><option>GBP</option><option>EUR</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Status</label>
              <select value={isActive ? 'active' : 'inactive'} onChange={e => setIsActive(e.target.value === 'active')} style={{ ...filterInputStyle, height: 36 }}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[5] }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Columns ───────────────────────────────────────────────────────────────────

function makeCols(onEdit: (a: GLAccount) => void): TableCol<GLAccount>[] { return [
  { key: 'code', label: 'Code', render: r => (
    <span style={{ ...NUM, fontWeight: FW.bold, paddingLeft: r.parent_code ? SP[5] : 0 }}>{r.code}</span>
  )},
  { key: 'name', label: 'Account Name', sortable: true, render: r => (
    <span style={{ paddingLeft: r.parent_code ? SP[5] : 0, fontWeight: r.parent_code ? FW.normal : FW.semibold }}>
      {!r.parent_code && <span className="material-symbols-rounded" style={{ fontSize: TEXT.base, marginRight: 6, verticalAlign: 'middle', color: 'var(--txt2)' }}>folder</span>}
      {r.name}
    </span>
  )},
  { key: 'class', label: 'Class', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: `${CLASS_COLORS[r.class]}18`, color: CLASS_COLORS[r.class] }}>
      {r.class}
    </span>
  )},
  { key: 'normal_balance', label: 'Normal', align: 'center', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 7px', borderRadius: RADIUS['2xl'],
      background: r.normal_balance === 'Dr' ? 'rgba(37,99,235,.1)' : 'rgba(22,163,74,.1)',
      color: r.normal_balance === 'Dr' ? '#2563EB' : GREEN }}>
      {r.normal_balance}
    </span>
  )},
  { key: 'currency', label: 'CCY', align: 'center' },
  { key: 'profit_centre', label: 'Profit Centre', render: r => r.profit_centre ?? '—' },
  { key: 'is_active', label: 'Status', render: r => <StatusBadge status={r.is_active ? 'Active' : 'Inactive'} /> },
  { key: 'id', label: '', align: 'center', render: r => (
    <button onClick={() => onEdit(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', padding: SP[1], borderRadius: RADIUS.sm, display: 'flex', alignItems: 'center' }}>
      <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>edit</span>
    </button>
  )},
]}

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
      <div style={{ position: 'relative', background: 'var(--card)', borderRadius: RADIUS.xl, padding: SP[6], width: 420, zIndex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SP[5] }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>Add GL Account</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.xl }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {[['Account Code', code, setCode], ['Account Name', name, setName]].map(([label, val, setter]) => (
            <div key={label as string} style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{label as string} *</label>
              <input value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)}
                style={{ ...filterInputStyle, height: 36 }} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Class</label>
              <select value={cls} onChange={e => setCls(e.target.value as AccountClass)} style={{ ...filterInputStyle, height: 36 }}>
                {(['Asset','Liability','Income','Expense','Equity'] as AccountClass[]).map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Normal Balance</label>
              <select value={normalBalance} onChange={e => setNormalBalance(e.target.value as 'Dr' | 'Cr')} style={{ ...filterInputStyle, height: 36 }}>
                <option value="Dr">Debit (Dr)</option>
                <option value="Cr">Credit (Cr)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[1] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Currency</label>
              <select value={currency} onChange={e => setCurrency(e.target.value)} style={{ ...filterInputStyle, height: 36 }}>
                <option>NGN</option><option>USD</option><option>GBP</option><option>EUR</option>
              </select>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end', marginTop: SP[5] }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
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
  const [editAccount, setEditAccount] = useState<GLAccount | null>(null)
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

  function exportAccountsCsv(data: GLAccount[]) {
    const header = ['Code', 'Name', 'Class', 'Currency', 'Normal Balance', 'Active']
    const lines = data.map(r => [
      r.code ?? '',
      `"${String(r.name ?? '').replace(/"/g, '""')}"`,
      r.class ?? '',
      r.currency ?? '',
      r.normal_balance ?? '',
      r.is_active ? 'Yes' : 'No',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `chart-of-accounts-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  return (
    <Page
      title="Chart of Accounts"
      subtitle={`${accounts.length} accounts · Assets · Liabilities · Income · Expense · Equity`}
      actions={
        <button onClick={() => setShowAdd(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 14px', borderRadius: RADIUS.md, border: 'none',
          background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>Add Account
        </button>
      }
    >
      {error && <ErrBanner error={error} onRetry={load} />}
      {loading && <Spinner />}

      {!loading && !error && (
        <SectionCard title="GL Accounts" badge={filtered.length} padding={false} actions={
          <button onClick={() => exportAccountsCsv(filtered)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'inherit' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>download</span>
            Export CSV
          </button>
        }>

          {/* Filter bar */}
          <div style={{
            padding: '12px 18px',
            borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap',
          }}>
            <SearchInput value={search} onChange={setSearch} onClear={() => setSearch('')} />

            <button
              onClick={() => setFilterOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
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
                  fontSize: 9, fontWeight: FW.bold, fontFamily: INTER,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{activeFilterCount}</span>
              )}
            </button>

            <div style={{ marginLeft: 'auto', fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              {filtered.length} of {accounts.length}
            </div>
          </div>

          {/* Expandable filter panel */}
          {filterOpen && (
            <div style={{ borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

                {/* Class */}
                <div style={{ paddingRight: SP[5], borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>CLASS</div>
                  {(['', 'Asset', 'Liability', 'Income', 'Expense', 'Equity'] as const).map(cls => {
                    const color = cls ? CLASS_COLORS[cls as AccountClass] : NAVY
                    const count = cls ? accounts.filter(a => a.class === cls).length : accounts.length
                    return (
                      <label key={cls || 'all'} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                        <input type="radio" name="gl_class" value={cls} checked={classFilter === cls} onChange={() => setClassFilter(cls as any)}
                          style={{ accentColor: color, width: 14, height: 14, cursor: 'pointer' }} />
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: cls ? `${color}18` : 'var(--chip-bg)', color: cls ? color : 'var(--chip-txt)' }}>
                          {cls || 'All classes'}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>{count}</span>
                      </label>
                    )
                  })}
                </div>

                {/* Summary */}
                <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                  <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>SUMMARY</div>
                  {[
                    { label: 'Debit normal (Dr)',  count: accounts.filter(a => a.normal_balance === 'Dr').length,  color: BLUE },
                    { label: 'Credit normal (Cr)', count: accounts.filter(a => a.normal_balance === 'Cr').length,  color: GREEN },
                    { label: 'Active',             count: accounts.filter(a => a.is_active).length,                color: GREEN },
                  ].map(s => (
                    <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: SP[2] }}>
                      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: SORA }}>{s.label}</span>
                      <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: s.color, fontFamily: INTER }}>{s.count}</span>
                    </div>
                  ))}
                </div>

                <div style={{ paddingLeft: SP[5] }} />

              </div>

              <div style={{
                padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
                display: 'flex', alignItems: 'center', gap: SP[3],
              }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: SORA }}>
                  {activeFilterCount === 0
                    ? `No filters — showing all ${accounts.length} accounts`
                    : `${activeFilterCount} filter active`}
                </span>
                <button onClick={resetFilters} style={{
                  padding: '5px 12px', borderRadius: 7, fontSize: TEXT.sm, fontWeight: FW.semibold,
                  border: '1.5px solid var(--input-bdr)', background: 'transparent',
                  color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
                }}>Reset</button>
                <button onClick={() => setFilterOpen(false)} style={{
                  marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                  fontSize: TEXT.sm, fontWeight: FW.semibold, border: 'none', background: RED, color: '#fff',
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
              <span style={{ display: 'flex', alignItems: 'center', gap: SP[1], padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: `${CLASS_COLORS[classFilter]}18`, color: CLASS_COLORS[classFilter] }}>
                {classFilter}
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => setClassFilter('')}>close</span>
              </span>
            </div>
          )}

          <DataTable
            cols={makeCols(setEditAccount)}
            rows={filtered}
            keyFn={r => r.id}
            emptyText="No accounts match your filter"
            pageSize={20}
          />

        </SectionCard>
      )}

      {showAdd && (
        <AddAccountModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load() }}
        />
      )}
      {editAccount && (
        <EditAccountModal
          account={editAccount}
          onClose={() => setEditAccount(null)}
          onSaved={() => { setEditAccount(null); load() }}
        />
      )}
    </Page>
  )
}
