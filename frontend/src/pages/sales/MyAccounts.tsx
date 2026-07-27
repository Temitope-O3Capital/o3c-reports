import { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, ExpandableFilterBar, NameCell, ActionRow, KpiCard } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import type { AuthUser } from '../../hooks/useAuth'

interface Account {
  id: number
  first_name: string; last_name: string
  phone?: string; email?: string; cif_number?: string
  source?: string; source_type?: string
  employer_name?: string
  account_manager_id?: number; account_manager_name?: string
  updated_at: string; created_at: string
  // portfolio aggregates — loans
  loan_count: number
  active_loans: number
  outstanding_kobo: number
  max_dpd: number
  // portfolio aggregates — FDs
  active_fd_count: number
  fd_total_kobo: number
  fd_next_maturity: string | null
  // CRM
  open_deals: number
  activity_count: number
}

// ── Product chips ─────────────────────────────────────────────────────────────

function ProductChips({ hasLoan, hasFD }: { hasLoan: boolean; hasFD: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {hasLoan && (
        <span style={{
          fontSize: 10, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm,
          background: `${NAVY}12`, color: NAVY, whiteSpace: 'nowrap',
        }}>Loan</span>
      )}
      {hasFD && (
        <span style={{
          fontSize: 10, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm,
          background: `${GREEN}12`, color: GREEN, whiteSpace: 'nowrap',
        }}>FD</span>
      )}
    </div>
  )
}

// ── DPD indicator ─────────────────────────────────────────────────────────────

function DPDChip({ dpd }: { dpd: number }) {
  if (dpd === 0) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Current</span>
  const color = dpd >= 90 ? RED : dpd >= 30 ? AMBER : '#F59E0B'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: `${color}18`, color,
    }}>DPD {dpd}</span>
  )
}

// ── Portfolio bar ─────────────────────────────────────────────────────────────

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div style={{ width: 64, height: 4, background: 'var(--th-bg)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function currentUser(): AuthUser | null {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '') } catch { return null }
}

export default function MyAccounts() {
  const navigate  = useNavigate()
  const user      = currentUser()
  const isHead    = user?.role === 'sales_head' || user?.role === 'head_sales'

  const [accounts,  setAccounts]  = useState<Account[]>([])
  const [loading,   setLoading]   = useState(true)
  const [err,       setErr]       = useState<string | null>(null)
  const [search,    setSearch]    = useState('')
  const [fDPD,      setFDPD]      = useState<Set<string>>(new Set())
  const [fAMs,      setFAMs]      = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<{ data: Account[] }>('/api/crm/accounts')
      setAccounts(res?.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const dpd0   = accounts.filter(a => a.max_dpd === 0).length
  const dpd30  = accounts.filter(a => a.max_dpd > 0 && a.max_dpd < 30).length
  const dpd30p = accounts.filter(a => a.max_dpd >= 30 && a.max_dpd < 90).length
  const dpd90p = accounts.filter(a => a.max_dpd >= 90).length

  const uniqueAMs = useMemo(
    () => [...new Set(accounts.map(a => a.account_manager_name).filter(Boolean))] as string[],
    [accounts],
  )

  const maxOutstanding = useMemo(
    () => Math.max(1, ...accounts.map(a => a.outstanding_kobo ?? 0)),
    [accounts],
  )

  const filtered = useMemo(() => accounts.filter(a => {
    if (fAMs.size && !fAMs.has(a.account_manager_name ?? '')) return false
    if (fDPD.size) {
      const dpd = a.max_dpd ?? 0
      const bucket =
        dpd === 0 ? 'current' :
        dpd < 30  ? 'dpd_1_29' :
        dpd < 90  ? 'dpd_30_89' : 'dpd_90p'
      if (!fDPD.has(bucket)) return false
    }
    if (search) {
      const q = search.toLowerCase()
      if (![a.first_name, a.last_name, a.cif_number, a.email, a.employer_name]
        .some(f => f?.toLowerCase().includes(q))) return false
    }
    return true
  }), [accounts, fAMs, fDPD, search])

  const totalOutstanding = filtered.reduce((s, a) => s + (a.outstanding_kobo ?? 0), 0)
  const totalActiveLoans = filtered.reduce((s, a) => s + (a.active_loans ?? 0), 0)
  const totalFDValue     = filtered.reduce((s, a) => s + (a.fd_total_kobo ?? 0), 0)
  const atRisk           = filtered.filter(a => (a.max_dpd ?? 0) >= 30).length

  const cols: TableCol<Account>[] = [
    {
      key: 'first_name', label: 'Customer', sortable: true,
      render: a => (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <NameCell name={`${a.first_name} ${a.last_name}`.trim()} sub={a.employer_name ?? a.email ?? null} />
          {a.source_type === 'bd_assigned' && (
            <span style={{
              flexShrink: 0, marginTop: 2, fontSize: 10, fontWeight: FW.bold, padding: '1px 5px',
              borderRadius: RADIUS.sm, background: `${PURPLE}18`, color: PURPLE, letterSpacing: '0.04em',
            }}>BD</span>
          )}
        </div>
      ),
    },
    {
      key: 'cif_number', label: 'CIF', sortable: true,
      render: a => a.cif_number
        ? <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.cif_number}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'active_loans', label: 'Products', sortable: false,
      render: a => (
        <ProductChips hasLoan={(a.active_loans ?? 0) > 0} hasFD={(a.active_fd_count ?? 0) > 0} />
      ),
    },
    {
      key: 'outstanding_kobo', label: 'Loan Outstanding', sortable: true, align: 'right',
      render: a => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontWeight: FW.semibold, color: (a.outstanding_kobo ?? 0) > 0 ? 'var(--txt)' : 'var(--txt3)' }}>
            {(a.outstanding_kobo ?? 0) > 0 ? fmtKobo(a.outstanding_kobo) : '—'}
          </span>
          {(a.outstanding_kobo ?? 0) > 0 && (
            <div style={{ marginTop: 3 }}>
              <MiniBar value={a.outstanding_kobo} max={maxOutstanding} color={NAVY} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'fd_total_kobo', label: 'FD Value', sortable: true, align: 'right',
      render: a => (
        <div style={{ textAlign: 'right' }}>
          <span style={{ ...NUM, fontWeight: FW.semibold, color: (a.fd_total_kobo ?? 0) > 0 ? GREEN : 'var(--txt3)' }}>
            {(a.fd_total_kobo ?? 0) > 0 ? fmtKobo(a.fd_total_kobo) : '—'}
          </span>
          {a.fd_next_maturity && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
              matures {fmtDate(a.fd_next_maturity)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'max_dpd', label: 'DPD', sortable: true,
      render: a => <DPDChip dpd={a.max_dpd ?? 0} />,
    },
    {
      key: 'open_deals', label: 'Open Deals', sortable: true, align: 'right',
      render: a => (
        <span style={{ ...NUM, color: (a.open_deals ?? 0) > 0 ? AMBER : 'var(--txt3)' }}>
          {fmtNum(a.open_deals ?? 0)}
        </span>
      ),
    },
    ...(isHead ? [{
      key: 'account_manager_name' as keyof Account, label: 'Account Manager', sortable: true,
      render: (a: Account) => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.account_manager_name ?? '—'}</span>,
    }] : []),
    {
      key: '_actions' as keyof Account, label: '', sortable: false,
      render: (a: Account) => <ActionRow actions={[
        { icon: 'person_search', label: 'View C360',    onClick: () => navigate(`/customer360/${a.id}`) },
        { icon: 'add_circle',    label: 'New Deal',     onClick: () => navigate(`/sales/crm?contact=${a.id}`) },
        { icon: 'history',       label: 'Activity Log', onClick: () => navigate(`/customer360/${a.id}?tab=activities`) },
      ]} />,
    },
  ]

  return (
    <Page
      title={isHead ? 'All Accounts' : 'My Accounts'}
      subtitle={`${fmtNum(filtered.length)} customer${filtered.length !== 1 ? 's' : ''}`}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Accounts"     value={fmtNum(filtered.length)}                                icon="contacts"        accent={NAVY}                      loading={loading} />
        <KpiCard label="Active Loans"       value={fmtNum(totalActiveLoans)}                              icon="account_balance" accent={NAVY}                      loading={loading} />
        <KpiCard label="Loan Outstanding"   value={totalOutstanding > 0 ? fmtKobo(totalOutstanding) : '—'} icon="payments"      accent={NAVY}                      loading={loading} />
        <KpiCard label="FD Book Value"      value={totalFDValue > 0 ? fmtKobo(totalFDValue) : '—'}        icon="savings"        accent={GREEN}                     loading={loading} />
        <KpiCard label="At Risk (DPD 30+)"  value={fmtNum(atRisk)}                                        icon="warning"        accent={atRisk > 0 ? RED : GREEN}  loading={loading} />
      </div>

      {/* DPD health bar */}
      {accounts.length > 0 && (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--bdr)',
          borderRadius: RADIUS.xl, padding: '14px 18px', marginBottom: SP[4],
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--txt3)', whiteSpace: 'nowrap' }}>Portfolio Health</span>
          <div style={{ flex: 1, display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', gap: 1 }}>
            {[
              { count: dpd0,   color: GREEN,   label: 'Current' },
              { count: dpd30,  color: '#F59E0B', label: 'DPD 1–29' },
              { count: dpd30p, color: AMBER,   label: 'DPD 30–89' },
              { count: dpd90p, color: RED,     label: 'DPD 90+' },
            ].filter(b => b.count > 0).map(b => (
              <div
                key={b.label}
                title={`${b.label}: ${b.count}`}
                style={{ flex: b.count, background: b.color, minWidth: 4 }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
            {[
              { count: dpd0,   color: GREEN,    label: 'Current' },
              { count: dpd30,  color: '#F59E0B', label: '1–29' },
              { count: dpd30p, color: AMBER,    label: '30–89' },
              { count: dpd90p, color: RED,      label: '90+' },
            ].map(b => (
              <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{b.label}</span>
                <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, color: b.color }}>{b.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <SectionCard title="Accounts" badge={accounts.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          placeholder="Search by name, CIF, employer…"
          groups={[
            {
              key: 'dpd',
              label: 'DPD Status',
              options: [
                { value: 'current',   label: 'Current',   color: GREEN,    count: dpd0 },
                { value: 'dpd_1_29',  label: 'DPD 1–29',  color: '#F59E0B', count: dpd30 },
                { value: 'dpd_30_89', label: 'DPD 30–89', color: AMBER,    count: dpd30p },
                { value: 'dpd_90p',   label: 'DPD 90+',   color: RED,      count: dpd90p },
              ],
              selected: fDPD,
              onChange: setFDPD,
            },
            ...(isHead ? [{
              key: 'am',
              label: 'Account Manager',
              options: uniqueAMs.map(name => ({ value: name, avatarName: name })),
              selected: fAMs,
              onChange: setFAMs,
            }] : []),
          ]}
          onReset={() => { setSearch(''); setFDPD(new Set()); setFAMs(new Set()) }}
          resultCount={filtered.length}
          totalCount={accounts.length}
        />

        <DataTable<Account>
          cols={cols}
          rows={filtered}
          loading={loading}
          skeletonRows={8}
          emptyText={isHead ? 'No customer accounts yet' : 'No accounts assigned to you yet — converted leads will appear here'}
          keyFn={a => a.id}
          onRowClick={a => navigate(`/customer360/${a.id}`)}
          pageSize={25}
        />
      </SectionCard>
    </Page>
  )
}
