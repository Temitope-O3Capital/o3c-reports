import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtDate } from '../lib/fmt'
import { RED, GREEN, AMBER, NAVY, SORA, MONO } from '../lib/design'
import { IcoClose } from '../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface C360Customer {
  cif: string; name: string; phone: string; email: string
}

interface Account {
  account_number?: string; bank_name?: string; address?: string
}

interface Product {
  product_name?: string; card_type?: string; status?: string
}

interface Transaction {
  date?: string; description?: string; amount_kobo?: number; type?: string
}

interface LoanApplication {
  product_type?: string; amount_requested_kobo?: number; stage?: string
}

interface Profile {
  cif?: string; name?: string; phone?: string; email?: string
  account?: Account
  products?: Product[]
  transactions?: Transaction[]
  loan_applications?: LoanApplication[]
  financial_summary?: { dpd_bucket?: string | null }
}

const REJECTED = new Set(['rejected', 'cancelled', 'declined'])

function dpdColor(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Current') return GREEN
  if (bucket === '1-30') return AMBER
  return RED
}

// ── Shared section-title style ────────────────────────────────────────────────

const SEC_TITLE: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em',
  textTransform: 'uppercase', color: 'var(--txt3)',
  marginBottom: 12, fontFamily: MONO,
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function C360Drawer({ open, onClose, initialCustomer }: {
  open: boolean
  onClose: () => void
  initialCustomer?: C360Customer | null
}) {
  const navigate  = useNavigate()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(false)

  // Load profile whenever the drawer opens with a customer
  useEffect(() => {
    if (!open || !initialCustomer) {
      if (!open) setProfile(null)
      return
    }
    setLoading(true)
    setProfile(null)
    apiFetch<Profile>(`/api/customer360/${initialCustomer.cif}`)
      .then(data => setProfile({
        ...data,
        cif: initialCustomer.cif,
        name: initialCustomer.name,
        phone: initialCustomer.phone,
        email: initialCustomer.email,
      }))
      .catch(() => setProfile({
        cif: initialCustomer.cif,
        name: initialCustomer.name,
        phone: initialCustomer.phone,
        email: initialCustomer.email,
      }))
      .finally(() => setLoading(false))
  }, [open, initialCustomer])

  const dpdBucket   = profile?.financial_summary?.dpd_bucket ?? 'Current'
  const activeLoans = (profile?.loan_applications ?? []).filter(l => !REJECTED.has(l.stage ?? ''))

  const products = [
    ...(profile?.products ?? []).map(p => ({
      name: p.product_name ?? p.card_type ?? 'Product',
      amt:  p.status ?? '',
    })),
    ...activeLoans.map(l => ({
      name: l.product_type ?? 'Loan',
      amt:  l.amount_requested_kobo != null ? fmtKobo(l.amount_requested_kobo) : l.stage ?? '',
    })),
  ]

  const activity = (profile?.transactions ?? []).slice(0, 6)

  const profileKVs: [string, string | undefined][] = [
    ['Phone',     profile?.phone],
    ['Email',     profile?.email],
    ['Account #', profile?.account?.account_number],
    ['Bank',      profile?.account?.bank_name],
  ].filter(([, v]) => v) as [string, string][]

  return (
    <>
      {/* Veil */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(14,40,65,.4)',
            zIndex: 55,
          }}
        />
      )}

      {/* Slide-over panel — always in DOM so transition works */}
      <div style={{
        position: 'fixed', top: 0,
        right: open ? 0 : -460,
        width: 440, maxWidth: '94vw', height: '100%',
        background: 'var(--card)',
        borderLeft: '1px solid var(--bdr)',
        zIndex: 56,
        display: 'flex', flexDirection: 'column',
        transition: 'right .22s ease',
        fontFamily: SORA,
        fontSize: 13,
      }}>

        {/* ── Head ── */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{
              float: 'right', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--txt3)', padding: 0, lineHeight: 1,
              display: 'flex', alignItems: 'center',
            }}
          >
            <IcoClose width={18} height={18} />
          </button>

          {loading && (
            <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Loading…</div>
          )}

          {!loading && !profile && (
            <div style={{ color: 'var(--txt3)', fontSize: 13 }}>
              Search for a customer in the bar above
            </div>
          )}

          {profile && (
            <>
              <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--txt)', fontFamily: SORA }}>
                {profile.name}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11.5, color: 'var(--txt3)', marginTop: 3 }}>
                {profile.cif}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                  background: `${NAVY}22`, color: NAVY,
                }}>
                  Customer
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                  background: `${dpdColor(dpdBucket)}18`, color: dpdColor(dpdBucket),
                }}>
                  DPD: {dpdBucket}
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {profile ? (
            <>
              {/* Profile section */}
              {profileKVs.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={SEC_TITLE}>Profile</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' }}>
                    {profileKVs.map(([k, v]) => (
                      <div key={k}>
                        <div style={{ fontSize: 10.5, color: 'var(--txt3)', marginBottom: 3 }}>{k}</div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)', wordBreak: 'break-all' }}>{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Products & exposure section */}
              {products.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={SEC_TITLE}>Products &amp; exposure</div>
                  {products.map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'baseline',
                      padding: '9px 0',
                      borderBottom: i < products.length - 1 ? '1px solid var(--bdr)' : 'none',
                      fontSize: 12.5,
                    }}>
                      <span style={{ fontWeight: 600, color: 'var(--txt)', flex: 1 }}>{p.name}</span>
                      <span style={{
                        marginLeft: 'auto', fontFamily: MONO, fontWeight: 500,
                        fontVariantNumeric: 'tabular-nums', color: 'var(--txt2)', fontSize: 12,
                      }}>{p.amt}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Recent activity section */}
              {activity.length > 0 && (
                <div style={{ padding: '16px 24px' }}>
                  <div style={SEC_TITLE}>Recent activity</div>
                  {activity.map((tx, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, padding: '8px 0', fontSize: 12, color: 'var(--txt)' }}>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--txt3)', minWidth: 52, paddingTop: 1, flexShrink: 0 }}>
                        {tx.date ? fmtDate(tx.date).slice(0, 6) : '—'}
                      </span>
                      <span style={{ flex: 1, lineHeight: 1.45 }}>
                        {tx.description ?? '—'}
                        {tx.amount_kobo != null && (
                          <span style={{
                            color: tx.type === 'credit' ? GREEN : RED,
                            fontFamily: MONO, marginLeft: 6, fontSize: 11,
                          }}>
                            {tx.type === 'credit' ? '+' : '-'}{fmtKobo(Math.abs(tx.amount_kobo))}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {products.length === 0 && activity.length === 0 && profileKVs.length === 0 && (
                <div style={{ padding: '48px 24px', color: 'var(--txt3)', fontSize: 13, textAlign: 'center' }}>
                  No additional data available
                </div>
              )}
            </>
          ) : (
            !loading && (
              <div style={{ padding: '64px 24px', textAlign: 'center', color: 'var(--txt3)', fontSize: 13, lineHeight: 1.6 }}>
                Use the Customer 360 search in the top bar to find a customer.
              </div>
            )
          )}
        </div>

        {/* ── Foot ── */}
        {profile && (
          <div style={{
            padding: '14px 24px', borderTop: '1px solid var(--bdr)',
            display: 'flex', gap: 8, flexShrink: 0,
          }}>
            <button
              onClick={() => { onClose(); navigate('/collections/promises') }}
              style={{
                flex: 1, padding: '7px 14px', borderRadius: 6, border: 'none',
                background: '#C00000', color: '#fff',
                fontSize: 12.5, fontWeight: 600, fontFamily: SORA, cursor: 'pointer',
              }}
            >
              Log Promise
            </button>
            {profile.phone && (
              <a
                href={`tel:${profile.phone}`}
                style={{
                  flex: 1, padding: '7px 14px', borderRadius: 6,
                  border: '1px solid var(--bdr)', background: 'transparent',
                  color: 'var(--txt)', fontSize: 12.5, fontWeight: 600,
                  fontFamily: SORA, cursor: 'pointer', textDecoration: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                Call
              </a>
            )}
            <button
              onClick={() => { onClose(); navigate(`/contacts/${profile.cif}`) }}
              style={{
                flex: 1, padding: '7px 14px', borderRadius: 6,
                border: '1px solid var(--bdr)', background: 'transparent',
                color: 'var(--txt)', fontSize: 12.5, fontWeight: 600,
                fontFamily: SORA, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Full profile →
            </button>
          </div>
        )}
      </div>
    </>
  )
}
