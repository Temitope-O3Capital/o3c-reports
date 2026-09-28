// Measure — a derived number that knows whether it is allowed to exist.
//
// WHY THIS FILE EXISTS
//
// Mobile Analytics shipped a "What to Act On" card whose claims were each computed by
// dividing two aggregates without first checking the two were comparable. One omission,
// five wrong statements on screen:
//
//   - Organic showed "Sess./Install 0.0" beside a green "High · 55.7% loyal" badge on
//     the same row. AppsFlyer attributes sessions to paid partners only in this account,
//     so the 0 was absence of data rendered as a measurement.
//   - Denmark showed "100% · High" loyal-user rate on 2 installs.
//   - The funnel reported a 94% drop between two events that are not sequential.
//   - CTR / Click→Install / CPI were computed from a feed carrying zero impressions,
//     zero clicks and zero spend.
//   - A loyal-user rate divided September's loyal users by September's installs, so
//     August's installs turning loyal in September inflated the rate.
//
// The old derive() returned `null` for three of those and `0` for the other two. Zero is
// a lie: it renders as a confident number and even earns a red "Low" badge. The fix that
// generalises is to make "I cannot compute this" a first-class value that the formatter
// physically cannot print as a number, and that an insight rule cannot fire on.
//
// HOW TO USE IT
//
//   const loyalRate = rate(row.loyal_users, row.installs, 5, 'installs')
//   <span>{fmtM(loyalRate, fmtPct)}</span>           // renders "—" when it cannot exist
//   <span title={loyalRate.reason}>…</span>          // tells the reader why
//   if (isOk(loyalRate)) { /* only here may you assert it */ }
//
// The rule that makes this worth the ceremony: a claim may only be made about an `ok`
// Measure. Everything else in this file exists to make that rule enforceable by the
// type checker rather than remembered by the next person.

/** Why a derived number does or does not exist. */
export type MeasureStatus =
  /** Computed, and its preconditions held. */
  | 'ok'
  /** The denominator was zero — nothing in this window to measure against. */
  | 'no_data'
  /** Real but too few observations for a ratio to mean anything. */
  | 'below_floor'
  /** The upstream feed does not populate this for this slice. Absence, not zero. */
  | 'not_reported'

export interface Measure {
  /** null whenever status !== 'ok'. Never read this without checking the status. */
  value: number | null
  status: MeasureStatus
  /** Plain-language cause, safe to put in a tooltip. Present whenever value is null. */
  reason?: string
}

export const ok = (value: number): Measure => ({ value, status: 'ok' })

export const na = (status: Exclude<MeasureStatus, 'ok'>, reason: string): Measure =>
  ({ value: null, status, reason })

/**
 * Narrowing guard. `isOk(m)` proves `m.value` is a number, so a rule that fires only
 * inside an `isOk` branch cannot accidentally assert a figure that was never measured.
 */
export const isOk = (m: Measure): m is Measure & { value: number } =>
  m.status === 'ok' && m.value !== null && isFinite(m.value)

/**
 * A percentage that refuses to exist when its denominator is absent or too small.
 *
 * `floor` is the minimum denominator at which the ratio carries information. Pick it
 * from the decision it supports, not from taste: a loyal-user rate steering ad spend
 * needs more installs behind it than a completion rate on a queue does.
 */
export function rate(num: number, den: number, floor = 1, denLabel = 'observations'): Measure {
  if (!isFinite(num) || !isFinite(den)) return na('no_data', `no ${denLabel} in this window`)
  if (den <= 0) return na('no_data', `no ${denLabel} in this window`)
  if (den < floor) return na('below_floor', `only ${den} ${denLabel} — too few to rate reliably`)
  return ok(num / den * 100)
}

/** A plain ratio (not a percentage) under the same preconditions — sessions per install. */
export function per(num: number, den: number, floor = 1, denLabel = 'observations'): Measure {
  const r = rate(num, den, floor, denLabel)
  return isOk(r) ? ok(r.value / 100) : r
}

/**
 * Wraps a figure the upstream feed may simply not populate for this slice.
 *
 * This is the one that would have caught Organic's sessions. The feed sends 0; 0 and
 * "not measured" are different facts, and only the caller knows which applies.
 */
export function reported(value: number, isReported: boolean, why: string): Measure {
  if (!isReported) return na('not_reported', why)
  return isFinite(value) ? ok(value) : na('no_data', why)
}

/** Formats a Measure, or an em-dash when it cannot exist. Pair with title={m.reason}. */
export function fmtM(m: Measure, f: (n: number) => string): string {
  return isOk(m) ? f(m.value) : '—'
}

/** Sorts ok Measures ahead of absent ones, so "—" rows sink rather than reading as 0. */
export function cmpM(a: Measure, b: Measure, dir: 'asc' | 'desc' = 'desc'): number {
  if (!isOk(a) && !isOk(b)) return 0
  if (!isOk(a)) return 1
  if (!isOk(b)) return -1
  return dir === 'desc' ? b.value - a.value : a.value - b.value
}
