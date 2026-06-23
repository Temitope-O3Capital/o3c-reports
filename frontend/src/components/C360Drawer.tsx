import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import { fmt, fmtDate, fmtExact } from '../lib/fmt'
import { Spinner, ErrBanner, StatusBadge, NAVY, GREEN, RED } from './UI'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  cif: string
  name: string
  phone?: string
  email?: string
  status?: string
}

interface Product {
  id: string
  product_name?: string
  name_on_card?: string
  account_status?: string
  account_manager?: string
}

interface Transaction {
  id?: string
  transaction_date: string
  description?: string
  merchant_name?: string
  amount: number
  type?: string
}

interface LoanApp {
  id: string
  reference: string
  stage: string
  amount_requested_kobo: number
  created_at: string
}

interface CollectionRecord {
  id: string
  contact_type?: string
  outcome?: string
  agent?: string
  next_action_date?: string
  notes?: string
  date: string
  amount?: number
  mode_of_payment?: string
}

interface RecoveryCase {
  id: string
  legal_stage?: string
  status?: string
  recovery_amount?: number
  recovery_date?: string
}

interface CustomerProfile {
  account: {
    cif: string
    first_name?: string
    last_name?: string
    full_name?: string
    email?: string
    phone?: string
    job_title?: string
    state?: string
    account_created_date?: string
    status?: string
  }
  products: Product[]
  recent_transactions: Transaction[]
  loan_applications: LoanApp[]
  recovery_cases: RecoveryCase[]
}

interface Ticket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  assigned_to_name: string | null
  created_at: string
}

interface Call {
  id: number
  direction?: string
  outcome?: string
  agent_name?: string
  duration_sec?: number
  started_at?: string
  created_at?: string
  notes?: string
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface C360DrawerProps {
  open: boolean
  onClose: () => void
  initialCif?: string | null
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = ['Overview', 'Transactions', 'Loans', 'Collections', 'Tickets', 'Calls'] as const
type Tab = typeof TABS[number]

// ── Log Call Modal ────────────────────────────────────────────────────────────

function LogCallModal({
  cif,
  email,
  onClose,
}: {
  cif: string
  email?: string
  onClose: () => void
}) {
  const [direction, setDirection] = useState('inbound')
  const [outcome, setOutcome] = useState('answered')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      await apiFetch('/api/helpdesk/calls', {
        method: 'POST',
        body: JSON.stringify({ customer_cif: cif, customer_email: email, direction, outcome, notes }),
      })
      onClose()
    } catch (ex: any) {
      setErr(ex.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-bold text-slate-800 mb-4">Log Call</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Direction</label>
            <select
              value={direction}
              onChange={e => setDirection(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            >
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Outcome</label>
            <select
              value={outcome}
              onChange={e => setOutcome(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            >
              <option value="answered">Answered</option>
              <option value="no_answer">No Answer</option>
              <option value="voicemail">Voicemail</option>
              <option value="busy">Busy</option>
              <option value="callback_requested">Callback Requested</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-none"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
              placeholder="Call summary…"
            />
          </div>
          <ErrBanner msg={err} />
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
              style={{ background: NAVY }}
            >
              {saving ? <Spinner size={14} /> : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Drawer ───────────────────────────────────────────────────────────────

export default function C360Drawer({ open, onClose, initialCif }: C360DrawerProps) {
  // Search state
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Profile state
  const [cif, setCif] = useState<string | null>(initialCif ?? null)
  const [profile, setProfile] = useState<CustomerProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileErr, setProfileErr] = useState('')

  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>('Overview')

  // Tab-specific data
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [txLoading, setTxLoading] = useState(false)
  const [txPage, setTxPage] = useState(0)
  const txLimit = 50

  const [collections, setCollections] = useState<CollectionRecord[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(false)

  const [tickets, setTickets] = useState<Ticket[]>([])
  const [ticketsLoading, setTicketsLoading] = useState(false)

  const [calls, setCalls] = useState<Call[]>([])
  const [callsLoading, setCallsLoading] = useState(false)

  // Quick action state
  const [logCallOpen, setLogCallOpen] = useState(false)
  const [creatingTicket, setCreatingTicket] = useState(false)

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    if (open) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Load profile when initialCif changes
  useEffect(() => {
    if (initialCif) {
      setCif(initialCif)
      loadProfile(initialCif)
    }
  }, [initialCif])

  // Debounced search
  const handleQueryChange = useCallback((val: string) => {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!val.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      setSearchErr('')
      try {
        const res = await apiFetch<SearchResult[]>(`/api/customer360/search?q=${encodeURIComponent(val)}`)
        setResults(Array.isArray(res) ? res : [])
      } catch (ex: any) {
        setSearchErr(ex.message)
      } finally {
        setSearching(false)
      }
    }, 200)
  }, [])

  async function loadProfile(selectedCif: string) {
    setCif(selectedCif)
    setProfileLoading(true)
    setProfileErr('')
    setActiveTab('Overview')
    setTransactions([])
    setCollections([])
    setTickets([])
    setCalls([])
    try {
      const [profileData] = await Promise.all([
        apiFetch<CustomerProfile>(`/api/customer360/${selectedCif}`),
      ])
      setProfile(profileData)
    } catch (ex: any) {
      setProfileErr(ex.message)
    } finally {
      setProfileLoading(false)
    }
  }

  function selectResult(r: SearchResult) {
    setResults([])
    setQuery('')
    loadProfile(r.cif)
  }

  function backToSearch() {
    setCif(null)
    setProfile(null)
    setProfileErr('')
    setResults([])
    setQuery('')
    setActiveTab('Overview')
  }

  // Load tab data on tab switch
  useEffect(() => {
    if (!cif) return
    if (activeTab === 'Transactions') {
      loadTransactions(cif, txPage)
    }
    if (activeTab === 'Collections') {
      loadCollections(cif)
    }
    if (activeTab === 'Tickets') {
      loadTickets(cif)
    }
    if (activeTab === 'Calls') {
      loadCalls(cif)
    }
  }, [activeTab, cif, txPage])

  async function loadTransactions(selectedCif: string, page: number) {
    setTxLoading(true)
    try {
      const res = await apiFetch<{ data: Transaction[] }>(
        `/api/customer360/${selectedCif}/transactions?limit=${txLimit}&offset=${page * txLimit}`
      )
      setTransactions(res.data ?? [])
    } catch {
      // non-fatal
    } finally {
      setTxLoading(false)
    }
  }

  async function loadCollections(selectedCif: string) {
    setCollectionsLoading(true)
    try {
      const res = await apiFetch<CollectionRecord[] | { data: CollectionRecord[] }>(
        `/api/customer360/${selectedCif}/collections`
      )
      setCollections(Array.isArray(res) ? res : (res.data ?? []))
    } catch {
      // non-fatal
    } finally {
      setCollectionsLoading(false)
    }
  }

  async function loadTickets(selectedCif: string) {
    setTicketsLoading(true)
    try {
      const res = await apiFetch<{ data?: Ticket[]; tickets?: Ticket[] } | Ticket[]>(
        `/api/helpdesk/tickets?customer_cif=${selectedCif}&per_page=25`
      )
      setTickets(Array.isArray(res) ? res : (res.tickets ?? res.data ?? []))
    } catch {
      // non-fatal
    } finally {
      setTicketsLoading(false)
    }
  }

  async function loadCalls(selectedCif: string) {
    setCallsLoading(true)
    try {
      const res = await apiFetch<Call[] | { data: Call[] }>(
        `/api/helpdesk/calls?customer_cif=${selectedCif}`
      )
      setCalls(Array.isArray(res) ? res : (res.data ?? []))
    } catch {
      // non-fatal
    } finally {
      setCallsLoading(false)
    }
  }

  async function openTicket() {
    if (!cif || !profile) return
    setCreatingTicket(true)
    try {
      await apiFetch('/api/helpdesk/tickets', {
        method: 'POST',
        body: JSON.stringify({
          customer_cif: cif,
          customer_name: displayName,
          subject: `Query for ${displayName}`,
          channel: 'in-app',
          message_text: `Customer service ticket opened for ${displayName}.`,
        }),
      })
      setActiveTab('Tickets')
      loadTickets(cif)
    } catch {
      // non-fatal
    } finally {
      setCreatingTicket(false)
    }
  }

  const displayName = profile
    ? (profile.account.full_name ||
       `${profile.account.first_name ?? ''} ${profile.account.last_name ?? ''}`.trim())
    : ''

  const initials = displayName
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  // KPI derived values
  const openLoans = profile
    ? profile.loan_applications.filter(l => !['completed', 'rejected', 'cancelled'].includes(l.stage)).length
    : 0

  const spentThisMonth = (() => {
    if (!profile) return 0
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    return profile.recent_transactions
      .filter(t => t.transaction_date?.startsWith(thisMonth) && (t.type ?? '').toLowerCase().includes('debit'))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0)
  })()

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity duration-200"
        style={{
          background: 'rgba(0,0,0,0.35)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col bg-white shadow-2xl transition-transform duration-200"
        style={{
          width: 'min(680px, 100vw)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          borderLeft: '1px solid rgba(15,23,42,0.08)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Customer 360"
      >
        {/* ── Search screen ── */}
        {!cif && (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4 flex-shrink-0"
              style={{ background: NAVY, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
            >
              <div>
                <h2 className="text-[15px] font-bold text-white">Customer 360</h2>
                <p className="text-[12px] mt-0.5" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  Search by name, CIF, phone, or email
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                aria-label="Close"
              >
                <span className="material-symbols-rounded text-[18px] text-white">close</span>
              </button>
            </div>

            {/* Search input */}
            <div className="px-5 py-4 flex-shrink-0" style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
              <div className="relative">
                <span className="material-symbols-rounded text-[18px] absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                  search
                </span>
                <input
                  autoFocus
                  className="w-full pl-9 pr-4 py-3 rounded-xl border text-[14px] outline-none focus:ring-2"
                  style={{
                    borderColor: 'rgba(15,23,42,0.15)',
                  }}
                  placeholder="Search by name, CIF, phone, or email…"
                  value={query}
                  onChange={e => handleQueryChange(e.target.value)}
                />
                {searching && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Spinner size={16} />
                  </span>
                )}
              </div>
              <ErrBanner msg={searchErr} />
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {results.length === 0 && !searching && query && (
                <div className="py-16 text-center">
                  <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">person_off</span>
                  <p className="text-[13px] text-slate-400">No customers found</p>
                </div>
              )}

              {results.length === 0 && !query && (
                <div className="py-20 text-center">
                  <span className="material-symbols-rounded text-[48px] text-slate-300 block mb-3">manage_search</span>
                  <p className="text-[14px] text-slate-400">Start typing to search for a customer</p>
                </div>
              )}

              {results.length > 0 && (
                <div>
                  <div className="px-5 py-2" style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
                    <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      {results.length} result{results.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {results.map(r => (
                      <button
                        key={r.cif}
                        className="w-full text-left px-5 py-4 hover:bg-slate-50 transition-colors"
                        onClick={() => selectResult(r)}
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-[13px] flex-shrink-0"
                            style={{ background: NAVY }}
                          >
                            {r.name?.charAt(0)?.toUpperCase() ?? '?'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold text-slate-800">{r.name}</p>
                            <div className="flex items-center gap-3 mt-0.5">
                              <span className="text-[11px] font-mono text-slate-400">{r.cif}</span>
                              {r.phone && <span className="text-[11px] text-slate-400">{r.phone}</span>}
                            </div>
                          </div>
                          {r.status && <StatusBadge status={r.status} />}
                          <span className="material-symbols-rounded text-[16px] text-slate-300">chevron_right</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Customer profile screen ── */}
        {cif && (
          <div className="flex flex-col h-full">
            {/* Profile header (navy strip) */}
            <div className="flex-shrink-0" style={{ background: NAVY }}>
              <div className="flex items-center gap-3 px-5 py-4">
                <button
                  onClick={backToSearch}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors flex-shrink-0"
                  aria-label="Back to search"
                >
                  <span className="material-symbols-rounded text-[18px] text-white">arrow_back</span>
                </button>

                {profileLoading ? (
                  <div className="flex-1 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-white/20 animate-pulse" />
                    <div className="space-y-1.5">
                      <div className="w-36 h-3 bg-white/20 rounded animate-pulse" />
                      <div className="w-24 h-2.5 bg-white/15 rounded animate-pulse" />
                    </div>
                  </div>
                ) : profile ? (
                  <div className="flex-1 flex items-center gap-3 min-w-0">
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-[15px] flex-shrink-0"
                      style={{ background: 'rgba(255,255,255,0.18)' }}
                    >
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-[15px] font-bold text-white truncate">{displayName}</h2>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] font-mono" style={{ color: 'rgba(255,255,255,0.55)' }}>
                          {profile.account.cif}
                        </span>
                        {profile.account.phone && (
                          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                            {profile.account.phone}
                          </span>
                        )}
                      </div>
                    </div>
                    {profile.account.status && <StatusBadge status={profile.account.status} />}
                  </div>
                ) : null}

                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors flex-shrink-0"
                  aria-label="Close"
                >
                  <span className="material-symbols-rounded text-[18px] text-white">close</span>
                </button>
              </div>

              {/* Quick actions bar */}
              {profile && !profileLoading && (
                <div
                  className="flex items-center gap-2 px-5 py-2.5"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <button
                    onClick={openTicket}
                    disabled={creatingTicket}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors disabled:opacity-60"
                    style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}
                  >
                    <span className="material-symbols-rounded text-[14px]">add_circle</span>
                    {creatingTicket ? 'Opening…' : 'Open Ticket'}
                  </button>
                  <button
                    onClick={() => setLogCallOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
                    style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}
                  >
                    <span className="material-symbols-rounded text-[14px]">call</span>
                    Log Call
                  </button>
                  {profile.account.email && (
                    <a
                      href={`/mail/compose?to=${encodeURIComponent(profile.account.email)}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors"
                      style={{ background: 'rgba(255,255,255,0.12)', color: '#fff' }}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="material-symbols-rounded text-[14px]">mail</span>
                      Send Email
                    </a>
                  )}
                </div>
              )}

              {/* Tabs */}
              {profile && !profileLoading && (
                <div className="flex gap-0 px-2 overflow-x-auto" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  {TABS.map(t => (
                    <button
                      key={t}
                      onClick={() => setActiveTab(t)}
                      className="px-4 py-2.5 text-[12.5px] font-semibold border-b-2 whitespace-nowrap transition-colors"
                      style={{
                        borderColor: activeTab === t ? '#fff' : 'transparent',
                        color: activeTab === t ? '#fff' : 'rgba(255,255,255,0.5)',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto bg-slate-50/50">
              {profileLoading && (
                <div className="flex items-center justify-center py-20">
                  <Spinner size={32} />
                </div>
              )}

              {profileErr && (
                <div className="px-5 py-4">
                  <ErrBanner msg={profileErr} />
                </div>
              )}

              {profile && !profileLoading && (
                <div className="p-5">
                  {/* ── Overview ── */}
                  {activeTab === 'Overview' && (
                    <div className="space-y-4">
                      {/* KPI cards */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[
                          { label: 'Total Products', value: profile.products.length, icon: 'credit_card' },
                          { label: 'Open Loans', value: openLoans, icon: 'account_balance' },
                          { label: 'Spent This Month', value: fmt(spentThisMonth / 100), icon: 'payments' },
                          { label: 'Transactions', value: profile.recent_transactions.length, icon: 'receipt_long' },
                        ].map(k => (
                          <div
                            key={k.label}
                            className="bg-white rounded-xl p-4 border"
                            style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <span
                                className="material-symbols-rounded text-[15px]"
                                style={{ color: NAVY }}
                              >
                                {k.icon}
                              </span>
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                {k.label}
                              </p>
                            </div>
                            <p className="text-[20px] font-bold text-slate-900 font-mono">{k.value}</p>
                          </div>
                        ))}
                      </div>

                      {/* Two-column detail */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Account details */}
                        <div
                          className="bg-white rounded-xl p-4 border"
                          style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                        >
                          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">
                            Account Details
                          </h3>
                          <div className="space-y-2.5">
                            {[
                              ['Email', profile.account.email],
                              ['Phone', profile.account.phone],
                              ['State', profile.account.state],
                              ['Job Title', profile.account.job_title],
                              ['Member Since', fmtDate(profile.account.account_created_date)],
                            ].filter(([, v]) => v).map(([k, v]) => (
                              <div key={k as string}>
                                <p className="text-[10.5px] font-semibold text-slate-400 uppercase tracking-wider">{k}</p>
                                <p className="text-[13px] text-slate-700 mt-0.5">{v as string}</p>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Recent activity */}
                        <div
                          className="bg-white rounded-xl p-4 border"
                          style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                        >
                          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">
                            Recent Activity
                          </h3>
                          {profile.recent_transactions.length === 0 ? (
                            <p className="text-[12px] text-slate-400">No recent transactions</p>
                          ) : (
                            <div className="space-y-2.5">
                              {profile.recent_transactions.slice(0, 5).map((t, i) => {
                                const isCredit = (t.type ?? '').toLowerCase().includes('credit')
                                return (
                                  <div key={i} className="flex items-center justify-between">
                                    <div className="min-w-0">
                                      <p className="text-[12px] text-slate-700 truncate">
                                        {t.description ?? t.merchant_name ?? '—'}
                                      </p>
                                      <p className="text-[10.5px] text-slate-400">{fmtDate(t.transaction_date)}</p>
                                    </div>
                                    <span
                                      className="font-mono text-[12px] font-semibold ml-2 flex-shrink-0"
                                      style={{ color: isCredit ? GREEN : RED }}
                                    >
                                      {isCredit ? '+' : '-'}{fmtExact(Math.abs(t.amount))}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Transactions ── */}
                  {activeTab === 'Transactions' && (
                    <div
                      className="bg-white rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                    >
                      {txLoading ? (
                        <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                      ) : (
                        <>
                          <div className="overflow-x-auto">
                            <table className="w-full text-[13px]">
                              <thead>
                                <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                                  {['Date', 'Description', 'Amount', 'Type'].map(h => (
                                    <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {transactions.length === 0 ? (
                                  <tr>
                                    <td colSpan={4} className="px-4 py-10 text-center text-slate-400 text-[13px]">
                                      No transactions
                                    </td>
                                  </tr>
                                ) : transactions.map((t, i) => {
                                  const isCredit = (t.type ?? '').toLowerCase().includes('credit')
                                  return (
                                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/60">
                                      <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{fmtDate(t.transaction_date)}</td>
                                      <td className="px-4 py-3 text-slate-700">{t.description ?? t.merchant_name ?? '—'}</td>
                                      <td className="px-4 py-3 font-mono" style={{ color: isCredit ? GREEN : RED }}>
                                        {isCredit ? '+' : '-'}{fmtExact(Math.abs(t.amount))}
                                      </td>
                                      <td className="px-4 py-3 text-slate-500 capitalize">{t.type ?? '—'}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                          <div className="flex justify-between items-center px-4 py-3 border-t border-slate-100">
                            <span className="text-[12px] text-slate-400">Page {txPage + 1}</span>
                            <div className="flex gap-2">
                              <button
                                disabled={txPage === 0}
                                onClick={() => setTxPage(p => p - 1)}
                                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
                              >
                                Prev
                              </button>
                              <button
                                disabled={transactions.length < txLimit}
                                onClick={() => setTxPage(p => p + 1)}
                                className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ── Loans ── */}
                  {activeTab === 'Loans' && (
                    <div
                      className="bg-white rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                    >
                      <div className="overflow-x-auto">
                        <table className="w-full text-[13px]">
                          <thead>
                            <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                              {['Reference', 'Product Type', 'Amount', 'Stage', 'Date'].map(h => (
                                <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(profile.loan_applications ?? []).length === 0 ? (
                              <tr>
                                <td colSpan={5} className="px-4 py-10 text-center text-slate-400 text-[13px]">
                                  No loan applications
                                </td>
                              </tr>
                            ) : profile.loan_applications.map(l => (
                              <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                                <td className="px-4 py-3 font-mono text-[12px] text-slate-600">{l.reference}</td>
                                <td className="px-4 py-3 text-slate-600">—</td>
                                <td className="px-4 py-3 font-mono text-slate-700">{fmt(l.amount_requested_kobo / 100)}</td>
                                <td className="px-4 py-3"><StatusBadge status={l.stage} /></td>
                                <td className="px-4 py-3 text-slate-500">{fmtDate(l.created_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── Collections ── */}
                  {activeTab === 'Collections' && (
                    <div
                      className="bg-white rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                    >
                      {collectionsLoading ? (
                        <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                                {['Contact Type', 'Outcome', 'Agent', 'Next Action', 'Notes'].map(h => (
                                  <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {collections.length === 0 ? (
                                <tr>
                                  <td colSpan={5} className="px-4 py-10 text-center text-slate-400 text-[13px]">
                                    No collections records
                                  </td>
                                </tr>
                              ) : collections.map(c => (
                                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                                  <td className="px-4 py-3 text-slate-600 capitalize">{c.contact_type ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-600 capitalize">{c.outcome ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-700">{c.agent ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-500">{fmtDate(c.next_action_date)}</td>
                                  <td className="px-4 py-3 text-slate-500 max-w-[200px] truncate">{c.notes ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Tickets ── */}
                  {activeTab === 'Tickets' && (
                    <div
                      className="bg-white rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                    >
                      {ticketsLoading ? (
                        <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                                {['Ref', 'Subject', 'Status', 'Agent', 'Date', ''].map(h => (
                                  <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {tickets.length === 0 ? (
                                <tr>
                                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400 text-[13px]">
                                    No tickets found
                                  </td>
                                </tr>
                              ) : tickets.map(t => (
                                <tr key={t.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                                  <td className="px-4 py-3 font-mono text-[12px] text-slate-600">{t.ticket_ref}</td>
                                  <td className="px-4 py-3 text-slate-700 max-w-[180px] truncate">{t.subject}</td>
                                  <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                                  <td className="px-4 py-3 text-slate-500">{t.assigned_to_name ?? 'Unassigned'}</td>
                                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{fmtDate(t.created_at)}</td>
                                  <td className="px-4 py-3">
                                    <a
                                      href={`/helpdesk/${t.id}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-[11px] font-semibold hover:underline"
                                      style={{ color: NAVY }}
                                    >
                                      View
                                    </a>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Calls ── */}
                  {activeTab === 'Calls' && (
                    <div
                      className="bg-white rounded-xl border overflow-hidden"
                      style={{ borderColor: 'rgba(15,23,42,0.07)' }}
                    >
                      {callsLoading ? (
                        <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-[13px]">
                            <thead>
                              <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                                {['Direction', 'Outcome', 'Agent', 'Duration', 'Date'].map(h => (
                                  <th key={h} className="px-4 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {calls.length === 0 ? (
                                <tr>
                                  <td colSpan={5} className="px-4 py-10 text-center text-slate-400 text-[13px]">
                                    No call records
                                  </td>
                                </tr>
                              ) : calls.map(c => (
                                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/60">
                                  <td className="px-4 py-3 text-slate-600 capitalize">{c.direction ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-600 capitalize">{c.outcome ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-700">{c.agent_name ?? '—'}</td>
                                  <td className="px-4 py-3 text-slate-500">
                                    {c.duration_sec != null
                                      ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s`
                                      : '—'}
                                  </td>
                                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{fmtDate(c.started_at ?? c.created_at ?? '')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Log call modal */}
      {logCallOpen && cif && (
        <LogCallModal
          cif={cif}
          email={profile?.account.email}
          onClose={() => setLogCallOpen(false)}
        />
      )}
    </>
  )
}
