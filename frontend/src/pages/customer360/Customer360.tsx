import { snake } from '../../lib/labels'
import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import { fmt, fmtDate, fmtExact } from '../../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, Page, NAVY, RED } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────
interface SearchResult {
  cif: string; name: string; phone?: string; email?: string; product?: string; status?: string
}

interface Product { id: string; product_name?: string; name_on_card?: string; account_status?: string; account_manager?: string }
interface Transaction { id?: string; transaction_date: string; description?: string; merchant_name?: string; amount: number; type?: string }
interface LoanApp { id: string; reference: string; stage: string; amount_requested_kobo: number; created_at: string; updated_at?: string }
interface Collection { id: string; date: string; agent?: string; amount: number; mode_of_payment?: string; payment_receipt?: string }
interface RecoveryCase { id: string; legal_stage?: string; status?: string; recovery_amount?: number; recovery_date?: string }

interface FinancialSummary {
  dpd_bucket?: string
  recovery_outstanding_kobo?: number
  loan_approved_kobo?: number
}

interface CustomerProfile {
  account: {
    cif: string; first_name?: string; last_name?: string; full_name?: string
    email?: string; phone?: string; job_title?: string; state?: string
    account_created_date?: string; status?: string
  }
  products: Product[]
  recent_transactions: Transaction[]
  loan_applications: LoanApp[]
  recovery_cases: RecoveryCase[]
  financial_summary?: FinancialSummary
  transactions?: Transaction[]
  loan_apps?: LoanApp[]
}

const TABS = ['Overview', 'Transactions', 'Loans', 'Collections', 'Recovery'] as const
type Tab = typeof TABS[number]

export default function Customer360() {
  const [query, setQuery]           = useState('')
  const [results, setResults]       = useState<SearchResult[]>([])
  const [searching, setSearching]   = useState(false)
  const [searchErr, setSearchErr]   = useState('')

  const [selected, setSelected]     = useState<string | null>(null)
  const [profile, setProfile]       = useState<CustomerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileErr, setProfileErr] = useState('')

  const [activeTab, setActiveTab]   = useState<Tab>('Overview')
  const [txPage, setTxPage]         = useState(0)
  const [transactions, setTx]       = useState<Transaction[]>([])
  const [txLoading, setTxLoading]   = useState(false)
  const [txSortKey, setTxSortKey]   = useState<string | null>(null)
  const [txSortDir, setTxSortDir]   = useState<'asc' | 'desc'>('asc')

  const toggleTxSort = (key: string) => {
    if (txSortKey === key) setTxSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setTxSortKey(key); setTxSortDir('asc') }
  }
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(false)
  const limit = 50

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true); setSearchErr('')
      try {
        const res = await apiFetch<SearchResult[]>(`/api/customer360/search?q=${encodeURIComponent(query)}`)
        setResults(Array.isArray(res) ? res : [])
      } catch (e: any) {
        setSearchErr(e.message)
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  async function loadProfile(cif: string) {
    setSelected(cif); setProfileLoading(true); setProfileErr(''); setActiveTab('Overview')
    try {
      const res = await apiFetch<CustomerProfile>(`/api/customer360/${cif}`)
      setProfile(res)
    } catch (e: any) {
      setProfileErr(e.message)
    } finally {
      setProfileLoading(false)
    }
  }

  async function loadTransactions(cif: string, page: number) {
    setTxLoading(true)
    try {
      const res = await apiFetch<{ data: Transaction[] }>(
        `/api/customer360/${cif}/transactions?limit=${limit}&offset=${page * limit}`
      )
      setTx(res.data ?? [])
    } catch { /* ignore, profile already shown */ }
    finally { setTxLoading(false) }
  }

  async function loadCollections(cif: string) {
    setCollectionsLoading(true)
    try {
      const res = await apiFetch<{ data: Collection[] } | Collection[]>(
        `/api/collections-ops/queue?account_cif=${cif}`
      )
      setCollections(Array.isArray(res) ? res : (res.data ?? []))
    } catch { /* ignore */ }
    finally { setCollectionsLoading(false) }
  }

  useEffect(() => {
    if (activeTab === 'Transactions' && selected) {
      loadTransactions(selected, txPage)
    }
    if (activeTab === 'Collections' && selected) {
      loadCollections(selected)
    }
  }, [activeTab, txPage, selected])

  const displayName = profile
    ? (profile.account.full_name || `${profile.account.first_name ?? ''} ${profile.account.last_name ?? ''}`.trim())
    : ''

  return (
    <Page title="Customer 360" subtitle="Unified customer profile — search by name, CIF, or phone">
      {/* Search bar */}
      <div className="card p-4 mb-5">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <span className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[18px]" style={{ color: 'var(--txt2)' }}>search</span>
            <input
              className="w-full pl-9 pr-4 py-2.5 rounded-lg border border-[var(--bdr)] text-[14px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
              placeholder="Search by name, CIF number, or phone…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2"><Spinner size={16} /></span>}
          </div>
        </div>
        <ErrBanner msg={searchErr} />
      </div>

      <div className="flex gap-5 flex-col xl:flex-row">
        {/* Results list */}
        {results.length > 0 && (
          <div className="xl:w-72 flex-shrink-0">
            <div className="card overflow-hidden">
              <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--bdr)' }}>
                <p className="text-[12px] font-semibold" style={{ color: 'var(--txt2)' }}>{results.length} result{results.length !== 1 ? 's' : ''}</p>
              </div>
              <div className="divide-theme max-h-[60vh] overflow-y-auto">
                {results.map(r => (
                  <button
                    key={r.cif}
                    className="w-full text-left px-4 py-3 tbl-row transition-colors"
                    style={{ background: selected === r.cif ? 'var(--row-hvr)' : undefined }}
                    onClick={() => loadProfile(r.cif)}
                  >
                    <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>{r.name}</p>
                    <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--txt2)' }}>{r.cif}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {r.product && <span className="text-[11px] capitalize" style={{ color: 'var(--txt2)' }}>{snake(r.product)}</span>}
                      {r.status && <StatusBadge status={r.status} />}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Profile */}
        {selected && (
          <div className="flex-1 min-w-0">
            {profileLoading ? (
              <div className="flex items-center justify-center py-20"><Spinner size={36} /></div>
            ) : profileErr ? (
              <ErrBanner msg={profileErr} />
            ) : profile ? (
              <>
                {/* Profile header */}
                <div className="card p-5 mb-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <div
                      className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-[18px] flex-shrink-0"
                      style={{ background: NAVY }}
                    >
                      {displayName.charAt(0)}
                    </div>
                    <div className="flex-1">
                      <h2 className="text-[18px] font-bold" style={{ color: 'var(--txt)' }}>{displayName}</h2>
                      <div className="flex flex-wrap gap-3 mt-1">
                        <span className="text-[12px] font-mono" style={{ color: 'var(--txt2)' }}>{profile.account.cif}</span>
                        {profile.account.phone && <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{profile.account.phone}</span>}
                        {profile.account.email && <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{profile.account.email}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {profile.account.status && <StatusBadge status={profile.account.status} />}
                      {/* Quick actions */}
                      <a
                        href={`/helpdesk?cif=${profile.account.cif}`}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all"
                        style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}>
                        <span className="material-symbols-rounded text-[14px]">confirmation_number</span>
                        New Ticket
                      </a>
                      <a
                        href={`/collections-ops?account_cif=${profile.account.cif}`}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all"
                        style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}>
                        <span className="material-symbols-rounded text-[14px]">handshake</span>
                        Log Promise
                      </a>
                      {profile.account.phone && (
                        <a
                          href={`tel:${profile.account.phone}`}
                          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold border transition-all"
                          style={{ borderColor: 'rgba(14,40,65,0.2)', color: NAVY }}>
                          <span className="material-symbols-rounded text-[14px]">call</span>
                          Call
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Financial summary strip */}
                  {profile.financial_summary && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4" style={{ borderTop: '1px solid var(--bdr)' }}>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>DPD Bucket</p>
                        <p className="text-[15px] font-bold mt-0.5" style={{
                          color: profile.financial_summary.dpd_bucket && profile.financial_summary.dpd_bucket !== 'current'
                            ? RED : '#059669'
                        }}>
                          {profile.financial_summary.dpd_bucket ?? '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>Recovery Outstanding</p>
                        <p className="text-[15px] font-bold mt-0.5 font-mono" style={{ color: NAVY }}>
                          {profile.financial_summary.recovery_outstanding_kobo != null
                            ? fmt(profile.financial_summary.recovery_outstanding_kobo / 100)
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>Latest Loan Limit</p>
                        <p className="text-[15px] font-bold mt-0.5 font-mono" style={{ color: NAVY }}>
                          {profile.financial_summary.loan_approved_kobo != null
                            ? fmt(profile.financial_summary.loan_approved_kobo / 100)
                            : '—'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>Last Transaction</p>
                        <p className="text-[15px] font-bold mt-0.5" style={{ color: NAVY }}>
                          {profile.transactions?.[0]
                            ? fmtDate((profile.transactions[0] as any)['Transaction_Date'] ?? (profile.transactions[0] as any)['transaction_date'])
                            : '—'}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Tabs */}
                <div className="flex gap-0 border-b mb-4" style={{ borderColor: 'var(--bdr)' }}>
                  {TABS.map(t => (
                    <button key={t} onClick={() => setActiveTab(t)}
                      className="px-4 py-2.5 text-[13px] font-semibold border-b-2 -mb-px transition-colors"
                      style={{ borderColor: activeTab === t ? NAVY : 'transparent', color: activeTab === t ? NAVY : '#94A3B8' }}>
                      {t}
                    </button>
                  ))}
                </div>

                {/* Overview */}
                {activeTab === 'Overview' && (
                  <div className="space-y-4">
                    <div className="card p-5">
                      <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] mb-4" style={{ color: 'var(--txt2)' }}>Account Details</h3>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                        {[
                          ['Job Title', profile.account.job_title ?? '—'],
                          ['State', profile.account.state ?? '—'],
                          ['Member Since', fmtDate(profile.account.account_created_date)],
                        ].map(([k, v]) => (
                          <div key={k}>
                            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>{k}</p>
                            <p className="text-[13.5px] mt-0.5" style={{ color: 'var(--txt)' }}>{v}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                    {profile.products.length > 0 && (
                      <div className="card overflow-hidden">
                        <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--bdr)' }}>
                          <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>Products ({profile.products.length})</p>
                        </div>
                        <div className="divide-theme">
                          {profile.products.map(p => (
                            <div key={p.id} className="px-5 py-3 flex items-center justify-between">
                              <div>
                                <p className="text-[13px] font-semibold capitalize" style={{ color: 'var(--txt)' }}>{snake(p.product_name ?? '')}</p>
                                {p.name_on_card && <p className="text-[11px]" style={{ color: 'var(--txt2)' }}>{p.name_on_card}</p>}
                              </div>
                              <div className="flex items-center gap-2">
                                {p.account_manager && <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{p.account_manager}</span>}
                                {p.account_status && <StatusBadge status={p.account_status} />}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Transactions */}
                {activeTab === 'Transactions' && (
                  <div className="card overflow-hidden">
                    {txLoading ? (
                      <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                                {([['Date','transaction_date'],['Description',null],['Amount','amount'],['Type','type']] as [string, string|null][]).map(([h, k]) => (
                                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]"
                                    style={{ color: txSortKey === k ? 'var(--txt)' : 'var(--txt2)', cursor: k ? 'pointer' : undefined }}
                                    onClick={k ? () => toggleTxSort(k) : undefined}>
                                    {h}{k && <span style={{ marginLeft: 3, color: '#C00000', opacity: txSortKey === k ? 1 : 0.3 }}>{txSortKey === k ? (txSortDir === 'asc' ? '↑' : '↓') : '↕'}</span>}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                const sortedTx = txSortKey
                                  ? [...transactions].sort((a, b) => {
                                      const va = (a as any)[txSortKey] ?? ''
                                      const vb = (b as any)[txSortKey] ?? ''
                                      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))
                                      return txSortDir === 'asc' ? cmp : -cmp
                                    })
                                  : transactions
                                return sortedTx.length === 0 ? (
                                  <tr><td colSpan={4} className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No transactions</td></tr>
                                ) : sortedTx.map((t, i) => (
                                <tr key={i} className="tbl-row" style={{ borderBottom: '1px solid var(--bdr)' }}>
                                  <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{fmtDate(t.transaction_date)}</td>
                                  <td className="px-4 py-3" style={{ color: 'var(--txt)' }}>{t.description ?? t.merchant_name ?? '—'}</td>
                                  <td className="px-4 py-3 font-mono"
                                    style={{ color: (t.type ?? '').toLowerCase().includes('credit') ? '#059669' : '#C00000' }}>
                                    {fmtExact(t.amount)}
                                  </td>
                                  <td className="px-4 py-3 capitalize" style={{ color: 'var(--txt2)' }}>{t.type ?? '—'}</td>
                                </tr>
                                ))
                              })()}
                            </tbody>
                          </table>
                        </div>
                        <div className="flex justify-between items-center px-4 py-3" style={{ borderTop: '1px solid var(--bdr)' }}>
                          <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>Page {txPage + 1}</span>
                          <div className="flex gap-2">
                            <button disabled={txPage === 0} onClick={() => setTxPage(p => p - 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40">Prev</button>
                            <button disabled={transactions.length < limit} onClick={() => setTxPage(p => p + 1)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40">Next</button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Loans */}
                {activeTab === 'Loans' && (
                  <div className="card overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                            {['Reference','Stage','Amount','Date'].map(h => (
                              <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--txt2)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(profile.loan_applications ?? []).length === 0 ? (
                            <tr><td colSpan={4} className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No loan applications</td></tr>
                          ) : profile.loan_applications.map(l => (
                            <tr key={l.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                              <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{l.reference}</td>
                              <td className="px-4 py-3"><StatusBadge status={l.stage} /></td>
                              <td className="px-4 py-3 font-mono" style={{ color: 'var(--txt)' }}>{fmt(l.amount_requested_kobo / 100)}</td>
                              <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{fmtDate(l.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Collections */}
                {activeTab === 'Collections' && (
                  <div className="card overflow-hidden">
                    {collectionsLoading ? (
                      <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                          <thead>
                            <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                              {['Date','Agent','Amount','Mode','Receipt'].map(h => (
                                <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--txt2)' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {collections.length === 0 ? (
                              <tr><td colSpan={5} className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No collections history found</td></tr>
                            ) : collections.map(c => (
                              <tr key={c.id} className="tbl-row" style={{ borderBottom: '1px solid var(--bdr)' }}>
                                <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{fmtDate(c.date)}</td>
                                <td className="px-4 py-3" style={{ color: 'var(--txt)' }}>{c.agent ?? '—'}</td>
                                <td className="px-4 py-3 font-mono" style={{ color: 'var(--txt)' }}>{fmt(c.amount / 100)}</td>
                                <td className="px-4 py-3 capitalize" style={{ color: 'var(--txt2)' }}>{c.mode_of_payment ?? '—'}</td>
                                <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{c.payment_receipt ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Recovery */}
                {activeTab === 'Recovery' && (
                  <div className="card overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                            {['ID','Legal Stage','Status','Amount','Date'].map(h => (
                              <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--txt2)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(profile.recovery_cases ?? []).length === 0 ? (
                            <tr><td colSpan={5} className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No recovery cases</td></tr>
                          ) : profile.recovery_cases.map(r => (
                            <tr key={r.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                              <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{r.id}</td>
                              <td className="px-4 py-3 capitalize" style={{ color: 'var(--txt2)' }}>{r.legal_stage ?? '—'}</td>
                              <td className="px-4 py-3"><StatusBadge status={r.status ?? 'pending'} /></td>
                              <td className="px-4 py-3 font-mono" style={{ color: 'var(--txt)' }}>{r.recovery_amount ? fmt(r.recovery_amount / 100) : '—'}</td>
                              <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{fmtDate(r.recovery_date)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {!selected && results.length === 0 && (
          <div className="flex-1 flex items-center justify-center py-20 text-center">
            <div>
              <span className="material-symbols-rounded text-[48px] block mb-3" style={{ color: 'var(--bdr)' }}>manage_search</span>
              <p className="text-[14px]" style={{ color: 'var(--txt2)' }}>Search for a customer above to view their profile</p>
            </div>
          </div>
        )}
      </div>
    </Page>
  )
}
