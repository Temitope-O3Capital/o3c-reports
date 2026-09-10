// ─────────────────────────────────────────────────────────────────────────────
// Chart colour palette — the APP's own product colours (lib/design), NOT the
// Paystack teal/green of the mockup:
//   Cards = purple · Loans = navy · Fixed Deposit = amber
//   plus brand navy / blue / green / red for non-product metrics.
//
// The Recharts-based chart components that used to live here (ComboChart,
// ChartTooltip, Grid, areaGradient, the "Rails" curve) have been retired — every
// chart now renders through the ECharts wrapper in components/echarts.tsx. Only
// the shared colour constants remain, so this module no longer pulls in Recharts.
// ─────────────────────────────────────────────────────────────────────────────
import { NAVY, BLUE, GREEN, RED, AMBER, PURPLE } from '../lib/design'

// ── Palette (the product colours) ───────────────────────────────────────────
export const CHART = {
  navy: NAVY, blue: BLUE, green: GREEN, red: RED, amber: AMBER, purple: PURPLE,
  // Product-line colours — mirror lib/products.ts lineColor()
  cards: PURPLE, loans: NAVY, fixedDeposit: AMBER,
}

/** Categorical slot order for donuts / multi-series (matches design --sc-* slots). */
export const CHART_SERIES = [BLUE, GREEN, PURPLE, AMBER, NAVY, '#5B7A94']

/** Sequential delinquency / ageing ramp — calm(current) → alarming(charged off).
 *  Warm and monotonic so an older bucket always reads one shade hotter. Use the
 *  steps IN ORDER along a bucket ladder; this is the canonical severity ramp so
 *  ladders match across Collections / Recovery / Risk. */
export const SEVERITY = ['#16A34A', '#D97706', '#EA580C', '#C2410C', '#C00000', '#7F0000']
