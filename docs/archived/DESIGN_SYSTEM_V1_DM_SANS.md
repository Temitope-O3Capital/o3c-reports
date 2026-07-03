# O3C Cards Internal Operating Platform — Design System

**Version 1.0 | June 2026 | Staff-facing internal tool**

---

## TABLE OF CONTENTS

1. Tailwind Config Extension
2. Navigation Architecture (per role)
3. Core Component Library Spec
4. Page Template Layouts
5. Table Design Patterns
6. Color Coding System
7. Notification & Alert Design
8. Dark Mode Decision
9. Accessibility Spec
10. Animation & Transitions
11. Typography Usage Guide
12. Key Design Decisions

---

## 1. TAILWIND CONFIG EXTENSION

```typescript
// tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {

      // ─── COLORS ────────────────────────────────────────────────
      colors: {
        // Brand
        navy: {
          50:  '#E8EDF3',
          100: '#C5D1DE',
          200: '#9EB2C6',
          300: '#7793AE',
          400: '#577A9B',
          500: '#376288',
          600: '#2A5179',
          700: '#1D3E63',
          800: '#122E4E',
          900: '#0E2841', // ← primary navy
          950: '#091A2B',
        },
        brand: {
          red:    '#C00000',
          'red-hover': '#A30000',
          'red-light': '#FEE2E2',
        },

        // Semantic — surfaces & text
        canvas:   '#F4F6F8',
        surface:  '#FFFFFF',
        'surface-raised': '#FFFFFF',

        // Semantic — status
        success: {
          50:  '#F0FDF4',
          100: '#DCFCE7',
          200: '#BBF7D0',
          500: '#22C55E',
          600: '#16A34A',
          700: '#166534', // ← brand green
          800: '#14532D',
        },
        warning: {
          50:  '#FFFBEB',
          100: '#FEF3C7',
          200: '#FDE68A',
          400: '#FBBF24',
          500: '#F59E0B', // ← brand amber
          600: '#D97706',
          700: '#B45309',
        },
        danger: {
          50:  '#FFF1F2',
          100: '#FFE4E6',
          200: '#FECDD3',
          500: '#EF4444',
          600: '#DC2626',
          700: '#C00000', // ← brand red
          800: '#991B1B',
        },
        info: {
          50:  '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          500: '#3B82F6',
          600: '#2563EB',
          700: '#1D4ED8',
        },

        // DPD buckets (used in loan status)
        dpd: {
          current:   '#166534', // 0 DPD — green-700
          early:     '#D97706', // 1–29 — amber-600
          mild:      '#EA580C', // 30–59 — orange-600
          moderate:  '#DC2626', // 60–89 — red-600
          npl:       '#991B1B', // 90+ — red-800
          'written-off': '#374151', // grey-700
        },

        // Application stage palette
        stage: {
          draft:       '#6B7280', // grey
          submitted:   '#2563EB', // blue
          docs:        '#7C3AED', // violet
          risk:        '#0891B2', // cyan
          riskhead:    '#0E7490', // cyan dark
          conditions:  '#D97706', // amber
          finance:     '#059669', // emerald
          booking:     '#166534', // green
          active:      '#15803D', // green-700
          declined:    '#991B1B', // red
          withdrawn:   '#6B7280', // grey
          expired:     '#9CA3AF', // grey-400
        },

        // Reconciliation
        recon: {
          matched:    '#166534',
          unmatched:  '#C00000',
          partial:    '#D97706',
          pending:    '#6B7280',
          exception:  '#7C3AED',
        },
      },

      // ─── TYPOGRAPHY ────────────────────────────────────────────
      fontFamily: {
        sans:  ['DM Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono:  ['DM Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // Display (dashboard headlines)
        'display-lg': ['2.25rem',  { lineHeight: '2.5rem',  fontWeight: '600' }], // 36px
        'display-md': ['1.875rem', { lineHeight: '2.25rem', fontWeight: '600' }], // 30px
        'display-sm': ['1.5rem',   { lineHeight: '2rem',    fontWeight: '600' }], // 24px

        // Headings
        'heading-xl': ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }], // 20px — page titles
        'heading-lg': ['1.125rem',{ lineHeight: '1.75rem', fontWeight: '600' }], // 18px — section headers
        'heading-md': ['1rem',    { lineHeight: '1.5rem',  fontWeight: '600' }], // 16px — card headers
        'heading-sm': ['0.875rem',{ lineHeight: '1.25rem', fontWeight: '600' }], // 14px — subsections

        // Body
        'body-lg': ['1rem',    { lineHeight: '1.5rem',  fontWeight: '400' }], // 16px
        'body-md': ['0.875rem',{ lineHeight: '1.25rem', fontWeight: '400' }], // 14px — default
        'body-sm': ['0.75rem', { lineHeight: '1rem',    fontWeight: '400' }], // 12px — supporting text

        // Labels & UI
        'label-md': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '500' }], // 14px
        'label-sm': ['0.75rem',  { lineHeight: '1rem',    fontWeight: '500' }], // 12px
        'label-xs': ['0.6875rem',{ lineHeight: '1rem',    fontWeight: '500' }], // 11px — table column headers

        // Numeric (always DM Mono)
        'num-lg': ['1.125rem', { lineHeight: '1.75rem', fontWeight: '500' }], // 18px — KPI values
        'num-md': ['0.875rem', { lineHeight: '1.25rem', fontWeight: '400' }], // 14px — table amounts
        'num-sm': ['0.75rem',  { lineHeight: '1rem',    fontWeight: '400' }], // 12px — small amounts
      },

      // ─── SPACING (8pt grid) ────────────────────────────────────
      spacing: {
        // Tailwind's default spacing is already 4px-based.
        // We extend with named semantic tokens:
        'page-x':  '1.5rem',   // 24px — page horizontal padding
        'page-y':  '1.5rem',   // 24px — page vertical padding
        'card':    '1.5rem',   // 24px — card inner padding
        'card-sm': '1rem',     // 16px — compact card padding
        'section': '2rem',     // 32px — section gap
        'form-gap':'1rem',     // 16px — form field gap
      },

      // ─── BORDER RADIUS ─────────────────────────────────────────
      borderRadius: {
        'none': '0',
        'sm':   '0.25rem',  // 4px  — badges, small chips
        'md':   '0.375rem', // 6px  — inputs, buttons
        'lg':   '0.5rem',   // 8px  — cards
        'xl':   '0.75rem',  // 12px — modals, drawers
        '2xl':  '1rem',     // 16px — large panels
        'full': '9999px',   // pills
      },

      // ─── SHADOWS ───────────────────────────────────────────────
      boxShadow: {
        'sm':    '0 1px 2px 0 rgb(14 40 65 / 0.05)',
        'md':    '0 4px 6px -1px rgb(14 40 65 / 0.08), 0 2px 4px -2px rgb(14 40 65 / 0.05)',
        'lg':    '0 10px 15px -3px rgb(14 40 65 / 0.08), 0 4px 6px -4px rgb(14 40 65 / 0.05)',
        'xl':    '0 20px 25px -5px rgb(14 40 65 / 0.10), 0 8px 10px -6px rgb(14 40 65 / 0.05)',
        'inner': 'inset 0 2px 4px 0 rgb(14 40 65 / 0.06)',
        'none':  'none',
        // Sidebar shadow (right edge)
        'sidebar': '4px 0 16px -2px rgb(14 40 65 / 0.12)',
        // Card hover lift
        'card-hover': '0 8px 20px -4px rgb(14 40 65 / 0.12)',
        // Focus ring (accessibility)
        'focus':    '0 0 0 3px rgb(192 0 0 / 0.25)',
        'focus-sm': '0 0 0 2px rgb(192 0 0 / 0.30)',
      },

      // ─── Z-INDEX ───────────────────────────────────────────────
      zIndex: {
        'sidebar':   '40',
        'topbar':    '50',
        'dropdown':  '100',
        'drawer':    '200',
        'modal':     '300',
        'toast':     '400',
        'tooltip':   '500',
      },
    },
  },
  plugins: [],
}

export default config
```

---

## 2. NAVIGATION ARCHITECTURE

### 2.1 Sidebar Design Spec

**Structure:** Fixed left sidebar, 240px expanded / 64px collapsed (icon-only). Collapsible via toggle button at bottom. State persisted in localStorage.

**Anatomy:**
```
┌─────────────────────┐
│ [Logo] O3C Cards    │  ← 64px header, navy-900 bg
├─────────────────────┤
│ ▾ LENDING           │  ← Section label (label-xs, navy-400, uppercase)
│   📋 Applications   │  ← Nav item
│   👥 Customers      │
├─────────────────────┤
│ ▾ OPERATIONS        │
│   💳 Cards Ops      │
│   📊 Collections    │
│   ⚖️  Recovery       │
├─────────────────────┤
│ (scrollable)        │
│                     │
├─────────────────────┤
│ [collapse toggle]   │  ← bottom, always visible
│ [user avatar]       │  ← current user chip
└─────────────────────┘
```

**Tailwind classes — sidebar container:**
```
w-60 shrink-0 bg-navy-900 flex flex-col h-screen sticky top-0
shadow-sidebar transition-all duration-200
```

**Collapsed state:** `w-16` — hide labels, show only icons, show section dividers not labels.

**Nav item — default:**
```
flex items-center gap-3 px-3 py-2 mx-2 rounded-md
text-body-md text-navy-200
hover:bg-navy-800 hover:text-white
transition-colors duration-150 cursor-pointer
```

**Nav item — active:**
```
bg-navy-700 text-white font-medium
border-l-2 border-brand-red
```

**Nav section label:**
```
px-5 pt-5 pb-1 text-label-xs text-navy-400 uppercase tracking-widest
```

**Collapsed icon tooltip:** Show label in a tooltip (role="tooltip") on hover, positioned to the right.

---

### 2.2 Role-Based Navigation

Each role sees only the modules relevant to their work. Nav items marked `[H]` appear only for Head/manager roles.

---

#### MD (Managing Director) — Full access

```
LENDING
  📋 Applications
  👥 Customers
  📈 Credit Bureau

OPERATIONS
  💳 Cards Ops
  📞 Collections
  ⚖️  Recovery
  🏦 Finance

ANALYTICS
  📊 KPI Dashboard
  📉 Portfolio Analytics
  🗂️  Reports

PEOPLE & COMPLIANCE
  👔 HR
  🛡️  Compliance
  🔍 Internal Control
  📋 Audit Trail

INTEGRATIONS
  💰 Paystack
  🔗 Interswitch

SETTINGS
  ⚙️  System Settings
  👤 User Management
  🔔 Notifications
```

---

#### Sales Officer — Lending only

```
LENDING
  📋 Applications          ← their own + new application form
  👥 Customers             ← search + view only (no edit)
  📊 My Performance        ← personal KPIs only

SUPPORT
  🔔 Notifications
  ❓ Help
```

---

#### Collections Agent — Collections queue only

```
MY WORK
  📥 My Queue              ← DPD cases assigned to them
  📞 Call Log              ← their call activity
  👥 Customer Lookup       ← read-only customer 360

COLLECTIONS
  📅 Payment Posting       ← post payments received
  📊 My Performance

SUPPORT
  🔔 Notifications
  ❓ Help
```

---

#### Risk Officer — Review queue + application detail

```
RISK
  📥 Review Queue          ← applications pending risk review
  📋 Applications          ← all applications (read-only browse)
  👥 Customers             ← read-only
  📈 Credit Bureau         ← view bureau data on applicants

ANALYTICS
  📊 Risk Dashboard        ← portfolio risk view

SUPPORT
  🔔 Notifications
  ❓ Help
```

*(Risk Head adds: Risk Policy Config, Approval Authority Matrix, Team Dashboard)*

---

#### Finance Officer — Disbursements + reconciliation

```
FINANCE
  💸 Disbursements         ← pending + approve
  🔄 Reconciliation        ← matching, exceptions
  📒 GL Journal            ← view GL entries
  🧾 Transactions          ← transaction log

REPORTS
  📊 Finance Dashboard
  📄 Finance Reports

SUPPORT
  🔔 Notifications
  ❓ Help
```

*(CFO adds: Budget vs Actual, Approval Authority, all Finance sub-pages)*

---

#### Compliance Officer — Audit + CBN reports

```
COMPLIANCE
  🛡️  Compliance Dashboard
  📋 Audit Trail           ← full system audit log
  📑 CBN Returns           ← generate + submit
  📄 SARs                  ← suspicious activity reports
  ⚖️  Regulatory Calendar

INTERNAL CONTROL
  🔍 Control Assessments
  🚨 Exceptions Log
  📊 IC Dashboard

SUPPORT
  🔔 Notifications
  ❓ Help
```

---

### 2.3 Breadcrumbs

**Pattern:** Shown in TopBar below the page title. Max 4 levels before truncation.

```
Home > Collections > My Queue > Customer: Adebayo Okonkwo
```

**Tailwind classes:**
```
flex items-center gap-1 text-body-sm text-gray-500
```
Separator: `<span class="text-gray-300 mx-1">/</span>`
Current page (last item): `text-navy-900 font-medium` — not a link.
Ancestor items: `text-gray-500 hover:text-navy-700 cursor-pointer underline-offset-2 hover:underline`

---

### 2.4 TopBar

**Height:** 56px. Sticky top, `z-topbar`.

```
┌────────────────────────────────────────────────────────────────────┐
│  [Page Title + Breadcrumb]              [🔍 Search]  [🔔3] [Avatar]│
└────────────────────────────────────────────────────────────────────┘
```

**Tailwind:**
```
h-14 bg-white border-b border-gray-200 flex items-center
px-6 gap-4 sticky top-0 z-topbar
```

**Search:** Global search bar (Cmd+K shortcut). Searches customers, applications, case numbers.

**Notification bell:** Icon button with unread count badge (brand-red pill).

**Avatar:** 32px circle, initials fallback. Click opens profile dropdown (My Profile, Change Password, Sign Out).

---

### 2.5 Tablet Navigation (iPad)

Below 1024px: Sidebar collapses to icon-only (64px) by default. Hamburger in TopBar opens a temporary overlay drawer (full sidebar, 280px, closes on backdrop tap).

---

## 3. CORE COMPONENT LIBRARY SPEC

### 3.1 Layout Components

---

#### PageShell

```tsx
// Props
interface PageShellProps {
  sidebar: React.ReactNode
  topbar: React.ReactNode
  children: React.ReactNode
}
```

**Layout:**
```
flex h-screen overflow-hidden bg-canvas
├── Sidebar (sticky, full height)
└── flex-1 flex flex-col min-w-0 overflow-hidden
    ├── TopBar (sticky top-0 z-topbar)
    └── main (flex-1 overflow-y-auto p-6)
```

**CSS:**
```
// Outer shell
className="flex h-screen overflow-hidden bg-canvas"

// Content area
className="flex-1 flex flex-col min-w-0 overflow-hidden"

// Scrollable main
className="flex-1 overflow-y-auto p-6 space-y-6"
```

---

#### Card

```tsx
interface CardProps {
  variant?: 'default' | 'elevated' | 'bordered' | 'colored-header'
  headerColor?: 'navy' | 'success' | 'warning' | 'danger'
  title?: string
  subtitle?: string
  actions?: React.ReactNode   // top-right of card header
  padding?: 'default' | 'compact' | 'none'
  children: React.ReactNode
}
```

**Variants:**

| Variant | Classes |
|---|---|
| default | `bg-white rounded-lg shadow-sm border border-gray-100` |
| elevated | `bg-white rounded-lg shadow-md` |
| bordered | `bg-white rounded-lg border-2 border-gray-200` |
| colored-header | Card with colored top strip (4px) |

**Card header:**
```
flex items-center justify-between px-6 py-4 border-b border-gray-100
```

**Card body:**
```
px-6 py-4        // default padding
px-4 py-3        // compact
p-0              // none (when table fills card)
```

**Colored header variant** — adds top border:
```
border-t-4 border-t-navy-900    // navy header
border-t-4 border-t-success-700 // green
border-t-4 border-t-warning-500 // amber
border-t-4 border-t-danger-700  // red
```

---

### 3.2 Data Display

---

#### DataTable

```tsx
interface DataTableProps<T> {
  columns: ColumnDef<T>[]
  data: T[]
  loading?: boolean
  error?: string
  emptyMessage?: string
  selectable?: boolean          // row checkboxes
  onSelectionChange?: (rows: T[]) => void
  pagination?: PaginationConfig
  onSort?: (key: string, dir: 'asc' | 'desc') => void
  stickyHeader?: boolean
  stickyFirstColumn?: boolean
  expandable?: boolean
  renderExpanded?: (row: T) => React.ReactNode
}

interface ColumnDef<T> {
  key: string
  header: string
  width?: string               // e.g. 'w-32', 'min-w-[200px]'
  align?: 'left' | 'right' | 'center'
  numeric?: boolean            // right-align, DM Mono font
  currency?: boolean           // ₦ prefix, DM Mono, right-align
  sortable?: boolean
  render?: (value: unknown, row: T) => React.ReactNode
}
```

**Table container:**
```
w-full overflow-x-auto
```

**Table element:**
```
w-full border-collapse text-body-md
```

**Column header:**
```
px-4 py-3 text-left text-label-xs text-gray-500 uppercase tracking-wider
bg-gray-50 border-b border-gray-200 font-medium whitespace-nowrap
```

Numeric column header: add `text-right`

Sort indicators: `↑` (ascending) `↓` (descending) `↕` (unsorted, shown on hover) — inline SVG icons, 12px.

**Table row:**
```
// Default
border-b border-gray-100 hover:bg-blue-50/30 transition-colors duration-100

// Selected
bg-blue-50 border-l-2 border-l-info-600

// Loading skeleton
animate-pulse bg-gray-50

// Error row (e.g. reconciliation exception)
bg-danger-50 border-l-2 border-l-danger-600
```

**Table cell:**
```
px-4 py-3 text-body-md text-gray-900 whitespace-nowrap
```

Numeric cell: `text-right font-mono tabular-nums`

Currency cell: `text-right font-mono tabular-nums` — value rendered as `₦1,234,567`

**Loading skeleton (per row):**
```tsx
// 8 skeleton rows, each cell is a rounded bar
<div className="h-4 bg-gray-200 rounded animate-pulse" />
```

**Empty state (inside table):**
```
// Centered cell spanning all columns
<td colSpan={n}>
  <div className="flex flex-col items-center justify-center py-16 text-gray-400">
    <Icon className="w-10 h-10 mb-3 opacity-40" />
    <p className="text-body-md font-medium">No records found</p>
    <p className="text-body-sm mt-1">Try adjusting your filters</p>
  </div>
</td>
```

**Pagination:**
```
flex items-center justify-between px-4 py-3 border-t border-gray-200
```
Left: `Showing 1–25 of 342 results` — `text-body-sm text-gray-500`
Right: Prev / Next buttons + page number input

**Sticky first column:**
```
// First th/td
sticky left-0 bg-white z-10 after:absolute after:right-0 after:top-0
after:bottom-0 after:w-px after:bg-gray-200
```

**Expandable rows:** Chevron icon in first column. Expanded content renders in a `<tr>` below with `<td colSpan={n} className="bg-gray-50 px-6 py-4">`.

---

#### KpiCard

```tsx
interface KpiCardProps {
  label: string
  value: string | number
  currency?: boolean           // prefix ₦
  trend?: {
    value: number              // percentage change
    direction: 'up' | 'down'
    isGood?: boolean           // up might be bad (e.g. NPL rate)
  }
  period?: string              // e.g. "vs last month"
  status?: 'good' | 'warning' | 'bad' | 'neutral'
  sparkline?: number[]         // 7-point array for mini chart
  loading?: boolean
}
```

**Status color mapping:**

| Status | Background | Value color | Border |
|---|---|---|---|
| good | `bg-success-50` | `text-success-700` | `border-success-200` |
| warning | `bg-warning-50` | `text-warning-700` | `border-warning-200` |
| bad | `bg-danger-50` | `text-danger-700` | `border-danger-200` |
| neutral | `bg-white` | `text-navy-900` | `border-gray-100` |

**Structure:**
```
┌──────────────────────────────┐
│ Label                 [spark]│
│ ₦ 12,450,000                │
│ ↑ 8.2%  vs last month       │
└──────────────────────────────┘
```

**Tailwind:**
```
bg-white rounded-lg border p-5 flex flex-col gap-2
// value
text-display-sm font-semibold font-mono tabular-nums
// trend up-good
text-success-600 text-body-sm flex items-center gap-1
// trend up-bad (NPL)
text-danger-600 text-body-sm flex items-center gap-1
```

---

#### StatusBadge

```tsx
interface StatusBadgeProps {
  status: string
  type: 'dpd' | 'application' | 'kyc' | 'card' | 'recon' | 'generic'
  size?: 'sm' | 'md'
}
```

**Base classes:**
```
inline-flex items-center rounded-full font-medium
// sm
px-2 py-0.5 text-label-xs
// md
px-2.5 py-1 text-label-sm
```

**DPD badge colors:**
```
Current (0):     bg-success-100 text-success-700
1–29 DPD:        bg-warning-100 text-warning-700
30–59 DPD:       bg-orange-100 text-orange-700
60–89 DPD:       bg-danger-100 text-danger-700
90+ DPD (NPL):   bg-danger-200 text-danger-800 font-semibold
Written Off:     bg-gray-200 text-gray-600
```

**Application stage colors:**
```
Draft:           bg-gray-100 text-gray-600
Submitted:       bg-info-100 text-info-700
Doc Collection:  bg-violet-100 text-violet-700
Risk Review:     bg-cyan-100 text-cyan-700
Risk Head:       bg-cyan-200 text-cyan-800
Conditions:      bg-warning-100 text-warning-700
Finance Approval:bg-emerald-100 text-emerald-700
Booking:         bg-success-100 text-success-700
Active:          bg-success-200 text-success-800 font-semibold
Declined:        bg-danger-100 text-danger-700
Withdrawn:       bg-gray-100 text-gray-500
Expired:         bg-gray-100 text-gray-400
```

**KYC status:**
```
Verified:        bg-success-100 text-success-700
Pending:         bg-warning-100 text-warning-700
Failed:          bg-danger-100 text-danger-700
Not Started:     bg-gray-100 text-gray-500
```

---

#### ActivityTimeline

```tsx
interface ActivityTimelineProps {
  events: TimelineEvent[]
  maxHeight?: string    // CSS value, enables scroll
}

interface TimelineEvent {
  id: string
  actor: string         // "Chidi Okonkwo (Risk Officer)"
  action: string        // "Approved application"
  detail?: string       // optional extra detail
  timestamp: Date
  type: 'approval' | 'rejection' | 'note' | 'document' | 'status' | 'payment' | 'system'
  metadata?: Record<string, string>
}
```

**Visual structure:**
```
●──────────────────────────────────
│  [icon] Chidi Okonkwo            ← actor, font-medium
│         Approved application     ← action, text-gray-700
│         "Strong repayment hist." ← detail, italic text-gray-500
│         16 Jun 2026 · 14:32      ← timestamp, text-body-sm text-gray-400
│
●──────────────────────────────────
```

**Connector line:** `border-l-2 border-gray-200 ml-3 pl-4`

**Icon by type:**
```
approval:   CheckCircle  — text-success-600
rejection:  XCircle      — text-danger-600
note:       MessageSquare— text-info-600
document:   FileText     — text-violet-600
status:     ArrowRight   — text-gray-500
payment:    Banknote     — text-success-700
system:     Zap          — text-gray-400
```

---

#### KPI Sparkline

Thin, 60×24px inline SVG line chart. No axes, no labels. Renders last 7 data points.

```tsx
interface SparklineProps {
  data: number[]       // 7 values
  color?: string       // tailwind arbitrary: '#166534'
  trend?: 'up' | 'down' | 'flat'
}
```

Implementation: small `<svg>` with a `<polyline>` using viewBox="0 0 60 24". Stroke only, no fill. Stroke width 1.5px.

---

#### ProgressBar

```tsx
interface ProgressBarProps {
  value: number         // 0–100
  max?: number
  label?: string
  showPercent?: boolean
  size?: 'sm' | 'md' | 'lg'
  color?: 'success' | 'warning' | 'danger' | 'info' | 'navy'
}
```

**Heights:** sm=`h-1.5`, md=`h-2.5`, lg=`h-4`

**Track:** `bg-gray-100 rounded-full overflow-hidden`
**Fill:** `h-full rounded-full transition-all duration-500`

Color classes for fill:
```
success: bg-success-600
warning: bg-warning-500
danger:  bg-danger-600
info:    bg-info-600
navy:    bg-navy-700
```

---

### 3.3 Form Components

---

#### Input

```tsx
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string
  prefix?: React.ReactNode     // icon or text (₦, +234)
  suffix?: React.ReactNode
  size?: 'sm' | 'md'
  loading?: boolean
}
```

**Base input classes:**
```
w-full rounded-md border border-gray-300 bg-white text-body-md text-gray-900
px-3 py-2 placeholder:text-gray-400
focus:outline-none focus:ring-2 focus:ring-brand-red/25 focus:border-brand-red
disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed
transition-colors duration-150
```

**Error state:** replace border class with `border-danger-500 focus:ring-danger-500/25 focus:border-danger-500`

**With prefix (₦ or +234):**
```
// Container
relative flex items-stretch
// Prefix box
flex items-center px-3 border border-r-0 border-gray-300 rounded-l-md
bg-gray-50 text-gray-500 text-body-md
// Input
rounded-l-none
```

**Label:**
```
block text-label-md text-gray-700 mb-1
```

**Error message:**
```
text-body-sm text-danger-600 mt-1 flex items-center gap-1
```

**Hint:**
```
text-body-sm text-gray-500 mt-1
```

---

#### CurrencyInput

Formats value as `₦1,234,567` as user types. Stores in kobo (integer × 100) internally.

```tsx
interface CurrencyInputProps {
  label?: string
  value: number          // stored in kobo
  onChange: (kobo: number) => void
  min?: number           // in kobo
  max?: number           // in kobo
  error?: string
  hint?: string
  disabled?: boolean
}
```

**Behavior:**
- Display value = `(kobo / 100).toLocaleString('en-NG')` with `₦` prefix
- On change: strip `₦`, commas → parse float → multiply by 100 → store as integer
- Shows: `₦ 1,250,000` (formatted)
- Min/max validation shown inline

**Display format:** `₦1,250,000` — no decimals for whole naira amounts; show `.50` only if half-kobo (rare).

---

#### Select / Combobox

```tsx
interface SelectProps {
  label?: string
  options: { value: string; label: string; disabled?: boolean }[]
  value?: string
  onChange: (value: string) => void
  searchable?: boolean        // combobox mode: filters options
  placeholder?: string
  error?: string
  loading?: boolean
  creatable?: boolean         // allow new values (tag input)
}
```

**Trigger button classes (same height as Input):**
```
w-full flex items-center justify-between
rounded-md border border-gray-300 bg-white px-3 py-2
text-body-md text-gray-900 text-left
focus:outline-none focus:ring-2 focus:ring-brand-red/25 focus:border-brand-red
```

**Dropdown panel:**
```
absolute z-dropdown mt-1 w-full bg-white rounded-lg border border-gray-200
shadow-lg max-h-60 overflow-auto
```

**Option item:**
```
px-3 py-2 text-body-md cursor-pointer
hover:bg-gray-50
// selected
bg-navy-50 text-navy-900 font-medium
// disabled
text-gray-300 cursor-not-allowed
```

**Searchable mode:** text input at top of dropdown with search icon. Filters options in real-time.

---

#### MultiSelect

Renders selected items as removable chips inside the input. Same dropdown as Select.

**Chip:**
```
inline-flex items-center gap-1 bg-navy-100 text-navy-800
text-label-sm px-2 py-0.5 rounded-full
```

Remove `×` button: `text-navy-500 hover:text-navy-900 hover:bg-navy-200 rounded-full p-0.5`

---

#### FileUpload

```tsx
interface FileUploadProps {
  label?: string
  accept?: string              // e.g. ".pdf,.jpg,.png"
  multiple?: boolean
  maxSizeMB?: number
  value?: UploadedFile[]
  onChange: (files: UploadedFile[]) => void
  onUpload?: (file: File) => Promise<string>  // returns URL
  error?: string
}
```

**Drop zone:**
```
border-2 border-dashed border-gray-300 rounded-lg p-8
flex flex-col items-center justify-center text-center
hover:border-navy-400 hover:bg-gray-50
drag-active: border-navy-600 bg-navy-50
transition-colors duration-150
```

**Progress bar:** renders below drop zone per file during upload. Thin `h-1` bar, navy fill.

**Preview thumbnail grid (images):** 80×80px thumbnails with overlay showing filename and delete button.

**PDF preview:** Document icon + filename chip.

---

#### StepperProgress

```tsx
interface StepperProgressProps {
  steps: { label: string; description?: string }[]
  currentStep: number     // 0-indexed
  completedSteps?: number[]
}
```

**Visual (horizontal for LOS form):**
```
●━━━━━●━━━━━●━━━━━●━━━━━●
1      2      3      4      5
Done  Done  Active  Todo   Todo
```

**Completed step:** `bg-success-600 text-white` circle + `bg-success-600` connector
**Active step:** `bg-navy-900 text-white ring-4 ring-navy-200` circle
**Todo step:** `bg-white border-2 border-gray-300 text-gray-400` circle
**Connector line:** `h-0.5 flex-1`, completed=`bg-success-600`, todo=`bg-gray-200`

**Label below circle:** `text-label-sm`, active=`text-navy-900 font-medium`, others=`text-gray-500`

---

### 3.4 Navigation Components

---

#### Tabs

```tsx
interface TabsProps {
  tabs: { id: string; label: string; count?: number; icon?: React.ReactNode }[]
  activeTab: string
  onChange: (id: string) => void
  variant?: 'underline' | 'pill'
}
```

**Underline variant (default — used in Customer 360, Application Detail):**

```
// Tab bar container
border-b border-gray-200 flex gap-0

// Tab item — default
px-4 py-3 text-body-md text-gray-500 cursor-pointer
border-b-2 border-transparent -mb-px
hover:text-gray-700 hover:border-gray-300
transition-colors duration-150

// Tab item — active
text-navy-900 font-medium border-b-2 border-navy-900

// Count badge on tab
ml-2 bg-gray-100 text-gray-600 text-label-xs px-1.5 py-0.5 rounded-full
// Active tab count badge
bg-navy-100 text-navy-700
```

**Pill variant (used in filter contexts):**
```
// Container
flex gap-2 p-1 bg-gray-100 rounded-lg

// Item default
px-3 py-1.5 rounded-md text-body-sm text-gray-600 cursor-pointer
hover:bg-white hover:text-gray-900 hover:shadow-sm

// Item active
bg-white text-navy-900 font-medium shadow-sm
```

---

### 3.5 Feedback Components

---

#### Toast

```tsx
interface ToastProps {
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
  duration?: number          // ms, default 4000
  action?: { label: string; onClick: () => void }
  onDismiss: () => void
}
```

**Container position:** `fixed bottom-5 right-5 z-toast flex flex-col gap-2 max-w-sm`

**Toast card:**
```
flex items-start gap-3 bg-white rounded-lg shadow-xl border p-4
w-full max-w-sm
```

**Left accent border by type:**
```
success: border-l-4 border-l-success-600
error:   border-l-4 border-l-danger-700
warning: border-l-4 border-l-warning-500
info:    border-l-4 border-l-info-600
```

**Icon by type:** 20px, colored to match border:
```
success: CheckCircle  text-success-600
error:   XCircle      text-danger-700
warning: AlertTriangle text-warning-600
info:    Info         text-info-600
```

**Title:** `text-body-md font-semibold text-gray-900`
**Message:** `text-body-sm text-gray-600 mt-0.5`
**Dismiss button:** `text-gray-400 hover:text-gray-600 ml-auto`

**Animation:** enter `translate-x-0 opacity-100`, from `translate-x-full opacity-0`. Duration 200ms ease-out. Exit: fade + slide right, 150ms.

---

#### Alert Banner

Used for in-page contextual alerts (data freshness, SLA warnings).

```tsx
interface AlertBannerProps {
  type: 'info' | 'warning' | 'error' | 'success'
  title?: string
  message: string
  dismissible?: boolean
  dataSource?: 'live' | 'snapshot'   // shows data freshness indicator
  action?: { label: string; onClick: () => void }
}
```

**Layout:**
```
flex items-start gap-3 rounded-lg px-4 py-3 text-body-sm border
```

**Colors by type:**
```
info:    bg-info-50 border-info-200 text-info-800
warning: bg-warning-50 border-warning-200 text-warning-800
error:   bg-danger-50 border-danger-200 text-danger-800
success: bg-success-50 border-success-200 text-success-800
```

**Data source indicator:**
```
// Live
inline-flex items-center gap-1 text-label-xs
<span className="inline-block w-2 h-2 rounded-full bg-success-500 animate-pulse" />
Live data

// Snapshot
inline-flex items-center gap-1 text-label-xs text-warning-700
<span className="inline-block w-2 h-2 rounded-full bg-warning-500" />
Snapshot · 14:30
```

---

#### Modal

```tsx
interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  children: React.ReactNode
  footer?: React.ReactNode
  closeOnBackdrop?: boolean    // default true
}
```

**Sizes:** sm=`max-w-sm`, md=`max-w-lg`, lg=`max-w-2xl`, xl=`max-w-4xl`, full=`max-w-7xl`

**Backdrop:** `fixed inset-0 bg-navy-900/50 z-modal flex items-center justify-center p-4`

**Modal panel:**
```
bg-white rounded-xl shadow-xl w-full flex flex-col max-h-[90vh]
```

**Header:**
```
flex items-center justify-between px-6 py-4 border-b border-gray-100
```
Title: `text-heading-lg font-semibold text-navy-900`
Close: `text-gray-400 hover:text-gray-600 rounded-md p-1 hover:bg-gray-100`

**Body:** `flex-1 overflow-y-auto px-6 py-5`

**Footer:** `px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3`

**Animation:** backdrop fades in (`opacity-0 → opacity-100`, 150ms). Panel scales in (`scale-95 opacity-0 → scale-100 opacity-100`, 200ms ease-out).

---

#### Drawer

Right-side panel. Used for detail views, document upload, quick edits.

```tsx
interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  width?: 'sm' | 'md' | 'lg'   // 400px / 560px / 720px
  children: React.ReactNode
  footer?: React.ReactNode
}
```

**Backdrop:** Same as Modal but drawer sits at right edge.

**Panel:**
```
fixed inset-y-0 right-0 z-drawer bg-white shadow-xl flex flex-col
// sm: w-[400px], md: w-[560px], lg: w-[720px]
```

**Animation:** Slides in from right. `translate-x-full → translate-x-0`, 250ms ease-out.

---

#### ConfirmDialog

```tsx
interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmLabel?: string        // default "Confirm"
  cancelLabel?: string         // default "Cancel"
  destructive?: boolean        // confirm button red
  loading?: boolean
}
```

Renders as a small Modal (sm size). When `destructive=true`, confirm button uses `bg-danger-700 hover:bg-danger-800 text-white`.

---

#### LoadingSkeleton

```tsx
// Generic
<Skeleton className="h-4 w-full rounded" />
<Skeleton className="h-4 w-3/4 rounded" />

// Table row skeleton (repeatable)
<SkeletonRow columns={7} />

// KPI card skeleton
<SkeletonKpiCard />

// Text block skeleton
<SkeletonText lines={3} />
```

All skeletons: `bg-gray-200 animate-pulse rounded`

---

#### EmptyState

```tsx
interface EmptyStateProps {
  icon?: React.ComponentType     // lucide icon
  title: string
  description?: string
  action?: { label: string; onClick: () => void; icon?: React.ComponentType }
}
```

**Layout:**
```
flex flex-col items-center justify-center py-16 text-center
```
Icon: `w-12 h-12 text-gray-300 mb-4`
Title: `text-heading-md text-gray-600 mb-2`
Description: `text-body-sm text-gray-400 max-w-xs`
Action button: appears below description, `mt-4`

---

### 3.6 Charts (Recharts Wrappers)

All chart components share these conventions:
- Wrapped in a Card with title + optional period selector
- ResponsiveContainer fills card body
- Tooltip styled: `bg-white border border-gray-200 shadow-lg rounded-md px-3 py-2 text-body-sm`
- Colors: use brand palette (navy-700, success-600, warning-500, danger-600, info-600)
- No chart border. Light grid: `stroke="#E5E7EB"` (gray-200), `strokeDasharray="4 2"`

**Period Selector (shared):** Pill tab group: `1W | 1M | 3M | 6M | 1Y`. Right-aligned in card header.

---

#### LineChart Card

```tsx
interface LineChartCardProps {
  title: string
  data: { date: string; [key: string]: number | string }[]
  lines: { key: string; label: string; color: string }[]
  period?: PeriodOption
  onPeriodChange?: (p: PeriodOption) => void
  yFormatter?: (v: number) => string   // e.g. currency formatter
}
```

Y-axis: DM Mono font, right-aligned labels. X-axis: date labels, gray-400.

---

#### BarChart Card

Target line: rendered as a `ReferenceLine` with `stroke="#C00000" strokeDasharray="6 3"` and label.

---

#### DonutChart

```tsx
interface DonutChartProps {
  title: string
  data: { name: string; value: number; color: string }[]
  centerLabel?: string    // e.g. "Total"
  centerValue?: string    // e.g. "₦450M"
  formatter?: (v: number) => string
}
```

Inner radius: 60%, outer radius: 85%. Center text uses absolute positioning.

Legend: below chart, horizontal wrap. Color dot + name + value.

---

#### HeatmapGrid

Used for cohort retention analysis (Collections, Risk).

```tsx
interface HeatmapGridProps {
  rows: string[]          // e.g. cohort months
  cols: string[]          // e.g. "Month 1", "Month 2"...
  data: number[][]        // value[row][col]
  colorScale?: [string, string]   // [low, high] hex colors
  formatter?: (v: number) => string
}
```

Cell color: interpolated between `[low, high]` based on value / max. Cell text: white if dark bg, gray-900 if light. Cell size: 48×36px min.

---

## 4. PAGE TEMPLATE LAYOUTS

### Template A — Dashboard Page

```
┌─────────────────────────────────────────────────────────────────────┐
│ TopBar: "MD Dashboard"                    [🔍] [🔔] [Avatar]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                     │
│  │KPI 1 │ │KPI 2 │ │KPI 3 │ │KPI 4 │ │KPI 5 │  ← StatStrip       │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                     │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────┐          │
│  │ Disbursements (Line)    │  │ Portfolio Mix (Donut)    │          │
│  │ [1W|1M|3M|6M|1Y]        │  │                         │          │
│  │                         │  │  [Chart]                │          │
│  │  [Chart]                │  │                         │          │
│  └─────────────────────────┘  └─────────────────────────┘          │
│                                                                     │
│  ┌─────────────────────────┐  ┌─────────────────────────┐          │
│  │ DPD Movement (Bar)      │  │ Action Items            │          │
│  │                         │  │ ● 3 apps pending ApprHd │          │
│  │  [Chart]                │  │ ● 2 disbursements > 48h │          │
│  │                         │  │ ● 5 NPL cases no contact│          │
│  └─────────────────────────┘  └─────────────────────────┘          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────┐           │
│  │ Recent Activity Feed                                │           │
│  │ ● Tunde Okafor  Approved application #APP-2025-4421 │           │
│  │ ● Ngozi Eze     Posted payment ₦50,000 · Case 881  │           │
│  │ ...                                                 │           │
│  └─────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

**Grid:** `grid grid-cols-5 gap-4` for StatStrip. `grid grid-cols-2 gap-6` for chart rows.

---

### Template B — Queue / List Page

```
┌─────────────────────────────────────────────────────────────────────┐
│ TopBar: "Risk Review Queue"               [🔍] [🔔] [Avatar]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 🔍 Search...  [Status ▾] [Product ▾] [Assigned ▾] [Reset]│       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │New (12)  │ │Review(8) │ │Pending(5)│ │Approved  │  ← Summary   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ [☐] [Actions ▾]  Showing 1–25 of 47   [Columns ▾] [⬇CSV]│       │
│  ├─────────────────────────────────────────────────────────┤       │
│  │ ☐  App ID    Customer        Amount    Stage   Risk  Age │       │
│  ├─────────────────────────────────────────────────────────┤       │
│  │ ☐  APP-4421  Adebayo O.   ₦500,000  Review   68   2d   │       │
│  │ ☐  APP-4420  Chioma N.  ₦1,200,000  Review   71   1d   │       │
│  │ ...                                                     │       │
│  ├─────────────────────────────────────────────────────────┤       │
│  │ ← Prev  [1] [2] [3] ...  Next →           25 per page   │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

**Filter bar:** `flex flex-wrap items-center gap-3 p-4 bg-white rounded-lg border border-gray-200`

**Bulk action toolbar** (shown when rows selected):
```
fixed bottom-6 left-1/2 -translate-x-1/2 z-50
bg-navy-900 text-white rounded-full px-6 py-3 shadow-xl
flex items-center gap-4 text-body-sm
```
Contains: "3 selected" count + action buttons (Assign, Export, Bulk Update).

---

### Template C — Detail Page (Application Detail / Customer 360)

```
┌─────────────────────────────────────────────────────────────────────┐
│ TopBar  Home > LOS > Applications > APP-4421  [🔍] [🔔] [Avatar]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Adebayo Okonkwo · APP-2025-4421    [● Risk Review]          │   │
│  │ Personal Loan · ₦500,000 · 12 months  [Approve] [Decline]  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌────────────────────────────────────┐  ┌──────────────────────┐  │
│  │                                    │  │ Quick Facts          │  │
│  │ [Overview][Documents][Credit]      │  │ Credit Score: 671    │  │
│  │ [Financials][Activity][Notes]      │  │ DTI: 38%            │  │
│  │                                    │  │ Employment: Salaried │  │
│  │ ← Tab content area →               │  │ Employer: GTBank     │  │
│  │                                    │  │                      │  │
│  │   (varies by active tab)           │  │ Quick Actions        │  │
│  │                                    │  │ [Request Document]   │  │
│  │                                    │  │ [Add Note]           │  │
│  │                                    │  │ [Reassign]           │  │
│  └────────────────────────────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Header strip:**
```
bg-white border-b border-gray-200 px-6 py-4
flex items-start justify-between
```

**Entity name:** `text-heading-xl font-semibold text-navy-900`
**Sub-info line:** `text-body-sm text-gray-500 mt-0.5 flex items-center gap-2`
**Action buttons:** right-aligned, use Button component variants

**Main area grid:** `grid grid-cols-[1fr_300px] gap-6` (tabs left, sidebar right)

**Right sidebar:** `space-y-4` — stacked Card components (Quick Facts, Quick Actions, SLA Timer if applicable)

---

### Template D — Multi-Step Form (LOS New Application)

```
┌─────────────────────────────────────────────────────────────────────┐
│ TopBar: "New Application"                 [🔍] [🔔] [Avatar]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ ●━━━━━●━━━━━●━━━━━○━━━━━○━━━━━○                         │       │
│  │ 1     2     3     4     5     6                         │       │
│  │ Done  Done  Here  Todo  Todo  Todo                       │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌────────────────────────────────────────────────────────┐        │
│  │ Step 3: Employment & Income                            │        │
│  │                                                        │        │
│  │  Employment Type  [Select ▾]                           │        │
│  │  Employer Name    [                    ]               │        │
│  │  Monthly Income   [₦                  ]               │        │
│  │  Employment Start [Date picker         ]               │        │
│  │                                                        │        │
│  │  ─ Bank Statement ─────────────────────────────────    │        │
│  │  [Drop files here or click to upload]                  │        │
│  │                                                        │        │
│  └────────────────────────────────────────────────────────┘        │
│                                                                     │
│  ┌────────────────────────────────────────────────────────┐        │
│  │ [← Back]    [Save Draft]              [Continue →]     │        │
│  └────────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

**Stepper:** full-width, above the form card. `mx-auto max-w-2xl mb-8`

**Form card:** `bg-white rounded-xl shadow-sm border border-gray-100 p-8 max-w-3xl mx-auto`

**Form sections** within the card are separated by `<hr className="border-gray-100 my-6" />` with a section label above.

**Navigation bar:** `flex items-center justify-between pt-6 mt-6 border-t border-gray-100`

---

### Template E — Report / Export Page

```
┌─────────────────────────────────────────────────────────────────────┐
│ TopBar: "Collections Report"              [🔍] [🔔] [Avatar]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ [Date: Jun 1–Jun 30 ▾]  [Product ▾]  [Agent ▾]  [Apply]│       │
│  │                                                [⬇ Export ▾]     │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │
│  │Total Due │ │Collected │ │Recovery% │ │Accounts  │  ← StatStrip  │
│  │₦24.5M    │ │₦18.2M    │ │74.3%     │ │342       │              │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ [Bar Chart: Daily Collections vs Target]                │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ Agent       Accounts  Contacted  Promises  Payments  Rate│       │
│  │ Ngozi Eze       42        38        21         18    42%  │      │
│  │ Emeka Obi       38        30        17         14    37%  │      │
│  │ ...                                                     │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

**Export dropdown:** `CSV | Excel | PDF` options.

**Filter panel:** `bg-white rounded-lg border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3`

---

## 5. TABLE DESIGN PATTERNS

### 5.1 Column Header Style

```
// Header cell
px-4 py-3
text-label-xs text-gray-500 uppercase tracking-wider
bg-gray-50 border-b-2 border-gray-200
font-medium whitespace-nowrap

// Numeric column header
text-right

// Sortable — hover
cursor-pointer hover:bg-gray-100 select-none

// Sort indicator placement: inline after label
<span className="ml-1 inline-flex flex-col text-[10px] leading-none text-gray-300">
  <span className={sort === 'asc' ? 'text-navy-700' : ''}>▲</span>
  <span className={sort === 'desc' ? 'text-navy-700' : ''}>▼</span>
</span>
```

Fixed headers: sticky top within scrollable container. `sticky top-0 z-10` on `<thead>`.

---

### 5.2 Number & Currency Formatting

```typescript
// Currency display
const formatNaira = (kobo: number): string =>
  '₦' + (kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
// ₦1,234,567

// For amounts >= ₦1,000,000 in summary cards: abbreviate
// ₦1.2M, ₦450K

// Date formatting (always)
const formatDate = (d: Date | string): string =>
  new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  })
// 16 Jun 2026

// DateTime
const formatDateTime = (d: Date | string): string =>
  new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
// 16 Jun 2026 · 14:32
```

All numeric cells: `font-mono tabular-nums text-right`

---

### 5.3 Table Toolbar

```
flex items-center justify-between px-4 py-3 border-b border-gray-100
```

Left side: search input (`w-64`) + filter chips for active filters
Right side: column visibility toggle (gear icon) + export button

**Column visibility toggle:** Dropdown with checkboxes per column. Persisted in localStorage per table ID.

---

## 6. COLOR CODING REFERENCE TABLES

### 6.1 DPD / Loan Status

| Bucket | Label | Background | Text | Border | Badge Classes |
|---|---|---|---|---|---|
| 0 DPD | Current | `bg-success-100` | `text-success-700` | `border-success-200` | `bg-success-100 text-success-700` |
| 1–29 DPD | Early | `bg-warning-100` | `text-warning-700` | `border-warning-200` | `bg-warning-100 text-warning-700` |
| 30–59 DPD | Mild | `bg-orange-100` | `text-orange-700` | `border-orange-200` | `bg-orange-100 text-orange-700` |
| 60–89 DPD | Moderate | `bg-danger-100` | `text-danger-700` | `border-danger-200` | `bg-danger-100 text-danger-700` |
| 90+ DPD | NPL | `bg-danger-200` | `text-danger-800` | `border-danger-300` | `bg-danger-200 text-danger-800 font-semibold` |
| Written Off | — | `bg-gray-200` | `text-gray-600` | `border-gray-300` | `bg-gray-200 text-gray-600` |

### 6.2 Application Stage

| Stage | Hex | Tailwind Badge |
|---|---|---|
| Draft | #6B7280 | `bg-gray-100 text-gray-600` |
| Submitted | #2563EB | `bg-blue-100 text-blue-700` |
| Doc Collection | #7C3AED | `bg-violet-100 text-violet-700` |
| Risk Review | #0891B2 | `bg-cyan-100 text-cyan-700` |
| Risk Head Review | #0E7490 | `bg-cyan-200 text-cyan-800` |
| Pending Conditions | #D97706 | `bg-amber-100 text-amber-700` |
| Finance Approval | #059669 | `bg-emerald-100 text-emerald-700` |
| Booking | #166534 | `bg-green-100 text-green-700` |
| Active | #15803D | `bg-green-200 text-green-800 font-semibold` |
| Declined | #991B1B | `bg-red-100 text-red-800` |
| Withdrawn | #6B7280 | `bg-gray-100 text-gray-500` |
| Expired | #9CA3AF | `bg-gray-100 text-gray-400` |

### 6.3 KPI RAG System

```typescript
// Usage: pass thresholds for each KPI — direction-aware
interface KpiThreshold {
  metric: string
  goodMin?: number     // value >= goodMin is green
  goodMax?: number     // value <= goodMax is green (for metrics like NPL rate)
  warnMin?: number
  warnMax?: number
  // values outside good/warn range = bad (red)
}

// Examples:
const kpiThresholds: KpiThreshold[] = [
  { metric: 'collection_rate',  goodMin: 75,  warnMin: 60 }, // higher = better
  { metric: 'npl_rate',         goodMax: 5,   warnMax: 10 }, // lower = better
  { metric: 'disbursement_tat', goodMax: 48,  warnMax: 72 }, // hours, lower better
]
```

| RAG | Background | Text | Icon |
|---|---|---|---|
| Good (Green) | `bg-success-50` | `text-success-700` | `TrendingUp` |
| Warning (Amber) | `bg-warning-50` | `text-warning-700` | `AlertTriangle` |
| Bad (Red) | `bg-danger-50` | `text-danger-700` | `TrendingDown` |

### 6.4 Settlement / Reconciliation

| Status | Badge Classes | Meaning |
|---|---|---|
| Matched | `bg-success-100 text-success-700` | Fully reconciled |
| Unmatched | `bg-danger-100 text-danger-700` | No matching entry found |
| Partial | `bg-warning-100 text-warning-700` | Amount mismatch |
| Pending | `bg-gray-100 text-gray-600` | Awaiting processing |
| Exception | `bg-violet-100 text-violet-700` | Manual review needed |

---

## 7. NOTIFICATION & ALERT DESIGN

### 7.1 Notification Bell

```
// Bell button in TopBar
relative p-2 rounded-md hover:bg-gray-100 text-gray-600

// Unread badge
absolute -top-0.5 -right-0.5
min-w-[18px] h-[18px] rounded-full bg-brand-red text-white
text-[10px] font-bold flex items-center justify-center px-1
```

Clicking the bell opens a dropdown panel:
```
absolute right-0 top-full mt-2 w-96 bg-white rounded-xl shadow-xl
border border-gray-200 z-dropdown
```

**Dropdown header:**
```
flex items-center justify-between px-4 py-3 border-b border-gray-100
// Title: "Notifications" text-heading-md
// Actions: "Mark all read" text-body-sm text-info-600 cursor-pointer
```

**Notification list:** `max-h-[480px] overflow-y-auto divide-y divide-gray-50`

**Individual notification card:**
```
flex gap-3 px-4 py-3 cursor-pointer
hover:bg-gray-50 transition-colors

// Unread state
bg-info-50/40

// Icon container
w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0
// color by type — see below
```

**Notification types & icons:**
```
approval:        bg-success-100  CheckCircle   text-success-600
rejection:       bg-danger-100   XCircle       text-danger-600
assignment:      bg-info-100     UserPlus      text-info-600
payment:         bg-success-100  Banknote      text-success-700
sla_breach:      bg-warning-100  Clock         text-warning-600
system:          bg-gray-100     Bell          text-gray-500
compliance:      bg-violet-100   Shield        text-violet-600
```

**Notification text:**
```
// Title
text-body-sm font-medium text-gray-900 leading-tight

// Body
text-body-sm text-gray-600 mt-0.5 line-clamp-2

// Timestamp
text-label-xs text-gray-400 mt-1
```

**Unread indicator:** 6px filled circle `bg-info-600 rounded-full` right side of notification row.

**Footer link:** `View all notifications →` centered, `text-body-sm text-info-600`

---

### 7.2 SSE Connection Status

Small indicator in bottom-right of TopBar (right of avatar):

```
// Connected
<span className="flex items-center gap-1 text-label-xs text-success-600">
  <span className="w-1.5 h-1.5 rounded-full bg-success-500 animate-pulse" />
  Live
</span>

// Reconnecting
<span className="flex items-center gap-1 text-label-xs text-warning-600">
  <span className="w-1.5 h-1.5 rounded-full bg-warning-500 animate-ping" />
  Reconnecting...
</span>

// Disconnected
<span className="flex items-center gap-1 text-label-xs text-danger-600">
  <span className="w-1.5 h-1.5 rounded-full bg-danger-500" />
  Offline
</span>
```

---

### 7.3 In-Page Alert Banners

**SLA Breach Warning (on Application Detail):**
```tsx
<AlertBanner
  type="warning"
  title="SLA Approaching"
  message="This application has been in Risk Review for 46h. SLA is 48h."
  action={{ label: "Escalate", onClick: handleEscalate }}
/>
```

**Data Source Banner (stale data warning):**
```tsx
<AlertBanner
  type="info"
  message="Showing snapshot data from 14:30. Refresh to get live data."
  dataSource="snapshot"
  action={{ label: "Refresh", onClick: handleRefresh }}
/>
```

Both render at the top of the page content area, below any breadcrumbs, before the main content.

---

## 8. DARK MODE DECISION

**Decision: No dark mode for v1.**

**Rationale:**
1. **Office environment, daytime use.** O3C staff work in lit office environments on desktop PCs. The primary pain dark mode solves (eye strain in low-light environments) does not apply.
2. **Data-dense tables.** DPD color coding and status badges rely on light background tints (e.g., `bg-success-100`). Translating these to dark mode requires remapping all semantic colors — significant maintenance overhead.
3. **50 concurrent users.** The implementation cost (every component needs dark: variants, semantic color inversion testing) is not justified for this team size.
4. **No user request.** Dark mode is a preference feature, not a business requirement.

**Future:** If field recovery agents complain about tablet glare, add dark mode as a phase 2 enhancement. The token system (using semantic color names not raw hex) makes this tractable — add `dark:` variants to the design token layer.

---

## 9. ACCESSIBILITY SPEC

### 9.1 WCAG 2.1 AA Requirements

**Contrast ratios (minimum 4.5:1 for text, 3:1 for large text/UI):**

| Pair | Ratio | Pass |
|---|---|---|
| `#0E2841` (navy-900) on `#FFFFFF` | 16.2:1 | ✓ AA + AAA |
| `#FFFFFF` on `#0E2841` | 16.2:1 | ✓ |
| `#C00000` (red) on `#FFFFFF` | 5.9:1 | ✓ AA |
| `#FFFFFF` on `#C00000` | 5.9:1 | ✓ |
| `#166534` (green-700) on `#FFFFFF` | 7.6:1 | ✓ AAA |
| `#D97706` (amber-600) on `#FFFFFF` | 2.9:1 | ✗ — use `#B45309` (amber-700) for text |
| `#B45309` on `#FFFFFF` | 4.6:1 | ✓ AA |
| `#6B7280` (gray-500) on `#FFFFFF` | 4.6:1 | ✓ AA |
| Body text `#111827` on `#F4F6F8` | 17.5:1 | ✓ |

**Rule:** Never use `text-warning-500` (`#F59E0B`) directly on white. Use `text-warning-700` (`#B45309`) instead. The `warning-500` amber is background-only.

---

### 9.2 Focus Ring Design

```css
/* Applied to all interactive elements via Tailwind */
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-offset-2
focus-visible:ring-brand-red

/* ring-brand-red = #C00000 */
/* ring-offset-2 = 2px white gap between element and ring */
```

Do not use `outline-none` without providing a replacement. Every interactive element must show a visible focus indicator.

---

### 9.3 Key ARIA Patterns

**Data Table:**
```html
<table role="grid" aria-label="Applications queue" aria-rowcount="342">
  <thead>
    <tr role="row">
      <th role="columnheader" scope="col" aria-sort="ascending">
        Application ID
        <span aria-hidden="true">▲</span>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr role="row" aria-selected="false">
      <td role="gridcell">APP-4421</td>
    </tr>
  </tbody>
</table>
<!-- Pagination -->
<nav aria-label="Table pagination">...</nav>
```

**Modal:**
```html
<div role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <h2 id="modal-title">Confirm Approval</h2>
  <!-- body -->
  <!-- Focus trap: Tab cycles within modal only -->
</div>
```
On open: focus moves to first focusable element. Escape closes. Focus returns to trigger on close.

**Tabs:**
```html
<div role="tablist" aria-label="Application details">
  <button role="tab" aria-selected="true" aria-controls="panel-overview" id="tab-overview">
    Overview
  </button>
  <button role="tab" aria-selected="false" aria-controls="panel-docs" id="tab-docs">
    Documents
  </button>
</div>
<div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" tabindex="0">
  <!-- content -->
</div>
```
Arrow keys navigate between tabs. Enter/Space activates.

**Sidebar Navigation:**
```html
<nav aria-label="Main navigation">
  <ul>
    <li>
      <a href="/applications" aria-current="page">Applications</a>
    </li>
  </ul>
</nav>
```

---

### 9.4 Keyboard Navigation Requirements

| Component | Keys |
|---|---|
| Sidebar | Tab to navigate, Enter to activate, arrow keys within groups |
| Table rows | Tab into table, arrow keys for row navigation, Space to select, Enter to open detail |
| Modal | Tab/Shift+Tab within modal, Escape to close |
| Drawer | Same as Modal |
| Dropdown/Select | Enter/Space to open, arrow keys to navigate, Enter to select, Escape to close |
| Tabs | Arrow keys to switch tabs, Enter/Space to activate |
| Date Picker | Arrow keys for calendar navigation |
| Toast | Auto-dismiss; Escape dismisses immediately |
| Global Search | Cmd+K (Mac) / Ctrl+K (Win) to open |

---

## 10. ANIMATION & TRANSITIONS

### 10.1 Motion Spec

| Element | Animation | Duration | Easing |
|---|---|---|---|
| Page transition | Subtle fade only (`opacity-0 → opacity-100`) | 150ms | ease-out |
| Sidebar collapse | Width transition | 200ms | ease-in-out |
| Table row hover | Background color | 100ms | linear |
| Modal open | Backdrop fade + panel scale-up | 150ms backdrop, 200ms panel | ease-out |
| Modal close | Panel fade + scale-down | 150ms | ease-in |
| Drawer open | Slide in from right | 250ms | ease-out |
| Drawer close | Slide out to right | 200ms | ease-in |
| Toast enter | Slide up + fade in | 200ms | ease-out |
| Toast exit | Fade out + slide right | 150ms | ease-in |
| Dropdown open | Scale + fade from top | 150ms | ease-out |
| Accordion expand | Height auto (max-height) | 200ms | ease-in-out |
| Chart data | Recharts default (1s ease) | 800ms | ease-out |
| Progress bar fill | Width | 500ms | ease-out |
| Skeleton pulse | `animate-pulse` | 2s | linear (CSS) |

### 10.2 Skeleton vs Spinner

**Preference: Skeletons for known layouts, spinners for unknown-duration actions.**

```
Skeleton:    Page load, table initial load, dashboard KPI cards
Spinner:     Form submission, file upload, individual async action
Inline dots: Button loading state ("Approving...")
```

**Spinner classes:**
```
animate-spin h-5 w-5 border-2 border-current border-t-transparent rounded-full
```

### 10.3 prefers-reduced-motion

```css
/* In global CSS */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

In Tailwind, wrap animated elements:
```
motion-safe:animate-pulse     (skeleton)
motion-safe:transition-all    (transitions)
```

Chart animations: pass `isAnimationActive={!prefersReducedMotion}` to Recharts components.

---

## 11. TYPOGRAPHY USAGE GUIDE

```
DM Sans  — ALL body text, UI labels, headings
DM Mono  — ALL numbers, amounts, IDs, dates in tables

Never mix fonts within a sentence.
Never use DM Mono for non-numeric content.
```

| Use Case | Token | Size | Weight |
|---|---|---|---|
| Dashboard KPI value (₦12.4M) | `text-display-sm font-mono` | 24px | 600 |
| Page title ("Applications") | `text-heading-xl` | 20px | 600 |
| Card / section header | `text-heading-md` | 16px | 600 |
| Default body copy | `text-body-md` | 14px | 400 |
| Table cell text | `text-body-md` | 14px | 400 |
| Table column header | `text-label-xs uppercase tracking-wider` | 11px | 500 |
| Table amount (₦1,234,567) | `text-num-md font-mono tabular-nums` | 14px | 400 |
| Badge / chip text | `text-label-sm` | 12px | 500 |
| Form label | `text-label-md` | 14px | 500 |
| Helper / hint text | `text-body-sm text-gray-500` | 12px | 400 |
| Nav item (active) | `text-body-md font-medium` | 14px | 500 |
| Breadcrumb | `text-body-sm` | 12px | 400 |
| Tooltip | `text-body-sm` | 12px | 400 |
| Empty state title | `text-heading-md text-gray-600` | 16px | 600 |
| Toast title | `text-body-md font-semibold` | 14px | 600 |

**Line height:** Use `leading-snug` (1.375) for headings, `leading-normal` (1.5) for body, `leading-none` (1) for single-line UI labels.

**₦ symbol:** Always preceded by thin space in display contexts (`₦ 1,234,567`) but no space in inline/badge contexts (`₦1,234,567`). In tables: no space, right-aligned.

---

## 12. KEY DESIGN DECISIONS

### D1 — Navy as primary, red as accent only
Navy (#0E2841) is used for all primary UI chrome (sidebar, primary buttons, active states). Red (#C00000) is reserved for alerts, critical statuses, CTAs that require attention, and destructive actions. Red is never used for decorative purposes — its appearance always signals something actionable or urgent.

### D2 — DM Mono for all numbers
Every number, amount, ID, date, or percentage in a table or data display uses DM Mono. This is non-negotiable for a fintech platform — tabular numbers must align vertically and be scannable. Body text remains DM Sans.

### D3 — 8pt spacing grid
All padding and spacing uses multiples of 4px (Tailwind's default) with a preference for 8px increments in layout (16px, 24px, 32px). This produces consistent rhythm across dense data pages.

### D4 — Kobo as internal currency unit
All currency is stored and passed as integer kobo (100ths of a naira). The `CurrencyInput` and `formatNaira()` handle conversion at the boundary. Never store or display fractional naira amounts.

### D5 — Status badge design constraint
Status badges use `bg-{color}-100 text-{color}-700` pairs (light background, dark text) rather than solid fills. This keeps them readable in table rows without overpowering the row content. The one exception is `Active` loan status which uses `bg-green-200 text-green-800` to be slightly more prominent.

### D6 — No mobile breakpoint
The platform is desktop-primary (1920×1080). Minimum supported width is 1280px. Tablet (iPad, ~1024px) is supported via the collapsible sidebar pattern. No layouts are designed for <768px — this is documented to prevent accidental mobile-first CSS patterns.

### D7 — Role-based nav via server claims
Nav visibility is controlled by JWT role claims, not frontend config alone. The frontend reads `user.roles[]` from the token and renders nav accordingly. Backend enforces authorization independently — frontend filtering is UX only, not a security boundary.

### D8 — Amber text exception
`#F59E0B` (warning-500 / brand amber) fails WCAG AA contrast on white (#FFFFFF). It is used ONLY as a background tint. Text in warning states uses `#B45309` (warning-700) which passes at 4.6:1. Every amber badge uses `text-warning-700` not `text-warning-500`.

### D9 — Table-first layout decisions
Most pages in this platform are tables. Cards, charts, and forms exist to serve the tables. Design choices favor table density: 14px body text (not 16px), compact row height (44px), tight cell padding (12px horizontal). Dense tables are appropriate for trained internal users who are not casual consumers.

### D10 — Sticky first column on wide tables
Tables with >7 columns use a sticky first column (application ID, customer name, or case number). This allows horizontal scrolling without losing the row identity anchor. Implemented via `sticky left-0 z-10` with a shadow separator.

### D11 — Toast vs Alert Banner
**Toast:** transient feedback about a user action (form save, approval submitted). Auto-dismisses in 4s. Bottom-right position. Does not interrupt workflow.
**Alert Banner:** persistent in-page context that affects how the user should interpret the current view (stale data, SLA breach, compliance hold). Stays visible until dismissed or condition resolves. Top of page content area.

### D12 — Collapsible sidebar default
Sidebar defaults to expanded (240px) on 1920px+ screens. Collapses to icon-only (64px) on 1280–1439px screens automatically. State override persisted in localStorage per user. This maximizes content area on common office PC resolutions while keeping nav accessible.
