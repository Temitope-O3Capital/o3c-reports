import { GREEN, BLUE, AMBER, RED } from './design'

// Shared QA types, scoring and presentation — mirrors the server's authoritative
// scoring so the evaluation form can preview the total/band/pass instantly.

export interface QAParam {
  section_key: string; section_label: string; section_weight: number
  param_key: string; param_label: string; max_points: number
}
export interface QASection { key: string; label: string; weight: number; params: QAParam[] }
export interface QASettings { pass_threshold: number; critical_error_auto_fail: boolean }
export interface QAConfig {
  sections: QASection[]; settings: QASettings
  scale: { value: number; label: string }[]; can_evaluate: boolean
}
export interface QAScore { rating: number | null; na?: boolean; comment?: string }
export type QAScores = Record<string, QAScore>

// Rating scale 0–5 (plus N/A handled separately).
export const RATING_META: Record<number, { label: string; color: string }> = {
  5: { label: 'Excellent',           color: '#16A34A' },
  4: { label: 'Good',                color: GREEN },
  3: { label: 'Meets Expectations',  color: BLUE },
  2: { label: 'Needs Improvement',   color: AMBER },
  1: { label: 'Poor',                color: '#F97316' },
  0: { label: 'Not Demonstrated',    color: RED },
}

export const BAND_COLOR: Record<string, string> = {
  Outstanding: '#16A34A', Excellent: GREEN, Good: BLUE, Fair: AMBER, 'Needs Improvement': RED,
}

export function qaBand(score: number): string {
  if (score >= 95) return 'Outstanding'
  if (score >= 90) return 'Excellent'
  if (score >= 80) return 'Good'
  if (score >= 70) return 'Fair'
  return 'Needs Improvement'
}

// Weighted score: within a section, N/A params drop out of the denominator; a
// whole-N/A section drops out and its weight is redistributed.
export function qaCompute(sections: QASection[], scores: QAScores, pass: number, autoFail: boolean, critical: boolean) {
  let weightedPct = 0, totalWeight = 0
  let rated = 0, totalParams = 0
  for (const sec of sections) {
    let earned = 0, max = 0
    for (const p of sec.params) {
      totalParams++
      const sc = scores[p.param_key]
      if (!sc || sc.na || sc.rating == null) continue
      rated++
      const r = Math.max(0, Math.min(5, sc.rating))
      earned += (r / 5) * p.max_points
      max += p.max_points
    }
    if (max <= 0) continue
    weightedPct += (earned / max) * sec.weight
    totalWeight += sec.weight
  }
  const total = totalWeight > 0 ? Math.round((weightedPct / totalWeight) * 1000) / 10 : 0
  const band = qaBand(total)
  let passed = total >= pass
  if (critical && autoFail) passed = false
  return { total, band, passed, rated, totalParams }
}
