import { describe, it, expect } from 'vitest'
import { checkSequence, rankFindings, findingFrom } from './insights'
import type { SeqStep, Finding } from './insights'
import { rate, per, reported, na, isOk, fmtM, cmpM } from './measure'

// These are the real Blink event counts for 2026-08-29 → 2026-09-28, pulled from
// appsflyer_events. They are kept verbatim because they are the case that broke:
// "What to Act On" reported "Card Blocked Kyc Required → Card Issuance Failed loses
// 94%. Best place to fix onboarding" — 17 blocked users against 1 issuance failure,
// two unrelated events the backend sort had appended alphabetically after the
// declared journey ran out.
//
// The declared order also put onboarding after BVN, but Blink fires onboarding_start
// at app-open, so the funnel showed 227 users converting from a step with 9.
const BLINK_SEPT: SeqStep[] = [
  { name: 'First Open', users: 236, ordered: true },
  { name: 'Registration Start', users: 124, ordered: true },
  { name: 'Registration Details Submitted', users: 47, ordered: true },
  { name: 'Registration Email Verified', users: 52, ordered: true },   // ← breaks monotonicity
  { name: 'Registration Passcode Created', users: 36, ordered: true },
  { name: 'Complete Registration', users: 46, ordered: true },
  { name: 'Kyc Start', users: 47, ordered: true },
  { name: 'Kyc Result', users: 30, ordered: true },
  { name: 'Bvn Start', users: 10, ordered: true },
  { name: 'Bvn Result', users: 9, ordered: true },
  { name: 'Onboarding Start', users: 227, ordered: true },             // ← the 2,522% step
  { name: 'Onboarding Complete', users: 200, ordered: true },
  { name: 'Card Cta Tapped', users: 34, ordered: true },
  { name: 'Login', users: 34, ordered: true },
  { name: 'Initiated Checkout', users: 21, ordered: false },
  { name: 'Card Blocked Kyc Required', users: 17, ordered: false },
  { name: 'Card Issuance Failed', users: 1, ordered: false },          // ← the phantom 94%
]

describe('checkSequence', () => {
  const seq = checkSequence(BLINK_SEPT)

  it('rejects a declared order the data contradicts', () => {
    expect(seq.trusted).toBe(false)
    expect(seq.violations).toHaveLength(4)
    expect(seq.violations.map(v => v.to)).toEqual([
      'Registration Email Verified',
      'Complete Registration',
      'Kyc Start',
      'Onboarding Start',
    ])
  })

  it('trusts only the monotonic leading run', () => {
    expect(seq.verified.map(s => s.name)).toEqual([
      'First Open', 'Registration Start', 'Registration Details Submitted',
    ])
  })

  it('never reports a drop across unplaced events — the original bug', () => {
    expect(seq.drop).not.toBeNull()
    expect(seq.drop!.from).not.toBe('Card Blocked Kyc Required')
    expect(seq.drop!.to).not.toBe('Card Issuance Failed')
    expect(seq.unordered.map(s => s.name)).toContain('Card Issuance Failed')
  })

  it('finds the sharpest drop inside the verified run', () => {
    expect(seq.drop!.from).toBe('Registration Start')
    expect(seq.drop!.to).toBe('Registration Details Submitted')
    expect(seq.drop!.lostPct).toBeCloseTo(62.1, 1)
    expect(seq.drop!.a).toBe(124)
    expect(seq.drop!.b).toBe(47)
  })

  it('accepts a genuinely monotonic funnel end to end', () => {
    const clean = checkSequence([
      { name: 'Open', users: 100, ordered: true },
      { name: 'Register', users: 60, ordered: true },
      { name: 'Verify', users: 25, ordered: true },
    ])
    expect(clean.trusted).toBe(true)
    expect(clean.verified).toHaveLength(3)
    expect(clean.drop!.from).toBe('Register')   // 60 → 25 loses more than 100 → 60
    expect(clean.drop!.lostPct).toBeCloseTo(58.33, 1)
  })

  it('treats an equal step as valid, not as a violation', () => {
    const flat = checkSequence([
      { name: 'A', users: 50, ordered: true },
      { name: 'B', users: 50, ordered: true },
    ])
    expect(flat.trusted).toBe(true)
    expect(flat.drop).toBeNull()   // nothing was lost
  })

  it('survives an empty funnel', () => {
    const none = checkSequence([])
    expect(none.trusted).toBe(true)
    expect(none.drop).toBeNull()
    expect(none.verified).toHaveLength(0)
  })
})

describe('Measure', () => {
  it('refuses a rate with no denominator instead of returning 0', () => {
    const m = rate(0, 0, 1, 'impressions')
    expect(isOk(m)).toBe(false)
    expect(m.status).toBe('no_data')
    expect(m.value).toBeNull()
    expect(fmtM(m, v => v.toFixed(1))).toBe('—')
  })

  it('refuses a rate below its sample floor — Denmark: 2 installs, 2 loyal', () => {
    const m = rate(2, 2, 5, 'installs')
    expect(isOk(m)).toBe(false)
    expect(m.status).toBe('below_floor')
    expect(m.reason).toContain('too few')
  })

  it('computes a rate once the floor is met', () => {
    const m = rate(103, 185, 5, 'installs')
    expect(isOk(m)).toBe(true)
    expect(m.value).toBeCloseTo(55.68, 2)
  })

  it('separates "not reported" from zero — Organic sessions', () => {
    const m = reported(0, false, 'AppsFlyer reports sessions for paid partners only')
    expect(m.status).toBe('not_reported')
    expect(m.value).toBeNull()
    expect(fmtM(m, v => v.toFixed(1))).toBe('—')
  })

  it('per() returns a plain ratio, not a percentage', () => {
    const m = per(222, 77, 1, 'installs')
    expect(m.value).toBeCloseTo(2.88, 2)
  })

  it('sorts absent measures last in both directions', () => {
    const absent = na('no_data', 'nothing here')
    expect(cmpM(rate(1, 10), absent)).toBeLessThan(0)
    expect(cmpM(absent, rate(1, 10))).toBeGreaterThan(0)
    expect(cmpM(absent, rate(1, 10), 'asc')).toBeGreaterThan(0)
  })
})

describe('findings', () => {
  const mk = (id: string, tone: Finding['tone'], impact: number): Finding =>
    ({ id, tone, icon: 'x', text: id, impact })

  it('leads with problems, then wins, then context', () => {
    const out = rankFindings([
      mk('neutral-big', 'neutral', 999),
      mk('good-small', 'good', 1),
      mk('bad-small', 'bad', 2),
    ])
    expect(out.map(f => f.id)).toEqual(['bad-small', 'good-small', 'neutral-big'])
  })

  it('orders by impact within a tone', () => {
    const out = rankFindings([mk('bad-a', 'bad', 5), mk('bad-b', 'bad', 50)])
    expect(out.map(f => f.id)).toEqual(['bad-b', 'bad-a'])
  })

  it('drops rules that did not fire', () => {
    expect(rankFindings([null, undefined, mk('only', 'bad', 1)])).toHaveLength(1)
  })

  it('refuses to build a finding that cites a measure which does not exist', () => {
    const absent = rate(0, 0, 1, 'clicks')
    let built = false
    const f = findingFrom([absent], () => { built = true; return mk('never', 'good', 1) })
    expect(f).toBeNull()
    expect(built).toBe(false)
  })

  it('builds when every cited measure exists', () => {
    const f = findingFrom([rate(27, 77, 5, 'installs')], () => mk('ok', 'good', 1))
    expect(f).not.toBeNull()
  })
})
