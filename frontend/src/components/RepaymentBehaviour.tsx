import { useEffect, useState } from 'react'
import { apiFetch } from '../lib/api'
import { fmtKoboExact, fmtNum } from '../lib/fmt'
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
interface Behaviour {
  loan_tiers?: LoanTier[]
  card_behaviour?: { accounts: number; with_minimum: number; met_minimum: number; outstanding_kobo: number }
  installment_behaviour?: { installments: number; processed: number; loans: number }
}

function pct(n: number, d: number): number { return d > 0 ? Math.round((100 * n) / d) : 0 }

/**
 * RepaymentBehaviour is the repayment-side twin of the spending-behaviour block: it
 * shows how the credit book actually pays down — loans banded by % of principal repaid,
 * cards by whether the minimum was met last cycle, and loans by installments processed.
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
    <SectionCard title="Repayment Behaviour" subtitle="How the credit book pays down — loans by principal repaid, cards by minimum met, loans by installments processed">
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5], paddingTop: SP[2] }}>

        {/* Headline behaviour stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP[3] }}>
          <MiniStat
            label="Cards met minimum (last cycle)"
            main={card ? `${pct(card.met_minimum, card.with_minimum)}%` : '—'}
            sub={card ? `${fmtNum(card.met_minimum)} of ${fmtNum(card.with_minimum)} billed accounts` : undefined}
            color={GREEN}
          />
          <MiniStat
            label="Loan installments processed"
            main={inst ? `${pct(inst.processed, inst.installments)}%` : '—'}
            sub={inst ? `${fmtNum(inst.processed)} of ${fmtNum(inst.installments)} scheduled` : undefined}
            color={NAVY}
          />
          <MiniStat
            label="Loans fully repaid"
            main={totalLoans ? `${pct(Number(tiers.find(t => t.tier === 'cleared')?.loans ?? 0), totalLoans)}%` : '—'}
            sub={`${fmtNum(Number(tiers.find(t => t.tier === 'cleared')?.loans ?? 0))} of ${fmtNum(totalLoans)} loans`}
            color={BLUE}
          />
        </div>

        {/* Loan paydown-tier distribution */}
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: SP[3] }}>Loan paydown tiers</div>
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
                  <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, width: 54, textAlign: 'right' }}>{fmtNum(loans)}</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 42, textAlign: 'right' }}>{share}%</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)', width: 150, textAlign: 'right' }}>{fmtKoboExact(Number(t?.outstanding_kobo ?? 0))}</span>
                  <span style={{ ...NUM, fontSize: TEXT.xs, color: Number(t?.delinquent ?? 0) > 0 ? AMBER : 'var(--txt3)', width: 96, textAlign: 'right' }}>{fmtNum(Number(t?.delinquent ?? 0))} delinq.</span>
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
