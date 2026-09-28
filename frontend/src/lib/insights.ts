// Insight findings — structured claims, ranked by what deserves attention.
//
// WHY THIS FILE EXISTS
//
// The first "What to Act On" card built the list as a run of `if` blocks pushing prose
// straight into an array. Two problems followed from that shape, both invisible until
// you compared the card against the database:
//
//   1. ORDER WAS AUTHORSHIP ORDER. The list came out in the order someone typed the
//      blocks, so a neutral "Organic drives 71% of installs" sat above the one genuine
//      problem on the page. A card titled "What to Act On" must lead with what is wrong.
//
//   2. A RULE COULD FIRE ON A NUMBER THAT WAS NEVER MEASURED. Rules read raw floats, so
//      nothing stopped one asserting a rate derived from an empty denominator. Findings
//      here carry evidence, and the rules that build them are expected to gate on
//      isOk() from ./measure — see MobileAnalytics.tsx for the reference use.
//
// checkSequence below fixes the third and worst defect, which was neither of those.
//
// THE DECLARED-ORDER TRAP
//
// A funnel is usually declared as a hardcoded list of steps in the order someone
// believes users move through them. That belief is rarely re-checked against the data,
// and when it is wrong every step-to-step conversion computed from it is meaningless.
//
// Blink's declared order put onboarding after BVN. The app actually fires
// onboarding_start at app-open, so the funnel reported 227 users converting from a step
// with 9 — a "2,522% conversion" — and the sharpest-drop rule, scanning for the largest
// loss, landed on two unrelated events that the code had appended alphabetically:
// "Card Blocked Kyc Required → Card Issuance Failed loses 94%. Best place to fix
// onboarding." 17 blocked users against 1 issuance failure, read as a drop-off.
//
// The test is monotonicity. Users cannot increase as they move down a funnel, so any
// step reporting MORE users than the one before it proves the declared order is wrong.
// checkSequence trusts only the monotonic prefix, measures drops inside it, and returns
// the violations so the ordering itself gets fixed instead of quietly misreporting.

import type { Measure } from './measure'
import { isOk } from './measure'

// ── Findings ──────────────────────────────────────────────────────────────────

export type Tone = 'good' | 'bad' | 'neutral'

export interface Finding {
  /** Stable id — use it as the React key and to suppress a finding per-page. */
  id: string
  tone: Tone
  /** Material Symbols name. */
  icon: string
  text: string
  /**
   * Units at stake: users lost, installs affected, naira exposed. Ranks findings of the
   * same tone against each other, so "62% of registrations abandoned" outranks a 3%
   * wobble. Use a real count from the finding's own evidence, never a severity guess.
   */
  impact: number
}

// Problems first, then what is working, then context. A card called "What to Act On"
// that opens with a neutral observation has buried its own purpose.
const TONE_RANK: Record<Tone, number> = { bad: 0, good: 1, neutral: 2 }

/**
 * Drops the rules that did not fire and orders what remains: bad before good before
 * neutral, and within each tone by impact descending.
 */
export function rankFindings(findings: (Finding | null | undefined)[], limit = 6): Finding[] {
  return findings
    .filter((f): f is Finding => !!f)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.impact - a.impact)
    .slice(0, limit)
}

/**
 * Builds a Finding only when every Measure it cites actually exists. This is the
 * enforcement point for the rule that makes the whole pattern work: a claim may only be
 * made about an `ok` Measure.
 */
export function findingFrom(
  cites: Measure[],
  build: () => Finding,
): Finding | null {
  return cites.every(isOk) ? build() : null
}

// ── Ordered sequences (funnels) ───────────────────────────────────────────────

export interface SeqStep {
  name: string
  users: number
  /** False for a step present in the data but absent from the declared order. */
  ordered: boolean
}

export interface SeqViolation {
  from: string
  to: string
  a: number
  b: number
  /** How many more users the later step reports than the earlier one. */
  gained: number
}

export interface SeqDrop {
  from: string
  to: string
  /** Percentage of the earlier step's users not reaching the later one. */
  lostPct: number
  a: number
  b: number
}

export interface SeqCheck {
  /** The leading run of declared steps the data corroborates. Safe to reason about. */
  verified: SeqStep[]
  /** Every consecutive declared pair that grows. Non-empty ⇒ the declared order is wrong. */
  violations: SeqViolation[]
  /** Largest consecutive loss inside `verified`, or null when the prefix is too short. */
  drop: SeqDrop | null
  /** Steps the data carries that the declared order never mentions. */
  unordered: SeqStep[]
  /** True when the declared order survives the monotonicity test end to end. */
  trusted: boolean
}

/**
 * Validates a declared funnel order against its own counts.
 *
 * Steps must arrive in declared order. Anything flagged `ordered: false` is excluded
 * from both the drop search and the violation list — an event that was never placed in
 * the sequence cannot corroborate or contradict it, and comparing against it is exactly
 * how the old code produced its 94% phantom.
 */
export function checkSequence(steps: SeqStep[]): SeqCheck {
  const declared = steps.filter(s => s.ordered)
  const unordered = steps.filter(s => !s.ordered)

  const violations: SeqViolation[] = []
  for (let i = 1; i < declared.length; i++) {
    const a = declared[i - 1], b = declared[i]
    if (b.users > a.users) {
      violations.push({ from: a.name, to: b.name, a: a.users, b: b.users, gained: b.users - a.users })
    }
  }

  // Trust the sequence only as far as it stays monotonic. Past the first violation the
  // declared order is demonstrably not the order users travel, so nothing downstream of
  // it can be read as a conversion.
  const verified: SeqStep[] = declared.slice(0, 1)
  for (let i = 1; i < declared.length; i++) {
    if (declared[i].users > declared[i - 1].users) break
    verified.push(declared[i])
  }

  let drop: SeqDrop | null = null
  for (let i = 1; i < verified.length; i++) {
    const a = verified[i - 1], b = verified[i]
    if (a.users <= 0) continue
    const lostPct = 100 - (b.users / a.users * 100)
    if (lostPct > 0 && (!drop || lostPct > drop.lostPct)) {
      drop = { from: a.name, to: b.name, lostPct, a: a.users, b: b.users }
    }
  }

  return { verified, violations, drop, unordered, trusted: violations.length === 0 }
}
