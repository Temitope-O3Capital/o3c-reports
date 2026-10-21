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
import { humanLabel } from '../lib/labels'

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
  is_restructure: boolean
  restructured_from: string
  restructured_from_kobo: number
  was_restructured_into: boolean
  scheduled_kobo: number
  expected_kobo: number
  paid_kobo: number
  paid_pct: number
  arrears_kobo: number
  schedule: SchedRow[]
  schedule_note: string
}

export interface SourceAge {
  source_key: 'feed_accounts' | 'feed_transactions' | 'cbs' | 'cbs_repayments'
  label: string
  state: string
  last_data_at: string | null
  days_stale: number
}

// WHICH FEED GOVERNS WHICH HALF OF THIS PAGE.
//
// The card side arrives on nightly file feeds and the Udara side on an API poll, and the
// two keep completely different time — on 2026-10-21 the card feeds were 15 days behind
// while Udara was current to the minute. So "how old is this figure" has no single
// answer, and the page has to say which source it means.
//
//   feed_accounts      app.accounts      -> the card balance, i.e. the headline outstanding
//   feed_transactions  core.transaction  -> the card ledger, i.e. billing cycles and card receipts
//   cbs                cbs_loans         -> Udara facilities and their schedules
//   cbs_repayments     loan_repayments   -> Udara repayment postings
export const CARD_SOURCES: SourceAge['source_key'][] = ['feed_accounts', 'feed_transactions']
export const UDARA_SOURCES: SourceAge['source_key'][] = ['cbs', 'cbs_repayments']

// A day is the smallest unit worth reporting here: these are nightly feeds, so "17 hours"
// would imply a precision the pipeline does not have. Same day reads as current.
export function sourceAgeNote(sources: SourceAge[] | undefined, keys: SourceAge['source_key'][]): string {
  const rel = (sources ?? []).filter(s => keys.includes(s.source_key) && s.last_data_at)
  if (rel.length === 0) return ''
  // The OLDEST of the relevant feeds governs: a figure is only as current as the stalest
  // input behind it, and quoting the freshest would be the flattering answer.
  const worst = rel.reduce((a, b) => (b.days_stale > a.days_stale ? b : a))
  if (worst.days_stale <= 0) return 'Current to today'
  if (worst.days_stale === 1) return 'As at yesterday'
  return `As at ${fmtDate(worst.last_data_at as string)} · ${worst.days_stale} days behind`
}

// Shown only when a feed is genuinely behind. A badge that always appears stops being
// read, and on a page of money figures the one that matters is the one that is stale.
export function DataAge({ sources, keys, align = 'left' }: {
  sources: SourceAge[] | undefined
  keys: SourceAge['source_key'][]
  align?: 'left' | 'right'
}) {
  const rel = (sources ?? []).filter(s => keys.includes(s.source_key) && s.last_data_at)
  if (rel.length === 0) return null
  const worst = rel.reduce((a, b) => (b.days_stale > a.days_stale ? b : a))
  if (worst.days_stale <= 1) return null

  const bad = worst.days_stale > 7
  const c = bad ? RED : AMBER
  return (
    <div
      title={`${worst.label} last delivered ${fmtDate(worst.last_data_at as string)}. Every figure drawn from it is that old — it is not live.`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6,
        padding: '2px 8px', borderRadius: RADIUS.full,
        background: `${c}14`, color: c,
        fontSize: TEXT['2xs'], fontWeight: FW.bold,
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>schedule</span>
      As at {fmtDate(worst.last_data_at as string)} · {worst.days_stale}d behind
    </div>
  )
}

export interface Repayment {
  date: string
  amount_kobo: number
  channel: string
  reference: string
  // 'udara' was MISSING from this union, and that is most of the "repayments are
  // scattered" complaint. The handler has been sending core-banking loan postings as
  // source 'udara' ever since that linkage was added; the ledger below knew only two
  // sources, so every one of them fell through a `source === 'card' ? … : 'Collections'`
  // ternary and was labelled Collections — a Udara general-ledger posting presented as
  // something an agent had keyed in, with no filter and no count of its own.
  source: 'collections' | 'card' | 'udara'
  facility_key: string
  received_by: string
  status: string
  component?: string
  is_imported?: boolean
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
  // How old each feed behind this page is. Not the same thing as the envelope's
  // data_as_of, which is time.Now() and therefore always says "just now".
  sources?: SourceAge[]
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

// A Udara-sourced collections row is keyed 'UD-<udara customer id>' (migration 267).
export function isUdaraKey(id: string | null | undefined): boolean {
  return /^UD-/i.test((id ?? '').trim())
}

// Caption an identifier with the namespace it ACTUALLY belongs to.
//
// CIF is a CARDS identifier. A Udara customer id is a different namespace that happens
// to use the same 8-digit shape, and 289 of the 295 Udara ids also exist as a real card
// CIF — 94% of them belonging to a DIFFERENT PERSON. So printing a Udara id as "CIF"
// is not a cosmetic slip: it invites someone to look that number up in the cards system
// and act on a stranger's record. Udara customers do not have a CIF at all; their
// workspace profiles carry cif = NULL, which is correct and must stay that way.
//
// Returns '' for synthetic workspace handles, which mean nothing to a reader.
// `origin` is REQUIRED wherever the caller knows it, and passing it is not optional
// politeness: a bare Udara id and a cards CIF are both 8 zero-padded digits, so the
// VALUE CANNOT BE CLASSIFIED BY LOOKING AT IT. An earlier version of this function tried,
// and captioned every Udara-sourced facility "CIF <udara id>" — pointing the reader at a
// different person's cards record, which is the exact failure the prefix rule exists to
// stop. Only the 'UD-' prefix (collections rows, migration 267) is self-describing.
export function idCaption(id: string | null | undefined, origin?: string): string {
  const s = (id ?? '').trim()
  if (!s) return ''
  if (isUdaraKey(s)) return `Udara ID ${s.slice(3)}`
  if (isInternalId(s)) return ''
  const o = (origin ?? '').trim().toLowerCase()
  if (o === 'udara' || o === 'cbs') return `Udara ID ${s}`
  // No origin and no prefix: say nothing rather than assert the wrong namespace.
  if (!o) return s
  return `CIF ${s}`
}

// ── Shared bits ───────────────────────────────────────────────────────────────

const STATUS_META: Record<SchedRow['status'], { label: string; color: string }> = {
  paid:     { label: 'Paid',     color: GREEN },
  partial:  { label: 'Part-Paid',color: AMBER },
  overdue:  { label: 'Overdue',  color: RED   },
  due:      { label: 'Due Today',color: BLUE  },
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
    ['cake', 'Date of Birth', c.date_of_birth ? fmtDate(c.date_of_birth) : ''],
    ['wc', 'Gender', c.gender],
    ['verified_user', 'Account Status', c.account_status],
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
        No contact details on file for this customer. Nothing to call, email or visit.
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
      }}>Customer Details</div>

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
          }}>Other Numbers on File ({others.length})</div>
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
                  {idCaption(p.source_id) ? ` · from ${idCaption(p.source_id)}` : ''}
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
              In Recovery: case {recovery.case_ref || recovery.id}
              {recovery.legal_stage ? ` · ${humanLabel(recovery.legal_stage)}` : ''}
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
            >Open Recovery Case</button>
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
              {humanLabel(a.kind)} {a.concession_type ? `· ${humanLabel(a.concession_type)}` : ''} approved
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

// ExposureStrip answers ONE question — is this customer keeping to the schedule — and
// no longer repeats the two figures that are stated elsewhere on the page.
//
// Total Exposure left because the masthead now carries the live outstanding figure as
// the page's single headline, and two 24px naira amounts on one screen that disagree
// (41% of accounts) is the defect this strip was half of. Payments Received left because
// its "Logged to collections" subtitle was the giveaway: it counted only
// collection_payments, which is the lane the Repayments tab now labels explicitly, while
// the customer's core-banking and card-ledger receipts were excluded from it. A figure
// that silently means "some of the money" does not belong next to one that means all of
// it.
//
// What remains is a run of schedule figures that read left to right as one sentence:
// this much was scheduled, this much of it has landed, this much is behind, this much is
// next.
export function ExposureStrip({ t }: { t: CreditDossier['totals'] }) {
  const recovered = t.paid_pct
  const meterColor = recovered >= 80 ? GREEN : recovered >= 40 ? AMBER : RED
  const nothingScheduled = t.scheduled_kobo === 0

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl,
      padding: `${SP[4]} ${SP[5]}`, marginBottom: SP[4],
    }}>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.07em',
        textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: SP[3],
      }}>Against The Schedule</div>

      {nothingScheduled ? (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          Nothing is scheduled on this customer&rsquo;s credit, so there is no schedule to
          measure against. A card revolves rather than amortising; a closed loan keeps no
          schedule. The Repayments tab still shows every receipt.
        </div>
      ) : (
        <div style={{
          display: 'grid', gap: SP[5],
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end',
        }}>
          <Figure label="Scheduled" value={fmtKoboExact(t.scheduled_kobo)}
                  sub={`Due to date ${fmtKoboExact(t.expected_kobo)}`} size={22} />
          <div>
            <Figure label="Paid Against Schedule" value={fmtKoboExact(t.schedule_paid_kobo)} color={GREEN} size={22}
                    sub={`${recovered.toFixed(1)}% of the schedule`} />
            <div style={{ marginTop: 8 }}><Meter pct={recovered} color={meterColor} /></div>
          </div>
          <Figure label="Arrears" value={fmtKoboExact(t.arrears_kobo)}
                  color={t.arrears_kobo > 0 ? RED : GREEN} size={22}
                  sub={t.arrears_kobo > 0 ? 'Behind the schedule' : 'On or ahead of schedule'} />
          <Figure label="Next Instalment"
                  value={t.next_due_date ? fmtKoboExact(t.next_due_kobo) : '—'}
                  sub={t.next_due_date ? `Due ${fmtDate(t.next_due_date)}` : 'Nothing scheduled ahead'}
                  size={22} />
          {t.unallocated_kobo > 0 && (
            <Figure label="Beyond Schedule" value={fmtKoboExact(t.unallocated_kobo)} color={AMBER} size={22}
                    sub="Received but not matched to any instalment. Check the tenor or a restructure" />
          )}
        </div>
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
                {f.is_subject && <Chip label="This Account" color={NAVY} />}
                {SETTLED_STATUS.has((f.status ?? '').toLowerCase()) && (
                  <Chip label={f.status.toLowerCase() === 'closed' ? 'Settled' : f.status} color={GREEN} />
                )}
                {f.dpd > 0 && <Chip label={`${f.dpd}d late`} color={f.dpd > 90 ? RED : AMBER} />}
                {f.also_in_udara && (
                  <span
                    title="This uploaded loan mirrors a facility already booked in Udara core banking. Shown for its schedule. Do not count the exposure twice."
                    style={{
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
                      textTransform: 'uppercase', padding: '2px 8px', borderRadius: RADIUS.full,
                      background: `${AMBER}18`, color: AMBER, whiteSpace: 'nowrap',
                    }}
                  >Mirrors Udara</span>
                )}
                {/* Restructure lineage (migration 277). On a collections call the borrower
                    already knows this is the same debt on new terms; the agent should too. */}
                {f.is_restructure && (
                  <span
                    title={`Restructured from ${f.restructured_from || 'an earlier facility'}${f.restructured_from_kobo ? ` · originally ${fmtKoboExact(f.restructured_from_kobo)}` : ''} — this is existing debt on new terms, not new lending.`}
                    style={{
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
                      textTransform: 'uppercase', padding: '2px 8px', borderRadius: RADIUS.full,
                      background: `${PURPLE}18`, color: PURPLE, whiteSpace: 'nowrap', cursor: 'help',
                    }}
                  >Restructured</span>
                )}
                {f.was_restructured_into && !f.is_restructure && (
                  <span
                    title="This facility was replaced by a later one for the same customer. Its balance is history. The successor carries the live debt."
                    style={{
                      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em',
                      textTransform: 'uppercase', padding: '2px 8px', borderRadius: RADIUS.full,
                      background: 'var(--chip-bg)', color: 'var(--txt3)', whiteSpace: 'nowrap', cursor: 'help',
                    }}
                  >Superseded</span>
                )}
              </div>
              {f.is_restructure && f.restructured_from && (
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2, ...NUM }}>
                  continues {f.restructured_from}
                  {f.restructured_from_kobo ? ` · originally ${fmtKoboExact(f.restructured_from_kobo)}` : ''}
                </div>
              )}
              <div style={{
                fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.product}</div>
              <div style={{
                ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 8,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.ref || '—'}{idCaption(f.cif, f.origin) ? ` · ${idCaption(f.cif, f.origin)}` : ''}</div>
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
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>No Schedule on File</div>
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
        ['Credit Limit', f.limit_kobo ? fmtKoboExact(f.limit_kobo) : ''],
        ['Current Balance', fmtKoboExact(f.outstanding_kobo)],
        ['Cycle Balance', f.cycle_balance_kobo ? fmtKoboExact(f.cycle_balance_kobo) : ''],
        ['Minimum Due', f.min_payment_kobo ? fmtKoboExact(f.min_payment_kobo) : ''],
        ['Utilisation', pctTxt(f.utilisation)],
        ['Payment Due', f.next_due_date ? fmtDate(f.next_due_date) : ''],
        ['Days Overdue', f.dpd > 0 ? `${f.dpd}` : ''],
        ['Last Payment', f.last_payment_kobo ? `${fmtKoboExact(f.last_payment_kobo)}${f.last_payment_date ? ` on ${fmtDate(f.last_payment_date)}` : ''}` : ''],
        ['Opened', f.opened_date ? fmtDate(f.opened_date) : ''],
        ['Expires', f.expiry_date ? fmtDate(f.expiry_date) : ''],
        ['Status', f.status],
      ]
    : [
        ['Mandate / Account', f.ref],
        ['Principal', f.principal_kobo ? fmtKoboExact(f.principal_kobo) : ''],
        ['Outstanding', fmtKoboExact(f.outstanding_kobo)],
        ['Monthly Repayment', f.instalment_kobo ? fmtKoboExact(f.instalment_kobo) : ''],
        ['Rate', f.rate ? `${f.rate}%` : ''],
        ['Tenor', f.tenor && !/months|days/.test(f.tenor) ? `${f.tenor} months` : f.tenor],
        ['Disbursed', f.opened_date ? fmtDate(f.opened_date) : ''],
        ['Matures', f.maturity_date ? fmtDate(f.maturity_date) : ''],
        ['Debit Day', f.debit_day],
        ['Account Officer', f.officer_name],
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
    // A card is not a loan with a missing schedule. It revolves: there is no
    // amortisation to show and there never will be, so heading the panel "No Repayment
    // Schedule" reads as a fault on 416 of the 458 accounts in the queue, which are
    // cards. The handler's note already says which case this is; the title should agree
    // with it rather than contradict it.
    const isCard = f.kind === 'card'
    return (
      <EmptyState
        icon={isCard ? 'credit_card' : 'event_busy'}
        title={isCard ? 'No Billing Activity Yet' : 'No Repayment Schedule'}
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
              <th style={{ ...th, textAlign: 'left', paddingLeft: SP[5] }}>{isCycle ? 'Billing Period' : 'Instalment'}</th>
              <th style={{ ...th, textAlign: 'left' }}>{isCycle ? 'Month' : 'Due Date'}</th>
              {!isCycle && <th style={{ ...th, textAlign: 'left', minWidth: 118 }}>Timing</th>}
              {hasSplit && <th style={th}>Principal</th>}
              {hasSplit && <th style={th}>Interest</th>}
              {hasSplit && <th style={th}>Fees</th>}
              <th style={th}>{isCycle ? 'Billed' : 'Due'}</th>
              <th style={th}>Paid</th>
              <th style={{ ...th, textAlign: 'left', minWidth: 130 }}>% Paid</th>
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

// A repayment belongs to one of three LANES, not one of three sources, and the
// distinction is the point.
//
//   book     what a system of record says was received — Udara's general ledger for a
//            loan, the CCS card ledger for a card. Nobody typed these.
//   logged   a receipt an officer keyed into collections by hand.
//   imported a row that arrived in a spreadsheet upload.
//
// The lane decides what the reader is looking at, and the default decides what they
// see first. 1,713 of the 1,812 collection_payments rows are imports, so "All" opened
// on a wall of upload rows with the real receipts buried inside it — which is how a
// ledger that is populated reads as a ledger that is wrong.
//
// So the book of record leads whenever there is one. The other lanes are one click
// away and still counted, because an import is history and hiding it entirely would
// make a customer who paid through 2025 look as though they never paid at all.
type Lane = 'book' | 'logged' | 'imported'

function laneOf(r: Repayment): Lane {
  if (r.source === 'udara' || r.source === 'card') return 'book'
  return r.is_imported ? 'imported' : 'logged'
}

const SOURCE_CHIP: Record<Repayment['source'], { label: string; color: string }> = {
  udara:       { label: 'Core Banking', color: BLUE },
  card:        { label: 'Card Ledger',  color: PURPLE },
  collections: { label: 'Logged',       color: NAVY },
}

export function RepaymentLedger({ repayments, sources }: {
  repayments: Repayment[]
  sources?: SourceAge[]
}) {
  const counts = useMemo(() => {
    const c: Record<Lane, number> = { book: 0, logged: 0, imported: 0 }
    for (const r of repayments) c[laneOf(r)]++
    return c
  }, [repayments])

  // Open on the lane that is actually worth reading, in order of authority. Deliberately
  // not "whichever has the most rows": the imports outnumber everything on almost every
  // customer, and they are the least authoritative thing here.
  const initialLane: Lane = counts.book > 0 ? 'book' : counts.logged > 0 ? 'logged' : 'imported'
  const [lane, setLane] = useState<Lane>(initialLane)
  const activeLane = counts[lane] > 0 ? lane : initialLane

  const rows = useMemo(
    () => repayments.filter(r => laneOf(r) === activeLane),
    [repayments, activeLane],
  )
  const total = useMemo(() => rows.reduce((s, r) => s + r.amount_kobo, 0), [rows])

  if (repayments.length === 0) {
    return <EmptyState icon="payments" title="No Repayments Recorded" description="Nothing has been received on this customer's credit, from core banking, the card ledger or collections." />
  }

  const LANES: { key: Lane; label: string; hint: string }[] = [
    { key: 'book',     label: 'Core Banking & Card Ledger', hint: 'What the bank’s own systems recorded' },
    { key: 'logged',   label: 'Logged by an Officer',        hint: 'Keyed into collections by hand' },
    { key: 'imported', label: 'Imported',                   hint: 'Loaded from a spreadsheet' },
  ]

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: `${SP[3]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
      }}>
        {LANES.map(l => (
          <button
            key={l.key}
            onClick={() => setLane(l.key)}
            disabled={counts[l.key] === 0}
            title={l.hint}
            style={{
              padding: '4px 11px', borderRadius: RADIUS.md, fontFamily: 'inherit',
              cursor: counts[l.key] === 0 ? 'not-allowed' : 'pointer',
              opacity: counts[l.key] === 0 ? 0.45 : 1,
              fontSize: TEXT.xs, fontWeight: FW.semibold,
              border: `1.5px solid ${activeLane === l.key ? NAVY : 'var(--bdr)'}`,
              background: activeLane === l.key ? NAVY : 'var(--card)',
              color: activeLane === l.key ? '#fff' : 'var(--txt2)',
            }}
          >{l.label} ({counts[l.key]})</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN }}>
          {fmtKoboExact(total)}
        </span>
      </div>

      {/* The book-of-record lane is the one people will trust, so it is the one that has
          to admit how old it is. Keyed to the sources the visible rows actually came
          from: a lane of Udara postings is not stale because a card feed is. */}
      {activeLane === 'book' && (() => {
        const keys: SourceAge['source_key'][] = [
          ...(rows.some(r => r.source === 'card') ? CARD_SOURCES : []),
          ...(rows.some(r => r.source === 'udara') ? UDARA_SOURCES : []),
        ]
        const note = sourceAgeNote(sources, keys)
        if (!note || note === 'Current to today') return null
        return (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: `${SP[2]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
            fontSize: TEXT.xs, color: 'var(--txt3)',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>schedule</span>
            {note} — a payment received since then has not reached this ledger yet.
          </div>
        )
      })()}

      {activeLane === 'imported' && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: `${SP[3]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
          background: `${AMBER}12`,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: AMBER }}>upload_file</span>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
            These rows came from a spreadsheet, not from a receipt. They are the only record of
            repayments before Udara&rsquo;s call-over begins, so they are kept and shown here —
            but where core banking also holds the payment, the core banking figure is the one
            that counts.
          </span>
        </div>
      )}

      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
        {rows.map((p, i) => {
          const chip = SOURCE_CHIP[p.source] ?? SOURCE_CHIP.collections
          return (
            <div key={`${p.source}-${p.date}-${p.reference}-${i}`} style={{
              padding: `${SP[3]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
              display: 'grid', gridTemplateColumns: '1fr auto', gap: SP[4], alignItems: 'center',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN }}>
                    {fmtKoboExact(p.amount_kobo)}
                  </span>
                  <Chip label={chip.label} color={chip.color} />
                  {/* The core banking ledger posts principal and interest as separate
                      entries, and it is the only source that states the split. */}
                  {p.component && <Chip label={humanLabel(p.component)} color={BLUE} />}
                  {p.is_imported && <Chip label="Imported" color={AMBER} />}
                  {p.status && p.status !== 'posted' && <Chip label={humanLabel(p.status)} color={p.status === 'approved' ? GREEN : AMBER} />}
                </div>
                <div style={{
                  fontSize: TEXT.xs, color: 'var(--txt3)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {p.channel || '—'}
                  {p.reference ? ` · ${p.reference}` : ''}
                  {/* An import is not credited to a person: the name on these rows is
                      whichever account ran the loader, not whoever took the money. */}
                  {p.received_by && !p.is_imported ? ` · posted by ${p.received_by}` : ''}
                </div>
              </div>
              <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                {fmtDate(p.date)}
              </span>
            </div>
          )
        })}
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
