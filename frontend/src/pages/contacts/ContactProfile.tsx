import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Tabs, Pagination, Modal, filterInputStyle } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, fmtDatetime, fmtKoboExact, fmtNum } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, SORA, TEXT, FW, SP, RADIUS, TRANSITION } from '../../lib/design'
import { useDebouncedValue } from '../../hooks/useDebounce'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactProfileData {
  cif: string
  customer_id?: string
  identifiers?: {
    customer_id: string
    party_id: number
    cifs: string[]
    workspace_ids: string[]
    loan_mandates: string[]
    udara_loan_accounts: string[]
    fd_accounts: string[]
  }
  loans?: {
    mandate_id: string | null
    name: string | null
    outstanding_kobo: number | null
    repayment_kobo: number | null
    tenor: string | null
    rate: string | null
    debit_day: string | null
    disbursement_date: string | null
    maturity_date: string | null
    dpd_bucket: string | null
    officer_name: string | null
    source: string | null
  }[]
  name: string
  phone: string
  email: string
  bvn?: string
  nin?: string
  address?: string
  full_address?: string
  city?: string
  country?: string
  state?: string
  employer?: string
  monthly_income_kobo?: number
  date_of_birth?: string
  gender?: string

  // Repayments (naira) + monthly cadence, for the collections/recovery teams.
  payment_history?: { date: string; amount: number; description: string | null; merchant: string | null }[]
  repayment_pattern?: { month: string; amount: number; count: number }[]
  last_payment?: { date: string; amount: number; description: string | null; merchant: string | null }

  is_prospect: boolean
  is_applicant: boolean
  is_active_customer: boolean
  is_card_holder: boolean
  is_delinquent: boolean
  is_in_recovery: boolean
  is_written_off: boolean

  crm?: {
    contact_id: number
    status: string
    assigned_to: string
    created_at: string
    deals: { id: number; title: string; value_kobo: number; stage: string }[]
    activities: { id: number; type: string; note: string; created_at: string; user: string }[]
  }

  applications: {
    id: number
    ref: string
    product_type: string
    amount_requested_kobo: number
    stage: string
    created_at: string
  }[]

  active_loans: {
    id: number
    ref: string
    product_type: string
    outstanding_kobo: number
    disbursed_kobo: number
    dpd: number
    status: string
    next_payment_date: string | null
  }[]

  // One card = one CIF. `cif` is the handle the Transactions tab filters on;
  // `id` (account_id) is the only unique key, since two card rows can share a CIF.
  cards: {
    id: string
    cif: string
    account_no: string | null
    card_number_masked: string | null
    name_on_card: string | null
    product_name: string | null
    scheme: string | null
    status: string
    // Card-book money is naira numerics, not kobo.
    balance: number | null            // current bill / current debit balance
    bill_balance: number | null       // statement cycle balance
    credit_limit: number | null
    utilisation: number | null
    min_payment: number | null
    days_overdue: number | null
    last_payment_amount: number | null
    last_payment_date: string | null
    expiry_date: string | null
    payment_due: string | null
    issued_at: string | null
    txn_count: number
    last_txn_date: string | null
  }[]

  fixed_deposits: {
    id: string
    ref: string
    product_name: string
    status: string
    principal_kobo: number
    accrued_interest_kobo: number
    interest_rate: number
    commencement_date: string | null
    maturity_date: string | null
  }[]

  summary?: {
    loan_outstanding_kobo: number
    loan_count: number
    fd_principal_kobo: number
    fd_accrued_kobo: number
    fd_count: number
    card_count: number
    active_card_count: number
    txn_count: number
    net_position_kobo: number
  }

  transactions: {
    date: string
    amount: number       // absolute naira value; direction is money_in
    money_in: boolean    // true = credit (into account), false = debit
    description: string
    merchant: string | null
  }[]

  collections?: {
    dpd: number
    dpd_bucket: string
    outstanding_kobo: number
    last_contact_at: string | null
    agent_name: string | null
    ptp_date: string | null
    current_stage: string | null
  }

  recovery_case?: {
    id: number
    case_ref: string
    status: string
    outstanding_kobo: number
    recovered_kobo: number
    write_off_amount_kobo: number
    legal_stage: string | null
    agent_name: string | null
    opened_at: string
  }

  helpdesk_tickets: {
    id: number
    ticket_ref: string
    subject: string
    status: string
    priority: string
    created_at: string
  }[]

  activity_log: {
    id: string
    type: string
    description: string
    created_by: string
    created_at: string
    module: string
    ref: string
    meta: string
  }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────


function statusColour(status: string): string {
  const s = status.toLowerCase()
  if (['active', 'approved', 'disbursed', 'open', 'customer'].includes(s)) return GREEN
  if (['delinquent', 'blocked', 'written_off', 'closed_bad'].includes(s)) return RED
  if (['pending', 'in_progress', 'recovery', 'prospect'].includes(s)) return AMBER
  return '#6B7280'
}

function Badge({ label, colour, outline }: { label: string; colour: string; outline?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 9px', borderRadius: RADIUS.xl,
      fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: SORA,
      background: outline ? 'transparent' : `${colour}18`,
      color: colour,
      border: `1.5px solid ${colour}40`,
    }}>
      {label}
    </span>
  )
}

// Label above value, not a fixed 140px label column — the old two-column layout gave the
// value ~120px inside a 300px card, so emails, addresses and employer names overflowed or
// wrapped under a wide empty gap. Stacked + break-word renders cleanly at any card width.
function InfoPair({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (!value && value !== 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      <span style={{
        fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.35, wordBreak: 'break-word',
        fontFamily: mono ? 'var(--font-mono)' : undefined, fontWeight: mono ? FW.semibold : FW.medium,
      }}>
        {value}
      </span>
    </div>
  )
}

// Flows InfoPairs into as many columns as fit — Identity's 8 fields read as a tidy 2–3
// column block instead of one tall single-file list. Null pairs (no value) collapse out.
function InfoGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '13px 18px' }}>{children}</div>
}

function StagePill({ stage }: { stage: string }) {
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  const colour = statusColour(stage)
  return <Badge label={label} colour={colour} />
}

// "Transactions" Amount is whole naira (not kobo).
function fmtNaira(n: number): string {
  const v = Math.round(Number(n) || 0)
  return `${v < 0 ? '-' : ''}₦${Math.abs(v).toLocaleString('en-NG')}`
}

// The ledger and the card book are not single-currency — the Amex USD products
// hold dollars, so the amount's own currency picks the symbol. Dollars keep their
// cents; naira is whole (kobo is never material at these sizes).
function fmtMoney(n: number, currency?: string): string {
  const v = Number(n) || 0
  if (currency === 'USD') {
    return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
  return fmtNaira(v)
}

// ── Card face ─────────────────────────────────────────────────────────────────
// A card in the book is a real product with a tier, so it gets rendered as a real
// card — 85.6 × 54 mm proportions, chip, grouped PAN, network mark — rather than
// as another table row. Theme comes from the product tier, and the PAN's own BIN
// identifies the network, so nothing here is hardcoded per customer.

interface CardTheme { grad: string; ink: string; sub: string; sheen: string }

const CARD_THEMES: Record<string, CardTheme> = {
  platinum:  { grad: 'linear-gradient(135deg,#9AA7B8 0%,#68788E 45%,#3D4A5C 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', sheen: 'rgba(255,255,255,0.30)' },
  gold:      { grad: 'linear-gradient(135deg,#E0BC6B 0%,#B48A2C 45%,#7E5C13 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.78)', sheen: 'rgba(255,255,255,0.34)' },
  green:     { grad: 'linear-gradient(135deg,#3C8E68 0%,#1F5C3F 45%,#113A27 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', sheen: 'rgba(255,255,255,0.24)' },
  amex:      { grad: 'linear-gradient(135deg,#3390DE 0%,#006FCF 45%,#00457C 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.76)', sheen: 'rgba(255,255,255,0.26)' },
  prestige:  { grad: 'linear-gradient(135deg,#16324F 0%,#0E2841 45%,#050E18 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.68)', sheen: 'rgba(192,0,0,0.38)' },
  prepaid:   { grad: 'linear-gradient(135deg,#2C7A7B 0%,#1D5253 45%,#10312F 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', sheen: 'rgba(255,255,255,0.22)' },
  coop:      { grad: 'linear-gradient(135deg,#5A5AA8 0%,#3B3B76 45%,#22224A 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', sheen: 'rgba(255,255,255,0.22)' },
  charge:    { grad: 'linear-gradient(135deg,#7E4B84 0%,#55305C 45%,#301A36 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', sheen: 'rgba(255,255,255,0.22)' },
  classic:   { grad: 'linear-gradient(135deg,#1D4F7C 0%,#0E2841 45%,#071522 100%)', ink: '#FFFFFF', sub: 'rgba(255,255,255,0.70)', sheen: 'rgba(255,255,255,0.20)' },
}

function cardTheme(card: ContactProfileData['cards'][number]): CardTheme {
  const s = `${card.scheme ?? ''} ${card.product_name ?? ''}`.toLowerCase()
  if (s.includes('platinum'))                        return CARD_THEMES.platinum
  if (s.includes('gold'))                            return CARD_THEMES.gold
  if (s.includes('green'))                           return CARD_THEMES.green
  if (s.includes('amex'))                            return CARD_THEMES.amex
  if (s.includes('prestige'))                        return CARD_THEMES.prestige
  if (s.includes('prep'))                            return CARD_THEMES.prepaid
  if (s.includes('charge'))                          return CARD_THEMES.charge
  if (/coop|memcos|nimcos|ssanu|lirs|inclusion/.test(s)) return CARD_THEMES.coop
  return CARD_THEMES.classic
}

// The BIN on the PAN identifies the network — Verve issues on 5060/5061, so a
// leading 5 must be tested for Verve BEFORE the Mastercard 51–55 range.
function cardNetwork(pan: string | null): string {
  const d = (pan ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (/^(5060|5061|5078|6500)/.test(d)) return 'Verve'
  if (/^3[47]/.test(d))                 return 'Amex'
  if (/^4/.test(d))                     return 'Visa'
  if (/^(5[1-5]|2[2-7])/.test(d))       return 'Mastercard'
  return ''
}

// Lay the masked PAN out the way it is printed on the card.
//
// The book stores masks in mixed shapes — '506124*********1925' (19 chars),
// '379332*****0859' (15), bare 'XXXXXXXXX' with no digits at all. Chunking those
// by four gives ragged groups and a dangling digit. Instead the known digits are
// placed at their real POSITIONS in a 16-digit (or 15-digit Amex) number and the
// rest is bulleted, so '506124*********1925' reads '5061 24•• •••• 1925'.
function panGroups(pan: string | null): string[] {
  const raw = (pan ?? '').trim()
  const lead = (raw.match(/^\d+/) ?? [''])[0]
  const last4 = (raw.match(/(\d{4})$/) ?? ['', ''])[1]
  const amex = /^3[47]/.test(lead)
  const len = amex ? 15 : 16
  const sizes = amex ? [4, 6, 5] : [4, 4, 4, 4]

  const chars = Array.from({ length: len }, (_, i) => {
    if (i < lead.length) return lead[i]
    if (last4 && i >= len - 4) return last4[i - (len - 4)]
    return '•'
  })

  const out: string[] = []
  let at = 0
  for (const size of sizes) { out.push(chars.slice(at, at + size).join('')); at += size }
  return out
}

function isLiveCard(status: string): boolean {
  return ['open', 'active'].includes((status ?? '').toLowerCase())
}

function EmvChip() {
  return (
    <div style={{
      width: 40, height: 30, borderRadius: 5, flexShrink: 0,
      background: 'linear-gradient(135deg,#E8C877 0%,#C9A24A 45%,#9E7C2E 100%)',
      border: '1px solid rgba(0,0,0,0.18)', position: 'relative', overflow: 'hidden',
    }}>
      {[9, 15, 21].map(top => (
        <div key={top} style={{ position: 'absolute', left: 0, right: 0, top, height: 1, background: 'rgba(0,0,0,0.22)' }} />
      ))}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 13, width: 1, background: 'rgba(0,0,0,0.22)' }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, right: 13, width: 1, background: 'rgba(0,0,0,0.22)' }} />
    </div>
  )
}

function CardFace({ card, onClick }: { card: ContactProfileData['cards'][number]; onClick: () => void }) {
  const t = cardTheme(card)
  // A card past its printed expiry is not live no matter what status the book carries —
  // several rows are 'active' with a valid-thru years in the past. Expiry wins.
  const expired = !!card.expiry_date && new Date(card.expiry_date) < new Date()
  const live = isLiveCard(card.status) && !expired
  const network = cardNetwork(card.card_number_masked)
  const limit = Number(card.credit_limit ?? 0)
  const balance = Number(card.balance ?? 0)
  // A negative balance is money the customer is IN CREDIT for (overpaid / prepaid
  // float), not debt — it must never render as a bare "-₦X" or a negative utilisation.
  const inCredit = balance < 0
  // The Amex USD products hold dollars, so the card's own currency decides the
  // symbol — rendering $85.49 as ₦85 would misstate the balance.
  const ccy = /usd/i.test(card.product_name ?? '') ? 'USD' : 'NGN'
  // Utilisation only makes sense against a real limit AND an amount actually drawn.
  // The book stores 0 limits for prepaid/charge cards, and negative balances for
  // cards in credit — both of which produced fictions like "-2264% utilised".
  // Recomputed here (not read from card_utilisation, which holds those bad values);
  // the bar is clamped for layout while the LABEL shows the true figure, so an
  // over-limit card still reads as over-limit.
  const util = (limit > 0 && balance > 0) ? (balance / limit) * 100 : null
  const utilBar = util === null ? 0 : Math.max(0, Math.min(100, util))
  const expiry = card.expiry_date ? fmtDate(card.expiry_date, { month: '2-digit', year: '2-digit' }).replace(/\//g, '/') : '••/••'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <button
        onClick={onClick}
        title={`View transactions for ${card.cif}`}
        style={{
          position: 'relative', width: '100%', aspectRatio: '1.586', padding: '18px 20px',
          border: 'none', borderRadius: 14, cursor: 'pointer', textAlign: 'left',
          background: t.grad, color: t.ink, fontFamily: SORA, overflow: 'hidden',
          boxShadow: '0 8px 22px rgba(6,20,34,0.28)',
          filter: live ? undefined : 'grayscale(0.72)', opacity: live ? 1 : 0.78,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          transition: TRANSITION.base,
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 14px 30px rgba(6,20,34,0.36)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 8px 22px rgba(6,20,34,0.28)' }}
      >
        {/* Sheen — the diagonal highlight a real card catches under light */}
        <div style={{ position: 'absolute', top: -70, right: -40, width: 220, height: 220, borderRadius: '50%', background: `radial-gradient(circle, ${t.sheen} 0%, transparent 68%)`, pointerEvents: 'none' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, position: 'relative' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, letterSpacing: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {card.product_name || 'Card Account'}
            </div>
            {card.scheme && (
              <div style={{ fontSize: TEXT['2xs'], color: t.sub, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{card.scheme}</div>
            )}
          </div>
          <span style={{
            flexShrink: 0, padding: '2px 8px', borderRadius: RADIUS.xl,
            fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: 0.4, textTransform: 'uppercase',
            background: live ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.32)',
            border: '1px solid rgba(255,255,255,0.30)', color: t.ink,
          }}>{expired ? 'Expired' : (card.status || 'Unknown')}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
          <EmvChip />
          {/* Material's contactless glyph already opens to the right, as it is
              printed on a real card — no rotation. */}
          <span className="material-symbols-rounded" style={{ fontSize: 21, color: t.sub }}>contactless</span>
        </div>

        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: FW.semibold, letterSpacing: 1.4, textShadow: '0 1px 2px rgba(0,0,0,0.30)', flexWrap: 'wrap' }}>
            {panGroups(card.card_number_masked).map((g, i) => <span key={i}>{g}</span>)}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, position: 'relative' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 7.5, color: t.sub, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 1 }}>Card Holder</div>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {card.name_on_card || '—'}
            </div>
          </div>
          <div style={{ flexShrink: 0, textAlign: 'right' }}>
            <div style={{ fontSize: 7.5, color: t.sub, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 1 }}>Valid Thru</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.semibold }}>{expiry}</div>
          </div>
          {network && (
            <div style={{ flexShrink: 0, fontSize: TEXT.sm, fontWeight: FW.extrabold, fontStyle: 'italic', letterSpacing: 0.3, opacity: 0.95 }}>
              {network}
            </div>
          )}
        </div>
      </button>

      {/* Operational facts live under the card, not printed on it */}
      <div style={{ padding: '0 3px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {inCredit ? 'In credit' : (limit > 0 ? 'Balance / Limit' : 'Balance')}
          </span>
          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: inCredit ? GREEN : 'var(--txt)' }}>
            {inCredit
              ? `${fmtMoney(Math.abs(balance), ccy)} CR`
              : <>{fmtMoney(balance, ccy)}{limit > 0 ? <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}> / {fmtMoney(limit, ccy)}</span> : null}</>}
          </span>
        </div>

        {util !== null && (
          <div>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--th-bg)', overflow: 'hidden' }}>
              <div style={{ width: `${utilBar}%`, height: '100%', borderRadius: 2, background: util >= 90 ? RED : util >= 70 ? AMBER : GREEN }} />
            </div>
            <div style={{ fontSize: TEXT['2xs'], color: util > 100 ? RED : 'var(--txt3)', marginTop: 3, fontWeight: util > 100 ? FW.bold : FW.normal }}>
              {util.toFixed(1)}% utilised{util > 100 ? ', over limit' : ''}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>CIF {card.cif}</span>
          {Number(card.days_overdue ?? 0) > 0 && <Badge label={`${card.days_overdue}d overdue`} colour={RED} />}
        </div>

        <button
          onClick={onClick}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, width: '100%',
            padding: '6px 10px', background: 'var(--card)', border: '1px solid var(--bdr)',
            borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
            color: Number(card.txn_count ?? 0) > 0 ? 'var(--txt)' : 'var(--txt3)',
            cursor: 'pointer', fontFamily: SORA,
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>receipt_long</span>
          {Number(card.txn_count ?? 0) > 0
            ? `${fmtNum(card.txn_count)} transaction${Number(card.txn_count) === 1 ? '' : 's'}`
            : 'No transactions'}
          {card.last_txn_date && <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}>· last {fmtDate(card.last_txn_date)}</span>}
        </button>
      </div>
    </div>
  )
}

function initialsOf(name: string): string {
  return (name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// ── Relationship KPI strip ────────────────────────────────────────────────────

function KpiStrip({ profile }: { profile: ContactProfileData }) {
  const s = profile.summary
  const net = s?.net_position_kobo ?? 0
  const cards = [
    { label: 'Deposits',     value: fmtKoboExact(s?.fd_principal_kobo ?? 0),     sub: `${s?.fd_count ?? 0} fixed deposit${(s?.fd_count ?? 0) === 1 ? '' : 's'}`,  icon: 'savings',                 color: AMBER },
    { label: 'Borrowings',   value: fmtKoboExact(s?.loan_outstanding_kobo ?? 0), sub: `${s?.loan_count ?? 0} active loan${(s?.loan_count ?? 0) === 1 ? '' : 's'}`, icon: 'account_balance_wallet',  color: NAVY  },
    { label: 'Net Position', value: fmtKoboExact(net),                           sub: net >= 0 ? 'net saver' : 'net borrower',                                    icon: 'balance',                 color: net >= 0 ? GREEN : RED },
    { label: 'Active Cards', value: String(s?.active_card_count ?? 0),       sub: `${s?.card_count ?? 0} on file`,                                            icon: 'credit_card',             color: PURPLE },
    { label: 'Transactions', value: fmtNum(s?.txn_count ?? 0),              sub: 'lifetime activity',                                                        icon: 'receipt_long',            color: BLUE  },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: SORA }}>{c.label}</span>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: c.color, opacity: 0.85 }}>{c.icon}</span>
          </div>
          <div style={{ ...NUM, fontSize: 21, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1, letterSpacing: -0.5 }}>{c.value}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5 }}>{c.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ── Transactions tab ──────────────────────────────────────────────────────────

interface LedgerTxn {
  txn_id: string
  cif: string
  date: string
  post_date: string | null
  amount: number
  money_in: boolean
  description: string
  merchant: string | null
  channel: string | null
  city: string | null
  txn_code: string | null
  card_product: string | null
  card_pan: string | null
  currency: 'NGN' | 'USD'
}

// money_in/out/net cover the NAIRA rows only — the Amex USD products post dollars
// into the same ledger, and one blended total would be a meaningless number.
interface LedgerSummary {
  count: number; money_in: number; money_out: number; net: number
  usd_count: number; usd_in: number; usd_out: number
}


// The ledger is served page-by-page rather than from the profile payload: the
// profile carries 40 rows for the whole person, and a single card in this book
// can hold 4,600+ transactions. Filtering that client-side would silently show a
// slice while looking like the whole thing.
// ── Spending & behaviour analytics ──────────────────────────────────────────────
// ISO-18245 merchant categories, named for the codes that actually appear in O3's book
// (6011 dominates — it's ATM cash). Unknown codes fall back to "MCC ####".
const MCC_NAMES: Record<string, string> = {
  '6011': 'ATM cash', '6010': 'Cash — manual', '6012': 'Financial institution', '6013': 'Financial — other', '6014': 'Cash disbursement',
  '6051': 'Quasi-cash / crypto', '4829': 'Money transfer',
  '5541': 'Fuel', '5542': 'Fuel — automated', '5411': 'Groceries', '5300': 'Wholesale', '5310': 'Discount stores',
  '5399': 'General merchandise', '5999': 'Retail — misc', '5311': 'Department stores', '5651': 'Clothing', '5691': 'Apparel',
  '5812': 'Restaurants', '5814': 'Fast food', '5811': 'Caterers', '7011': 'Hotels', '7399': 'Business services',
  '4814': 'Telecoms / airtime', '4900': 'Utilities', '5912': 'Pharmacy', '8011': 'Doctors', '8062': 'Hospitals',
  '4111': 'Transport', '4121': 'Taxi / rideshare', '7995': 'Betting', '7994': 'Gaming', '5964': 'Direct marketing',
  '1111': 'Uncategorised',
}
const mccName = (m: string) => MCC_NAMES[m] ?? `MCC ${m}`

const _num = (x: unknown) => Number(x ?? 0)
function nairaShort(v: number): string {
  const n = Math.abs(v)
  if (n >= 1e9) return `₦${(v / 1e9).toFixed(1)}b`
  if (n >= 1e6) return `₦${(v / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `₦${Math.round(v / 1e3)}k`
  return `₦${Math.round(v)}`
}

interface Analytics {
  totals?: { txns: number; outflow: number; inflow: number; out_txns: number; in_txns: number; first_txn: string; last_txn: string }
  top_merchants?: { merchant: string; txns: number; spend: number }[]
  by_category?: { mcc: string; txns: number; spend: number }[]
  by_channel?: { channel: string; txns: number; spend: number }[]
  by_city?: { city: string; txns: number; spend: number }[]
  monthly?: { month: string; outflow: number; inflow: number }[]
}

function BarList({ items, color }: { items: { label: string; value: number; sub: string }[]; color: string }) {
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {items.map((it, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: TEXT.sm, marginBottom: 3 }}>
            <span style={{ color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
            <span style={{ ...NUM, color: 'var(--txt2)', flexShrink: 0 }}>{it.sub}</span>
          </div>
          <div style={{ height: 6, background: 'var(--chip-bg)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, (it.value / max) * 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function InsightCard({ title, icon, tone, children }: { title: string; icon: string; tone: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '13px 15px', background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: tone }}>{icon}</span>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</span>
      </div>
      {children}
    </div>
  )
}

function SpendingInsights({ cif }: { cif: string }) {
  const [a, setA] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiFetch<any>(`/api/contacts/${cif}/transaction-analytics`)
      .then(r => { if (!cancelled) setA(r?.data ?? r) })
      .catch(() => { if (!cancelled) setA(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cif])

  if (loading) return null
  const merchants = a?.top_merchants ?? []
  const cats = a?.by_category ?? []
  const channels = a?.by_channel ?? []
  const cities = a?.by_city ?? []
  const monthly = a?.monthly ?? []
  if (merchants.length === 0 && cats.length === 0 && channels.length === 0) return null

  const monthMax = Math.max(1, ...monthly.flatMap(m => [_num(m.outflow), _num(m.inflow)]))
  const span = a?.totals ? `${fmtDate(a.totals.first_txn)} – ${fmtDate(a.totals.last_txn)}` : ''

  return (
    <SectionCard title="Spending & behaviour" subtitle={span ? `Across all accounts · ${span}` : 'Across all accounts'}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {merchants.length > 0 && (
          <InsightCard title="Top merchants" icon="storefront" tone={NAVY}>
            <BarList color={NAVY} items={merchants.map(m => ({ label: m.merchant || '—', value: _num(m.spend), sub: nairaShort(_num(m.spend)) }))} />
          </InsightCard>
        )}
        {cats.length > 0 && (
          <InsightCard title="Spending by category" icon="category" tone={PURPLE}>
            <BarList color={PURPLE} items={cats.map(c => ({ label: mccName(c.mcc), value: _num(c.spend), sub: nairaShort(_num(c.spend)) }))} />
          </InsightCard>
        )}
        {channels.length > 0 && (
          <InsightCard title="How they transact" icon="lan" tone={BLUE}>
            <BarList color={BLUE} items={channels.map(c => ({ label: initCap(c.channel), value: _num(c.txns), sub: `${fmtNum(c.txns)}×` }))} />
          </InsightCard>
        )}
        {cities.length > 0 && (
          <InsightCard title="Where they transact" icon="location_on" tone={GREEN}>
            <BarList color={GREEN} items={cities.map(c => ({ label: c.city || '—', value: _num(c.txns), sub: `${fmtNum(c.txns)}×` }))} />
          </InsightCard>
        )}
        {monthly.length > 1 && (
          <InsightCard title="Cashflow · last 12 months" icon="bar_chart" tone={AMBER}>
            <div style={{ display: 'flex', gap: 5, alignItems: 'flex-end', height: 92 }}>
              {monthly.map(m => (
                <div key={m.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 2, width: '100%', justifyContent: 'center' }}>
                    <div title={`Out ${nairaShort(_num(m.outflow))}`} style={{ width: 5, height: `${(_num(m.outflow) / monthMax) * 100}%`, background: RED, borderRadius: 2, minHeight: _num(m.outflow) > 0 ? 2 : 0 }} />
                    <div title={`In ${nairaShort(_num(m.inflow))}`} style={{ width: 5, height: `${(_num(m.inflow) / monthMax) * 100}%`, background: GREEN, borderRadius: 2, minHeight: _num(m.inflow) > 0 ? 2 : 0 }} />
                  </div>
                  <span style={{ fontSize: 9, color: 'var(--txt3)' }}>{m.month.slice(5)}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: RED }} />Out</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: GREEN }} />In</span>
            </div>
          </InsightCard>
        )}
      </div>
    </SectionCard>
  )
}

function initCap(s: string): string {
  if (!s) return '—'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function TransactionsTab({ profile, cardCif, onCardCif }: {
  profile: ContactProfileData
  cardCif: string
  onCardCif: (cif: string) => void
}) {
  const [rows, setRows]       = useState<LedgerTxn[]>([])
  const [summary, setSummary] = useState<LedgerSummary | null>(null)
  const [pages, setPages]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

  const [q, setQ]             = useState('')
  const [dir, setDir]         = useState('')
  const [channel, setChannel] = useState('')
  const [from, setFrom]       = useState('')
  const [to, setTo]           = useState('')
  const debouncedQ            = useDebouncedValue(q, 350)

  const cardsByCif = new Map(profile.cards.map(c => [c.cif, c]))
  const selected   = cardCif ? cardsByCif.get(cardCif) : undefined

  // Any filter change invalidates the current page number — staying on page 7 of
  // a narrower result set would show an empty list that looks like "no data".
  useEffect(() => { setPage(1) }, [cardCif, debouncedQ, dir, channel, from, to])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ page: String(page), size: '50' })
    if (cardCif)    params.set('card', cardCif)
    if (debouncedQ) params.set('q', debouncedQ)
    if (dir)        params.set('dir', dir)
    if (channel)    params.set('channel', channel)
    if (from)       params.set('from', from)
    if (to)         params.set('to', to)

    apiFetch<any>(`/api/contacts/${profile.cif}/transactions?${params}`)
      .then(res => {
        if (cancelled) return
        const d = res?.data ?? res
        setRows(d?.data ?? [])
        setSummary(d?.summary ?? null)
        setPages(d?.pages ?? 0)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [profile.cif, page, cardCif, debouncedQ, dir, channel, from, to])

  const filtered = Boolean(cardCif || debouncedQ || dir || channel || from || to)
  const reset = () => { onCardCif(''); setQ(''); setDir(''); setChannel(''); setFrom(''); setTo('') }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Which card am I looking at */}
      {selected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', background: `${BLUE}0D`, border: `1px solid ${BLUE}33`, borderRadius: RADIUS.lg }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: BLUE }}>credit_card</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {selected.product_name || 'Card'} <span style={{ fontFamily: 'var(--font-mono)', fontWeight: FW.normal, color: 'var(--txt2)' }}>{selected.card_number_masked}</span>
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              CIF {selected.cif}{selected.name_on_card ? ` · ${selected.name_on_card}` : ''}
            </div>
          </div>
          <button onClick={() => onCardCif('')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 11px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer', fontFamily: SORA }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>All cards
          </button>
        </div>
      )}

      {/* Totals describe the filtered set, not the visible page. Naira only —
          any dollar movement is reported separately underneath. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 12 }}>
        {[
          { label: 'Transactions', value: fmtNum(summary?.count ?? 0),       colour: 'var(--txt)', icon: 'receipt_long', sub: null },
          { label: 'Money In',     value: fmtNaira(summary?.money_in ?? 0),  colour: GREEN,        icon: 'south_west',   sub: (summary?.usd_in ?? 0) > 0 ? `+ ${fmtMoney(summary!.usd_in, 'USD')}` : null },
          { label: 'Money Out',    value: fmtNaira(summary?.money_out ?? 0), colour: RED,          icon: 'north_east',   sub: (summary?.usd_out ?? 0) > 0 ? `+ ${fmtMoney(summary!.usd_out, 'USD')}` : null },
          { label: 'Net',          value: fmtNaira(summary?.net ?? 0),       colour: (summary?.net ?? 0) >= 0 ? GREEN : RED, icon: 'balance', sub: null },
        ].map(m => (
          <div key={m.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{m.label}</span>
              <span className="material-symbols-rounded" style={{ fontSize: 15, color: m.colour, opacity: 0.8 }}>{m.icon}</span>
            </div>
            <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: m.colour, letterSpacing: -0.3 }}>{m.value}</div>
            {m.sub && <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>{m.sub}</div>}
          </div>
        ))}
      </div>

      {(summary?.usd_count ?? 0) > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.xs, color: 'var(--txt2)', padding: '8px 12px', background: `${AMBER}0D`, border: `1px solid ${AMBER}33`, borderRadius: RADIUS.md }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15, color: AMBER }}>currency_exchange</span>
          {fmtNum(summary!.usd_count)} of these transactions are on a USD card. Dollar amounts are totalled separately. Naira figures above exclude them.
        </div>
      )}

      {/* Spending & behaviour — merchants, categories, channels, geography, cashflow.
          Reads the whole ledger for the person (not the paged/filtered list), so it is a
          stable picture regardless of the filters below. */}
      <SpendingInsights cif={profile.cif} />

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={cardCif} onChange={e => onCardCif(e.target.value)} style={{ ...filterInputStyle, minWidth: 220 }}>
          <option value="">All cards ({profile.cards.length})</option>
          {profile.cards.map(c => (
            <option key={c.id} value={c.cif}>
              {(c.product_name || 'Card')} · {c.card_number_masked || c.cif} ({fmtNum(c.txn_count)})
            </option>
          ))}
        </select>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search description or merchant…" style={{ ...filterInputStyle, flex: 1, minWidth: 200 }} />
        <select value={dir} onChange={e => setDir(e.target.value)} style={filterInputStyle}>
          <option value="">In &amp; out</option>
          <option value="in">Money in</option>
          <option value="out">Money out</option>
        </select>
        <select value={channel} onChange={e => setChannel(e.target.value)} style={filterInputStyle}>
          <option value="">All channels</option>
          <option value="interswitch">Interswitch</option>
          <option value="internal">Internal</option>
          <option value="collection">Collection</option>
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={filterInputStyle} title="From date" />
        <input type="date" value={to}   onChange={e => setTo(e.target.value)}   style={filterInputStyle} title="To date" />
        {filtered && (
          <button onClick={reset} style={{ padding: '7px 12px', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA }}>
            Clear filters
          </button>
        )}
      </div>

      {err && <ErrBanner error={err} />}

      <SectionCard
        title={selected ? 'Card Transactions' : 'Account Transactions'}
        subtitle={`${fmtNum(summary?.count ?? 0)} matching${pages > 1 ? ` · page ${page} of ${fmtNum(pages)}` : ''}`}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={26} /></div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
            {filtered ? 'No transactions match these filters.' : 'No transactions on record.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((t, i) => {
              const credit = t.money_in
              // Only worth naming the card when the view spans several of them.
              const cardLabel = !cardCif ? (t.card_pan || t.card_product || t.cif) : null
              return (
                <div key={t.txn_id || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 2px', borderBottom: i < rows.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: credit ? `${GREEN}14` : `${RED}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 17, color: credit ? GREEN : RED }}>{credit ? 'south_west' : 'north_east'}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.description || 'Transaction'}
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span>{fmtDate(t.date)}</span>
                      {t.merchant && <span>· {t.merchant}</span>}
                      {t.channel && <span>· {t.channel}</span>}
                      {cardLabel && (
                        <button
                          onClick={() => onCardCif(t.cif)}
                          title={`Filter to card ${t.cif}`}
                          style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT['2xs'], padding: '1px 6px', borderRadius: RADIUS.xl, background: 'var(--th-bg)', border: '1px solid var(--bdr)', color: 'var(--txt2)', cursor: 'pointer' }}
                        >
                          {cardLabel}
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: credit ? GREEN : 'var(--txt)', flexShrink: 0 }}>
                    {credit ? '+' : '−'}{fmtMoney(t.amount, t.currency)}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {pages > 1 && (
          <div style={{ marginTop: 14 }}>
            <Pagination page={page} pages={pages} total={summary?.count ?? 0} pageSize={50} onPage={setPage} />
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ── Lifecycle bar ─────────────────────────────────────────────────────────────

const LIFECYCLE_STEPS = [
  { key: 'is_prospect',       label: 'Prospect',   icon: 'person_search' },
  { key: 'is_applicant',      label: 'Applicant',  icon: 'description' },
  { key: 'is_active_customer',label: 'Customer',   icon: 'how_to_reg' },
  { key: 'is_card_holder',    label: 'Card Holder',icon: 'credit_card' },
  { key: 'is_delinquent',     label: 'Delinquent', icon: 'warning' },
  { key: 'is_in_recovery',    label: 'Recovery',   icon: 'gavel' },
  { key: 'is_written_off',    label: 'Written Off',icon: 'do_not_disturb_on' },
] as const

const STEP_COLOUR: Record<string, string> = {
  is_prospect: BLUE, is_applicant: '#8B5CF6', is_active_customer: GREEN,
  is_card_holder: PURPLE, is_delinquent: AMBER, is_in_recovery: RED, is_written_off: '#6B7280',
}

// The customer's own status badges (Customer, Card Holder, Delinquent, In Recovery…),
// rendered as pills inside the blue overview hero — only the ones this customer
// actually has. Replaces the standalone horizontal lifecycle stepper.
function HeroStatusBadges({ profile }: { profile: ContactProfileData }) {
  const active = LIFECYCLE_STEPS.filter(s => profile[s.key as keyof ContactProfileData] as boolean)
  if (active.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 12 }}>
      {active.map(s => {
        const c = STEP_COLOUR[s.key]
        return (
          <span key={s.key} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: RADIUS.xl,
            background: 'rgba(255,255,255,0.12)', border: `1px solid ${c}99`,
            fontSize: TEXT.xs, fontWeight: FW.semibold, color: '#fff',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13, color: c }}>{s.icon}</span>
            {s.label}
          </span>
        )
      })}
    </div>
  )
}

// A single copyable identifier chip. One person legitimately holds many CIFs (a CIF
// is a card), plus loan/FD account numbers and a workspace Customer ID — click any to
// copy it.
function IdChip({ id, colour }: { id: string; colour: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { try { navigator.clipboard?.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* clipboard unavailable */ } }}
      title="Click to copy"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, fontWeight: FW.semibold,
        padding: '3px 9px', borderRadius: RADIUS.full, cursor: 'pointer',
        background: copied ? `${GREEN}1f` : `${colour}14`,
        color: copied ? GREEN : colour,
        border: `1px solid ${copied ? GREEN : colour}3a`,
      }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{copied ? 'check' : 'content_copy'}</span>
      {id}
    </button>
  )
}

// Every id a customer carries, grouped and colour-coded: the universal Customer ID,
// each card CIF, workspace-only ids, uploaded-loan mandates and Udara loan/FD accounts.
// Surfaces the full identity graph instead of hiding it behind one field.
function AllIdentifiersCard({ profile }: { profile: ContactProfileData }) {
  const ids = profile.identifiers
  if (!ids) return null
  const groups: { label: string; icon: string; colour: string; items: string[] }[] = [
    { label: 'Card CIFs',      icon: 'credit_card',     colour: PURPLE, items: ids.cifs ?? [] },
    { label: 'Loan Mandates',  icon: 'account_balance', colour: AMBER,  items: ids.loan_mandates ?? [] },
    { label: 'Udara Loans',    icon: 'request_quote',   colour: RED,    items: ids.udara_loan_accounts ?? [] },
    { label: 'Udara Deposits', icon: 'savings',         colour: GREEN,  items: ids.fd_accounts ?? [] },
  ].filter(g => g.items.length > 0)
  const total = groups.reduce((s, g) => s + g.items.length, 0)

  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <SectionCard title="Identifiers" subtitle={`One customer · ${total} linked id${total === 1 ? '' : 's'} across products`}>
        {/* Customer ID — the one id that unifies everything */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px', marginBottom: groups.length ? 14 : 0,
          borderRadius: RADIUS.md, background: `${NAVY}0c`, border: `1px solid ${NAVY}26`,
        }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Customer ID</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--txt)' }}>{ids.customer_id}</span>
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>universal · with or without a CIF</span>
        </div>
        {/* Grouped id chips */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
          {groups.map(g => (
            <div key={g.label}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15, color: g.colour }}>{g.icon}</span>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{g.label}</span>
                <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: g.colour, background: `${g.colour}1a`, borderRadius: RADIUS.full, padding: '0 6px', minWidth: 16, textAlign: 'center' }}>{g.items.length}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {g.items.map(id => <IdChip key={id} id={id} colour={g.colour} />)}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  )
}

// ── Tab content panels ────────────────────────────────────────────────────────

function OverviewTab({ profile, onOpenTab }: { profile: ContactProfileData; onOpenTab: (t: string) => void }) {
  const s = profile.summary
  const txns = profile.transactions.slice(0, 5)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
      {s && (
        <div style={{ gridColumn: '1 / -1' }}>
          <SectionCard title="Financial Snapshot">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {[
                { label: 'Deposits',    value: fmtKoboExact(s.fd_principal_kobo),     sub: `${fmtNum(s.fd_count)} FD${s.fd_count === 1 ? '' : 's'}`,              colour: GREEN },
                { label: 'Borrowings',  value: fmtKoboExact(s.loan_outstanding_kobo), sub: `${fmtNum(s.loan_count)} loan${s.loan_count === 1 ? '' : 's'}`,        colour: s.loan_outstanding_kobo > 0 ? RED : 'var(--txt)' },
                { label: 'Net Position',value: fmtKoboExact(s.net_position_kobo),     sub: s.fd_accrued_kobo > 0 ? `+${fmtKoboExact(s.fd_accrued_kobo)} accrued` : 'Deposits − borrowings', colour: s.net_position_kobo >= 0 ? GREEN : RED },
                { label: 'Cards',       value: fmtNum(s.active_card_count),      sub: `${fmtNum(s.card_count)} on file`,                                     colour: 'var(--txt)' },
              ].map(m => (
                <div key={m.label} style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{m.label}</div>
                  <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: m.colour }}>{m.value}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2 }}>{m.sub}</div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}
      <AllIdentifiersCard profile={profile} />

      <SectionCard title="Identity &amp; Contact">
        <InfoGrid>
          <InfoPair label="Full Name"      value={profile.name} />
          <InfoPair label="Phone"          value={profile.phone} />
          <InfoPair label="Email"          value={profile.email} />
          <InfoPair label="Gender"         value={profile.gender} />
          <InfoPair label="Date of Birth"  value={profile.date_of_birth ? fmtDate(profile.date_of_birth) : undefined} />
          <InfoPair label="BVN"            value={profile.bvn} mono />
          <InfoPair label="NIN"            value={profile.nin} mono />
        </InfoGrid>
      </SectionCard>

      <SectionCard title="Employment &amp; Address">
        <InfoGrid>
          <InfoPair label="Employer"        value={profile.employer} />
          <InfoPair label="Monthly Income"  value={profile.monthly_income_kobo != null ? fmtKoboExact(profile.monthly_income_kobo) : undefined} />
          <InfoPair label="Address"         value={profile.full_address ?? profile.address} />
          <InfoPair label="City"            value={profile.city} />
          <InfoPair label="State"           value={profile.state} />
          <InfoPair label="Country"         value={profile.country} />
        </InfoGrid>
      </SectionCard>

      {profile.crm && (
        <SectionCard title="Sales Record">
          <InfoGrid>
            <InfoPair label="Status"       value={profile.crm.status.replace(/_/g,' ')} />
            <InfoPair label="Assigned To"  value={profile.crm.assigned_to} />
            <InfoPair label="Since"        value={fmtDate(profile.crm.created_at)} />
          </InfoGrid>
          {profile.crm.deals.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>Deals</div>
              {profile.crm.deals.map(d => (
                <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--bdr)', fontSize: TEXT.sm }}>
                  <span style={{ color: 'var(--txt)' }}>{d.title}</span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={NUM}>{fmtKoboExact(d.value_kobo)}</span>
                    <StagePill stage={d.stage} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {(profile.collections || profile.recovery_case) && (
        <SectionCard title="Risk Snapshot">
          <InfoGrid>
            {profile.collections && (
              <>
                <InfoPair label="DPD" value={`${profile.collections.dpd}d (${profile.collections.dpd_bucket})`} />
                <InfoPair label="Outstanding" value={fmtKoboExact(profile.collections.outstanding_kobo)} />
                <InfoPair label="Collections Agent" value={profile.collections.agent_name ?? 'Unassigned'} />
                {profile.collections.ptp_date && <InfoPair label="PTP Date" value={fmtDate(profile.collections.ptp_date)} />}
              </>
            )}
            {profile.recovery_case && (
              <>
                <InfoPair label="Recovery Case" value={profile.recovery_case.case_ref} mono />
                <InfoPair label="Recovery Status" value={profile.recovery_case.status} />
                <InfoPair label="Recovery Agent" value={profile.recovery_case.agent_name ?? 'Unassigned'} />
                <InfoPair label="Recovered"  value={fmtKoboExact(profile.recovery_case.recovered_kobo)} />
                {profile.recovery_case.legal_stage && <InfoPair label="Legal Stage" value={profile.recovery_case.legal_stage} />}
              </>
            )}
            {profile.last_payment && (
              <InfoPair label="Last Payment" value={`${fmtNaira(profile.last_payment.amount)} · ${fmtDate(profile.last_payment.date)}`} />
            )}
          </InfoGrid>
        </SectionCard>
      )}

      {txns.length > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <SectionCard
            title="Recent Transactions"
            actions={
              <button
                onClick={() => onOpenTab('transactions')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 10px', background: 'transparent', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA }}
              >
                View all {fmtNum(profile.summary?.txn_count ?? profile.transactions.length)}
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>chevron_right</span>
              </button>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {txns.map((t, i) => {
                const credit = t.money_in
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 2px', borderBottom: i < txns.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                    <div style={{ width: 30, height: 30, borderRadius: '50%', background: credit ? `${GREEN}14` : `${RED}12`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 16, color: credit ? GREEN : RED }}>{credit ? 'south_west' : 'north_east'}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description || 'Transaction'}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(t.date)}{t.merchant ? ` · ${t.merchant}` : ''}</div>
                    </div>
                    <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: credit ? GREEN : 'var(--txt)', flexShrink: 0 }}>{credit ? '+' : '−'}{fmtNaira(t.amount)}</div>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        </div>
      )}

      {(profile.payment_history?.length ?? 0) > 0 && (
        <div style={{ gridColumn: '1 / -1' }}>
          <SectionCard title="Payment History" subtitle="Repayments received — monthly cadence and detail">
            {(profile.repayment_pattern?.length ?? 0) > 0 && (() => {
              const pat = profile.repayment_pattern!
              const max = Math.max(...pat.map(x => Number(x.amount) || 0), 1)
              return (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 62, marginBottom: 16, paddingTop: 4 }}>
                  {pat.map((m, i) => (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, minWidth: 0 }}>
                      <div title={`${m.month}: ${fmtNaira(m.amount)} · ${m.count} payment${m.count === 1 ? '' : 's'}`}
                        style={{ width: '100%', height: `${Math.max(3, ((Number(m.amount) || 0) / max) * 44)}px`, background: GREEN, borderRadius: 3 }} />
                      <span style={{ fontSize: 8, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{m.month}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {profile.payment_history!.slice(0, 20).map((p, i, arr) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 2px', borderBottom: i < arr.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${GREEN}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15, color: GREEN }}>payments</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.description || 'Repayment'}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDate(p.date)}{p.merchant ? ` · ${p.merchant}` : ''}</div>
                  </div>
                  <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN, flexShrink: 0 }}>+{fmtNaira(p.amount)}</div>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  )
}

function LoansTab({ profile }: { profile: ContactProfileData }) {
  const manual = profile.loans ?? []
  const hasContent = profile.applications.length > 0 || profile.active_loans.length > 0 || manual.length > 0
  if (!hasContent) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No loan applications or active loans found.</div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {manual.length > 0 && (
        <SectionCard title="Loan Repayment (uploaded)">
          {manual.map((l, i) => (
            <div key={i} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>
                  {l.mandate_id && l.mandate_id !== 'NO MANDATE' ? `Mandate ${l.mandate_id}` : 'Loan'}
                </div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                  {[l.officer_name && `Officer: ${l.officer_name}`,
                    l.tenor && `Tenor ${l.tenor}`,
                    l.rate && `${l.rate}%`,
                    l.debit_day && `Debit day ${l.debit_day}`,
                    l.maturity_date && `Matures ${fmtDate(l.maturity_date)}`,
                   ].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
                  {fmtKoboExact(l.outstanding_kobo ?? 0)}
                </div>
                {l.repayment_kobo != null && (
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>Repay {fmtKoboExact(l.repayment_kobo)}</div>
                )}
                {l.dpd_bucket && l.dpd_bucket !== '0' && (
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED }}>DPD {l.dpd_bucket}</div>
                )}
              </div>
            </div>
          ))}
        </SectionCard>
      )}
      {profile.active_loans.length > 0 && (
        <SectionCard title="Active Loans">
          {profile.active_loans.map(l => (
            <div key={l.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{l.ref}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{l.product_type}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: l.dpd > 0 ? RED : 'var(--txt)' }}>
                  {fmtKoboExact(l.outstanding_kobo)}
                </div>
                {l.dpd > 0 && (
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: RED, marginBottom: 2 }}>{l.dpd}d DPD</div>
                )}
                <StagePill stage={l.status} />
              </div>
            </div>
          ))}
        </SectionCard>
      )}
      {profile.applications.length > 0 && (
        <SectionCard title="Applications">
          {profile.applications.map(a => (
            <div key={a.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{a.ref}</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.product_type} · {fmtDate(a.created_at)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>
                  {fmtKoboExact(a.amount_requested_kobo)}
                </div>
                <StagePill stage={a.stage} />
              </div>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  )
}

function CardsTab({ profile, onViewTransactions }: {
  profile: ContactProfileData
  onViewTransactions: (cif: string) => void
}) {
  if (profile.cards.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No cards found for this customer.</div>
  )
  return (
    <div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 14 }}>
        {profile.cards.length} card{profile.cards.length === 1 ? '' : 's'} on this relationship · click a card to see its transactions
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 18 }}>
        {profile.cards.map(c => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <CardFace card={c} onClick={() => onViewTransactions(c.cif)} />
            <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '12px 14px' }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>Billing</div>
              {([
                ['Current Bill',  c.balance != null ? fmtNaira(c.balance) : '—'],
                ['Bill Balance',  c.bill_balance != null ? fmtNaira(c.bill_balance) : '—'],
                ['Min Payment',   c.min_payment != null ? fmtNaira(c.min_payment) : '—'],
                ['Credit Limit',  c.credit_limit != null ? fmtNaira(c.credit_limit) : '—'],
                ['Payment Due',   c.payment_due ? fmtDate(c.payment_due) : '—'],
                ['Last Payment',  c.last_payment_amount != null ? `${fmtNaira(c.last_payment_amount)}${c.last_payment_date ? ' · ' + fmtDate(c.last_payment_date) : ''}` : '—'],
              ] as [string, string][]).map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0', fontSize: TEXT.sm }}>
                  <span style={{ color: 'var(--txt2)' }}>{label}</span>
                  <span style={{ ...NUM, color: 'var(--txt)', fontWeight: FW.medium }}>{val}</span>
                </div>
              ))}
              {Number(c.days_overdue) > 0 && (
                <div style={{ marginTop: 6, fontSize: TEXT.xs, fontWeight: FW.semibold, color: RED }}>{fmtNum(c.days_overdue)} days overdue</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FixedDepositsTab({ profile }: { profile: ContactProfileData }) {
  if (profile.fixed_deposits.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No fixed deposits for this customer.</div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {profile.fixed_deposits.map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'var(--card)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT['2xl'], color: AMBER }}>savings</span>
            <div>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{f.product_name || 'Fixed Deposit'}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'var(--font-mono)' }}>
                {f.ref} · {Number(f.interest_rate ?? 0).toFixed(1)}% · matures {f.maturity_date ? fmtDate(f.maturity_date) : '—'}
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', marginBottom: 4 }}>{fmtKoboExact(f.principal_kobo)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
              {f.accrued_interest_kobo > 0 && <span style={{ fontSize: TEXT.xs, color: GREEN }}>+{fmtKoboExact(f.accrued_interest_kobo)} int</span>}
              <Badge label={f.status} colour={statusColour(f.status)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CollectionsTab({ profile }: { profile: ContactProfileData }) {
  const c = profile.collections
  if (!c) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No collections record for this customer.</div>
  )
  const dpdColour = c.dpd >= 90 ? '#7F1D1D' : c.dpd >= 60 ? RED : c.dpd >= 30 ? '#EA580C' : c.dpd > 0 ? AMBER : GREEN
  return (
    <SectionCard title="Collections Status">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'DPD', value: `${c.dpd}d`, colour: dpdColour },
          { label: 'Bucket', value: c.dpd_bucket, colour: dpdColour },
          { label: 'Outstanding', value: fmtKoboExact(c.outstanding_kobo), colour: 'var(--txt)' },
          { label: 'Stage', value: c.current_stage ?? '—', colour: 'var(--txt)' },
        ].map(({ label, value, colour }) => (
          <div key={label} style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: colour }}>{value}</div>
          </div>
        ))}
      </div>
      <InfoPair label="Assigned Agent"  value={c.agent_name ?? 'Unassigned'} />
      <InfoPair label="Last Contact"    value={c.last_contact_at ? fmtDate(c.last_contact_at) : 'Never'} />
      <InfoPair label="PTP Date"        value={c.ptp_date ? fmtDate(c.ptp_date) : undefined} />
    </SectionCard>
  )
}

function RecoveryTab({ profile }: { profile: ContactProfileData }) {
  const r = profile.recovery_case
  if (!r) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No recovery case found.</div>
  )
  const net = r.outstanding_kobo - r.recovered_kobo
  return (
    <SectionCard title="Recovery Case">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Outstanding', value: fmtKoboExact(r.outstanding_kobo), colour: RED },
          { label: 'Recovered',   value: fmtKoboExact(r.recovered_kobo),   colour: GREEN },
          { label: 'Net',         value: fmtKoboExact(net),                  colour: net > 0 ? RED : GREEN },
        ].map(({ label, value, colour }) => (
          <div key={label} style={{ padding: '12px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, marginBottom: 4 }}>{label}</div>
            <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: colour }}>{value}</div>
          </div>
        ))}
      </div>
      <InfoPair label="Case Ref"     value={r.case_ref} mono />
      <InfoPair label="Status"       value={r.status} />
      <InfoPair label="Assigned To"  value={r.agent_name ?? 'Unassigned'} />
      {r.legal_stage && <InfoPair label="Legal Stage" value={r.legal_stage} />}
      {r.write_off_amount_kobo > 0 && <InfoPair label="Written Off" value={fmtKoboExact(r.write_off_amount_kobo)} />}
      <InfoPair label="Opened"       value={fmtDate(r.opened_at)} />
    </SectionCard>
  )
}

function HelpdeskTab({ profile }: { profile: ContactProfileData }) {
  const navigate = useNavigate()
  if (profile.helpdesk_tickets.length === 0) return (
    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No helpdesk tickets found.</div>
  )
  const priorityColour: Record<string, string> = { high: RED, medium: AMBER, low: GREEN, critical: '#7F1D1D' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {profile.helpdesk_tickets.map(t => (
        <div
          key={t.id}
          onClick={() => navigate(`/helpdesk/${t.id}`)}
          style={{ padding: '12px 16px', background: 'var(--card)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--card)' }}
        >
          <div>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{t.subject}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{t.ticket_ref} · {fmtDate(t.created_at)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Badge label={t.priority} colour={priorityColour[t.priority] ?? AMBER} />
            <Badge label={t.status} colour={statusColour(t.status)} />
          </div>
        </div>
      ))}
    </div>
  )
}

const ACTIVITY_ICON: Record<string, string> = {
  call: 'call', email: 'mail', meeting: 'groups', task: 'task_alt',
  stage_change: 'swap_horiz', note_added: 'sticky_note_2',
  condition_added: 'rule', condition_waived: 'check_circle',
  declined: 'cancel', approved: 'verified',
  collection_contact: 'phone_in_talk',
  ticket_opened: 'confirmation_number', ticket_resolved: 'support_agent',
  payment: 'payments', disbursement: 'account_balance',
}

const MODULE_LABEL: Record<string, { label: string; colour: string }> = {
  crm:         { label: 'CRM',         colour: BLUE },
  los:         { label: 'LOS',         colour: NAVY },
  collections: { label: 'Collections', colour: AMBER },
  helpdesk:    { label: 'Helpdesk',    colour: '#0891B2' },
  recovery:    { label: 'Recovery',    colour: RED },
}

function fmtStage(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Live interaction timeline (calls / tickets / collections) ─────────────────
interface TimelineItem {
  kind: string; ts: string; direction?: string | null; purpose?: string | null
  outcome?: string | null; status?: string | null; agent_name?: string | null
  detail?: string | null; title?: string | null; duration_sec?: number | null; ref?: string | null
}

const PURPOSE_STYLE: Record<string, { label: string; colour: string }> = {
  collections: { label: 'Collections', colour: AMBER },
  recovery:    { label: 'Recovery',    colour: RED },
  marketing:   { label: 'Marketing',   colour: BLUE },
  support:     { label: 'Support',      colour: '#0891B2' },
  retention:   { label: 'Retention',    colour: GREEN },
  other:       { label: 'Other',        colour: 'var(--txt3)' },
  // Interaction channels / purposes added to the unified timeline
  email:       { label: 'Email',       colour: BLUE },
  sms:         { label: 'SMS',         colour: '#0891B2' },
  whatsapp:    { label: 'WhatsApp',    colour: '#25D366' },
  phone:       { label: 'Phone',       colour: BLUE },
  in_app:      { label: 'In-App',      colour: PURPLE },
  statement:   { label: 'Statement',   colour: NAVY },
  campaign:    { label: 'Campaign',    colour: PURPLE },
  risk:        { label: 'Risk',        colour: '#DC2626' },
  collections_payment: { label: 'Payment', colour: GREEN },
  recovery_payment:    { label: 'Payment', colour: GREEN },
  loan_repayment:      { label: 'Payment', colour: GREEN },
}
const KIND_ICON: Record<string, string> = {
  call: 'call', ticket: 'confirmation_number', collection: 'phone_in_talk', credit: 'account_balance',
  message: 'forum', statement_email: 'receipt_long', campaign_email: 'campaign', campaign_sms: 'sms',
  field_visit: 'pin_drop', payment: 'payments', activity: 'bolt',
}

// Activity-stream rows all arrive as kind 'activity'; their specific type comes on `purpose`
// (handoff, decision, note, …), so pick the icon from that.
const STREAM_ICON: Record<string, string> = {
  handoff: 'swap_horiz', decision: 'gavel', note: 'sticky_note_2', document: 'description',
  stage_change: 'trending_up', task: 'task_alt', email: 'mail', sms: 'sms', meeting: 'groups',
}

function fmtDur(s?: number | null): string {
  if (!s || s <= 0) return ''
  const m = Math.floor(s / 60), ss = s % 60
  return `${m}:${String(ss).padStart(2, '0')}`
}

function InteractionTimeline({ cif }: { cif: string }) {
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const [err, setErr]     = useState<string | null>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const d = await apiFetch<any>(`/api/customer360/${cif}/activity?limit=200`)
        const rows = (d?.data ?? d) as TimelineItem[]
        if (live) setItems(Array.isArray(rows) ? rows : [])
      } catch (e: any) { if (live) setErr(e.message) }
    })()
    return () => { live = false }
  }, [cif])

  if (err) return (
    <SectionCard title="All Interactions">
      <div style={{ fontSize: TEXT.sm, color: RED }}>Couldn’t load interactions: {err}</div>
    </SectionCard>
  )
  if (!items) return (
    <SectionCard title="All Interactions">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner size={20} /></div>
    </SectionCard>
  )
  if (items.length === 0) return (
    <SectionCard title="All Interactions">
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>No interactions on record yet.</div>
    </SectionCard>
  )

  return (
    <SectionCard title="All Interactions" subtitle={`${items.length} most recent · calls, emails, tickets, visits, collections & payments`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {items.map((it, i) => {
          const isLast  = i === items.length - 1
          const icon    = it.kind === 'activity' ? (STREAM_ICON[it.purpose ?? ''] ?? 'bolt') : (KIND_ICON[it.kind] ?? 'history')
          const ps      = PURPOSE_STYLE[it.purpose ?? ''] ?? null
          const dirIcon = it.kind === 'call'
                        ? (it.direction === 'inbound' ? 'call_received' : it.direction === 'outbound' ? 'call_made' : null)
                        : null
          const dirLabel = it.direction === 'inbound' ? 'Inbound'
                         : it.direction === 'outbound' ? 'Outbound' : ''
          // A call gets a direction-aware heading ("Call — Inbound"); a credit-audit
          // row humanises its raw action ("promise_created" → "Promise Created");
          // other kinds keep their server-supplied title.
          const heading = it.kind === 'call' ? `Call${dirLabel ? ': ' + dirLabel : ''}`
                        : it.kind === 'credit' ? (it.title || 'Credit activity').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                        : (it.title || it.kind)
          const result  = it.outcome || it.status || ''
          const dur     = fmtDur(it.duration_sec)
          return (
            <div key={`${it.kind}-${it.ref}-${i}`} style={{ display: 'flex', gap: 12, paddingBottom: isLast ? 0 : 12, position: 'relative' }}>
              {!isLast && <div style={{ position: 'absolute', left: 15, top: 40, bottom: 0, width: 1, background: 'var(--bdr)' }} />}
              <div style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0, marginTop: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: ps ? `${ps.colour}15` : 'var(--chip-bg)', border: `1px solid ${ps ? ps.colour + '30' : 'var(--bdr)'}`, zIndex: 1,
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: ps?.colour ?? 'var(--txt2)' }}>{icon}</span>
              </div>
              <div style={{ flex: 1, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '10px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                  {dirIcon && <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt2)' }}>{dirIcon}</span>}
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{heading}</span>
                  {ps && (
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: RADIUS.xl, background: `${ps.colour}15`, color: ps.colour, border: `1px solid ${ps.colour}30` }}>{ps.label}</span>
                  )}
                  {result && <Badge label={result} colour={statusColour(result)} />}
                  {dur && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt2)' }}>{dur}</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--txt2)' }}>
                  {fmtDatetime(it.ts)}{it.agent_name && ` · ${it.agent_name}`}
                </div>
                {it.detail && <div style={{ fontSize: 12.5, color: 'var(--txt)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{it.detail}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

function ActivityTab({ profile, cif }: { profile: ContactProfileData; cif: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InteractionTimeline cif={cif} />
      {profile.activity_log.length > 0 && <SystemActivityList profile={profile} />}
    </div>
  )
}

function SystemActivityList({ profile }: { profile: ContactProfileData }) {
  if (profile.activity_log.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {profile.activity_log.map((a, i) => {
        const icon    = ACTIVITY_ICON[a.type] ?? 'history'
        const isLast  = i === profile.activity_log.length - 1
        const title   = a.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        const mod     = MODULE_LABEL[a.module]
        // meta may be "from_stage → to_stage" for LOS or "Call · Promised to pay" for collections
        const metaParts = a.meta ? a.meta.split(' → ') : []
        const isStageTransition = metaParts.length === 2

        return (
          <div key={a.id} style={{ display: 'flex', gap: 12, paddingBottom: isLast ? 0 : 12, position: 'relative' }}>
            {!isLast && (
              <div style={{ position: 'absolute', left: 15, top: 40, bottom: 0, width: 1, background: 'var(--bdr)' }} />
            )}
            {/* Circle */}
            <div style={{
              width: 32, height: 32, borderRadius: '50%', flexShrink: 0, marginTop: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--chip-bg)', border: '1px solid var(--bdr)', zIndex: 1,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt2)' }}>{icon}</span>
            </div>

            {/* Pill card */}
            <div style={{
              flex: 1, background: 'var(--card)',
              border: '1px solid var(--bdr)', borderRadius: RADIUS.lg,
              padding: '10px 14px',
            }}>
              {/* Header row: title + module badge + ref */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{title}</span>
                {mod && (
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: RADIUS.xl,
                    background: `${mod.colour}15`, color: mod.colour, border: `1px solid ${mod.colour}30`,
                  }}>{mod.label}</span>
                )}
                {a.ref && (
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt2)',
                    background: 'var(--th-bg)', padding: '1px 6px', borderRadius: RADIUS.md,
                    border: '1px solid var(--bdr)',
                  }}>{a.ref}</span>
                )}
              </div>

              {/* Timestamp · actor */}
              <div style={{ fontSize: 12, color: 'var(--txt2)' }}>
                {fmtDatetime(a.created_at)}{a.created_by && ` · ${a.created_by}`}
              </div>

              {/* Stage transition */}
              {isStageTransition && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <span style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: RADIUS.md,
                    background: 'var(--th-bg)', border: '1px solid var(--bdr)', color: 'var(--txt2)',
                  }}>{fmtStage(metaParts[0])}</span>
                  <span className="material-symbols-rounded" style={{ fontSize: 14, color: 'var(--txt3)' }}>arrow_forward</span>
                  <span style={{
                    fontSize: 12, padding: '2px 8px', borderRadius: RADIUS.md,
                    background: `${NAVY}12`, border: `1px solid ${NAVY}25`, color: NAVY,
                    fontWeight: 600,
                  }}>{fmtStage(metaParts[1])}</span>
                </div>
              )}

              {/* Plain meta (e.g. "Call · Promised to pay") */}
              {a.meta && !isStageTransition && (
                <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 5, fontStyle: 'italic' }}>{a.meta}</div>
              )}

              {/* Description / notes */}
              {a.description && (
                <div style={{
                  marginTop: 7, fontSize: 13, color: 'var(--txt2)', lineHeight: 1.5,
                  paddingTop: 7, borderTop: '1px solid var(--bdr)',
                }}>
                  {a.description}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Status badges for header ──────────────────────────────────────────────────

// ── Main page ─────────────────────────────────────────────────────────────────

// ── Documents tab ─────────────────────────────────────────────────────────────
// Renders every file collected on the customer's credit applications (KYC, payslips,
// bank statements…), aggregated by CIF from los_documents. Images render inline, PDFs
// in an iframe, anything else offers the original. Empty until an application is raised.

interface DocRow {
  id: number; doc_type: string; file_name: string; file_url: string
  file_size_bytes: number | null; created_at: string
  application_ref: string; product_type: string | null; uploaded_by_name: string | null
}

const DOC_TYPE_LABEL: Record<string, string> = {
  id_card: 'ID Card', passport: 'Passport', utility_bill: 'Utility Bill',
  bank_statement: 'Bank Statement', payslip: 'Payslip', employment_letter: 'Employment Letter',
  signature: 'Signature', photo: 'Passport Photo', other: 'Other Document',
}
function docLabel(t: string) { return DOC_TYPE_LABEL[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }
function isImageDoc(name: string) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) }
function isPdfDoc(name: string) { return /\.pdf$/i.test(name) }
function fmtBytes(n: number | null) {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function DocumentsTab({ cif }: { cif: string }) {
  const [docs, setDocs] = useState<DocRow[]>([])
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState<DocRow | null>(null)

  useEffect(() => {
    setLoading(true)
    apiFetch<{ data: DocRow[] }>(`/api/contacts/${cif}/documents`)
      .then(r => setDocs(r.data ?? []))
      .catch(() => setDocs([]))
      .finally(() => setLoading(false))
  }, [cif])

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}><Spinner size={26} /></div>

  return (
    <>
      <SectionCard title="Documents" badge={docs.length}>
        {docs.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 16px', textAlign: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 38, color: 'var(--txt3)' }}>folder_open</span>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>No documents on file</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', maxWidth: 380 }}>
              KYC and supporting files uploaded on this customer's credit applications appear here.
              None have been collected yet.
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {docs.map(d => (
              <div key={d.id} onClick={() => setPreview(d)} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, cursor: 'pointer', background: 'var(--card)',
              }}>
                <div style={{ width: 38, height: 38, borderRadius: RADIUS.md, background: 'var(--chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>{isImageDoc(d.file_name) ? 'image' : isPdfDoc(d.file_name) ? 'picture_as_pdf' : 'description'}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{docLabel(d.doc_type)}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.application_ref}{d.file_size_bytes ? ` · ${fmtBytes(d.file_size_bytes)}` : ''}</div>
                </div>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)' }}>visibility</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview ? docLabel(preview.doc_type) : ''} width={720} maxHeight="82vh">
        {preview && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                {preview.file_name} · {preview.application_ref}{preview.uploaded_by_name ? ` · by ${preview.uploaded_by_name}` : ''}
              </div>
              <a href={preview.file_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, textDecoration: 'none' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>open_in_new</span> Open original
              </a>
            </div>
            {isImageDoc(preview.file_name) ? (
              <img src={preview.file_url} alt={preview.file_name} style={{ maxWidth: '100%', maxHeight: '64vh', display: 'block', margin: '0 auto', borderRadius: RADIUS.md }} />
            ) : isPdfDoc(preview.file_name) ? (
              <iframe src={preview.file_url} title={preview.file_name} style={{ width: '100%', height: '64vh', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '50px 0', color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 44, color: 'var(--txt3)' }}>description</span>
                <div style={{ fontSize: TEXT.sm }}>Preview not available — use "Open original"</div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}

// ── Concessions & Restructuring tab ─────────────────────────────────────────────

interface Accommodation {
  id: number; kind: string; concession_type: string | null; account_ref: string | null
  amount_kobo: number | null
  new_tenor_months: number | null; new_rate_bps: number | null
  new_installment_kobo: number | null; new_maturity_date: string | null
  reason: string; status: string
  requested_by_name: string | null; requested_at: string
  decided_by_name: string | null; decided_at: string | null; decision_note: string | null
}

const CONCESSION_TYPES = [
  { value: 'interest_waiver',   label: 'Interest Waiver' },
  { value: 'penalty_waiver',    label: 'Penalty Waiver' },
  { value: 'partial_settlement', label: 'Partial Settlement' },
  { value: 'payment_holiday',   label: 'Payment Holiday' },
  { value: 'rate_reduction',    label: 'Rate Reduction' },
  { value: 'other',             label: 'Other' },
]

function isCreditHead(): boolean {
  try {
    const u = JSON.parse(localStorage.getItem('o3c_user') || '{}')
    return ['recovery_head', 'collections_head', 'risk_head', 'risk_all', 'admin', 'management', 'md', 'coo', 'head_recovery', 'head_collections'].includes(u.role)
  } catch { return false }
}

const accStatusColor: Record<string, string> = { pending: AMBER, approved: GREEN, rejected: RED }

function titleCase(s: string) { return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }

function RequestAccommodationModal({ cif, open, onClose, onDone }: {
  cif: string; open: boolean; onClose: () => void; onDone: () => void
}) {
  const [kind, setKind] = useState<'concession' | 'restructure'>('concession')
  const [cType, setCType] = useState('interest_waiver')
  const [amount, setAmount] = useState('')
  const [accountRef, setAccountRef] = useState('')
  const [tenor, setTenor] = useState('')
  const [rate, setRate] = useState('')
  const [installment, setInstallment] = useState('')
  const [maturity, setMaturity] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    if (!reason.trim() || saving) return
    setSaving(true)
    try {
      await apiPost('/api/credit-accommodations', {
        cif, account_ref: accountRef || null, kind, reason,
        concession_type: kind === 'concession' ? cType : null,
        amount_kobo: kind === 'concession' && amount ? Math.round(parseFloat(amount) * 100) : null,
        new_tenor_months: kind === 'restructure' && tenor ? parseInt(tenor) : null,
        new_rate_bps: kind === 'restructure' && rate ? Math.round(parseFloat(rate) * 100) : null,
        new_installment_kobo: kind === 'restructure' && installment ? Math.round(parseFloat(installment) * 100) : null,
        new_maturity_date: kind === 'restructure' && maturity ? maturity : null,
      })
      toast.success('Submitted for approval')
      setReason(''); setAmount(''); setAccountRef(''); setTenor(''); setRate(''); setInstallment(''); setMaturity('')
      onDone()
    } catch (e: any) { toast.error(e.message ?? 'Failed to submit') } finally { setSaving(false) }
  }

  const inp = { ...filterInputStyle, height: 36, width: '100%' } as React.CSSProperties
  const lbl = { fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 } as React.CSSProperties

  return (
    <Modal open={open} onClose={onClose} title="Request Concession / Restructure" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['concession', 'restructure'] as const).map(k => (
            <button key={k} onClick={() => setKind(k)} style={{
              flex: 1, padding: '8px', borderRadius: RADIUS.md, cursor: 'pointer',
              border: `1px solid ${kind === k ? NAVY : 'var(--bdr)'}`,
              background: kind === k ? NAVY : 'transparent', color: kind === k ? '#fff' : 'var(--txt2)',
              fontSize: TEXT.sm, fontWeight: FW.semibold,
            }}>{titleCase(k)}</button>
          ))}
        </div>
        <div><label style={lbl}>Account / Loan Reference (optional)</label>
          <input value={accountRef} onChange={e => setAccountRef(e.target.value)} placeholder="e.g. loan or card ref" style={inp} /></div>
        {kind === 'concession' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <div><label style={lbl}>Concession Type</label>
              <select value={cType} onChange={e => setCType(e.target.value)} style={inp}>
                {CONCESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select></div>
            <div><label style={lbl}>Amount (NGN)</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="waiver / settlement" style={inp} /></div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <div><label style={lbl}>New Tenor (months)</label>
              <input type="number" value={tenor} onChange={e => setTenor(e.target.value)} style={inp} /></div>
            <div><label style={lbl}>New Rate (% p.a.)</label>
              <input type="number" value={rate} onChange={e => setRate(e.target.value)} style={inp} /></div>
            <div><label style={lbl}>New Installment (NGN)</label>
              <input type="number" value={installment} onChange={e => setInstallment(e.target.value)} style={inp} /></div>
            <div><label style={lbl}>New Maturity</label>
              <input type="date" value={maturity} onChange={e => setMaturity(e.target.value)} style={inp} /></div>
          </div>
        )}
        <div><label style={lbl}>Reason *</label>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} spellCheck={false}
            placeholder="Why this accommodation is warranted…"
            style={{ ...filterInputStyle, width: '100%', resize: 'vertical' }} /></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={!reason.trim() || saving} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: (!reason.trim() || saving) ? 'not-allowed' : 'pointer', opacity: (!reason.trim() || saving) ? 0.6 : 1 }}>Submit for Approval</button>
        </div>
      </div>
    </Modal>
  )
}

function ConcessionsTab({ cif }: { cif: string }) {
  const [rows, setRows] = useState<Accommodation[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const isHead = isCreditHead()

  const load = () => {
    setLoading(true)
    apiFetch<{ data: Accommodation[] }>(`/api/credit-accommodations?cif=${encodeURIComponent(cif)}`)
      .then(r => setRows(r.data ?? [])).catch(() => setRows([])).finally(() => setLoading(false))
  }
  useEffect(load, [cif])

  async function decide(id: number, outcome: 'approve' | 'reject') {
    try {
      await apiPut(`/api/credit-accommodations/${id}/${outcome}`, {})
      toast.success(outcome === 'approve' ? 'Approved' : 'Rejected')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: '50px 0' }}><Spinner size={26} /></div>

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Concessions (waivers / settlements) and restructures raised on this customer's credit.</div>
        <button onClick={() => setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>New Concession / Restructure
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '46px 16px', textAlign: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 38, color: 'var(--txt3)' }}>handshake</span>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>No concessions or restructures yet</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', maxWidth: 360 }}>Raise one to waive/settle a balance or re-term the facility. It goes to a head for approval before taking effect.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(a => (
            <div key={a.id} style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: '14px 16px', background: 'var(--card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{titleCase(a.kind)}{a.concession_type ? ` · ${titleCase(a.concession_type)}` : ''}</span>
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS['2xl'], background: `${accStatusColor[a.status] ?? NAVY}18`, color: accStatusColor[a.status] ?? NAVY }}>{titleCase(a.status)}</span>
                </div>
                {a.status === 'pending' && isHead && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => decide(a.id, 'approve')} style={{ padding: '4px 12px', borderRadius: RADIUS.sm, border: 'none', background: GREEN, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Approve</button>
                    <button onClick={() => decide(a.id, 'reject')} style={{ padding: '4px 12px', borderRadius: RADIUS.sm, border: `1px solid ${RED}40`, background: 'transparent', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Reject</button>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: SP[4], flexWrap: 'wrap', fontSize: TEXT.sm, color: 'var(--txt2)', marginBottom: 6 }}>
                {a.amount_kobo != null && <span>Amount <strong style={{ ...NUM, color: 'var(--txt)' }}>{fmtKoboExact(a.amount_kobo)}</strong></span>}
                {a.new_tenor_months != null && <span>Tenor <strong style={{ color: 'var(--txt)' }}>{a.new_tenor_months}m</strong></span>}
                {a.new_rate_bps != null && <span>Rate <strong style={{ color: 'var(--txt)' }}>{(a.new_rate_bps / 100).toFixed(1)}%</strong></span>}
                {a.new_installment_kobo != null && <span>Installment <strong style={{ ...NUM, color: 'var(--txt)' }}>{fmtKoboExact(a.new_installment_kobo)}</strong></span>}
                {a.new_maturity_date && <span>Maturity <strong style={{ color: 'var(--txt)' }}>{fmtDate(a.new_maturity_date)}</strong></span>}
                {a.account_ref && <span>Ref <strong style={{ color: 'var(--txt)' }}>{a.account_ref}</strong></span>}
              </div>
              {a.reason && <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', marginBottom: 4 }}>{a.reason}</div>}
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                Requested by {a.requested_by_name ?? '—'} · {fmtDate(a.requested_at)}
                {a.status !== 'pending' && a.decided_by_name ? ` · ${titleCase(a.status)} by ${a.decided_by_name}${a.decided_at ? ' · ' + fmtDate(a.decided_at) : ''}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      <RequestAccommodationModal cif={cif} open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); load() }} />
    </>
  )
}

// Core-banking account activity — the live Udara posting ledger (disbursements,
// repayments, interest, fees) resolved across the customer's accounts. This is real
// money movement the card feed (app.transactions) never carries.
function AccountStatementTab({ cif }: { cif: string }) {
  const iso = (dt: Date) => dt.toISOString().slice(0, 10)
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 90 * 86400000)))
  const [to, setTo]     = useState(() => iso(new Date()))
  const [data, setData] = useState<{ accounts: { account: string; name: string }[]; postings: any[]; count: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]   = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true); setErr(null)
    apiFetch<any>(`/api/cbs/customer/${cif}/statement?from=${from}&to=${to}`)
      .then(r => { if (live) setData(r) })
      .catch(e => { if (live) setErr(e?.message || 'Failed to load account activity') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cif, from, to])

  const postings   = data?.postings ?? []
  const multiAcct  = (data?.accounts?.length ?? 0) > 1

  return (
    <SectionCard
      title="Core Banking Account Activity"
      subtitle="Live posting ledger from Udara — disbursements, repayments, interest & fees"
      actions={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={filterInputStyle} />
          <span style={{ color: 'var(--txt3)', fontSize: TEXT.xs }}>→</span>
          <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} style={filterInputStyle} />
        </div>
      }
    >
      {data?.accounts?.length ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {data.accounts.map(a => (
            <span key={a.account} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)', background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: 99, padding: '4px 11px' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14, color: NAVY }}>account_balance</span>
              {a.name || 'Account'} <span style={{ ...NUM, color: 'var(--txt3)' }}>{a.account}</span>
            </span>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner size={18} color={NAVY} /></div>
      ) : err ? (
        <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>{err}</div>
      ) : postings.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '40px 16px', textAlign: 'center' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>receipt_long</span>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>No postings in this window</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', maxWidth: 320 }}>No core-banking account movement between the selected dates.</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bdr)' }}>
                {['Value date', 'Description', 'Debit', 'Credit', 'Balance'].map((h, i) => (
                  <th key={h} style={{ textAlign: i > 1 ? 'right' : 'left', padding: '9px 12px', fontSize: TEXT['2xs'], textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--txt3)', fontWeight: FW.bold, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {postings.map((p, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--txt2)', ...NUM }}>{fmtDate(p.financial_date)}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--txt)' }}>
                    {p.narration || '—'}
                    {multiAcct && p.account ? <span style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginLeft: 6 }}>·{String(p.account).slice(-4)}</span> : null}
                    {p.reference ? <span style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginLeft: 6 }}>#{p.reference}</span> : null}
                  </td>
                  <td style={{ padding: '9px 12px', textAlign: 'right', ...NUM, color: p.debit_kobo > 0 ? RED : 'var(--txt3)', whiteSpace: 'nowrap' }}>{p.debit_kobo > 0 ? fmtKoboExact(p.debit_kobo) : '—'}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right', ...NUM, color: p.credit_kobo > 0 ? GREEN : 'var(--txt3)', whiteSpace: 'nowrap' }}>{p.credit_kobo > 0 ? fmtKoboExact(p.credit_kobo) : '—'}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right', ...NUM, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtKoboExact(p.balance_kobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

const TABS = [
  { key: 'overview',    label: 'Overview' },
  { key: 'loans',       label: 'Loans & Applications' },
  { key: 'fixed_deposits', label: 'Fixed Deposits' },
  { key: 'cards',       label: 'Cards' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'statement',   label: 'Account Activity' },
  { key: 'collections', label: 'Collections' },
  { key: 'recovery',    label: 'Recovery' },
  { key: 'helpdesk',    label: 'Helpdesk' },
  { key: 'concessions', label: 'Concessions' },
  { key: 'documents',   label: 'Documents' },
  { key: 'activity',    label: 'Activity' },
]

export default function ContactProfile() {
  // Route param is :cif under /customers/:cif (and :id under the legacy /contacts/:id).
  const { id, cif } = useParams<{ id?: string; cif?: string }>()
  const key = cif ?? id
  const navigate = useNavigate()
  const [profile, setProfile] = useState<ContactProfileData | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [tab, setTab]           = useState('overview')
  // Which card the Transactions tab is scoped to. Lives here, not in the tab, so
  // clicking a card on the Cards tab can set it and switch tabs in one go.
  const [cardCif, setCardCif]   = useState('')

  const openCardTransactions = useCallback((cif: string) => {
    setCardCif(cif)
    setTab('transactions')
  }, [])

  // Only surface tabs the customer actually has data for. Keeps the bar short (it was
  // 12 tabs and overflowed small screens) and means a loan-only customer isn't shown
  // Cards/FD/Recovery tabs that would just be empty. Overview + Activity are always on.
  const visibleTabs = useMemo(() => {
    const p = profile
    if (!p) return TABS
    const has = {
      loans:       (p.active_loans?.length ?? 0) + (p.applications?.length ?? 0) + (p.loans?.length ?? 0) > 0,
      fds:         (p.fixed_deposits?.length ?? 0) > 0,
      cards:       (p.cards?.length ?? 0) > 0,
      txns:        (p.summary?.txn_count ?? 0) > 0 || (p.cards?.length ?? 0) > 0,
      collections: !!p.collections || p.is_delinquent,
      recovery:    !!p.recovery_case || p.is_in_recovery,
      helpdesk:    (p.helpdesk_tickets?.length ?? 0) > 0,
      credit:      (p.cards?.length ?? 0) > 0 || (p.active_loans?.length ?? 0) > 0 || (p.loans?.length ?? 0) > 0,
    }
    return TABS.filter(t => {
      switch (t.key) {
        case 'overview': case 'activity': return true
        case 'loans':          return has.loans
        case 'fixed_deposits': return has.fds
        case 'cards':          return has.cards
        case 'transactions':   return has.txns
        case 'statement':      return has.cards
        case 'collections':    return has.collections
        case 'recovery':       return has.recovery
        case 'helpdesk':       return has.helpdesk
        case 'concessions':    return has.credit
        case 'documents':      return has.credit
        default:               return true
      }
    })
  }, [profile])

  // If the active tab is no longer visible (e.g. after loading a customer without it),
  // fall back to Overview.
  useEffect(() => {
    if (!visibleTabs.some(t => t.key === tab)) setTab('overview')
  }, [visibleTabs, tab])

  const load = useCallback(async (silent = false) => {
    if (!key) return
    if (!silent) setLoading(true); setError(null)
    try {
      const data = await apiFetch<any>(`/api/contacts/${key}`)
      const raw = (data?.data ?? data) as ContactProfileData
      // Guard against any response shape that omits the list fields — every
      // tab maps over these, so a missing array would crash the page.
      const p: ContactProfileData = {
        ...raw,
        applications:     raw.applications     ?? [],
        active_loans:     raw.active_loans     ?? [],
        cards:            raw.cards            ?? [],
        fixed_deposits:   raw.fixed_deposits   ?? [],
        transactions:     raw.transactions     ?? [],
        helpdesk_tickets: raw.helpdesk_tickets ?? [],
        activity_log:     raw.activity_log     ?? [],
      }
      setProfile(p)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [key])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true))

  if (loading) return (
    <Page title="Customer">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spinner size={32} />
      </div>
    </Page>
  )

  if (error || !profile) return (
    <Page title="Customer">
      <ErrBanner error={error ?? 'Profile not found'} onRetry={load} />
    </Page>
  )

  return (
    <Page
      title={profile.name}
      subtitle={profile.cif}
      actions={
        <button
          onClick={() => navigate(-1)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 14px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', cursor: 'pointer', fontFamily: SORA }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>arrow_back</span>
          Back
        </button>
      }
    >
      {/* Premium hero */}
      <div style={{ background: `linear-gradient(135deg, ${NAVY} 0%, #0A1F38 100%)`, borderRadius: RADIUS.xl, padding: `${SP[6]} ${SP[6]}`, marginBottom: SP[4], display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', boxShadow: '0 10px 30px rgba(14,40,65,0.22)' }}>
        <div style={{
          width: 60, height: 60, borderRadius: RADIUS.full, flexShrink: 0,
          background: 'rgba(255,255,255,0.12)', border: '2px solid rgba(255,255,255,0.28)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: FW.extrabold, color: '#fff', fontFamily: SORA,
        }}>
          {initialsOf(profile.name)}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: '#fff', fontFamily: SORA }}>{profile.name || 'Unknown Customer'}</h1>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, color: 'rgba(255,255,255,0.6)', fontWeight: FW.semibold }}>{profile.customer_id ?? profile.cif}</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {([['call', profile.phone], ['mail', profile.email], ['location_on', profile.state], ['work', profile.employer]] as [string, string | undefined][])
              .filter(([, v]) => v).map(([icon, v]) => (
              <span key={icon} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT.sm, color: 'rgba(255,255,255,0.82)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{icon}</span>{v}
              </span>
            ))}
          </div>
          {/* The customer's status badges live here on the blue overview */}
          <HeroStatusBadges profile={profile} />
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          {profile.phone && (
            <a href={`tel:${profile.phone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', textDecoration: 'none', fontFamily: SORA }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>Call
            </a>
          )}
          <button onClick={() => navigate(`/statements?cif=${profile.cif}`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'rgba(255,255,255,0.14)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>receipt_long</span>Statement
          </button>
          <button onClick={() => navigate(`/helpdesk/new?cif=${profile.cif}&name=${encodeURIComponent(profile.name)}`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#fff', color: NAVY, border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add_comment</span>Open Ticket
          </button>
        </div>
      </div>

      {/* Relationship KPIs */}
      <KpiStrip profile={profile} />

      <div style={{ marginBottom: 20 }} />

      {/* Tabs */}
      <div style={{ marginBottom: 16 }}>
        <Tabs tabs={visibleTabs} active={tab} onChange={setTab} />
      </div>

      {tab === 'overview'    && <OverviewTab    profile={profile} onOpenTab={setTab} />}
      {tab === 'loans'       && <LoansTab       profile={profile} />}
      {tab === 'fixed_deposits' && <FixedDepositsTab profile={profile} />}
      {tab === 'cards'       && <CardsTab       profile={profile} onViewTransactions={openCardTransactions} />}
      {tab === 'transactions' && <TransactionsTab profile={profile} cardCif={cardCif} onCardCif={setCardCif} />}
      {tab === 'statement'   && <AccountStatementTab cif={profile.cif} />}
      {tab === 'collections' && <CollectionsTab profile={profile} />}
      {tab === 'recovery'    && <RecoveryTab    profile={profile} />}
      {tab === 'helpdesk'    && <HelpdeskTab    profile={profile} />}
      {tab === 'concessions' && <ConcessionsTab  cif={profile.cif} />}
      {tab === 'documents'   && <DocumentsTab   cif={profile.cif} />}
      {tab === 'activity'    && <ActivityTab    profile={profile} cif={profile.cif} />}
    </Page>
  )
}
