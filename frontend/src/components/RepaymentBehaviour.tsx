import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { fmtKoboExact, fmtCount } from '../lib/fmt'
import { SectionCard, Spinner } from './UI'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, BLUE, NUM } from '../lib/design'

// Mirror of the backend's 5 payment bands.
const TIER_META: Record<string, { label: string; range: string; color: string }> = {
  none:        { label: 'None',        range: '0%',      color: RED },
  minimal:     { label: 'Minimal',     range: '1–24%',   color: '#E8590C' },
  partial:     { label: 'Partial',     range: '25–74%',  color: AMBER },
  substantial: { label: 'Substantial', range: '75–99%',  color: BLUE },
  cleared:     { label: 'Cleared',     range: '100%',    color: GREEN },
}
const TIER_ORDER = ['none', 'minimal', 'partial', 'substantial', 'cleared']

interface LoanTier { tier: string; loans: number; outstanding_kobo: number; paid_kobo: number; delinquent: number }

// Per-installment outcomes from Udara's amortisation schedules (app.cbs_loan_schedules).
//
// This used to read `processed` (cbs_loan_schedules.has_processed). That flag is FALSE
// on all 202 rows — Udara's repayment tracker is switched off on these loans — so the
// tile rendered a flat 0%, an artefact of an unset flag presented as a fact about the
// book. The backend dropped the field and now reports payment_status, which is Udara's
// real outcome per installment.
//
// HONESTY CONSTRAINT, carried from the backend and not to be optimised away: this table
// stores only SCHEDULED amounts. There is no paid-amount column anywhere in it. A
// 'PartiallyPaid' installment tells us it was partly paid and NOTHING about how much,
// so partial stays its own visible category — never rounded into paid or unpaid — and
// no paid figure is derived on this screen.
interface InstallmentBehaviour {
  installments: number
  loans: number
  not_yet_due: number
  due_and_unpaid: number
  partially_paid: number
  fully_paid: number
  status_unknown: number
  due_to_date: number
  scheduled_kobo: number
  scheduled_due_to_date_kobo: number
  amounts_are_scheduled_only?: boolean
  paid_amount_available?: boolean
  has_processed_flag_populated?: boolean
  note?: string
}

interface Behaviour {
  loan_tiers?: LoanTier[]
  card_behaviour?: { accounts: number; with_minimum: number; met_minimum: number; outstanding_kobo: number }
  installment_behaviour?: InstallmentBehaviour
}

// The four Udara installment outcomes, in schedule order: not due yet, then the three
// ways an installment that IS due can stand. Partial sits between unpaid and paid
// precisely because it is neither.
const STATUS_META: { key: keyof InstallmentBehaviour; label: string; color: string; note: string }[] = [
  { key: 'not_yet_due',    label: 'Not Yet Due',     color: NAVY,  note: 'scheduled, not yet payable' },
  { key: 'due_and_unpaid', label: 'Due And Unpaid',  color: RED,   note: 'due, nothing received' },
  { key: 'partially_paid', label: 'Partially Paid',  color: AMBER, note: 'part received: amount not recorded' },
  { key: 'fully_paid',     label: 'Fully Paid',      color: GREEN, note: 'settled in full' },
]

function pct(n: number, d: number): number { return d > 0 ? Math.round((100 * n) / d) : 0 }
const num = (v: unknown) => { const x = Number(v); return isFinite(x) ? x : 0 }

/**
 * RepaymentBehaviour is the repayment-side twin of the spending-behaviour block: it
 * shows how the credit book actually pays down — loans banded by % of principal repaid,
 * cards by whether the minimum was met last cycle, and loan schedules by the outcome
 * Udara recorded against each installment.
 */
export default function RepaymentBehaviour() {
  const [data, setData]   = useState<Behaviour | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    apiFetch<{ data: Behaviour }>('/api/growth/repayment-behaviour')
      .then(r => { if (live) setData(r?.data ?? {}) })
      .catch(() => { if (live) setData({}) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  if (loading) return <SectionCard title="Repayment Behaviour"><div style={{ padding: SP[5], textAlign: 'center' }}><Spinner size={18} /></div></SectionCard>

  const tiers = data?.loan_tiers ?? []
  const totalLoans = tiers.reduce((s, t) => s + Number(t.loans || 0), 0)
  const card = data?.card_behaviour
  const inst = data?.installment_behaviour

  return (
    <SectionCard title="Repayment Behaviour" subtitle="How the credit book pays down. Loans by principal repaid, cards by minimum met, loans by installment outcome">
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5], paddingTop: SP[2] }}>

        {/* Headline behaviour stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[3] }}>
          <MiniStat
            label="Cards Met Minimum (Last Cycle)"
            main={card ? `${pct(card.met_minimum, card.with_minimum)}%` : '—'}
            sub={card ? `${fmtCount(card.met_minimum)} of ${fmtCount(card.with_minimum)} billed accounts` : undefined}
            color={GREEN}
          />
          {/* Deliberately a COUNT, not a percentage. Any single ratio here has to put
              partially-paid installments on one side or the other, and there is no
              honest side for them: Udara records that part was paid and never how much.
              The three outcomes are listed side by side instead. */}
          <MiniStat
            label="Loan Installments Due To Date"
            main={inst ? fmtCount(inst.due_to_date) : '—'}
            sub={inst
              ? `${fmtCount(inst.fully_paid)} fully paid · ${fmtCount(inst.partially_paid)} partially paid · ${fmtCount(inst.due_and_unpaid)} unpaid`
              : undefined}
            color={NAVY}
          />
          <MiniStat
            label="Loans Fully Repaid"
            main={totalLoans ? `${pct(Number(tiers.find(t => t.tier === 'cleared')?.loans ?? 0), totalLoans)}%` : '—'}
            sub={`${fmtCount(Number(tiers.find(t => t.tier === 'cleared')?.loans ?? 0))} of ${fmtCount(totalLoans)} loans`}
            color={BLUE}
          />
        </div>

        {/* Installment outcomes — the full schedule, all four states kept apart */}
        {inst && num(inst.installments) > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: SP[3], marginBottom: SP[3] }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Installment Outcomes</span>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                {fmtCount(inst.installments)} installments across {fmtCount(inst.loans)} loans
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {STATUS_META.map(s => {
                const n = num(inst[s.key])
                const share = pct(n, num(inst.installments))
                return (
                  <div key={String(s.key)} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 240, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{s.label}</span>
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.note}</span>
                    </div>
                    <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--bg2)', overflow: 'hidden' }}>
                      <div style={{ width: `${share}%`, height: '100%', background: s.color }} />
                    </div>
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, width: 54, textAlign: 'right' }}>{fmtCount(n)}</span>
                    <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 42, textAlign: 'right' }}>{share}%</span>
                  </div>
                )
              })}
              {num(inst.status_unknown) > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 240, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--txt3)', flexShrink: 0 }} />
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Status Not Recorded</span>
                  </div>
                  <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--bg2)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct(num(inst.status_unknown), num(inst.installments))}%`, height: '100%', background: 'var(--txt3)' }} />
                  </div>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, width: 54, textAlign: 'right' }}>{fmtCount(inst.status_unknown)}</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 42, textAlign: 'right' }}>{pct(num(inst.status_unknown), num(inst.installments))}%</span>
                </div>
              )}
            </div>
            {/* The limit of this data, stated on the screen that shows it rather than
                left for a reader to discover. No paid amount exists, so none is shown. */}
            <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginTop: SP[3] }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15, color: AMBER, flexShrink: 0, marginTop: 1 }}>info</span>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
                {inst.note || 'Counts are Udara installment outcomes. Amounts on the schedule are what was scheduled, not what was paid.'}
                {' '}Scheduled to date: {fmtKoboExact(inst.scheduled_due_to_date_kobo)} of {fmtKoboExact(inst.scheduled_kobo)} over the full schedule.
              </span>
            </div>
          </div>
        )}

        {/* Loan paydown-tier distribution */}
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: SP[3] }}>Loan Paydown Tiers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {TIER_ORDER.map(key => {
              const t = tiers.find(x => x.tier === key)
              const m = TIER_META[key]
              const loans = Number(t?.loans ?? 0)
              const share = pct(loans, totalLoans)
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 150, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: m.color }} />
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{m.label}</span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{m.range}</span>
                  </div>
                  <div style={{ flex: 1, height: 10, borderRadius: 5, background: 'var(--bg2)', overflow: 'hidden' }}>
                    <div style={{ width: `${share}%`, height: '100%', background: m.color }} />
                  </div>
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, width: 54, textAlign: 'right' }}>{fmtCount(loans)}</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 42, textAlign: 'right' }}>{share}%</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 150, textAlign: 'right' }}>{fmtKoboExact(Number(t?.outstanding_kobo ?? 0))}</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: Number(t?.delinquent ?? 0) > 0 ? AMBER : 'var(--txt3)', width: 96, textAlign: 'right' }}>{fmtCount(Number(t?.delinquent ?? 0))} delinq.</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

function MiniStat({ label, main, sub, color }: { label: string; main: string; sub?: string; color: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>{label}</span>
      <span style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color, lineHeight: 1 }}>{main}</span>
      {sub && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{sub}</span>}
    </div>
  )
}
