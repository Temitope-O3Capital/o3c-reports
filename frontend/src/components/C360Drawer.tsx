import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtDate } from '../lib/fmt'
import { NAVY, RED, GREEN, AMBER, INTER, SORA, NUM } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SearchResult {
  cif:   string
  name:  string
  phone: string
  email: string
}

interface Account {
  account_number?: string
  account_name?:  string
  bank_name?:     string
  status?:        string
  address?:       string
}

interface Product {
  product_name?:    string
  card_type?:       string
  status?:          string
  account_manager?: string
}

interface Transaction {
  date?:        string
  description?: string
  amount_kobo?: number
  type?:        string
}

interface LoanApplication {
  reference?:           string
  product_type?:        string
  amount_requested_kobo?: number
  stage?:               string
  status?:              string
}

interface RecoveryCase {
  id?:            number
  case_ref?:      string
  outstanding_kobo?: number
  status?:        string
}

interface FinancialSummary {
  dpd_bucket?:         string | null
  loan_approved_kobo?: number
}

interface Profile {
  account?:           Account
  products?:          Product[]
  transactions?:      Transaction[]
  loan_applications?: LoanApplication[]
  recovery_cases?:    RecoveryCase[]
  financial_summary?: FinancialSummary
  cif?:               string
  name?:              string
  phone?:             string
  email?:             string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const REJECTED_STAGES = new Set(['rejected', 'cancelled', 'declined'])

function deriveKycTier(profile: Profile): 1 | 2 | 3 {
  const hasAddress = !!profile.account?.address
  const hasProducts = (profile.products?.length ?? 0) > 0
  const hasRecovery = (profile.recovery_cases?.length ?? 0) > 0
  if (!hasRecovery && hasProducts && hasAddress) return 3
  if (hasProducts && hasAddress) return 2
  return 1
}

const TIER_COLORS: Record<number, { bg: string; txt: string }> = {
  1: { bg: `${NAVY}18`, txt: NAVY },
  2: { bg: `${AMBER}20`, txt: AMBER },
  3: { bg: `${GREEN}18`, txt: GREEN },
}

function StagePill({ stage }: { stage: string }) {
  const s = stage?.toLowerCase() ?? ''
  const color =
    s === 'active'  || s === 'approved' ? GREEN :
    s === 'declined' || s === 'rejected' || s === 'cancelled' ? RED :
    AMBER
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      background: `${color}18`, color, whiteSpace: 'nowrap',
      textTransform: 'capitalize', fontFamily: INTER,
    }}>
      {stage?.replace(/_/g, ' ')}
    </span>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)', marginBottom: 3, fontFamily: INTER }}>
      {children}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = ['Overview', 'Loans', 'Products', 'Transactions'] as const
type TabKey = typeof TABS[number]

// ── Tab content ───────────────────────────────────────────────────────────────

function OverviewTab({ profile }: { profile: Profile }) {
  const loans = (profile.loan_applications ?? []).filter(l => !REJECTED_STAGES.has(l.stage ?? ''))
  const recovery = profile.recovery_cases ?? []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--txt2)', marginBottom: 10, fontFamily: INTER }}>
          Active Loans
        </div>
        {loans.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: INTER }}>No active loans</div>
        ) : loans.map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{l.reference ?? '—'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER, marginTop: 1 }}>{l.product_type?.replace(/_/g, ' ')}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(l.amount_requested_kobo)}</div>
              <div style={{ marginTop: 3 }}><StagePill stage={l.stage ?? l.status ?? '—'} /></div>
            </div>
          </div>
        ))}
      </div>
      {recovery.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: RED, marginBottom: 10, fontFamily: INTER }}>
            Recovery Cases
          </div>
          {recovery.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: RED, fontFamily: SORA }}>{r.case_ref ?? `Case #${r.id}`}</div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: RED }}>{fmtKobo(r.outstanding_kobo)}</div>
                <div style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2, textTransform: 'capitalize' }}>{r.status}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LoansTab({ profile }: { profile: Profile }) {
  const loans = profile.loan_applications ?? []
  if (loans.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: INTER }}>No credit applications</div>
  }
  return (
    <div>
      {loans.map((l, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{l.reference ?? '—'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER, marginTop: 1 }}>{l.product_type?.replace(/_/g, ' ')}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{fmtKobo(l.amount_requested_kobo)}</div>
            <div style={{ marginTop: 3 }}><StagePill stage={l.stage ?? l.status ?? '—'} /></div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ProductsTab({ profile }: { profile: Profile }) {
  const products = profile.products ?? []
  if (products.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: INTER }}>No products</div>
  }
  return (
    <div>
      {products.map((p, i) => (
        <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{p.product_name ?? '—'}</div>
            {p.status && <StagePill stage={p.status} />}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            {p.card_type && (
              <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER }}>
                <span style={{ fontWeight: 600 }}>Type: </span>{p.card_type}
              </div>
            )}
            {p.account_manager && (
              <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER }}>
                <span style={{ fontWeight: 600 }}>AM: </span>{p.account_manager}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function TransactionsTab({ profile }: { profile: Profile }) {
  const txns = (profile.transactions ?? []).slice(0, 20)
  if (txns.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: INTER }}>No transactions</div>
  }
  return (
    <div>
      {txns.map((t, i) => {
        const isCredit = t.type?.toLowerCase() === 'credit'
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', fontFamily: SORA }}>{t.description ?? '—'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER, marginTop: 1 }}>{fmtDate(t.date)}</div>
            </div>
            <div style={{ ...NUM, fontSize: 13, fontWeight: 600, color: isCredit ? GREEN : RED, whiteSpace: 'nowrap' }}>
              {isCredit ? '+' : '-'}{fmtKobo(t.amount_kobo)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function C360Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const [query,      setQuery]      = useState('')
  const [results,    setResults]    = useState<SearchResult[]>([])
  const [showDrop,   setShowDrop]   = useState(false)
  const [searching,  setSearching]  = useState(false)
  const [profile,    setProfile]    = useState<Profile | null>(null)
  const [loadingPro, setLoadingPro] = useState(false)
  const [activeTab,  setActiveTab]  = useState<TabKey>('Overview')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef    = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setQuery(''); setResults([]); setShowDrop(false); setProfile(null); setActiveTab('Overview')
    }
  }, [open])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 2) { setResults([]); setShowDrop(false); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await apiFetch<{ data: SearchResult[] }>(`/api/customer360/search?q=${encodeURIComponent(q)}&limit=10`)
        setResults(data?.data ?? [])
        setShowDrop(true)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [query])

  async function selectCustomer(r: SearchResult) {
    setShowDrop(false)
    setQuery(r.name)
    setLoadingPro(true)
    setProfile(null)
    try {
      const data = await apiFetch<Profile>(`/api/customer360/${r.cif}`)
      setProfile({ ...data, cif: r.cif, name: r.name, phone: r.phone, email: r.email })
    } catch {
      setProfile({ cif: r.cif, name: r.name, phone: r.phone, email: r.email })
    } finally {
      setLoadingPro(false)
    }
  }

  if (!open) return null

  const tier = profile ? deriveKycTier(profile) : null
  const tierStyle = tier ? TIER_COLORS[tier] : null

  const activeLoans = (profile?.loan_applications ?? []).filter(l => !REJECTED_STAGES.has(l.stage ?? ''))
  const dpdBucket   = profile?.financial_summary?.dpd_bucket ?? 'Current'
  const outstanding = profile?.financial_summary?.loan_approved_kobo
  const productCount = profile?.products?.length ?? 0

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} onClick={onClose} />

      <div style={{ position: 'relative', width: 480, height: '100%', background: 'var(--card)', borderLeft: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ fontFamily: SORA, fontWeight: 700, fontSize: 15, color: 'var(--txt)' }}>Customer 360°</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', display: 'flex', alignItems: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Search bar */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, position: 'relative' }}>
          <div style={{ position: 'relative' }}>
            <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 17, color: 'var(--txt3)', pointerEvents: 'none' }}>search</span>
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setProfile(null) }}
              onFocus={() => results.length > 0 && setShowDrop(true)}
              onBlur={() => setTimeout(() => setShowDrop(false), 150)}
              placeholder="Search by name, CIF, or phone…"
              style={{
                width: '100%', boxSizing: 'border-box' as const,
                height: 38, paddingLeft: 34, paddingRight: 12,
                border: '1px solid var(--input-bdr)', borderRadius: 9,
                background: 'var(--input-bg)', color: 'var(--txt)',
                fontSize: 13.5, fontFamily: SORA, outline: 'none',
              }}
            />
            {searching && (
              <span className="material-symbols-rounded" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 16, color: 'var(--txt3)', animation: 'spin 1s linear infinite' }}>
                progress_activity
              </span>
            )}
          </div>

          {/* Dropdown */}
          {showDrop && results.length > 0 && (
            <div style={{
              position: 'absolute', left: 20, right: 20, top: 'calc(100% - 6px)',
              background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10,
              boxShadow: '0 4px 20px rgba(0,0,0,0.12)', zIndex: 10, overflow: 'hidden',
            }}>
              {results.map(r => (
                <div
                  key={r.cif}
                  onMouseDown={() => selectCustomer(r)}
                  style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>
                    {r.cif} · {r.phone}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto' }}>

          {/* Empty state */}
          {!profile && !loadingPro && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 32 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)', opacity: 0.5 }}>manage_accounts</span>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt2)', fontFamily: SORA, textAlign: 'center' }}>Search for a customer</div>
              <div style={{ fontSize: 13, color: 'var(--txt3)', fontFamily: INTER, textAlign: 'center', lineHeight: 1.6 }}>
                Type a name, CIF, or phone number above to load their full 360° profile.
              </div>
            </div>
          )}

          {/* Loading profile */}
          {loadingPro && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 24, color: 'var(--txt3)', animation: 'spin 1s linear infinite' }}>progress_activity</span>
            </div>
          )}

          {/* Profile loaded */}
          {profile && !loadingPro && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>

              {/* Profile header */}
              <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--txt)', fontFamily: SORA, lineHeight: 1.3 }}>{profile.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ ...NUM, fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>CIF: {profile.cif}</span>
                      {profile.phone && (
                        <span style={{ fontSize: 12, color: 'var(--txt2)', fontFamily: INTER }}>{profile.phone}</span>
                      )}
                    </div>
                  </div>
                  {tier && tierStyle && (
                    <span style={{
                      flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                      background: tierStyle.bg, color: tierStyle.txt, fontFamily: INTER,
                      border: `1px solid ${tierStyle.txt}30`,
                    }}>
                      Tier {tier}
                    </span>
                  )}
                </div>
              </div>

              {/* Financial summary strip */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)' }}>
                {[
                  { label: 'Active Loans', value: String(activeLoans.length) },
                  { label: 'DPD Bucket',   value: dpdBucket },
                  { label: 'Outstanding',  value: outstanding != null ? fmtKobo(outstanding) : '—', num: true },
                  { label: 'Products',     value: String(productCount) },
                ].map((kpi, i, arr) => (
                  <div
                    key={kpi.label}
                    style={{
                      flex: 1, padding: '12px 14px', textAlign: 'center',
                      borderRight: i < arr.length - 1 ? '1px solid var(--bdr)' : 'none',
                    }}
                  >
                    <Label>{kpi.label}</Label>
                    <div style={{ ...(kpi.num ? NUM : {}), fontSize: 14, fontWeight: 700, color: 'var(--txt)', fontFamily: kpi.num ? INTER : SORA }}>
                      {kpi.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Quick actions */}
              <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)' }}>
                {[
                  { label: 'New Ticket', icon: 'add_circle', color: NAVY, onClick: () => { onClose(); navigate('/helpdesk/tickets') } },
                  { label: 'Log Promise', icon: 'handshake', color: GREEN, onClick: () => { onClose(); navigate('/collections/promises') } },
                  { label: 'Call', icon: 'call', color: AMBER, href: profile.phone ? `tel:${profile.phone}` : undefined },
                ].map(a => (
                  a.href ? (
                    <a key={a.label} href={a.href} style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '8px 4px', borderRadius: 9, border: `1px solid ${a.color}25`,
                      background: `${a.color}08`, color: a.color, textDecoration: 'none',
                      fontSize: 11.5, fontWeight: 600, fontFamily: INTER, cursor: 'pointer',
                    }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{a.icon}</span>
                      {a.label}
                    </a>
                  ) : (
                    <button key={a.label} onClick={a.onClick} style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '8px 4px', borderRadius: 9, border: `1px solid ${a.color}25`,
                      background: `${a.color}08`, color: a.color,
                      fontSize: 11.5, fontWeight: 600, fontFamily: INTER, cursor: 'pointer',
                    }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{a.icon}</span>
                      {a.label}
                    </button>
                  )
                ))}
              </div>

              {/* Tab bar */}
              <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0 }}>
                {TABS.map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    style={{
                      flex: 1, padding: '10px 4px', border: 'none', cursor: 'pointer',
                      background: 'transparent', fontSize: 12.5, fontWeight: activeTab === tab ? 700 : 500,
                      color: activeTab === tab ? RED : 'var(--txt2)',
                      fontFamily: SORA,
                      borderBottom: activeTab === tab ? `2px solid ${RED}` : '2px solid transparent',
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div style={{ padding: '18px 20px' }}>
                {activeTab === 'Overview'      && <OverviewTab profile={profile} />}
                {activeTab === 'Loans'         && <LoansTab profile={profile} />}
                {activeTab === 'Products'      && <ProductsTab profile={profile} />}
                {activeTab === 'Transactions'  && <TransactionsTab profile={profile} />}
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  )
}
