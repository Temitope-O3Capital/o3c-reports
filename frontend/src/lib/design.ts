// Shared design system — Editorial B
// Source of truth for all token values, typography, and chart components.
// Import this everywhere instead of duplicating.

import type React from 'react'

// ── Typography ────────────────────────────────────────────────────────────────
export const SORA  = "'Sora', ui-sans-serif, sans-serif"
export const INTER = "'Inter', ui-sans-serif, sans-serif"
export const PLEX  = "'IBM Plex Sans', ui-sans-serif, sans-serif"
export const MONO  = "'Roboto Mono', ui-monospace, monospace"
export const NUM: React.CSSProperties = {
  fontFamily: MONO,
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: "'tnum' 1",
}

// ── Brand constants ───────────────────────────────────────────────────────────
export const NAVY   = '#0E2841'
export const RED    = '#C00000'
export const GREEN  = '#16A34A'
export const AMBER  = '#D97706'
export const BLUE   = '#2563EB'
export const PURPLE = '#7C3AED'

// ── Theme token type ─────────────────────────────────────────────────────────
export type ThemeVars = React.CSSProperties & {
  '--bg'?: string
  '--sb'?: string; '--sb2'?: string; '--sb-bdr'?: string
  '--topbar-bg'?: string
  '--grp'?: string
  '--nav-txt'?: string; '--nav-act-txt'?: string; '--nav-act-bg'?: string
  '--nav-dot'?: string; '--nav-hvr-bg'?: string; '--nav-hvr-txt'?: string
  '--sub-txt'?: string; '--sub-hvr'?: string; '--sub-act'?: string
  '--card'?: string; '--card-bdr'?: string; '--card-shadow'?: string
  '--txt'?: string; '--txt2'?: string; '--txt3'?: string
  '--bdr'?: string; '--row-hvr'?: string; '--row-sel'?: string
  '--th-bg'?: string; '--input-bg'?: string; '--input-bdr'?: string
  '--chip-bg'?: string; '--chip-txt'?: string
  '--chart-grid'?: string; '--chart-lbl'?: string
  '--fp-bg'?: string; '--fp-bdr'?: string
}

// ── Light theme ───────────────────────────────────────────────────────────────
export const LIGHT: ThemeVars = {
  '--bg': '#F4F6FA',
  '--sb': '#0E2841',                       // sidebar: O3 navy
  '--sb2': '#14324F',                      // sidebar secondary (cmdk bg, hover)
  '--sb-bdr': '#0A1E33',
  '--topbar-bg': '#FFFFFF',
  '--grp': 'rgba(255,255,255,0.28)',        // section header labels
  '--nav-txt': 'rgba(255,255,255,0.42)',    // inactive nav items
  '--nav-act-txt': '#FFFFFF',              // active nav items
  '--nav-act-bg': 'rgba(255,255,255,0.10)',
  '--nav-dot': '#C00000',
  '--nav-hvr-bg': 'rgba(255,255,255,0.07)',
  '--nav-hvr-txt': 'rgba(255,255,255,0.82)',
  '--sub-txt': 'rgba(255,255,255,0.32)',
  '--sub-hvr': 'rgba(255,255,255,0.70)',
  '--sub-act': '#FFFFFF',
  '--card': '#FFFFFF', '--card-bdr': '#E8EBF2',
  '--card-shadow': '0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)',
  '--txt': '#0F1623', '--txt2': '#798094', '--txt3': '#C0C8D8',
  '--bdr': '#E8EBF2', '--row-hvr': '#F8F9FC', '--row-sel': '#FFF2F2',
  '--th-bg': '#F6F8FC', '--input-bg': '#F2F4F9', '--input-bdr': '#DDE0EA',
  '--chip-bg': '#EEF0F8', '--chip-txt': '#4A5270',
  '--chart-grid': '#E8EBF2', '--chart-lbl': '#9AA4B8',
  '--fp-bg': '#FFFFFF', '--fp-bdr': '#E8EBF2',
}

// ── Dark theme ────────────────────────────────────────────────────────────────
export const DARK: ThemeVars = {
  '--bg': '#07090F',
  '--sb': '#0A1E33',
  '--sb2': '#102A44',
  '--sb-bdr': '#0D2240',
  '--topbar-bg': '#07090F',  // topbar: same as page bg in dark — unified dark shell
  '--grp': 'rgba(255,255,255,0.18)',
  '--nav-txt': 'rgba(255,255,255,0.38)',
  '--nav-act-txt': '#FFFFFF',
  '--nav-act-bg': 'rgba(255,255,255,0.10)',
  '--nav-dot': '#FF4444',
  '--nav-hvr-bg': 'rgba(255,255,255,0.06)',
  '--nav-hvr-txt': 'rgba(255,255,255,0.72)',
  '--sub-txt': 'rgba(255,255,255,0.28)',
  '--sub-hvr': 'rgba(255,255,255,0.60)',
  '--sub-act': '#FFFFFF',
  '--card': '#0A0E1A', '--card-bdr': '#121C30',
  '--card-shadow': '0 1px 3px rgba(0,0,0,0.5), 0 8px 28px rgba(0,0,0,0.3)',
  '--txt': '#D5DDED', '--txt2': '#384A68', '--txt3': '#1C2438',
  '--bdr': '#121C30', '--row-hvr': '#0C1220', '--row-sel': '#180E1C',
  '--th-bg': '#060910', '--input-bg': '#0A0E1A', '--input-bdr': '#121C30',
  '--chip-bg': '#0F1A30', '--chip-txt': '#506898',
  '--chart-grid': '#0F1626', '--chart-lbl': '#242E44',
  '--fp-bg': '#0A0E1A', '--fp-bdr': '#121C30',
}

// ── Status pill colours ───────────────────────────────────────────────────────
export const PILL_STYLES: Record<string, { bg: string; txt: string; dkBg: string; dkTxt: string }> = {
  Hot:  { bg: '#FEE2E2', txt: '#991B1B', dkBg: 'rgba(192,0,0,.18)',    dkTxt: '#FF7070' },
  Warm: { bg: '#FEF3C7', txt: '#92400E', dkBg: 'rgba(217,119,6,.18)',   dkTxt: '#FBBF24' },
  New:  { bg: '#DBEAFE', txt: '#1E40AF', dkBg: 'rgba(37,99,235,.18)',   dkTxt: '#93C5FD' },
  Won:  { bg: '#DCFCE7', txt: '#14532D', dkBg: 'rgba(22,163,74,.18)',   dkTxt: '#86EFAC' },
  Lost: { bg: '#F3F4F6', txt: '#6B7280', dkBg: 'rgba(75,85,99,.18)',    dkTxt: '#9CA3AF' },
  Open:     { bg: '#DBEAFE', txt: '#1E40AF', dkBg: 'rgba(37,99,235,.18)',  dkTxt: '#93C5FD' },
  Resolved: { bg: '#DCFCE7', txt: '#14532D', dkBg: 'rgba(22,163,74,.18)', dkTxt: '#86EFAC' },
  Closed:   { bg: '#F3F4F6', txt: '#6B7280', dkBg: 'rgba(75,85,99,.18)',  dkTxt: '#9CA3AF' },
  Pending:  { bg: '#FEF3C7', txt: '#92400E', dkBg: 'rgba(217,119,6,.18)', dkTxt: '#FBBF24' },
  Active:   { bg: '#DCFCE7', txt: '#14532D', dkBg: 'rgba(22,163,74,.18)', dkTxt: '#86EFAC' },
  Declined: { bg: '#FEE2E2', txt: '#991B1B', dkBg: 'rgba(192,0,0,.18)',   dkTxt: '#FF7070' },
}
