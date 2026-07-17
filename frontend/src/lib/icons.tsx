// Icon library — Lucide React (matches Phoenix OS portal icon set)
// All exports keep their existing names so callers need no changes.

import {
  // Utility / UI
  Search,
  Moon,
  Sun,
  Bell,
  X,
  Calendar,
  SlidersHorizontal,
  ClipboardCheck,

  // Nav — Sales & BD
  LayoutDashboard,
  Handshake,
  Mail,
  Megaphone,
  TrendingUp,
  Users,

  // Nav — Contact Centre
  PhoneCall,
  Headphones,

  // Nav — Cards
  CreditCard,

  // Nav — Credit Management
  ShieldAlert,
  Coins,
  Scale,

  // Nav — Finance
  Landmark,
  ArrowRightLeft,

  // Nav — Compliance
  ShieldCheck,

  // Nav — People
  BadgeCheck,
  Banknote,

  // Nav — Analytics
  BarChart3,
  Receipt,

  // Nav — Admin & Core Banking
  Settings2,
  Building2,
} from 'lucide-react'

import type { LucideIcon } from 'lucide-react'

// ── Utility exports (used across components) ──────────────────────────────────
export const IcoSearch   = Search
export const IcoMoon     = Moon
export const IcoSun      = Sun
export const IcoBell     = Bell
export const IcoClose    = X
export const IcoCalendar = Calendar
export const IcoTune     = SlidersHorizontal
export const IcoApprove  = ClipboardCheck

// ── Nav icon exports (consumed via NAV_ICONS or directly) ─────────────────────
export const IcoDashboard = LayoutDashboard
export const IcoBriefcase = Handshake       // Business Dev
export const IcoMail      = Mail
export const IcoMegaphone = Megaphone
export const IcoTrendUp   = TrendingUp
export const IcoCRM       = Users
export const IcoPhone     = PhoneCall
export const IcoHeadset   = Headphones      // Customer Service
export const IcoCard      = CreditCard
export const IcoShield    = ShieldAlert     // Risk  (! badge — distinct from Compliance)
export const IcoCol       = Coins           // Collections
export const IcoRec       = Scale           // Recovery (legal scale)
export const IcoBank      = Landmark        // Finance
export const IcoArrows    = ArrowRightLeft  // Settlements
export const IcoVerified  = ShieldCheck     // Compliance (tick — distinct from Risk)
export const IcoBadge     = BadgeCheck      // HR
export const IcoPayment   = Banknote        // Payroll
export const IcoBI        = BarChart3       // Reports & BI
export const IcoReceipt   = Receipt         // Statements
export const IcoSettings  = Settings2       // Admin
export const IcoLoan      = Banknote        // (WorkspaceDemo compat)

// ── NAV_ICONS — Material Symbols key → Lucide component ──────────────────────
// Sidebar checks this map first; falls back to <span class="material-symbols-rounded">
// if a key is missing. Keep keys in sync with SECTIONS in Sidebar.tsx.
export const NAV_ICONS: Record<string, LucideIcon> = {
  // Root
  space_dashboard:      LayoutDashboard,

  // Sales & BD
  corporate_fare:       Handshake,
  mark_email_read:      Mail,
  campaign:             Megaphone,
  trending_up:          TrendingUp,
  contacts:             Users,

  // Contact Centre
  call:                 PhoneCall,
  support_agent:        Headphones,

  // Cards
  credit_card:          CreditCard,

  // Credit Management
  shield:               ShieldAlert,     // Risk  — warning shield
  collections_bookmark: Coins,           // Collections
  gavel:                Scale,           // Recovery — legal scale

  // Finance
  account_balance:      Landmark,        // Finance
  compare_arrows:       ArrowRightLeft,  // Settlements

  // Compliance
  verified_user:        ShieldCheck,     // Compliance — tick shield

  // People
  badge:                BadgeCheck,      // HR
  payments:             Banknote,        // Payroll

  // Analytics
  analytics:            BarChart3,
  receipt_long:         Receipt,

  // Admin & Core Banking (separate keys — distinct icons)
  admin_panel_settings: Settings2,
  core_banking:         Building2,       // Core Banking — different from Finance
}
