import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtDate } from '../lib/fmt'
import { RED, GREEN, AMBER, NAVY, BLUE, SORA, MONO, TEXT, FW, RADIUS } from '../lib/design'
import { IcoClose } from '../lib/icons'

// ── Types ─────────────────────────────────────────────────────────────────────

interface C360Customer {
  cif: string; name: string; phone: string; email: string
}

interface Account {
  'Phone Number'?: string; 'Email'?: string; 'City'?: string
  'State'?: string; 'Job Title'?: string; 'Birthday'?: string
}

interface Product {
  'Product Name'?: string; 'Account Status'?: string; 'Name On Card'?: string
}

interface LoanApplication {
  product_type?: string; amount_requested_kobo?: number; stage?: string
}

interface Profile {
  cif?: string; name?: string; phone?: string; email?: string
  account?: Account
  products?: Product[]
  loan_apps?: LoanApplication[]
  financial_summary?: { dpd_bucket?: string | null }
}

// Paystack funding attempts for this customer. Surfaced here because "I paid and
// it didn't reflect" is a Customer 360 / helpdesk question, not a settlement one —
// and more than half of all funding attempts never complete.
interface PsFunding {
  id: number
  reference: string
  status: string
  channel: string
  amount_kobo: number
  created_at_ps: string
  gateway_response: string
  auth_bank: string
}

interface PsActivity {
  summary: {
    matched_on: string
    // 'ambiguous' when the customer's email is shared across several CIFs — the
    // API returns no rows in that case rather than risk showing another
    // customer's money here.
    identity: 'unique' | 'ambiguous'
    shared_cifs?: number
    note?: string
    funding_n: number
    funding_success: number
    funding_failed: number
    funded_kobo: number
  }
  fundings: PsFunding[]
}

interface ActivityEvent {
  id: number
  ts: string
  module: string
  actor_name: string
  actor_role: string
  entity_type: string
  action: string
  description: string
  previous_state?: string | null
  new_state?: string | null
}

const REJECTED = new Set(['rejected', 'cancelled', 'declined'])

function dpdColor(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Current') return GREEN
  if (bucket === '1-30') return AMBER
  return RED
}

const SEC_TITLE: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em',
  textTransform: 'uppercase', color: 'var(--txt3)',
  marginBottom: 12, fontFamily: MONO,
}

// ── Action config ─────────────────────────────────────────────────────────────

const ACTION_META: Record<string, { label: string; color: string; icon: string }> = {
  contact_logged:            { label: 'Contact',         color: BLUE,    icon: 'phone_in_talk' },
  promise_created:           { label: 'PTP Created',     color: NAVY,    icon: 'handshake' },
  promise_honoured:          { label: 'PTP Honoured',    color: GREEN,   icon: 'check_circle' },
  promise_broken:            { label: 'PTP Broken',      color: RED,     icon: 'cancel' },
  payment_logged:            { label: 'Payment',         color: BLUE,    icon: 'payments' },
  payment_approved:          { label: 'Payment OK',      color: GREEN,   icon: 'check_circle' },
  payment_rejected:          { label: 'Payment Rej.',    color: RED,     icon: 'cancel' },
  writeoff_requested:        { label: 'W/O Request',     color: AMBER,   icon: 'request_page' },
  writeoff_request_approved: { label: 'W/O Approved',    color: RED,     icon: 'do_not_disturb_on' },
  writeoff_request_rejected: { label: 'W/O Rejected',    color: AMBER,   icon: 'undo' },
  writeoff_approved:         { label: 'Written Off',     color: RED,     icon: 'do_not_disturb_on' },
  watchlist_flagged:         { label: 'Watchlisted',     color: AMBER,   icon: 'flag' },
  watchlist_resolved:        { label: 'Flag Resolved',   color: GREEN,   icon: 'flag_circle' },
  sent_to_recovery:          { label: 'To Recovery',     color: RED,     icon: 'gavel' },
  field_visit_logged:        { label: 'Field Visit',     color: BLUE,    icon: 'location_on' },
  debt_sale_created:         { label: 'Debt Sale',       color: '#7C3AED', icon: 'sell' },
  plan_created:              { label: 'Plan Created',    color: NAVY,    icon: 'calendar_today' },
  instalment_paid:           { label: 'Instalment',      color: GREEN,   icon: 'paid' },
  legal_milestone_added:     { label: 'Legal',           color: '#7C3AED', icon: 'balance' },
}

function EventDot({ action }: { action: string }) {
  const meta = ACTION_META[action]
  const color = meta?.color ?? 'var(--txt3)'
  const icon  = meta?.icon  ?? 'circle'
  return (
    <div style={{
      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
      background: `${color}18`, border: `1.5px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 14, color }}>{icon}</span>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function C360Drawer({ open, onClose, initialCustomer }: {
  open: boolean
  onClose: () => void
  initialCustomer?: C360Customer | null
}) {
  const navigate = useNavigate()

  const [profile,   setProfile]   = useState<Profile | null>(null)
  const [events,    setEvents]    = useState<ActivityEvent[]>([])
  const [loading,   setLoading]   = useState(false)
  const [evtLoading,setEvtLoading]= useState(false)
  const [payments,  setPayments]  = useState<PsActivity | null>(null)
  const [payLoading,setPayLoading]= useState(false)

  const loadProfile = useCallback(() => {
    if (!initialCustomer) return
    setLoading(true)
    setProfile(null)
    apiFetch<any>(`/api/customer360/${initialCustomer.cif}`)
      .then(res => setProfile({
        ...((res?.data ?? res) as Profile),
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
  }, [initialCustomer])

  const loadEvents = useCallback(() => {
    if (!initialCustomer?.cif) return
    setEvtLoading(true)
    apiFetch<{ data: ActivityEvent[] }>(`/api/collections/activity/cif/${initialCustomer.cif}`)
      .then(r => setEvents(r.data ?? []))
      .catch(() => setEvents([]))
      .finally(() => setEvtLoading(false))
  }, [initialCustomer])

  const loadPayments = useCallback(() => {
    if (!initialCustomer?.cif) return
    setPayLoading(true)
    apiFetch<PsActivity>(`/api/paystack/customer?cif=${encodeURIComponent(initialCustomer.cif)}`)
      .then(r => setPayments(r))
      // A customer with no Paystack identity is normal, not an error.
      .catch(() => setPayments(null))
      .finally(() => setPayLoading(false))
  }, [initialCustomer])

  useEffect(() => {
    if (!open || !initialCustomer) {
      if (!open) { setProfile(null); setEvents([]); setPayments(null) }
      return
    }
    loadProfile()
    loadEvents()
    loadPayments()
  }, [open, initialCustomer, loadProfile, loadEvents, loadPayments])

  const dpdBucket   = profile?.financial_summary?.dpd_bucket ?? 'Current'
  const activeLoans = (profile?.loan_apps ?? []).filter(l => !REJECTED.has(l.stage ?? ''))
  const products    = [
    ...(profile?.products ?? []).map(p => ({
      name: p['Product Name'] ?? p['Name On Card'] ?? 'Product',
      amt:  p['Account Status'] ?? '',
    })),
    ...activeLoans.map(l => ({
      name: l.product_type ?? 'Loan',
      amt:  l.amount_requested_kobo != null ? fmtKobo(l.amount_requested_kobo) : l.stage ?? '',
    })),
  ]

  const acct = profile?.account
  const location = [acct?.['City'], acct?.['State']].filter(Boolean).join(', ')
  const profileKVs: [string, string | undefined][] = [
    ['Phone',     profile?.phone ?? acct?.['Phone Number']],
    ['Email',     profile?.email ?? acct?.['Email']],
    ['Job Title', acct?.['Job Title']],
    ['Location',  location || undefined],
  ].filter(([, v]) => v) as [string, string][]

  return (
    <>
      {open && (
        <div
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(14,40,65,.4)', zIndex: 55 }}
        />
      )}

      <div style={{
        position: 'fixed', top: 0,
        right: open ? 0 : -480,
        width: 460, maxWidth: '94vw', height: '100%',
        background: 'var(--card)',
        borderLeft: '1px solid var(--bdr)',
        zIndex: 56,
        display: 'flex', flexDirection: 'column',
        transition: 'right .22s ease',
        fontFamily: SORA,
        fontSize: 13,
      }}>

        {/* ── Header ── */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{
              float: 'right', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--txt3)', padding: 0, lineHeight: 1,
              display: 'flex', alignItems: 'center',
            }}
          >
            <IcoClose size={18} />
          </button>

          {loading && <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Loading…</div>}
          {!loading && !profile && (
            <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Search for a customer in the bar above</div>
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
                }}>Customer</span>
                <span style={{
                  fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                  background: `${dpdColor(dpdBucket)}18`, color: dpdColor(dpdBucket),
                }}>
                  DPD: {dpdBucket}
                </span>
                {events.length > 0 && (
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                    background: `${BLUE}12`, color: BLUE,
                  }}>
                    {events.length} credit events
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {profile ? (
            <>
              {/* Profile */}
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

              {/* Products & exposure */}
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
                      {p.amt && (p.amt.startsWith('₦')
                        ? <span style={{ marginLeft: 'auto', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: 'var(--txt2)', fontSize: 12 }}>{p.amt}</span>
                        : <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'var(--th-bg)', color: 'var(--txt2)', textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{p.amt.toLowerCase()}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* App payments (Paystack) */}
              {(payLoading || (payments && (payments.summary.funding_n > 0 || payments.summary.identity === 'ambiguous'))) && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ ...SEC_TITLE, marginBottom: 0 }}>App Payments</div>
                    {payments && (
                      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--txt3)', fontFamily: MONO }}>
                        matched on {payments.summary.matched_on}
                      </span>
                    )}
                  </div>

                  {payLoading && (
                    <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>
                      Loading payments…
                    </div>
                  )}

                  {!payLoading && payments?.summary.identity === 'ambiguous' && (
                    <div style={{
                      display: 'flex', gap: 8, padding: '10px 12px', borderRadius: RADIUS.md,
                      background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.18)',
                    }}>
                      <span style={{ color: AMBER, fontSize: 14, lineHeight: 1.2 }}>!</span>
                      <span style={{ fontSize: 11.5, color: 'var(--txt2)', lineHeight: 1.5 }}>
                        {payments.summary.note ?? 'Payment history cannot be attributed to this customer.'}
                      </span>
                    </div>
                  )}

                  {!payLoading && payments && payments.summary.identity !== 'ambiguous' && (
                    <>
                      <div style={{ display: 'flex', gap: 18, marginBottom: 12 }}>
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--txt3)' }}>Funded</div>
                          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
                            {fmtKobo(payments.summary.funded_kobo)}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--txt3)' }}>Successful</div>
                          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: GREEN }}>
                            {payments.summary.funding_success}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: 'var(--txt3)' }}>Failed / abandoned</div>
                          <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: payments.summary.funding_failed > 0 ? AMBER : 'var(--txt2)' }}>
                            {payments.summary.funding_failed}
                          </div>
                        </div>
                      </div>

                      {payments.fundings.slice(0, 6).map((f, i) => {
                        const ok = f.status === 'success'
                        const color = ok ? GREEN : f.status === 'failed' ? RED : AMBER
                        return (
                          <div key={f.id} style={{
                            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
                            borderBottom: i < Math.min(payments.fundings.length, 6) - 1 ? '1px solid var(--bdr)' : 'none',
                          }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, color: 'var(--txt)' }}>
                                {f.channel?.replace(/_/g, ' ') || 'payment'}
                                <span style={{ color: 'var(--txt3)', marginLeft: 6, fontFamily: MONO, fontSize: 10.5 }}>
                                  {fmtDate(f.created_at_ps)}
                                </span>
                              </div>
                              {!ok && f.gateway_response && (
                                <div style={{ fontSize: 10.5, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {f.gateway_response}
                                </div>
                              )}
                            </div>
                            <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: ok ? 'var(--txt)' : 'var(--txt3)' }}>
                              {fmtKobo(f.amount_kobo)}
                            </span>
                          </div>
                        )
                      })}
                    </>
                  )}
                </div>
              )}

              {/* Credit Activity Timeline */}
              <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--bdr)' }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ ...SEC_TITLE, marginBottom: 0 }}>Credit History</div>
                  {events.length > 0 && (
                    <button
                      onClick={() => { onClose(); navigate(`/collections/activity-log?cif=${profile.cif}`) }}
                      style={{
                        marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 11, color: NAVY, fontWeight: 600, fontFamily: SORA,
                        padding: 0,
                      }}
                    >
                      View all →
                    </button>
                  )}
                </div>

                {evtLoading && (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>
                    Loading history…
                  </div>
                )}

                {!evtLoading && events.length === 0 && (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: 12 }}>
                    No credit events on record
                  </div>
                )}

                {!evtLoading && events.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {events.slice(0, 12).map((evt, i) => {
                      const meta  = ACTION_META[evt.action]
                      const color = meta?.color ?? 'var(--txt3)'
                      const isLast = i === Math.min(events.length, 12) - 1
                      return (
                        <div key={evt.id} style={{ display: 'flex', gap: 12, position: 'relative' }}>
                          {/* Timeline line */}
                          {!isLast && (
                            <div style={{
                              position: 'absolute', left: 13, top: 32, bottom: 0,
                              width: 1.5, background: 'var(--bdr)',
                            }} />
                          )}
                          <div style={{ paddingTop: 4 }}>
                            <EventDot action={evt.action} />
                          </div>
                          <div style={{ flex: 1, paddingBottom: isLast ? 0 : 18 }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 3 }}>
                              <span style={{
                                fontSize: 10.5, fontWeight: FW.bold, padding: '1px 6px',
                                borderRadius: RADIUS['2xl'],
                                background: `${color}18`, color,
                                whiteSpace: 'nowrap', flexShrink: 0,
                              }}>
                                {meta?.label ?? evt.action}
                              </span>
                              <span style={{ fontSize: 10.5, color: 'var(--txt3)', fontFamily: MONO, paddingTop: 2 }}>
                                {new Date(evt.ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--txt)', lineHeight: 1.5, marginBottom: 2 }}>
                              {evt.description}
                            </div>
                            <div style={{ fontSize: 10.5, color: 'var(--txt3)' }}>
                              {evt.actor_name} · <span style={{ textTransform: 'capitalize' }}>{evt.actor_role.replace(/_/g, ' ')}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                    {events.length > 12 && (
                      <button
                        onClick={() => { onClose(); navigate(`/collections/activity-log?cif=${profile.cif}`) }}
                        style={{
                          width: '100%', padding: '8px', marginTop: 8,
                          border: '1px dashed var(--bdr)', borderRadius: RADIUS.md,
                          background: 'transparent', cursor: 'pointer',
                          fontSize: 12, color: NAVY, fontWeight: 600, fontFamily: SORA,
                        }}
                      >
                        + {events.length - 12} more events — View full history
                      </button>
                    )}
                  </div>
                )}
              </div>

              {products.length === 0 && events.length === 0 && profileKVs.length === 0 && (
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

        {/* ── Footer ── */}
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
