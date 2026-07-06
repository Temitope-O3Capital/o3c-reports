// Thin-stroke SVG icon library — 2px stroke, fill:none, stroke:currentColor
// Matches WorkspaceDemo.tsx visual style exactly.

import type React from 'react'

type SvgProps = React.SVGProps<SVGSVGElement>
const b: SvgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }

// ── From demo (exact copies) ──────────────────────────────────────────────────
export const IcoSearch   = (p: SvgProps) => <svg {...b} {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
export const IcoLoan     = (p: SvgProps) => <svg {...b} {...p}><path d="M12 2v20M2 12h20"/></svg>
export const IcoCol      = (p: SvgProps) => <svg {...b} {...p}><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>
export const IcoRec      = (p: SvgProps) => <svg {...b} {...p}><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v6h6"/></svg>
export const IcoCard     = (p: SvgProps) => <svg {...b} {...p}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>
export const IcoCRM      = (p: SvgProps) => <svg {...b} {...p}><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/></svg>
export const IcoMail     = (p: SvgProps) => <svg {...b} {...p}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>
export const IcoBI       = (p: SvgProps) => <svg {...b} {...p}><rect x="3" y="12" width="4" height="9"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="3" width="4" height="18"/></svg>
export const IcoMoon     = (p: SvgProps) => <svg {...b} {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
export const IcoSun      = (p: SvgProps) => <svg {...b} {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
export const IcoApprove  = (p: SvgProps) => <svg {...b} {...p}><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>
export const IcoBell     = (p: SvgProps) => <svg {...b} {...p}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
export const IcoCalendar = (p: SvgProps) => <svg {...b} {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
export const IcoClose    = (p: SvgProps) => <svg {...b} {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>
export const IcoTune     = (p: SvgProps) => <svg {...b} {...p}><path d="M4 6h16M8 12h8M11 18h2"/></svg>

// ── Extended nav icons ────────────────────────────────────────────────────────
export const IcoDashboard  = (p: SvgProps) => <svg {...b} {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
export const IcoBriefcase  = (p: SvgProps) => <svg {...b} {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>
export const IcoMegaphone  = (p: SvgProps) => <svg {...b} {...p}><path d="M11 5H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h5l6 3V2l-6 3z"/></svg>
export const IcoTrendUp    = (p: SvgProps) => <svg {...b} {...p}><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>
export const IcoPhone      = (p: SvgProps) => <svg {...b} {...p}><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 12 19.8 19.8 0 0 1 1 3.35 2 2 0 0 1 2.87 1.2h3a2 2 0 0 1 2 1.72c.127.96.361 1.9.7 2.81a2 2 0 0 1-.45 2.11L6.91 9a16 16 0 0 0 6.19 6.19l1.07-1.07a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.9z"/></svg>
export const IcoHeadset    = (p: SvgProps) => <svg {...b} {...p}><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>
export const IcoShield     = (p: SvgProps) => <svg {...b} {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
export const IcoVerified   = (p: SvgProps) => <svg {...b} {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
export const IcoBank       = (p: SvgProps) => <svg {...b} {...p}><path d="M3 21h18M3 10h18M5 21V10m14 11V10M12 2l-9 8h18z"/></svg>
export const IcoArrows     = (p: SvgProps) => <svg {...b} {...p}><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>
export const IcoBadge      = (p: SvgProps) => <svg {...b} {...p}><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14l-8-3-8 3V5z"/><circle cx="12" cy="10" r="2.5"/></svg>
export const IcoPayment    = (p: SvgProps) => <svg {...b} {...p}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M12 11v2M8 12h8"/></svg>
export const IcoReceipt    = (p: SvgProps) => <svg {...b} {...p}><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M8 10h8M8 14h6"/></svg>
export const IcoSettings   = (p: SvgProps) => <svg {...b} {...p}><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>

// ── Material Symbols name → SVG icon (for nav items) ─────────────────────────
export const NAV_ICONS: Record<string, (p: SvgProps) => React.ReactElement> = {
  space_dashboard:      IcoDashboard,
  corporate_fare:       IcoBriefcase,
  mark_email_read:      IcoMail,
  campaign:             IcoMegaphone,
  trending_up:          IcoTrendUp,
  contacts:             IcoCRM,
  call:                 IcoPhone,
  support_agent:        IcoHeadset,
  credit_card:          IcoCard,
  shield:               IcoShield,
  collections_bookmark: IcoCol,
  gavel:                IcoRec,
  account_balance:      IcoBank,
  compare_arrows:       IcoArrows,
  verified_user:        IcoVerified,
  badge:                IcoBadge,
  payments:             IcoPayment,
  analytics:            IcoBI,
  receipt_long:         IcoReceipt,
  admin_panel_settings: IcoSettings,
}
