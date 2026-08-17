// Risk band + score scale — single source of truth for the Risk module.
//
// This file exists because the vocabulary drifted. The backend has always emitted
// bands A/B/C/D/E (app.cbs_risk_band_dpd) and scores on a 0-100 scale, while every
// Risk page independently declared a Prime/Near-Prime/Sub-Prime/High-Risk map and
// coloured scores on a 300-850 bureau scale. The result: the Overview donut rendered
// one flat colour with an "A/B/C/E" legend, the Portfolio band pills were all grey,
// the band filter chips could never match a row, and a perfectly healthy score of 76
// was painted red because it was under 700.
//
// Import from here rather than redeclaring. The band letters and the 80/65/50/35
// score cut-offs mirror app.cbs_risk_band_dpd in migration 151 — change both together.
//
// SCOPE: this covers the CBS-DERIVED band/score only — the ones computed from
// repayment behaviour on the live Udara book (Overview band distribution, Portfolio,
// Vintage Detail). It does NOT cover the origination Eye Score in
// loan_applications.eye_rating, which is a genuinely different vocabulary
// (Prime/Near-Prime/Sub-Prime/High-Risk) on a bureau-style scale. App Review and the
// Eye Score page keep their own maps for that reason — the two must not be merged.

import { GREEN, BLUE, AMBER, RED } from './design'

export type RiskBand = 'A' | 'B' | 'C' | 'D' | 'E'

export const RISK_BANDS: RiskBand[] = ['A', 'B', 'C', 'D', 'E']

/** Human label for a band. The letter stays visible — it is what the data contains. */
export const BAND_LABEL: Record<RiskBand, string> = {
  A: 'Prime',
  B: 'Near-Prime',
  C: 'Acceptable',
  D: 'Sub-Prime',
  E: 'High-Risk',
}

export const BAND_COLOR: Record<RiskBand, string> = {
  A: GREEN,
  B: BLUE,
  C: AMBER,
  D: '#D97706',
  E: RED,
}

const DARK = '#6B7280'

export function isRiskBand(b: string | null | undefined): b is RiskBand {
  return !!b && (RISK_BANDS as string[]).includes(b)
}

export function bandColor(b: string | null | undefined): string {
  return isRiskBand(b) ? BAND_COLOR[b] : DARK
}

/** "A — Prime". Unknown bands pass through unchanged rather than being mislabelled. */
export function bandLabel(b: string | null | undefined): string {
  if (!b) return '—'
  return isRiskBand(b) ? `${b} — ${BAND_LABEL[b]}` : b
}

/** Short form for tight table cells: "A Prime". */
export function bandShort(b: string | null | undefined): string {
  if (!b) return '—'
  return isRiskBand(b) ? `${b} ${BAND_LABEL[b]}` : b
}

// ── Score ────────────────────────────────────────────────────────────────────
// The CBS-derived score is 0-100, NOT a bureau score. Cut-offs match the band
// boundaries in app.cbs_risk_band_dpd so colour and band can never disagree.

export const SCORE_MAX = 100

export function scoreColor(s: number | null | undefined): string {
  if (s === null || s === undefined) return 'var(--txt3)'
  if (s >= 80) return GREEN
  if (s >= 65) return BLUE
  if (s >= 50) return AMBER
  if (s >= 35) return '#D97706'
  return RED
}

/** The band a raw score falls into — mirrors app.cbs_risk_band_dpd. */
export function scoreBand(s: number | null | undefined): RiskBand | null {
  if (s === null || s === undefined) return null
  if (s >= 80) return 'A'
  if (s >= 65) return 'B'
  if (s >= 50) return 'C'
  if (s >= 35) return 'D'
  return 'E'
}

/** Renders as "76 / 100" so nobody reads a 0-100 score as a bureau score. */
export function fmtScore(s: number | null | undefined): string {
  return s === null || s === undefined ? '—' : `${s} / ${SCORE_MAX}`
}
