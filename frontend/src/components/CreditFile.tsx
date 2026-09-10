// Credit File — the facility-level view behind a collections account.
//
// One CIF is not one credit. A person can hold many cards and several loans, and
// the collections book files an assignment under just one of their ids. These
// components render what the /accounts/{cif}/credit dossier returns: every facility
// the person holds, each with its repayment schedule and how much of every
// instalment has actually been paid.
//
// All money arriving here is kobo (the API normalises the naira-denominated card
// book on the way out), so every figure goes through fmtKoboExact.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Spinner, EmptyState } from './UI'
import { apiFetch } from '../lib/api'
import { fmtKoboExact, fmtDate } from '../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchedRow {
  n: number
  due_date: string
  label: string
  principal_kobo: number
  interest_kobo: number
  fee_kobo: number
  due_kobo: number
  paid_kobo: number
  paid_pct: number
  days_to_due: number
  days_known: boolean
  status: 'paid' | 'partial' | 'overdue' | 'due' | 'upcoming'
  source: 'udara' | 'derived' | 'cycle'
}

export interface Facility {
  key: string
  kind: 'card' | 'loan'
  origin: string
  cif: string
  ref: string
  product: string
  status: string
  is_subject: boolean
  limit_kobo: number
  principal_kobo: number
  outstanding_kobo: number
  min_payment_kobo: number
  instalment_kobo: number
  utilisation: number
  dpd: number
  rate: string
  tenor: string
  debit_day: string
  officer_name: string
  guarantor_name: string
  opened_date: string
  maturity_date: string
  next_due_date: string
  last_payment_date: string
  last_payment_kobo: number
  pan_masked: string
  expiry_date: string
  cycle_balance_kobo: number
  collateral_type: string
  collateral_valuation_kobo: number
  economic_sector: string
  branch_name: string
  also_in_udara: boolean
  scheduled_kobo: number
  expected_kobo: number
  paid_kobo: number
  paid_pct: number
  arrears_kobo: number
  schedule: SchedRow[]
  schedule_note: string
}

export interface Repayment {
  date: string
  amount_kobo: number
  channel: string
  reference: string
  source: 'collections' | 'card'
  facility_key: string
  received_by: string
  status: string
}

export interface RecoveryCase {
  id?: number
  case_ref?: string
  status?: string
  legal_stage?: string
  outstanding_kobo?: number
  recovered_kobo?: number
  write_off_amount_kobo?: number
  write_off_status?: string
  opened_at?: string
  agent_name?: string
  solicitor?: string
}

export interface Accommodation {
  id: number
  kind: string
  concession_type: string
  amount_kobo: number
  new_tenor_months: number | null
  new_rate_bps: number | null
  new_installment_kobo: number
  new_maturity_date: string | null
  status: string
  reason: string
  decided_at: string | null
  account_ref: string
}

export interface ContactPoint {
  source_id: string
  phone: string
  email: string
  address: string
  phone_suspect: boolean
  email_suspect: boolean
  last_seen: string | null
}

export interface CreditDossier {
  customer: {
    cif: string
    customer_id: string
    party_id: number
    name: string
    phone: string
    email: string
    bvn: string
    address: string
    address_line: string
    city: string
    state: string
    country: string
    employer: string
    date_of_birth: string
    gender: string
    account_status: string
    contacts: ContactPoint[]
    cifs: string[]
    udara_customers: string[]
    udara_accounts: string[]
    cif_is_internal: boolean
    has_card: boolean
    linked_ids: string[]
    c360_path: string
  }
  recovery_case: RecoveryCase
  accommodations: Accommodation[]
  facilities: Facility[]
  repayments: Repayment[]
  totals: {
    facility_count: number
    exposure_kobo: number
    limit_kobo: number
    scheduled_kobo: number
    expected_kobo: number
    schedule_paid_kobo: number
    arrears_kobo: number
    paid_kobo: number
    paid_pct: number
    next_due_date: string
    next_due_kobo: number
    unallocated_kobo: number
  }
}

// ── Data ──────────────────────────────────────────────────────────────────────

export function useCreditDossier(cif: string | undefined) {
  const [data, setData] = useState<CreditDossier | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!cif) return
    if (!silent) { setLoading(true); setError(null) }
    try {
      const res = await apiFetch<{ data: CreditDossier }>(`/api/collections/accounts/${cif}/credit`)
      setData(res.data ?? null)
    } catch (e: any) {
      if (!silent) setError(e.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [cif])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload: load }
}

// The workspace shows exactly three identifiers for a credit customer: the Customer
// ID, the card CIF, and the Udara id. Anything else in the id columns is an internal
// handle — a 'W…' minted for a borrower who holds a loan and no card, or a 'Z…' for a
// feed-created card customer — and must never be printed as if it were a CIF.
export function isInternalId(id: string | null | undefined): boolean {
  const s = (id ?? '').trim()
  if (!s) return true
  if (s.startsWith('cid:')) return true
  return /^[WZwz][0-9]+$/.test(s)
}

// ── Shared bits ───────────────────────────────────────────────────────────────

const STATUS_META: Record<SchedRow['status'], { label: string; color: string }> = {
  paid:     { label: 'Paid',     color: GREEN },
  partial:  { label: 'Part-paid',color: AMBER },
  overdue:  { label: 'Overdue',  color: RED   },
  due:      { label: 'Due today',color: BLUE  },
  upcoming: { label: 'Upcoming', color: '#64748B' },
}

// A facility with nothing left to collect. Shown, but never as work.
const SETTLED_STATUS = new Set(['closed', 'settled', 'repaid'])

const kindColor = (k: string) => (k === 'card' ? PURPLE : NAVY)

export function Meter({ pct, color, height = 5 }: { pct: number; color: string; height?: number }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div style={{
      height, borderRadius: RADIUS.full, background: 'var(--bdr)',
      overflow: 'hidden', minWidth: 40,
    }}>
      <div style={{ width: `${w}%`, height: '100%', background: color, borderRadius: RADIUS.full }} />
    </div>
  )
}

function Chip({ label, color, solid = false }: { label: string; color: string; solid?: boolean }) {
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
      textTransform: 'uppercase', padding: '2px 8px', borderRadius: RADIUS.full,
      background: solid ? color : `${color}18`, color: solid ? '#fff' : color,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

// Money figure with its label above — the unit the whole page is built from.
export function Figure({
  label, value, sub, color, size = 22, align = 'left',
}: { label: string; value: string; sub?: string; color?: string; size?: number; align?: 'left' | 'right' }) {
  return (
    <div style={{ textAlign: align, minWidth: 0 }}>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 5,
      }}>{label}</div>
      <div style={{ ...NUM, fontSize: size, fontWeight: FW.extrabold, lineHeight: 1.1, color: color ?? 'var(--txt)' }}>
        {value}
      </div>
      {sub && <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── Customer details ──────────────────────────────────────────────────────────

// Everything an officer needs to reach the customer, on the page they are working
// rather than a click away in Customer 360. A person's contact details are spread
// across their card records and the one on the worked account is often the stale one,
// so every distinct number, email and address on file is listed.
export function CustomerDetails({ c }: { c: CreditDossier['customer'] }) {
  const line = (parts: (string | undefined)[]) => parts.filter(Boolean).join(', ')
  const primary: [string, string, string][] = [
    ['call', 'Phone', c.phone],
    ['mail', 'Email', c.email],
    ['home_pin', 'Address', c.address || line([c.address_line, c.city, c.state, c.country])],
    ['work', 'Occupation', c.employer],
    ['fingerprint', 'BVN', c.bvn],
    ['cake', 'Date of birth', c.date_of_birth ? fmtDate(c.date_of_birth) : ''],
    ['wc', 'Gender', c.gender],
    ['verified_user', 'Account status', c.account_status],
  ]
  const shown = primary.filter(([, , v]) => v && v.trim() !== '')

  // Alternative contact points, minus whatever is already the headline value.
  const others = (c.contacts ?? []).filter(p =>
    (p.phone && p.phone !== c.phone) || (p.email && p.email !== c.email))

  if (shown.length === 0 && others.length === 0) {
    return (
      <div style={{
        padding: `${SP[3]} ${SP[4]}`, marginBottom: SP[4], borderRadius: RADIUS.lg,
        background: `${AMBER}0A`, border: `1px solid ${AMBER}26`,
        fontSize: TEXT.sm, color: 'var(--txt2)',
      }}>
        No contact details on file for this customer — nothing to call, email or visit.
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl,
      padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[4],
    }}>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: SP[3],
      }}>Customer details</div>

      <div style={{
        display: 'grid', gap: `${SP[3]} ${SP[5]}`,
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
      }}>
        {shown.map(([icon, label, value]) => (
          <div key={label} style={{ display: 'flex', gap: 9, minWidth: 0 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: 'var(--txt3)', marginTop: 1 }}>{icon}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em',
                textTransform: 'uppercase', color: 'var(--txt3)',
              }}>{label}</div>
              {label === 'Phone' ? (
                <a href={`tel:${value}`} style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, textDecoration: 'none' }}>{value}</a>
              ) : label === 'Email' ? (
                <a href={`mailto:${value}`} style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, textDecoration: 'none', wordBreak: 'break-all' }}>{value}</a>
              ) : (
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', wordBreak: 'break-word' }}>{value}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {others.length > 0 && (
        <div style={{ marginTop: SP[4], paddingTop: SP[3], borderTop: '1px solid var(--bdr)' }}>
          <div style={{
            fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: SP[2],
          }}>Other numbers on file ({others.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${SP[2]} ${SP[4]}` }}>
            {others.map((p, i) => (
              <div key={`${p.source_id}-${i}`} style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                {p.phone && (
                  <a href={`tel:${p.phone}`} style={{ ...NUM, color: p.phone_suspect ? AMBER : NAVY, textDecoration: 'none', fontWeight: FW.semibold }}
                     title={p.phone_suspect ? 'Flagged as a likely bad number by the feed' : undefined}>
                    {p.phone}{p.phone_suspect ? ' (unverified)' : ''}
                  </a>
                )}
                {p.phone && p.email ? ' · ' : ''}
                {p.email && <span style={{ wordBreak: 'break-all' }}>{p.email}</span>}
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                  {isInternalId(p.source_id) ? '' : ` · from CIF ${p.source_id}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Case context ──────────────────────────────────────────────────────────────

// Two facts change what an officer may say on a call, and neither was on this page
// before: the debt has moved to Recovery, or its terms have been formally varied so
// the schedule below is no longer the one the customer agreed to.
export function CaseContext({
  recovery, accommodations, onOpenRecovery,
}: { recovery: RecoveryCase; accommodations: Accommodation[]; onOpenRecovery?: () => void }) {
  const hasRecovery = !!recovery?.id
  const live = accommodations.filter(a => ['approved', 'active'].includes((a.status || '').toLowerCase()))
  if (!hasRecovery && live.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2], marginBottom: SP[4] }}>
      {hasRecovery && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: `${SP[3]} ${SP[4]}`, background: `${RED}08`,
          border: `1px solid ${RED}22`, borderRadius: RADIUS.lg,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: RED }}>gavel</span>
          <div style={{ lineHeight: 1.35, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
              In Recovery — case {recovery.case_ref || recovery.id}
              {recovery.legal_stage ? ` · ${recovery.legal_stage.replace(/_/g, ' ')}` : ''}
            </div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {fmtKoboExact(recovery.outstanding_kobo ?? 0)} outstanding
              {(recovery.recovered_kobo ?? 0) > 0 && ` · ${fmtKoboExact(recovery.recovered_kobo ?? 0)} recovered`}
              {(recovery.write_off_amount_kobo ?? 0) > 0 && ` · ${fmtKoboExact(recovery.write_off_amount_kobo ?? 0)} written off`}
              {recovery.agent_name && ` · ${recovery.agent_name}`}
              {recovery.solicitor && ` · solicitor ${recovery.solicitor}`}
            </div>
          </div>
          {onOpenRecovery && (
            <button
              onClick={onOpenRecovery}
              style={{
                marginLeft: 'auto', padding: '5px 12px', borderRadius: RADIUS.md, cursor: 'pointer',
                border: 'none', background: RED, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold,
              }}
            >Open Recovery case</button>
          )}
        </div>
      )}
      {live.map(a => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: `${SP[3]} ${SP[4]}`, background: `${AMBER}0A`,
          border: `1px solid ${AMBER}26`, borderRadius: RADIUS.lg,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: AMBER }}>handshake</span>
          <div style={{ lineHeight: 1.35, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'capitalize' }}>
              {a.kind.replace(/_/g, ' ')} {a.concession_type ? `· ${a.concession_type.replace(/_/g, ' ')}` : ''} approved
              {a.account_ref ? ` on ${a.account_ref}` : ''}
            </div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {a.new_installment_kobo > 0 && `New instalment ${fmtKoboExact(a.new_installment_kobo)}`}
              {a.new_tenor_months ? ` · ${a.new_tenor_months} months` : ''}
              {a.new_rate_bps ? ` · ${(a.new_rate_bps / 100).toFixed(2)}%` : ''}
              {a.new_maturity_date ? ` · matures ${fmtDate(a.new_maturity_date)}` : ''}
              {a.decided_at ? ` · approved ${fmtDate(a.decided_at)}` : ''}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
              The schedule below reflects the original terms; these varied terms take precedence.
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Money strip ───────────────────────────────────────────────────────────────

export function ExposureStrip({ t }: { t: CreditDossier['totals'] }) {
  const recovered = t.paid_pct
  const meterColor = recovered >= 80 ? GREEN : recovered >= 40 ? AMBER : RED
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl,
      padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[4],
      display: 'grid', gap: SP[5],
      gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end',
    }}>
      <Figure label="Total exposure" value={fmtKoboExact(t.exposure_kobo)} color={RED} size={24}
              sub={`${t.facility_count} ${t.facility_count === 1 ? 'facility' : 'facilities'}`} />
      <Figure label="Scheduled" value={fmtKoboExact(t.scheduled_kobo)}
              sub={`Due to date ${fmtKoboExact(t.expected_kobo)}`} size={20} />
      <div>
        <Figure label="Paid against schedule" value={fmtKoboExact(t.schedule_paid_kobo)} color={GREEN} size={20}
                sub={`${recovered.toFixed(1)}% of the schedule`} />
        <div style={{ marginTop: 8 }}><Meter pct={recovered} color={meterColor} /></div>
      </div>
      <Figure label="Arrears" value={fmtKoboExact(t.arrears_kobo)}
              color={t.arrears_kobo > 0 ? RED : GREEN} size={20}
              sub={t.arrears_kobo > 0 ? 'Behind the schedule' : 'On or ahead of schedule'} />
      <Figure label="Next instalment"
              value={t.next_due_date ? fmtKoboExact(t.next_due_kobo) : '—'}
              sub={t.next_due_date ? `Due ${fmtDate(t.next_due_date)}` : 'Nothing scheduled ahead'}
              size={20} />
      <Figure label="Payments received" value={fmtKoboExact(t.paid_kobo)} color={GREEN} size={20}
              sub="Logged to collections" />
      {t.unallocated_kobo > 0 && (
        <Figure label="Beyond schedule" value={fmtKoboExact(t.unallocated_kobo)} color={AMBER} size={20}
                sub="Received but not matched to any instalment — check the tenor or a restructure" />
      )}
    </div>
  )
}

// ── Facility rail ─────────────────────────────────────────────────────────────

export function FacilityRail({
  facilities, selected, onSelect,
}: { facilities: Facility[]; selected: string; onSelect: (k: string) => void }) {
  if (facilities.length === 0) return null
  return (
    <div style={{
      display: 'grid', gap: SP[3], marginBottom: SP[4],
      gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))',
    }}>
      {facilities.map(f => {
        const on = f.key === selected
        const c = kindColor(f.kind)
        const meterColor = f.paid_pct >= 80 ? GREEN : f.paid_pct >= 40 ? AMBER : RED
        return (
          <button
            key={f.key}
            onClick={() => onSelect(f.key)}
            style={{
              textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
              background: 'var(--card)', borderRadius: RADIUS.lg, overflow: 'hidden',
              border: on ? `1.5px solid ${c}` : '1px solid var(--bdr)',
              boxShadow: on ? `0 0 0 3px ${c}1A` : 'none',
              display: 'grid', gridTemplateColumns: '4px 1fr',
            }}
          >
            <div style={{ background: c }} />
            <div style={{ padding: `${SP[3]} ${SP[4]}`, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                <Chip label={f.kind} color={c} solid={on} />
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold }}>{f.origin}</span>
                {f.is_subject && <Chip label="This account" color={NAVY} />}
                {SETTLED_STATUS.has((f.status ?? '').toLowerCase()) && (
                  <Chip label={f.status.toLowerCase() === 'closed' ? 'Settled' : f.status} color={GREEN} />
                )}
                {f.dpd > 0 && <Chip label={`${f.dpd}d late`} color={f.dpd > 90 ? RED : AMBER} />}
                {f.also_in_udara && (
                  <span
                    title="This uploaded loan mirrors a facility already booked in Udara core banking. Shown for its schedule — do not count the exposure twice."
                    style={{
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
                      textTransform: 'uppercase', padding: '2px 8px', borderRadius: RADIUS.full,
                      background: `${AMBER}18`, color: AMBER, whiteSpace: 'nowrap',
                    }}
                  >Mirrors Udara</span>
                )}
              </div>
              <div style={{
                fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.product}</div>
              <div style={{
                ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 8,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.ref || '—'}{f.cif && !isInternalId(f.cif) ? ` · CIF ${f.cif}` : ''}</div>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1.1 }}>
                {fmtKoboExact(f.outstanding_kobo)}
              </div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', margin: '3px 0 8px' }}>outstanding</div>
              {f.scheduled_kobo > 0 ? (
                <>
                  <Meter pct={f.paid_pct} color={meterColor} height={4} />
                  <div style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 5 }}>
                    {f.paid_pct.toFixed(0)}% of {fmtKoboExact(f.scheduled_kobo)} schedule paid
                  </div>
                </>
              ) : (
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>No schedule on file</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Facility terms ────────────────────────────────────────────────────────────

function Term({ label, value }: { label: string; value: string }) {
  if (!value || value === '—') return null
  return (
    <div>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 3,
      }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', wordBreak: 'break-word' }}>
        {value}
      </div>
    </div>
  )
}

export function FacilityTerms({ f }: { f: Facility }) {
  const pctTxt = (v: number) => (v > 0 ? `${v.toFixed(1)}%` : '')
  const terms: [string, string][] = f.kind === 'card'
    ? [
        ['Card', f.pan_masked],
        ['Account', f.ref],
        ['Credit limit', f.limit_kobo ? fmtKoboExact(f.limit_kobo) : ''],
        ['Current balance', fmtKoboExact(f.outstanding_kobo)],
        ['Cycle balance', f.cycle_balance_kobo ? fmtKoboExact(f.cycle_balance_kobo) : ''],
        ['Minimum due', f.min_payment_kobo ? fmtKoboExact(f.min_payment_kobo) : ''],
        ['Utilisation', pctTxt(f.utilisation)],
        ['Payment due', f.next_due_date ? fmtDate(f.next_due_date) : ''],
        ['Days overdue', f.dpd > 0 ? `${f.dpd}` : ''],
        ['Last payment', f.last_payment_kobo ? `${fmtKoboExact(f.last_payment_kobo)}${f.last_payment_date ? ` on ${fmtDate(f.last_payment_date)}` : ''}` : ''],
        ['Opened', f.opened_date ? fmtDate(f.opened_date) : ''],
        ['Expires', f.expiry_date ? fmtDate(f.expiry_date) : ''],
        ['Status', f.status],
      ]
    : [
        ['Mandate / account', f.ref],
        ['Principal', f.principal_kobo ? fmtKoboExact(f.principal_kobo) : ''],
        ['Outstanding', fmtKoboExact(f.outstanding_kobo)],
        ['Monthly repayment', f.instalment_kobo ? fmtKoboExact(f.instalment_kobo) : ''],
        ['Rate', f.rate ? `${f.rate}%` : ''],
        ['Tenor', f.tenor && !/months|days/.test(f.tenor) ? `${f.tenor} months` : f.tenor],
        ['Disbursed', f.opened_date ? fmtDate(f.opened_date) : ''],
        ['Matures', f.maturity_date ? fmtDate(f.maturity_date) : ''],
        ['Debit day', f.debit_day],
        ['Account officer', f.officer_name],
        ['Guarantor', f.guarantor_name],
        ['Collateral', f.collateral_type ? `${f.collateral_type}${f.collateral_valuation_kobo ? ` · ${fmtKoboExact(f.collateral_valuation_kobo)}` : ''}` : ''],
        ['Sector', f.economic_sector],
        ['Branch', f.branch_name],
        ['Status', f.status],
      ]
  return (
    <div style={{
      display: 'grid', gap: `${SP[4]} ${SP[5]}`,
      gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
      padding: `${SP[4]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
    }}>
      {terms.map(([l, v]) => <Term key={l} label={l} value={v} />)}
    </div>
  )
}

// ── Repayment schedule ────────────────────────────────────────────────────────

// How far an instalment is from today. A settled one needs no countdown; anything
// still owed is either coming up (with a warning inside the 7-day window an officer
// should be calling on) or already past due, which is the number that drives priority.
function DueTiming({ row }: { row: SchedRow }) {
  if (!row.days_known) return <span style={{ color: 'var(--txt3)' }}>—</span>

  const settled = row.status === 'paid'
  const d = row.days_to_due
  let text: string
  let color = 'var(--txt3)'

  if (settled) {
    text = 'Settled'
    color = GREEN
  } else if (d < 0) {
    text = `${Math.abs(d)} ${Math.abs(d) === 1 ? 'day' : 'days'} past due`
    color = Math.abs(d) > 90 ? RED : Math.abs(d) > 30 ? '#EA580C' : AMBER
  } else if (d === 0) {
    text = 'Due today'
    color = BLUE
  } else {
    text = `Due in ${d} ${d === 1 ? 'day' : 'days'}`
    // Inside a week is the window the customer should be called in.
    color = d <= 7 ? AMBER : 'var(--txt2)'
  }

  return (
    <span style={{
      ...NUM, fontSize: TEXT.xs, fontWeight: d <= 7 || settled ? FW.bold : FW.semibold,
      color, whiteSpace: 'nowrap',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      {!settled && d > 0 && d <= 7 && (
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>notifications_active</span>
      )}
      {!settled && d < 0 && (
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>error</span>
      )}
      {text}
    </span>
  )
}

export function ScheduleTable({ f }: { f: Facility }) {
  const isCycle = f.schedule.some(s => s.source === 'cycle')
  const hasSplit = f.schedule.some(s => s.interest_kobo > 0 || s.fee_kobo > 0)

  if (f.schedule.length === 0) {
    return (
      <EmptyState
        icon="event_busy"
        title="No repayment schedule"
        description={f.schedule_note || 'Nothing on file for this facility.'}
      />
    )
  }

  const th: React.CSSProperties = {
    fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--txt3)', padding: `${SP[2]} ${SP[3]}`, textAlign: 'right', whiteSpace: 'nowrap',
    borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)', position: 'sticky', top: 0,
  }
  const td: React.CSSProperties = {
    ...NUM, fontSize: TEXT.sm, padding: `${SP[2]} ${SP[3]}`, textAlign: 'right',
    borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap', color: 'var(--txt)',
  }

  return (
    <div>
      <div style={{ overflowX: 'auto', maxHeight: 460, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: hasSplit ? 860 : 680 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', paddingLeft: SP[5] }}>{isCycle ? 'Billing period' : 'Instalment'}</th>
              <th style={{ ...th, textAlign: 'left' }}>{isCycle ? 'Month' : 'Due date'}</th>
              {!isCycle && <th style={{ ...th, textAlign: 'left', minWidth: 118 }}>Timing</th>}
              {hasSplit && <th style={th}>Principal</th>}
              {hasSplit && <th style={th}>Interest</th>}
              {hasSplit && <th style={th}>Fees</th>}
              <th style={th}>{isCycle ? 'Billed' : 'Due'}</th>
              <th style={th}>Paid</th>
              <th style={{ ...th, textAlign: 'left', minWidth: 130 }}>% paid</th>
              <th style={{ ...th, textAlign: 'left', paddingRight: SP[5] }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {f.schedule.map(s => {
              const m = STATUS_META[s.status] ?? STATUS_META.upcoming
              const shortfall = s.due_kobo - s.paid_kobo
              return (
                <tr key={`${s.n}-${s.due_date}`}>
                  <td style={{ ...td, textAlign: 'left', paddingLeft: SP[5], fontWeight: FW.semibold }}>
                    {isCycle ? s.label : `#${s.n}`}
                  </td>
                  <td style={{ ...td, textAlign: 'left', color: 'var(--txt2)' }}>
                    {isCycle ? '' : fmtDate(s.due_date)}
                  </td>
                  {!isCycle && (
                    <td style={{ ...td, textAlign: 'left' }}>
                      <DueTiming row={s} />
                    </td>
                  )}
                  {hasSplit && <td style={{ ...td, color: 'var(--txt2)' }}>{s.principal_kobo ? fmtKoboExact(s.principal_kobo) : '—'}</td>}
                  {hasSplit && <td style={{ ...td, color: 'var(--txt2)' }}>{s.interest_kobo ? fmtKoboExact(s.interest_kobo) : '—'}</td>}
                  {hasSplit && <td style={{ ...td, color: 'var(--txt2)' }}>{s.fee_kobo ? fmtKoboExact(s.fee_kobo) : '—'}</td>}
                  <td style={{ ...td, fontWeight: FW.semibold }}>{fmtKoboExact(s.due_kobo)}</td>
                  <td style={{ ...td, fontWeight: FW.bold, color: s.paid_kobo > 0 ? GREEN : 'var(--txt3)' }}>
                    {s.paid_kobo > 0 ? fmtKoboExact(s.paid_kobo) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'left', minWidth: 130 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1 }}><Meter pct={s.paid_pct} color={m.color} height={5} /></div>
                      <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: m.color, minWidth: 38, textAlign: 'right' }}>
                        {s.paid_pct.toFixed(0)}%
                      </span>
                    </div>
                    {shortfall > 0 && s.status !== 'upcoming' && (
                      <div style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>
                        {fmtKoboExact(shortfall)} short
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'left', paddingRight: SP[5] }}>
                    <Chip label={m.label} color={m.color} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {f.schedule_note && (
        <div style={{
          padding: `${SP[3]} ${SP[5]}`, fontSize: TEXT.xs, color: 'var(--txt3)',
          borderTop: '1px solid var(--bdr)', lineHeight: 1.6,
        }}>{f.schedule_note}</div>
      )}
    </div>
  )
}

// ── Repayment ledger ──────────────────────────────────────────────────────────

export function RepaymentLedger({ repayments }: { repayments: Repayment[] }) {
  const [filter, setFilter] = useState<'all' | 'collections' | 'card'>('all')
  const rows = useMemo(
    () => (filter === 'all' ? repayments : repayments.filter(r => r.source === filter)),
    [repayments, filter],
  )
  const total = useMemo(() => rows.reduce((s, r) => s + r.amount_kobo, 0), [rows])

  if (repayments.length === 0) {
    return <EmptyState icon="payments" title="No repayments recorded" description="Nothing has been received on this customer's credit yet." />
  }

  const counts = {
    all: repayments.length,
    collections: repayments.filter(r => r.source === 'collections').length,
    card: repayments.filter(r => r.source === 'card').length,
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: `${SP[3]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
      }}>
        {([
          ['all', 'All'],
          ['collections', 'Logged to collections'],
          ['card', 'Card ledger'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            style={{
              padding: '4px 11px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: TEXT.xs, fontWeight: FW.semibold,
              border: `1.5px solid ${filter === k ? NAVY : 'var(--bdr)'}`,
              background: filter === k ? NAVY : 'var(--card)',
              color: filter === k ? '#fff' : 'var(--txt2)',
            }}
          >{label} ({counts[k]})</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN }}>
          {fmtKoboExact(total)}
        </span>
      </div>
      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        {rows.map((p, i) => (
          <div key={`${p.source}-${p.date}-${p.reference}-${i}`} style={{
            padding: `${SP[3]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
            display: 'grid', gridTemplateColumns: '1fr auto', gap: SP[4], alignItems: 'center',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN }}>
                  {fmtKoboExact(p.amount_kobo)}
                </span>
                <Chip label={p.source === 'card' ? 'Card ledger' : 'Collections'} color={p.source === 'card' ? PURPLE : NAVY} />
                {p.status && p.status !== 'posted' && <Chip label={p.status.replace(/_/g, ' ')} color={p.status === 'approved' ? GREEN : AMBER} />}
              </div>
              <div style={{
                fontSize: TEXT.xs, color: 'var(--txt3)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {p.channel || '—'}
                {p.reference ? ` · ${p.reference}` : ''}
                {p.received_by ? ` · posted by ${p.received_by}` : ''}
              </div>
            </div>
            <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
              {fmtDate(p.date)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Loading / empty shells ────────────────────────────────────────────────────

export function CreditFileSkeleton() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: SP[10] }}>
      <Spinner size={26} />
    </div>
  )
}
