# O3 Capital Workspace — Master Product Specification
**Version 2.1 · July 2026 · Session-captured reference**

This document is the single source of truth for the O3 Capital Workspace product. It captures every decision, gap, scenario, design rule, and module requirement discussed across all sessions. Nothing here is speculative — it was reviewed and approved in conversation.

**Relationship to DESIGN_BRIEF.md**: An earlier design brief exists at `/o3c-reports/DESIGN_BRIEF.md` (746 lines, written for a React 19 + ECharts + TanStack Table + shadcn/ui stack that was not adopted). This Master Spec supersedes it for design direction. The DESIGN_BRIEF.md is archived context only — do not use its font choices (DM Sans/DM Mono) or component library recommendations. The approved stack is React 18 + Recharts + Tailwind + inline styles with the "Editorial B" type system (Sora + Inter) documented in PART 2.

---

## PART 1 — What O3 Capital Is

**O3 Capital** is a Nigerian fintech company. They are not a bank — they are a financial services company operating in the following product lines:

| Product | Description |
|---------|-------------|
| Fixed Deposits | Term deposits with interest, rollover, and early withdrawal |
| Credit Cards | Revolving credit with statements, interest, and limits |
| Prepaid Cards | Stored-value cards (Blink Card, mobile wallet) |
| International USD Cards | USD-denominated virtual/physical cards for international transactions |
| Salary Loans | Payroll-deducted personal loans for employed individuals |
| Individual Loans | Personal loans based on credit scoring (non-salary) |
| Business Loans | SME/corporate lending with financial statement analysis |

The workspace replaces a fragmented mix of Power BI dashboards and spreadsheets. It is the single operations platform for every internal department.

**Channels:**
- **Staff workspace** — web application (this platform). All internal operations.
- **Customer mobile app** — Flutter (iOS + Android). Customers view balances, download statements, make repayments, manage cards.
- **Customer web portal** — planned (Phase 4 of native helpdesk rollout). Ticket submission, statement requests.

**Tech stack (current, in production):**
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS v3, deployed to Cloudflare Pages
- Backend: Go (chi router), deployed to Railway
- Primary DB: PostgreSQL (Supabase)
- Secondary DB: On-site MSSQL via Cloudflare Tunnel (live card/transaction data)
- Charts: Recharts v2.12.7
- Icons: Material Symbols Rounded (Google CDN)
- File store: Supabase Storage / R2 (wired as of P4-06)
- Call center: Zoho Voice API (inbound + outbound, no Zoho UI — see PART 10)
- Mobile: Flutter (iOS + Android) — built and deployed separately from `~/Developer/phoenix/apps/flutter_mobile`

**Regulatory context:** O3 Capital operates under a CBN licence in Nigeria. Key obligations: CBN Consumer Protection Framework (complaint logging and quarterly reporting), FCCPC registration, NDPR compliance for customer PII (data retention, subject rights, DPO documentation), and monthly credit bureau submissions to CRC / First Central.

---

## PART 2 — Approved Design System

### 2.1 Typography Direction — "Editorial B" (Approved)

This direction was approved after reviewing three options. It uses Stripe-style numeric typography with a clean editorial body font.

| Usage | Font | Key setting |
|-------|------|-------------|
| All body text, UI labels, headings | **Sora** | `'Sora', ui-sans-serif, sans-serif` |
| All numbers, amounts, IDs, dates | **Inter** | `fontVariantNumeric: 'tabular-nums'`, `fontFeatureSettings: "'tnum' 1, 'cv05' 1"` |

**In code (from approved DesignDemo.tsx):**
```tsx
const SORA  = "'Sora', ui-sans-serif, sans-serif"
const INTER = "'Inter', ui-sans-serif, sans-serif"
const NUM: React.CSSProperties = {
  fontFamily: INTER,
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: "'tnum' 1, 'cv05' 1",
}
```

**Font sizes:**
- Page title (h1): 24px / weight 800 / letter-spacing -0.7px
- Panel header: 13px / weight 700
- Body / table cells: 12.5–13px / weight 400–500
- KPI value: 28–30px / weight 800 / letter-spacing -1.2px (Inter + NUM)
- Sub-label / meta: 10.5–11.5px
- Table header: 10px / weight 700 / uppercase / letter-spacing 0.6px
- Badge/chip: 10–11px / weight 700
- Section group label: 8.5px / weight 700 / uppercase / letter-spacing 1.3px

### 2.2 Brand Colours

```
Navy:    #0E2841   — sidebar logo mark, primary nav active border
Red:     #C00000   — "Capital" logo text, active nav dot, danger, CTAs
White:   #FFFFFF
Canvas:  #F5F6FA   (light background)
Dark BG: #07090F   (dark mode background)
```

**Supporting palette:**
```
Green:  #16A34A  — positive metrics, Won status, success
Amber:  #D97706  — warnings, Warm status
Blue:   #2563EB  — secondary interactive
Purple: #7C3AED  — tertiary chart series
```

### 2.3 Theme Tokens (approved CSS custom property sets)

**Light theme:**
```
--bg: #F5F6FA           --sb: #FFFFFF            --sb-bdr: #E8EBF2
--card: #FFFFFF          --card-bdr: #E8EBF2
--card-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 18px rgba(0,0,0,0.05)
--txt: #0F1623           --txt2: #798094           --txt3: #C0C8D8
--bdr: #E8EBF2           --th-bg: #F6F8FC
--input-bg: #F2F4F9      --input-bdr: #DDE0EA
--nav-txt: #9AA4B8       --nav-act-txt: #0F1623    --nav-act-bg: #EEF1F8
--nav-dot: #C00000       --nav-hvr-bg: #F5F6FA     --nav-hvr-txt: #0F1623
--sub-txt: #C0C8D8       --sub-hvr: #6B7590        --sub-act: #0F1623
--grp: #B8BFCF           --chip-bg: #EEF0F8        --chip-txt: #4A5270
--row-hvr: #F8F9FC       --row-sel: #FFF2F2
```

**Dark theme:**
```
--bg: #07090F            --sb: #04060C             --sb-bdr: #0F1626
--card: #0A0E1A          --card-bdr: #121C30
--card-shadow: 0 1px 3px rgba(0,0,0,0.5), 0 8px 28px rgba(0,0,0,0.3)
--txt: #D5DDED           --txt2: #384A68           --txt3: #1C2438
--bdr: #121C30           --th-bg: #060910
--input-bg: #0A0E1A      --input-bdr: #121C30
--nav-txt: #242E44       --nav-act-txt: #E2E8F5    --nav-act-bg: #0F1A30
--nav-dot: #FF3333       --nav-hvr-bg: #0A0F1C     --nav-hvr-txt: #7888B0
--sub-txt: #161E30       --sub-hvr: #485870        --sub-act: #BAC6E0
--grp: #1C2438           --chip-bg: #0F1A30        --chip-txt: #506898
--row-hvr: #0C1220       --row-sel: #180E1C
```

**Implementation pattern (from DesignDemo.tsx):**
```tsx
// Applied as inline style prop on root div, with @ts-expect-error for custom props
const t = dark ? DARK : LIGHT
<div style={{ ...t, position: 'fixed', inset: 0, ... }}>
  {/* All children use var(--token-name) */}
</div>
```

### 2.4 Approved Sidebar Specification

The sidebar design was finalised and approved. These are the exact dimensions and behaviours.

**Structure:**
- Width: **236px** (expanded)
- Background: `var(--sb)` — white in light, near-black in dark
- Border-right: `1px solid var(--sb-bdr)`

**Logo area:**
- Height: **50px**
- Border-bottom: `1px solid var(--sb-bdr)`
- Logo mark: 28×28px, borderRadius 7px, background `#0E2841` (navy), "O3" white 11px/800 Inter
- Name: `fontSize 13.5px / weight 800 / letterSpacing -0.4px` — "O3 **Capital**" with "Capital" in `#C00000`
- WORKSPACE badge: right-aligned, 8.5px/700 Inter, background `var(--chip-bg)`

**Group section labels:**
- fontSize 8.5px / weight 700 / uppercase / letterSpacing 1.3px
- Colour: `var(--grp)`
- Padding: `10px 14px 3px`

**Nav items (top-level):**
- Height: **32px**
- Padding: `0 9px 0 11px`
- Margin: `1px 7px`
- borderRadius: 7px
- fontSize: 12.5px / weight 500 (inactive) / 600 (active)
- Icon: Material Symbol, fontSize 16px
- Chevron (if has subs): fontSize 13px, `var(--grp)`, rotates 180° when open
- **Active indicator**: absolutely positioned `3px × 16px` red bar at `left: -7px, top: 50%, translateY(-50%)`, `borderRadius: '0 3px 3px 0'`, `background: var(--nav-dot)` — NOT a border-left on the item itself

```tsx
{isAct && (
  <div style={{
    position: 'absolute', left: -7, top: '50%',
    transform: 'translateY(-50%)', width: 3, height: 16,
    background: 'var(--nav-dot)', borderRadius: '0 3px 3px 0',
  }} />
)}
```

**Sub-items:**
- Accordion container: `overflow: hidden`, `maxHeight` animated via CSS transition — closed: `maxHeight: 0`, open: `maxHeight: 500px` (or total content height), `transition: 'max-height .22s ease'`, padding `0 7px 0 14px`
- Each sub-item: height 28px, `display: flex`, `gap: 7px`, padding `0 8px 0 9px`, margin `1px 0`, borderRadius 5px
- **Each sub-item has its own 1px × 14px vertical line as first flex child** (not a container border):

```tsx
<div style={{
  width: 1, height: 14,
  background: sa ? 'var(--nav-dot)' : 'var(--bdr)',
  flexShrink: 0, borderRadius: 1, transition: 'background .12s',
}} />
```

- Sub-item badges: 15×15px, smaller font (9px)
- Active sub: `color: var(--sub-act)`, font-weight 600, subtle background
- Hover sub: `color: var(--sub-hvr)`, `background: var(--nav-hvr-bg)`

**Footer (bottom of sidebar):**
- Border-top: `1px solid var(--sb-bdr)`
- Padding: `8px 7px 6px`
- Two utility rows (Mail, Notifications) — `.fi` style: `display:flex, gap 8px, padding 7px 10px, borderRadius 7px, fontSize 12px, color: var(--nav-txt)`
- Notifications has a red badge (count 3)
- User row: `border-top: 1px solid var(--sb-bdr)`, `margin-top: 4px`, `padding: 8px 10px 2px`
  - Avatar: 26×26px circle, `background: linear-gradient(135deg, #0E2841, #1a3a5c)` (navy gradient — NOT red)
  - Name: 11.5px/700, `var(--txt)`
  - Role: 9.5px, `var(--txt2)`, Inter
  - more_horiz icon: 17px, `var(--txt3)`

### 2.5 Topbar Specification

- Height: **48px**
- Background: `var(--sb)`
- Border-bottom: `1px solid var(--sb-bdr)`
- Left: title (13px/700) + subtitle (11px Inter, `var(--txt2)`)
- Right: Dark/Light mode toggle (pill button, borderRadius 99px, gap 5px)

### 2.6 Card / Panel Specification

- Background: `var(--card)`
- Border: `1px solid var(--card-bdr)`
- borderRadius: **14px**
- boxShadow: `var(--card-shadow)`

### 2.7 Page Layout Dimensions

- Main content padding: **24px**
- Chart grid gap: **14px**
- KPI card inner padding: **18px 20px**
- Table card: `overflow: hidden` on the card, `overflowX: auto` on the table wrapper
- Table min-width: 880px

### 2.8 Approved Tooltip Component

All charts use the same dark tooltip:
```tsx
function Tip({ active, payload, label, fmt }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#0E2841', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)',
      border: '1px solid rgba(255,255,255,.08)',
    }}>
      {label && (
        <div style={{ fontSize: 9.5, fontWeight: 600, color: 'rgba(255,255,255,.4)',
          fontFamily: INTER, marginBottom: 7, letterSpacing: .5, textTransform: 'uppercase' }}>
          {label}
        </div>
      )}
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: i > 0 ? 5 : 0 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: p.color }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', ...NUM }}>{fmt(p.value)}</span>
          {p.name && payload.length > 1 && (
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)', fontFamily: SORA }}>{p.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}
```

### 2.9 Status Pill / Badge Specification

```
Hot:  bg #FEE2E2 / txt #991B1B  (dark: rgba(192,0,0,.18) / #FF7070)
Warm: bg #FEF3C7 / txt #92400E  (dark: rgba(217,119,6,.18) / #FBBF24)
New:  bg #DBEAFE / txt #1E40AF  (dark: rgba(37,99,235,.18) / #93C5FD)
Won:  bg #DCFCE7 / txt #14532D  (dark: rgba(22,163,74,.18) / #86EFAC)
Lost: bg #F3F4F6 / txt #6B7280  (dark: rgba(75,85,99,.18) / #9CA3AF)
```

Padding: `3px 9px` / borderRadius: 99px / fontSize 10.5px / weight 700 / Inter

### 2.10 Approved Chart Types

All implemented in Recharts v2.12.7:

| Chart | Component | Used For |
|-------|-----------|----------|
| Area | `AreaChart + Area` | Time series trends (income, applications) |
| Bar | `BarChart + Bar` | Stage/category comparisons |
| Donut | `PieChart + Pie` (innerRadius 42, outerRadius 66) | Portfolio breakdown by product |
| Funnel | Custom divs (label \| bar \| count%) | Lead → Customer conversion |
| Multi-line | `LineChart + Line` (multiple) | DPD trends, multi-series comparisons |
| Horizontal bars | Custom divs with filled track | Leaderboards, top performers |

**Sparklines**: Custom SVG polyline+polygon, 80×24px, inline on KPI cards.

### 2.11 Approved Page Tab Pattern

```
[Tab: Pipeline & Table] [Tab: Analytics & Charts]
— border-bottom: 2px solid #C00000 on active
— marginBottom: -1 (overlaps the container border)
— padding: 10px 18px / fontSize 13px
— colour: var(--txt) active, var(--txt2) inactive
```

### 2.12 Approved Filter Panel

The filter panel slides open below the filter bar when the "Filters" button is clicked.

**Structure:**
- 3-column grid layout: Status | Product | Assignee (+ Score Range in column 3)
- Each column has a group label (10px/700 Inter uppercase, letterSpacing 0.7px)
- Each checkbox row: `label` wrapper, 16×16px custom checkbox div, text, count, optional pill
- Checkbox active colour by category: red for Status, navy for Product, green for Assignee
- Footer row: active chips on left, "Reset" + "Apply · N results" buttons on right
- Chips: pill style, `background: var(--chip-bg)`, `color: var(--chip-txt)`, 11.5px/600 Inter, × close button

**Score range slider**: visual only (2 thumb handles on a 4px track), not yet wired to real input.

**Filter Filters button state**: turns red border + red text + red badge when filters are active.

### 2.13 Table Specification

| Element | Value |
|---------|-------|
| Header bg | `var(--th-bg)` |
| Header font | 10px/700 Inter uppercase, letterSpacing 0.6px |
| Header padding | 11px 14px |
| Row padding | 12px 14px |
| Row border | `1px solid var(--bdr)` on bottom |
| Row hover | `background: var(--row-hvr)` |
| Row selected | `background: var(--row-sel)` |
| Checkbox | `accentColor: #C00000` |
| Score bar | 56px wide, 4px tall, `var(--bdr)` track, coloured fill |
| Action icons | 28×28px, borderRadius 7px, 1.5px border |
| Sort indicator | ↑ / ↓ in `#C00000`, ↕ at 30% opacity when unsorted |

**Batch bar**: appears above table when rows are selected. `background: var(--nav-act-bg)` (light) or `#0F1A30` (dark). "Assign to Sales" (red/primary), "Export", "Add to Campaign", "Archive" (ghost).

### 2.14 KPI Strip

Single card across full width, 4 columns separated by `1px solid var(--bdr)` dividers (not 4 separate cards).

Each column:
- Label: 10.5px/600 Inter, uppercase, letterSpacing 0.5px, `var(--txt2)`
- Icon: Material Symbol, 16px, coloured at 70% opacity
- Value: 28px/800 Inter + NUM style, letterSpacing -1.2px
- Delta: 11px/600 Inter, green (up) or red (down), with arrow icon
- Sparkline: 80×24px SVG, same colour as icon

### 2.15 Implementation Location

- **Page file**: `/frontend/src/pages/DesignDemo.tsx`
- **Public route**: `/design-demo` (no auth required)
- **Route bypass**: Added in `App.tsx` before auth check — `if (window.location.pathname === '/design-demo') { ... }` same pattern as the `/csat/` bypass
- **Fonts**: Sora + Inter already loaded in `index.html` via Google Fonts (alongside DM Sans / DM Mono)

### 2.16 Design System Rollout Approach (Approved)

The design system in `DesignDemo.tsx` is approved. The rollout to real pages proceeds as follows:

**Do not rebuild pages from scratch.** Carry the design tokens and component patterns into existing pages incrementally.

**Step 1 — Shared token shell**: Extract `LIGHT`, `DARK`, `SORA`, `INTER`, `NUM` constants and the `Tip` tooltip component into `/frontend/src/components/UI.tsx` or a new `/frontend/src/lib/design.ts` file so every page can import them.

**Step 2 — Sidebar**: Replace or update `/frontend/src/components/Sidebar.tsx` to match the approved 236px spec (section 2.4). This is the highest-visibility change — once the sidebar is updated, every page inherits the new look.

**Step 3 — Per-page migration**: Migrate pages in order of user-facing priority. Each page:
1. Applies theme token `var(--xxx)` colours instead of hardcoded hex
2. Updates card `borderRadius` to 14px and padding to 18px/20px
3. Updates all KPI values to use `NUM` style (Inter tabular-nums)
4. Updates table headers to 10px/700 Inter uppercase
5. Updates status pills to the approved colour spec (section 2.9)

**Step 4 — New modules**: All new modules (Telemarketing, Active Loan Book, BD, Payroll) are built using the approved system from day one — no migration needed.

**The production `Sidebar.tsx`** currently uses `#0E2841` navy always-dark background. The approved design uses `var(--sb)` (white in light mode). This is the one deliberate divergence to resolve when the sidebar is updated.

---

## PART 3 — Business Scenarios & User Flows

### 3.1 The BD Lead Pipeline Flow (Primary Scenario)

This is the full journey a lead takes from first touch to becoming a customer. It drives the entire Business Development module.

```
Bureau Leads (2,400)
    ↓ 40% engaged
Campaign Engaged (960)          ← Marketing campaign targets the bureau list
    ↓ 50% called
Telemarketing Called (480)      ← Outbound call team works the engaged list
    ↓ 30% qualified
Hot Leads / Sales Queue (144)   ← Telemarketing hands off qualified leads to Sales
    ↓ 50% apply
Applications (72)               ← Sales officer submits loan application in LOS
    ↓ 50% approved & funded
Customers Won (36)              ← Risk approves, Finance disburses
```

**Who does what at each stage:**

| Stage | Owner | Tool Used | Next Action |
|-------|-------|-----------|-------------|
| Bureau list acquired | BD Head | External bureau | Import to Campaign |
| Campaign sent | Digital Marketing | Campaigns module | Track engagement |
| Engaged leads scored | Marketing/System | Lead scoring (auto-warm) | Push to Telemarketing queue |
| Outbound call | Telemarketing agent | Telemarketing module (to build) | Log disposition |
| Hot lead assigned | Telemarketing Head | Assignment workflow | BD/Sales takes over |
| Proposal & application | Sales Officer | LOS New Application | Submit to Risk |
| Credit review | Risk Officer | LOS Application Detail + Eye score | Approve/Decline |
| Disbursement | Finance Officer | Finance → Disbursements | Mark live in Loan Book |
| Relationship & cross-sell | Sales / CRM | Customer 360 + CRM Tasks | Retain and grow |

### 3.2 Page Transitions in the BD Flow

**Path 1: Campaign → Telemarketing hand-off**
```
Campaigns → Analytics → "Hot Engaged" leads list
  → filter by engagement score ≥ 70
  → "Push to Telemarketing" batch action
  → Telemarketing Outbound Queue receives them
```

**Path 2: Telemarketing → Sales hand-off**
```
Telemarketing: Outbound Queue
  → Agent opens call → logs disposition: "Interested, qualified"
  → Lead status changes to "Hot"
  → System assigns to Sales Officer (or BD Head assigns manually)
  → Sales: BD Leads → My Pipeline shows new hot lead
```

**Path 3: Sales → Application**
```
BD Leads: My Pipeline
  → Officer opens lead record → reviews employer, salary, product interest
  → Click "Create Application" → routes to LOS New Application
  → LOS pre-fills: contact, employer, product type (Salary Loan)
  → Officer completes form → submits to Risk
```

**Path 4: Risk review → Disburse**
```
Risk: My Queue
  → Opens application → sees Eye credit score + bureau result + DTI
  → Reviews documentation → Approves (or requests more info)
  → Finance: Disbursement Queue → marks payment sent
  → Active Loan Book: loan appears with Day 1 balance
```

**Path 5: Post-disbursal lifecycle**
```
Customer 360: customer profile shows:
  - Active loan (type, outstanding balance, next due date)
  - FD holdings (if any, showing if pledged as collateral)
  - Card transactions
  - Helpdesk ticket history
  
Collections Queue (Day 31+ if missed payment):
  - Lead appears automatically based on DPD
  - Agent contacts, logs call, creates Promise to Pay (PTP)
  
Recovery (if >90 DPD or default):
  - Case created, legal stage tracking begins
  - TPA assigned if internal recovery fails
```

### 3.3 Fixed Deposit Lifecycle Scenario

```
Customer enquiry → Sales Officer logs FD enquiry in CRM
  → FD rate quoted → Customer accepts
  → Finance Officer creates FD record (principal, rate, tenor, start date)
  → System calculates maturity date + interest schedule
  → FD Certificate generated (PDF)

At maturity:
  → FD Maturity Calendar flags upcoming maturity (7 days before)
  → Call Center agent contacts customer: "Roll over or withdraw?"
  → Customer opts to roll over → Finance executes rollover at current rate
  → New FD record created, old one closed

If FD pledged as collateral for a loan:
  → FD record linked to Loan record in Active Loan Book
  → FD is "locked" — withdrawal blocked until loan is cleared
  → If loan defaults → Recovery can action FD lien
```

### 3.4 Card Operations Scenario

```
New credit card:
  Sales/Cards Ops → Issues card → Links to customer CIF
  Customer uses card → Transactions appear in real time (MSSQL)
  Monthly billing cycle → Statement generated
  Minimum payment tracked → Grace period monitored

If payment missed:
  Day 1–30: Cards Ops reminder (or auto-SMS)
  Day 31+: Ticket in Collections queue (separate from loan collections)
  Dispute raised: Customer calls helpdesk → Ticket created
    → Cards Ops investigates → provisional credit → resolution

Credit limit review:
  Risk Officer reviews utilisation rate
  Cards Ops Head approves limit change
  Logged in Customer 360
```

### 3.5 Business Loan Scenario

Business loans differ from salary loans: repayment comes from business cash flow, not payroll deductions. The LOS flow has extra steps.

```
BD Officer identifies SME prospect → logs in BD Lead Pipeline
  → Collects 6-month bank statements + audited accounts
  → Creates Business Loan application in LOS (type = "Business")
  → Risk Officer reviews:
       Eye credit score (ob_analytics on business account)
       Financial statement analysis: revenue, net margin, DSCR
       Existing borrowings from other lenders (bureau)
       Industry / sector risk classification
  → Internal credit memo prepared by Risk
  → Credit committee approval (MD + CFO if above threshold)
  → Finance disburses to registered business account
  → Active Loan Book: loan appears, repayment schedule shown
  → Monthly: repayment debited, statement generated
  → If DPD 30+: Collections queue — but strategy differs:
       Business loans require relationship-based contact, not script
       Offer Repayment Plan if cash flow issue is temporary
       Collateral enforcement if secured (see Recovery)
```

### 3.6 Collections → Recovery Handoff

This handoff is currently manual and undocumented. The workspace needs to make it automatic and auditable.

```
Collections Queue: account crosses DPD 90 threshold
  → System flags account: "Recovery Candidate"
  → Collections Head reviews: "Has PTP been broken 3+ times?"
  → If yes: One-click "Send to Recovery" action
  → Recovery case auto-created:
       Customer CIF, loan ref, DPD, outstanding kobo, collections history
       Last contact date, number of broken PTPs
  → Recovery agent assigned
  → Account disappears from Collections Queue
  → Collections Head notified: "Case #REC-00123 opened for [Customer]"
  → Recovery tracks: legal stage, field visits, TPA assignment
  → If TPA assigned: commission rate, expected recovery %, recovery timeline
  → Write-off: if Recovery deems irrecoverable → write-off recommendation
       Goes to approval queue: Finance Head + MD
       On approval: GL journal entry (write-off debit, provision release)
       Customer 360 updated: "Written off [date]"
```

**Trigger rules (configurable by Collections Head):**
- DPD ≥ 90 AND ≥ 3 broken PTPs → auto-flag for handoff
- DPD ≥ 120 → mandatory handoff regardless of PTP history
- FD-collateralised loan in default → immediate handoff (lien enforcement)

### 3.7 New Customer Onboarding / KYC Flow

How a new customer enters the system — from first contact to being a known, verified customer with a CIF.

```
Channel 1 (Walk-in / Sales):
  Sales Officer opens LOS New Application
  → Enters: Name, Phone, DOB, BVN, Employment, Address
  → System runs BVN lookup (backend calls NIN/BVN API)
  → BVN verified → CIF auto-generated
  → Photo ID uploaded (R2 storage)
  → Address verified (or flagged for field verification)
  → Customer record created in Supabase

Channel 2 (Mobile App):
  Customer downloads O3 Capital app → registers
  → Enters BVN, phone (OTP verified), selfie (liveness check)
  → KYC data synced to workspace Customer 360
  → Compliance Officer sees new registration in KYC queue
  → If BVN match fails: flagged for manual review

Channel 3 (Existing customer — product upgrade):
  Customer has Blink Card → wants a credit card or loan
  → Sales Officer opens their Customer 360 profile
  → KYC already verified → "Create Application" button
  → LOS pre-fills BVN, CIF, address from existing record
  → Only new fields needed: employment (for salary loan) or bank statements (business loan)
```

**KYC completion statuses tracked in Customer 360:**
- BVN verified ✅ / ❌
- Phone OTP verified ✅ / ❌
- Photo ID uploaded and approved ✅ / ❌ / ⏳ (pending review)
- Address verified ✅ / ❌ / 🏠 (field visit required)
- Overall KYC tier: Tier 1 (BVN only) / Tier 2 (ID + address) / Tier 3 (full AML cleared)

### 3.8 FD Early Withdrawal Scenario

Early withdrawal triggers a penalty calculation and finance approval — not just a button click.

```
Customer calls helpdesk: "I want to withdraw my FD early"
  → Helpdesk agent opens Customer 360 → sees active FD
  → Clicks "Request Early Withdrawal" (direct action from ticket)
  → System calculates:
       Interest earned to date vs contracted rate
       Early withdrawal penalty (configurable % of interest or principal)
       Net payable amount
  → Withdrawal request goes to Finance Officer's approval queue
  → Finance Officer reviews: "Is FD pledged as collateral for a loan?"
       If yes → BLOCKED. Customer must clear loan first
       If no → Approve
  → On approval: FD record status → "Withdrawn Early"
       GL journal: debit FD liability, credit customer payout account, debit penalty income
       Customer notified (email/SMS): withdrawal amount and settlement date
  → Helpdesk ticket auto-resolved when Finance approves
```

### 3.9 Cross-Sell Scenario: FD Customer → Credit Card

O3 Capital's most natural cross-sell. A depositor with a good relationship is the ideal credit card candidate.

```
Finance / Sales reviews: FD maturity upcoming (FD Maturity Calendar)
  → Flags customers with: FD ≥ ₦500,000, no existing credit card, good standing
  → Sales Officer opens Customer 360 for flagged customer
  → Calls customer (click-to-call from C360 via Zoho Voice)
  → Disposition: "Interested in credit card"
  → Creates CRM Task: "Send credit card proposal to [Customer]"
  → Sends proposal via Mail (Microsoft Graph) or WhatsApp from workspace
  
Customer accepts → Sales opens LOS application (type = Credit Card):
  → Eye credit score pulled automatically (bureau + BVN)
  → FD shown as potential collateral (can pledge FD to secure limit)
  → Risk sets initial limit based on FD value and Eye score
  → Cards Ops Head approves limit
  → Card issued → linked to CIF
  → Customer 360 now shows: Active FD + Active Credit Card
  → FD maturity alert now also shows: "Customer has credit card — offer rollover + limit increase"
```

### 3.10 Card Dispute Resolution (End-to-End)

```
Customer: "I did not authorise this ₦45,000 charge at [Merchant] on [Date]"

Channel: Inbound call
  → Zoho Voice webhook → ticket auto-created
  → Agent opens ticket: sees customer's recent transactions (MSSQL live data)
  → Confirms disputed transaction visible → logs dispute details
  → Ticket type changed to "Card Dispute" (structured custom fields):
       Transaction date, amount, merchant, dispute reason (unauthorised / duplicate / wrong amount)

Cards Ops receives ticket (auto-routed):
  → Reviews transaction details from MSSQL
  → Decision 1: "Provisional credit" — ₦45,000 credited to customer account within 24h (CBN requirement)
  → Logs provisional credit in Finance GL
  → Investigation opens: contacts card network (Mastercard/Visa chargeback process)

Resolution path A (dispute upheld):
  → Chargeback confirmed → provisional credit becomes permanent
  → Customer notified
  → Ticket closed: "Resolved — chargeback successful"

Resolution path B (dispute rejected):
  → Customer account re-debited (provisional credit reversed)
  → Customer notified with reason
  → If customer appeals → escalate to Compliance Officer (CBN reportable)
  → Ticket type changed to "Complaint (CBN reportable)" → 5-day SLA applies

All disputes auto-appear in CBN Consumer Protection quarterly return.
```

---

## PART 4 — Department Coverage Audit

This section maps each department to what currently exists in the workspace, what's partially covered, and what's missing entirely.

### 4.1 Management (MD, COO, CFO, CMO, CTO)

**Roles in system:** `md`, `coo`, `cfo`, `cmo`, `executive`
**Missing:** Dedicated CTO/tech role (`it_admin` is operations-only, not strategic)

| Coverage | Status |
|----------|--------|
| MD full cross-platform access | ✅ Complete |
| CFO finance + reconciliation + P&L | ✅ Good |
| CMO campaigns + marketing access | ⚠️ Legacy role, no canonical `cmo` in new 24-role structure |
| Executive dashboard (KPI overview) | ✅ Exists |

**Gaps:**
- No consolidated **P&L by business line** — Cards vs Loans vs FD side by side. Management cannot see which product is profitable
- No **CTO role** — strategic tech visibility (system health, sync status, API keys) without full admin access
- No **board-level report** — single page: portfolio health + revenue + cost + risk metrics together
- CMO needs proper canonical role added to the system

### 4.2 Sales

**Roles:** `sales_officer`, `sales_head`
**Pages:** Sales Overview, LOS Queue/Applications/Detail, CRM Pipeline + Contacts + Tasks + Reports

| Coverage | Status |
|----------|--------|
| Individual loan origination | ✅ Complete |
| CRM pipeline (Kanban) | ✅ Complete |
| CRM contacts + tasks | ✅ Complete |
| Customer list | ✅ Complete |

**Gaps:**
- No **individual sales targets vs actuals** — "Officer A is at 12/20 loans this month"
- No **lead source tracking** — referral? campaign? walk-in? digital? not captured
- No **product recommendation tool** — nothing guides officer to right product (Salary vs Individual vs Business)
- No **referral management** — staff and customer referrals tracked nowhere
- No **loan type segmentation** in their views — all products mixed together

### 4.3 Business Development

**Roles in system:** NONE — BD does not exist in the role structure at all.

**Needs entirely:**
- New roles: `business_dev_officer`, `business_dev_head`
- **Employer Register** — approved companies with salary loan agreements, limits, contact person, status (active MoU / pending / expired)
- **BD Lead Pipeline** — distinct from Sales CRM. BD manages institutional/employer relationships, not individual applicants
- **Partnership pipeline** — track MoU negotiations, signed partners, volumes per partner
- **Channel performance** — loans originated via: Branch / Agent / Digital / Corporate
- **BD Analytics** — conversion rates by employer, by sector, pipeline value

### 4.4 Digital Marketing

**Roles in system:** CMO (legacy), no canonical marketing role
**Pages:** Campaigns module — email builder, contact lists, templates, analytics, campaign reports

| Coverage | Status |
|----------|--------|
| Campaign creation + sending | ✅ Complete |
| Contact list management | ✅ Complete |
| Campaign analytics / open rates | ✅ Complete |
| Message templates | ✅ Complete |

**Gaps:**
- No **`marketing_officer` / `marketing_head`** canonical roles — marketing staff login with wrong access level
- No **lead source attribution** — which campaign generated which loan application? Not linked
- No **acquisition funnel** — impressions → clicks → sign-ups → applications (top-of-funnel not tracked)
- No **A/B test tracking** on campaigns
- No **SMS/WhatsApp campaign integration** in the workspace (WhatsApp handler exists in backend but not surfaced)
- **Telemarketing is a separate department** (see below) — currently conflated with marketing

### 4.5 Telemarketing

**Roles in system:** NONE — completely absent.
**Status:** Module does not exist anywhere.

**What it needs:**
- New roles: `telemarketing_agent`, `telemarketing_head`
- **Outbound Queue** — list of leads to call today (from campaigns or bureau list), prioritised by score
- **Call Disposition** — outcome logging: Interested / Not Interested / Call Back / Wrong Number / DNC
- **Call Script** — structured script per campaign/product type displayed during call
- **DNC List** — Do Not Call list management; calls to DNC numbers blocked
- **Click-to-call via Zoho Voice API** (confirmed — see PART 10.4). Agents dial from the workspace; no separate Zoho app or PBX needed
- **Performance dashboard** — calls made, dispositions, conversion rate per agent
- **Hand-off to Sales** — one-click to assign a "Hot" lead to a Sales Officer

### 4.6 Call Center / Customer Service

> **Architecture decision (2026-07-02):** Zoho Desk is being replaced with a fully native helpdesk. Zoho Voice is retained for both inbound and outbound calls via API. See PART 10 for the full native helpdesk specification.

**Roles:** `call_center_agent`, `call_center_head`
**Pages:** Helpdesk (queue, ticket detail, CSAT, call log, stats, canned responses), Customer 360

| Coverage | Status |
|----------|--------|
| Inbound ticket queue | ✅ Complete |
| Ticket detail + reply | ✅ Complete |
| CSAT tracking | ✅ Complete |
| Call log | ✅ Complete |
| Customer 360 lookup | ✅ Complete |
| Canned responses | ✅ Complete |

**Gaps:**
- No **call scripting** — structured scripts per call type (FD maturity, loan status, card dispute, balance enquiry). Agents improvise
- No **SLA breach alerts** — can see stats but no real-time "Ticket #123 breached SLA 2 hours ago" alert
- No **escalation workflow** — when ticket escalates: to whom, why, time to resolution
- No **inbound routing rules** — who handles cards vs loans vs FD vs complaints
- No **product knowledge base** — agents have nowhere to look up rates, terms, product features

### 4.7 Human Resources

**Roles:** `hr_officer`, `hr_manager`
**Pages:** Employees, Leave, Performance, Disciplinary, Training

| Coverage | Status |
|----------|--------|
| Employee directory | ✅ Complete |
| Leave management | ✅ Complete |
| Performance reviews | ✅ Complete |
| Disciplinary tracking | ✅ Complete |
| Training management | ✅ Complete |

**Gaps (Major):**
- **No payroll module** — this is a critical gap. HR sees employees and leave but cannot process salaries. Needs: gross pay → deductions (PAYE, NHF, pension) → net pay → payment file
- No **recruitment / applicant tracking** — job postings, CVs, interview stages
- No **org chart / reporting lines** — structure is not visualised
- No **onboarding checklist** — tasks for new hires (IT setup, ID card, benefits enrolment)
- No **staff exit / offboarding** — clearance process, final pay, access revocation
- No **pension / HMO tracking** — PENCOM registration, HMO enrolment status
- No **staff loan visibility** — employees who borrow from O3 should show in HR view

### 4.8 Settlement & Reconciliation

**Roles in system:** No dedicated role — falls under `finance_officer` / `finance_head` (too much access)
**Pages:** Settlements Overview, Reconciliation (Paystack + Interswitch only)

**Gaps:**
- No **`settlement_officer`** role — settlement staff get over-permissioned via finance role
- **NIP/NIBSS/NAPS not covered** — only Paystack and Interswitch. Interbank transfers unreconciled
- No **failed transaction queue** — transactions failing mid-posting need retry / manual resolution workflow
- No **manual posting workflow** — structured approval process for manual credits
- No **daily settlement report** — auto-generated morning report of prior day net position
- No **inflow vs. outflow dashboard** — net daily, weekly, monthly position by processor

### 4.9 Collections

**Roles:** `collections_agent`, `collections_head`
**Pages:** Overview (KPIs + roll-rate matrix), Queue (contact/PTP), Targets, Promises

| Coverage | Status |
|----------|--------|
| Portfolio overview with DPD buckets | ✅ Complete |
| Agent queue with contact/PTP flow | ✅ Complete |
| Targets tracking | ✅ Complete |
| Promise to Pay logging | ✅ Complete |
| Roll-rate matrix | ✅ Complete |

**Gaps:**
- **No loan type segmentation** — delinquent salary loans, individual loans, and business loans all in same queue. Need different strategies for each
- No **per-agent dashboard** — individual agent's daily assignments, calls made, PTPs logged, conversion rate
- No **Repayment Plan module** — for customers needing multi-payment structured arrangement (not just a single PTP)
- No **bulk SMS/WhatsApp** from collection queue — agents manually contact one-by-one
- No **write-off recommendation engine** — system should flag accounts meeting write-off criteria
- No **last contacted** date/time visible on queue — agents don't know if a colleague already called today

### 4.10 Recovery

**Roles:** `recovery_agent`, `recovery_head`
**Pages:** Overview, Cases, Legal, Field Visits

| Coverage | Status |
|----------|--------|
| Case list | ✅ Complete |
| Legal stage tracking | ✅ Complete |
| Field visit log | ✅ Complete |

**Gaps:**
- No **TPA (Third Party Agency) management** — track which external debt collectors are working which accounts, commission rates, recovery %
- No **legal milestone tracker within a case** — court date → hearing → judgment → enforcement is not sequenced
- No **collateral management** — for secured loans, collateral details, valuation, enforcement actions
- No **settlement negotiation** — structured discount offers for full-and-final settlement
- No **debt sale tracking** — if NPL portfolio is sold, which accounts, at what price, to whom
- No **recovery P&L** — cost of recovery vs. amount recovered per account/agent/TPA

### 4.11 Compliance

**Roles:** `compliance_officer`, `compliance_head`, `internal_control_head`
**Pages:** Audit Trail, CBN Reports, Checklists, Findings, SARs, WatchList

| Coverage | Status |
|----------|--------|
| SAR filing | ✅ Complete |
| CBN regulatory reports | ✅ Complete |
| AML watchlist | ✅ Complete |
| Audit findings | ✅ Complete |
| Checklists | ✅ Complete |
| Audit trail | ✅ Complete |

**Gaps:**
- No **regulatory calendar** — upcoming CBN/FCCPC/NDIC deadlines with alerts
- No **KYC expiry dashboard** — customers whose BVN / address / ID expires need flagged for refresh
- No **AML auto-flagging** — rule-based alerts (transaction amount ≥ threshold, unusual pattern). Currently manual
- No **FCCPC consumer protection** reporting
- No **policy version control** — AML policy, credit policy documents with version history
- No **operational incident log** — breaches, system outages with regulatory notification tracking

### 4.12 Risk

**Roles:** `risk_officer`, `risk_head`
**Pages:** Risk Overview, Credit Portfolio, LOS All Applications, LOS Application Detail

| Coverage | Status |
|----------|--------|
| Portfolio health overview | ✅ Complete |
| NPL / PAR tracking (aggregate) | ✅ Complete |
| Application review queue | ✅ Complete |

**Gaps:**
- No **Eye score visibility in application detail** — credit scoring service exists (port 8001) but score is not shown in the LOS Application Detail page
- No **bureau result in application** — Creditchek/FirstCentral/CRC result not surfaced
- No **PAR by loan type** — PAR30/60/90 broken out by Salary vs Individual vs Business
- No **portfolio concentration report** — exposure by employer, sector, geography
- No **credit policy engine** — configurable scoring thresholds, maximum DTI, minimum score rules
- No **vintage analysis** — cohort tracking: loans booked in month X, how did they perform?
- No **credit file view** — single page: applicant's Eye score + bureau + existing loans + DTI calculation

### 4.13 Business Intelligence

**Roles in system:** NONE — BI does not exist in the role structure.
**Pages:** KPI Dashboard, Portfolio Metrics exist but are generic

**What it needs:**
- New roles: `bi_analyst`, `bi_head`
- Read-only access across all modules
- **Cross-module reporting** — query across Sales, Collections, Finance, Risk in one report
- **Data export** — CSV/Excel export from any table in the system
- **Scheduled reports** — reports auto-generated and emailed on a schedule
- **Custom dashboard builder** — BI team should be able to pin metrics from any module

### 4.14 Finance

**Roles:** `finance_officer`, `finance_head`
**Pages:** Finance Overview, Income, Transactions, EOD/Branch Reconciliation, Fixed Deposits, Settlements Overview

| Coverage | Status |
|----------|--------|
| Income management | ✅ Complete |
| Transactions ledger | ✅ Complete |
| End-of-day / branch reconciliation | ✅ Complete |
| Fixed deposit management (basic) | ✅ Complete |
| Settlements overview | ✅ Complete |
| Processor reconciliation (Paystack + Interswitch) | ✅ Complete |

**Gaps:**
- **No P&L by product line** — Finance cannot see Fixed Deposit revenue vs. Loan interest income vs. Card fee income side by side. All income is in one flat ledger
- **No payroll disbursement workflow** — HR approves salaries but Finance has no module to release the payment file to the bank. Payroll processing ends at HR and is manually handled outside the system
- **No GL chart of accounts** — income, expenses, and journal entries are not structured against a formal chart of accounts. No profit centre view by department
- **No cost tracking** — Finance tracks income but not departmental operational costs (marketing spend, recovery costs, IT costs)
- **FD interest accrual not automated** — interest is calculated on creation but daily accrual is not tracked in the system. Maturity payout amount is stored but the liability build-up is not visible
- **No budget vs. actuals** — annual/monthly budget targets not loaded, so there's no variance tracking
- **No intercompany / group reporting** — if O3 Capital has related entities, cross-entity consolidation is absent
- **No treasury / liquidity view** — cash at bank vs. FD liabilities vs. loan disbursements pending — Finance cannot see daily net funding position

### 4.15 IT / Administration

**Roles:** `it_admin`, (`cto` — needed, not yet in system)
**Pages:** Admin (Users, Roles, API Keys, Settings, Sync, Integrations, Mail Health)

| Coverage | Status |
|----------|--------|
| User management (create, suspend, reset password) | ✅ Complete |
| Role management (permissions per page) | ✅ Complete |
| API key management | ✅ Complete |
| Sync status and manual trigger | ✅ Complete |
| Mail health monitoring | ✅ Complete |
| Integration settings (Zoho, SendGrid, etc.) | ✅ Complete |

**Gaps:**
- **No CTO strategic view** — `it_admin` is operations-only. CTO needs: system health overview (uptime, error rate, DB pool usage, Railway deployment status, sync engine last-run), without full admin write access
- **No system health dashboard** — there is no page showing: API response time, Railway deployment status, MSSQL Cloudflare Tunnel status, last sync timestamps for all data sources, SSE connection count
- **No audit of admin actions** — who created/deleted users, who changed role permissions? Admin changes are not surfaced in the audit trail
- **No IT incident log** — system outages, degraded performance events, and remediation steps are tracked nowhere in the workspace
- **No vendor integration registry** — list of all third-party integrations with status, API key rotation dates, and owner (see PART 11)
- **No environment configuration diff** — staging vs. production env vars cannot be compared from within the workspace

### 4.16 Cards Operations

**Roles:** `cards_ops` (implicit under `finance_officer` / `sales_officer` — no dedicated role exists)
**Pages:** Cards Overview, Cards Trends, Cards Management, Blink Card Analytics, Mobile App Analytics

| Coverage | Status |
|----------|--------|
| Portfolio KPIs (active cards, spend volume) | ✅ Complete |
| Card transaction trends | ✅ Complete |
| Card management list | ✅ Complete |
| Blink Card (prepaid) analytics | ✅ Complete |
| Mobile wallet analytics | ✅ Complete |

**Gaps:**
- **No dedicated `cards_ops` role** — Cards staff use overly broad roles. Need a `cards_ops_officer` / `cards_ops_head` role scoped to card issuance, limits, and disputes only
- **No card issuance workflow** — no structured flow to issue a new card (physical or virtual): customer KYC check → card type selection → activation → CIF link
- **No credit limit review queue** — no workflow for Risk/Cards Ops to review and approve limit increases or decreases
- **No billing cycle / statement generation** — credit card statement generation, minimum payment tracking, and grace period monitoring are not in the workspace
- **No dispute / chargeback workflow** — customer disputes are logged as generic helpdesk tickets rather than structured card dispute cases with provisional credit and resolution steps
- **No card blocking / unblocking workflow** — freeze/unblock a card on request (lost, stolen, fraud) with audit trail
- **No KYC linkage status on prepaid cards** — cannot see what % of Blink Card holders have completed BVN verification (regulatory risk)
- **No prepaid top-up reconciliation** — top-up amounts received vs. balances credited are not reconciled in the system

---

## PART 5 — Module Roadmap

### New Modules to Build (Don't Exist)

| Module | Departments | Priority |
|--------|-------------|----------|
| Telemarketing (outbound queue + dispositions + DNC + scripts) | Telemarketing, Marketing | 🔴 Critical |
| Active Loan Book (post-disbursement lifecycle + repayment schedule) | Risk, Collections, Finance, Management | 🔴 Critical |
| Loan Type Tagging (Salary / Individual / Business across all modules) | All | 🔴 Critical |
| Business Development (employer register + corporate pipeline + BD analytics) | BD, Sales, Risk | 🔴 Critical |
| Payroll (monthly run + deductions + payslips + payment file) | HR, Finance | 🔴 Critical |
| Native Helpdesk (replace Zoho Desk — tickets, routing, context panel, SLA, knowledge base, Zoho Voice integration) | Call Center, All | 🔴 Critical |
| FD Maturity Calendar + Rollover workflow | Finance, Call Center | 🟠 High |
| Per-agent Collections Dashboard | Collections | 🟠 High |
| Repayment Plan (multi-PTP structured arrangement) | Collections | 🟠 High |
| Credit File view in Loan Detail (Eye score + bureau + DTI) | Risk | 🟠 High |
| Regulatory Calendar + deadline alerts | Compliance | 🟠 High |
| Legal Milestone Tracker (within Recovery case) | Recovery | 🟠 High |
| TPA Management (outsource, track, commission) | Recovery | 🟠 High |
| BI / Cross-module reporting + data export | BI, Management | 🟠 High |
| Settlement role + NIP/NIBSS reconciliation | Settlement | 🟠 High |
| Employer Register (approved companies for salary loans) | BD, Sales | 🟠 High |
| Lead scoring (auto-warm from campaign engagement) | Marketing, Telemarketing | 🟡 Medium |
| Bulk SMS/WhatsApp from Collections queue | Collections | 🟡 Medium |
| Write-off recommendation engine | Collections | 🟡 Medium |
| Portfolio concentration report (sector/employer/geography) | Risk | 🟡 Medium |
| Sales targets vs actuals per officer | Sales, Management | 🟡 Medium |
| KYC expiry dashboard | Compliance | 🟡 Medium |
| AML auto-flagging rules | Compliance | 🟡 Medium |
| Dispute / chargeback workflow | Cards, Helpdesk | 🟡 Medium |
| Staff loan tracking (HR view) | HR, Finance | 🟡 Medium |
| Recruitment / applicant tracking | HR | 🟡 Medium |

### Enhancements to Existing Modules

| Enhancement | Where |
|-------------|-------|
| Add Salary / Individual / Business tag to LOS (filter, report, prioritise) | LOS |
| Add lead source + campaign attribution to CRM contact | CRM |
| Surface Eye score + bureau result in Application Detail | LOS Detail |
| Add delegation to Approvals engine | Approvals |
| Add NIP/NIBSS to Reconciliation | Reconciliation |
| FD as collateral linkage to Loan | FD + LOS |
| Settlement / Recovery P&L views | Finance |
| Bulk communication from Collections queue (SMS + WhatsApp) | Collections |
| Last Contacted timestamp on Collections queue | Collections |
| Per-agent leaderboard on Sales Overview | Sales |
| Lead source field on New Application form | LOS |
| Credit limit review queue in Cards | Cards |
| Card blocking / unblocking workflow with audit trail | Cards |
| KYC linkage status (BVN confirmed %) on Prepaid Cards | Cards |
| Prepaid top-up reconciliation | Cards / Finance |
| Finance P&L by product line (FD vs Loans vs Cards) | Finance |
| FD interest accrual daily tracking | Finance / FD |
| Maturity calculator / interest preview on FD creation | FD |

### New Roles to Add

| Role | Department | Access |
|------|------------|--------|
| `business_dev_officer` | Business Development | BD Leads, Employer Register, CRM, Campaigns |
| `business_dev_head` | Business Development | All BD + Sales reporting |
| `telemarketing_agent` | Telemarketing | Outbound Queue, Dispositions, DNC, Call Scripts |
| `telemarketing_head` | Telemarketing | Full telemarketing + performance dashboard |
| `marketing_officer` | Digital Marketing | Campaigns, Contact Lists, Templates, Analytics |
| `marketing_head` | Digital Marketing | All marketing + reporting |
| `settlement_officer` | Settlement | Settlements, Reconciliation only |
| `bi_analyst` | Business Intelligence | Read-only all modules, Export, Reports |
| `bi_head` | Business Intelligence | All BI + scheduled reports |
| `cto` | Management | System health, Sync status, API keys, Infrastructure view |

---

## PART 6 — Existing Page Inventory

### What Exists Today (confirmed in frontend/src/pages)

**Executive**
- `/` — Overview / Executive Dashboard
- `/approvals` — Unified approval queue

**Finance**
- `/finance/overview` — Finance Overview
- `/finance/income` — Income management
- `/finance/transactions` — Transactions ledger
- `/finance/eod` — End of Day / Branch reconciliation
- `/finance/reconciliation` — Processor reconciliation (Paystack + Interswitch)
- `/finance/fixed-deposit` — Fixed deposits (basic)
- `/settlements/overview` — Settlements overview

**Sales & CRM**
- `/sales/overview` — Sales overview
- `/sales/customers` — Customer directory
- `/sales/cohort` — Cohort analysis
- `/sales/cards` — Sales + cards view
- `/crm/pipeline` — CRM Kanban pipeline
- `/crm/contacts` — CRM contacts
- `/crm/tasks` — CRM tasks
- `/crm/reports` — CRM reports

**Loan Origination**
- `/los/all` — All applications
- `/los/queue` — My queue
- `/los/new` — New application
- `/los/:id` — Application detail

**Risk**
- `/risk/overview` — Risk overview
- `/risk/portfolio` — Credit portfolio
- `/kpi/dashboard` — KPI dashboard
- `/kpi/metrics` — Portfolio metrics

**Cards & Channels**
- `/cards/overview` — Cards overview
- `/cards/trends` — Card performance analytics
- `/cards/management` — Card management
- `/operations/blink-card` — Blink Card analytics
- `/operations/mobile-app` — Mobile wallet analytics

**Collections**
- `/collections/overview` — Collections overview
- `/collections-ops/queue` — Agent queue
- `/collections-ops/targets` — Targets
- `/collections-ops/promises` — Payment promises

**Recovery**
- `/recovery/overview` — Recovery overview
- `/recovery-ops/cases` — Case list
- `/recovery-ops/legal` — Legal proceedings
- `/recovery-ops/visits` — Field visits

**Customer 360**
- `/customer360` — Unified customer view

**Helpdesk / Customer Service**
- `/helpdesk/overview` — Helpdesk overview
- `/helpdesk/tickets` — Ticket list
- `/helpdesk/:id` — Ticket detail
- `/helpdesk/stats` — Stats
- `/helpdesk/canned` — Canned responses
- `/helpdesk/calls` — Call log
- `/csat/:token` — CSAT survey (public)
- `/customer-service/calls` — Call log
- `/customer-service/overview` — Overview

**HR**
- `/hr/employees`
- `/hr/leave`
- `/hr/performance`
- `/hr/disciplinary`
- `/hr/training`

**Compliance**
- `/compliance/audit-trail`
- `/compliance/cbn-reports`
- `/compliance/checklists`
- `/compliance/findings`
- `/compliance/sars`
- `/compliance/watchlist`

**Campaigns & Marketing**
- `/campaigns` — Campaign list
- `/campaigns/overview` — KPI dashboard
- `/campaigns/:id/report` — Campaign report
- `/campaigns/analytics` — Cross-campaign analytics
- `/marketing/templates` — Message templates
- `/marketing/lists` — Contact lists
- `/marketing/compose` — Compose

**Mail**
- `/mail/inbox`
- `/mail/sent`
- `/mail/compose`
- `/mail/drafts`

**Reports & Admin**
- `/reports` — Report builder
- `/statements` — Statement generation
- `/admin/overview`, `/admin/users`, `/admin/roles`, `/admin/api-keys`
- `/admin/settings`, `/admin/sync`, `/admin/mail`, `/admin/notification-settings`
- `/admin/email-senders`, `/admin/integrations`

**Design Demo**
- `/design-demo` — Design system demo (public, no auth)

---

## PART 7 — Technical Conventions

### Money
- All amounts stored in **kobo** (integer smallest unit)
- Divide by 100 for display
- Never store floats for money
- Format: `₦X,XXX` or `₦XXm` depending on context
- All amounts use Inter + NUM style (tabular-nums)

### Auth
- JWT HS256, 8-hour access tokens
- `pages: string[]` array embedded in JWT — backend is source of truth
- Frontend reads `user.pages` from JWT; falls back to `ROLE_PAGES` only if empty
- All protected routes use `<RequireAccess page="page_key" />`

### Backend Routes
- API: Go + chi router, port 8000
- All responses via `respond()` wrapper
- Route groups: 30+ modules all gated behind JWT middleware
- Eye (credit scoring): separate service, port 8001, `X-Service-Key` header required

### Database
- PostgreSQL (Supabase) — primary
- MSSQL (on-site via Cloudflare Tunnel) — card/transaction data (live)
- Dual queries via `DualQuery` / `DualScalar` pattern — MSSQL first, Postgres fallback

### Deployment
- Frontend → Cloudflare Pages (project: `o3c-workspace`)
- Backend → Railway (`railway redeploy --from-source --yes` from `backend-go/`)
- Never Vercel

---

## PART 8 — What "Done" Means

A feature is complete when:
1. Code is written with no syntax errors and correct logic
2. TypeScript: `tsc --noEmit` passes with zero errors
3. Real API call made (no stubs or hardcoded data)
4. Loading state shows skeletons
5. Error state shows inline banner + retry
6. Role guard is applied — only correct roles can access
7. Design matches approved system: Sora font, Inter numbers, 14px card radius, correct token colours
8. Dark mode works (all `var(--token)` references resolve correctly)
9. Go: `go build ./...` compiles cleanly
10. Deployed and health endpoint responds

---

*Document captured: July 2026. Contains all decisions, gap analysis, design approvals, and module roadmap discussed across sessions. Authoritative until superseded.*

---

## PART 9 — Implementation Roadmap

**Source:** Merged from `O3C-IMPLEMENTATION-PLAN.md` (generated from 11-agent audit, 2026-06-21).  
**Last status update:** 2026-07-02  
**Legend:** ✅ Done · ⚠️ Partial · ❌ Not started

### Phase Status Overview

| Phase | Theme | Effort | Status |
|-------|-------|--------|--------|
| **0** | Day 1 hotfixes | 4 hours | ✅ Complete |
| **1** | Security emergency | 3–4 days | ✅ Complete |
| **2** | Workflow unblockers | 1 week | ✅ Complete |
| **3** | Financial data integrity | 2 weeks | ✅ Complete |
| **4** | CI/CD & DevOps foundation | 1 week | ✅ Complete |
| **5** | Design system consolidation | 2–3 weeks | ✅ Complete |
| **6** | Analytics overhaul | 3–4 weeks | ✅ Complete |
| **7** | Page-level UX improvements | 3 weeks | ⚠️ ~70% — 7 tasks remain |
| **8** | Security Phase 2 (JWT cookies, MFA) | 3 weeks | ⚠️ 2 of 5 done |
| **9** | Backend architecture | 4 weeks | ❌ Not started |
| **10** | Observability | 2 weeks | ❌ Not started |
| **11** | Quarter 2 features | 6–8 weeks | ❌ Not started |
| **12** | Regulatory compliance | 8–12 weeks | ❌ Not started |

---

### PHASE 0 — Day 1 Hotfixes ✅
*All items complete.*

| # | Task | File | Status |
|---|------|------|--------|
| P0-01 | Fix XSS in MailCompose signature — wrap `dangerouslySetInnerHTML` in `sanitizeHtml()` | `pages/mail/MailCompose.tsx:530` | ✅ |
| P0-02 | Fix LOS assign field name mismatch — `assigned_to_user_id` → `assign_to_user_id` | `pages/los/AllApplications.tsx:129` | ✅ |
| P0-03 | Fix Safari date parsing — append `Z` not `T00:00:00` | `lib/fmt.ts:40` | ✅ |
| P0-04 | Fix bcrypt error silently discarded in `resetPassword` | `handlers/admin.go:270` | ✅ |
| P0-05 | Fix `migrate.go` continues on error — change `continue` → `log.Fatalf` | `backend-go/migrate.go` | ✅ |
| P0-06 | Fix Dockerfile base image — `golang:1.25` → `golang:1.23-alpine` | `Dockerfile:1` | ✅ |
| P0-07 | Remove Documents placeholder tab in LOS ApplicationDetail | `pages/los/ApplicationDetail.tsx` | ✅ |
| P0-08 | Fix AuditTrail export — replace raw `fetch` with `apiExport()` | `pages/compliance/AuditTrail.tsx:59` | ✅ |
| P0-09 | Reject Zoho webhook when secret is unconfigured | `handlers/zoho.go:1694` | ✅ |
| P0-10 | Add `.dockerignore` — exclude `.env`, uploads, logs | `backend-go/.dockerignore` | ✅ |
| P0-11 | Fix collections `target_kobo` hardcoded to 0 | `pages/collections/Overview.tsx` | ✅ |

---

### PHASE 1 — Security Emergency ✅
*All items complete.*

| # | Task | File | Status |
|---|------|------|--------|
| P1-01 | Mask `/api/settings/` — never return decrypted credentials | `handlers/settings_handler.go:51` | ✅ |
| P1-02 | Implement WhatsApp webhook HMAC verification | `handlers/whatsapp.go` | ✅ |
| P1-03 | Add `RequireAccess` guards to `/approvals` and `/reports` routes | `App.tsx:643, 736` | ✅ |
| P1-04 | JTI-based token revocation denylist — migration + middleware + logout | `core/auth.go`, `handlers/auth.go` | ✅ |
| P1-05 | Randomize OAuth state parameter — replace `base64(userID)` with random nonce + DB store | `handlers/voice.go` | ✅ |
| P1-06 | Strip infrastructure topology from `/api/health` — return only `{"status":"ok"}` | `main.go:84` | ✅ |
| P1-07 | Never return `temp_password` in API responses — email only | `handlers/admin.go:136` | ✅ |
| P1-08 | Page-name allowlist on `POST /api/admin/activity` | `handlers/` | ✅ |
| P1-09 | Enforce 12-character minimum password server-side | `handlers/auth.go` | ✅ |
| P1-10 | Make `BOOTSTRAP_SECRET` required in production | `config.go` | ✅ |
| P1-11 | Fix `ROLE_PAGES` divergence — serve page list from backend JWT | `hooks/useAuth.ts`, `core/auth.go` | ✅ |
| P1-12 | Stop trusting client-parsed JWT — call `/api/auth/me` on load | `App.tsx:499` | ✅ |

---

### PHASE 2 — Workflow Unblockers ✅
*All items complete.*

| # | Task | File | Status |
|---|------|------|--------|
| P2-01 | Replace Collections Queue Reassign text input with user dropdown | `collections-ops/Queue.tsx` | ✅ |
| P2-02 | Replace LOS Assign text input with user dropdown | `los/AllApplications.tsx` | ✅ |
| P2-03 | Build `ConfirmModal` shared component | `components/UI.tsx` | ✅ |
| P2-04 | Replace all `window.confirm()` calls with `ConfirmModal` (6 files) | Cases, CbnReports, Pipeline, Tasks, ApplicationDetail, RoleManagement | ✅ |
| P2-05 | Fix Customer 360 Collections tab — wrong API endpoint | `customer360/Customer360.tsx` | ✅ |
| P2-06 | Add Forgot Password link to Login | `pages/Login.tsx` | ✅ |
| P2-07 | Fix recovery rate formula — `recovered / original_exposure` not `recovered / (collected + recovered)` | `recovery/Overview.tsx` | ✅ |
| P2-08 | Add urgency colour-coding to Approvals `waiting_days` | `pages/Approvals.tsx` | ✅ |
| P2-09 | Add context text to ForceChangePassword screen | `pages/Login.tsx` | ✅ |
| P2-10 | Fix Compliance Findings — replace 120px inline input with slide-over panel | `compliance/Findings.tsx` | ✅ |
| P2-11 | Fix CBN Reports — add `ConfirmModal` for regulatory submission | `compliance/CbnReports.tsx` | ✅ |
| P2-12 | Add period labels to every KPI card on Overview (`MTD`, `All Time`, etc.) | `pages/Overview.tsx` | ✅ |

---

### PHASE 3 — Financial Data Integrity ✅
*All items complete.*

| # | Task | File | Status |
|---|------|------|--------|
| P3-01 | Fix LOS stage advance — add optimistic lock (`WHERE stage = $current_stage`) | `handlers/los.go:309` | ✅ |
| P3-02 | Fix write-off double-approval — add conditional UPDATE + 409 | `handlers/recovery_ops.go:499` | ✅ |
| P3-03 | Fix leave approval double-deduction — wrap in DB transaction | `handlers/hr.go:360` | ✅ |
| P3-04 | Fix promise mark-honoured — add ownership check | `handlers/collections_ops.go:226` | ✅ |
| P3-05 | Fix LOS stage advance — add role check against transition matrix | `handlers/los.go` | ✅ |
| P3-06 | Fix loan reference — replace `COUNT` with sequence | `handlers/loans.go:163` | ✅ |
| P3-07 | Wrap collection payment in DB transaction | `handlers/collections_ops.go` | ✅ |
| P3-08 | Wrap LOS booking in DB transaction | `handlers/los.go` | ✅ |
| P3-09 | (Covered by P3-03) | — | ✅ |
| P3-10 | Add GL journal entries to all financial operations (`gl_journal_entries` table + `postJournal()`) | `handlers/los.go`, `loans.go`, `collections_ops.go`, `recovery_ops.go` | ✅ |
| P3-11 | Fix MSSQL `DECIMAL` → `float64` precision loss | `backend-go/db.go` | ✅ |
| P3-12 | Fix `eodTotals` struct — replace `float64` with `int64` | `handlers/eod.go` | ✅ |
| P3-13 | Add missing DB indexes (notifications, loan_applications, activity_log, collections) | New migration | ✅ |
| P3-14 | Fix SSE — replace 2-second polling with `pg_notify` listener | `handlers/notifications.go:250` | ✅ |
| P3-15 | Add record-level RBAC — scope listings to personal portfolio for ICs | collections, los, recovery handlers | ✅ |

---

### PHASE 4 — CI/CD & DevOps Foundation ✅
*All items complete.*

| # | Task | File | Status |
|---|------|------|--------|
| P4-01 | Add `go test ./...` to CI pipeline with Postgres service | `.github/workflows/deploy.yml` | ✅ |
| P4-02 | Add `govulncheck` to CI | `.github/workflows/deploy.yml` | ✅ |
| P4-03 | Add `tsc --noEmit` to CI (before `npm run build`) | `.github/workflows/deploy.yml` | ✅ |
| P4-04 | Create Railway staging environment | Railway dashboard | ✅ |
| P4-05 | Add `build.sourcemap: true` to `vite.config.ts` | `frontend/vite.config.ts` | ✅ |
| P4-06 | Wire R2 for file uploads — replace filesystem storage | `handlers/admin.go`, upload handlers | ✅ |
| P4-07 | Move sync engine to Railway cron service | New Railway service | ✅ |
| P4-08 | Add structured JSON logging (`slog.NewJSONHandler`) | `main.go` | ✅ |
| P4-09 | Write rollback scripts for migrations 016–032 | `migrations/rollback/` | ✅ |
| P4-10 | Add Sentry for frontend error tracking | `frontend/src/main.tsx` | ✅ |
| P4-11 | Install vitest + @testing-library/react | `frontend/package.json` | ✅ |
| P4-12 | Write first critical frontend tests (`fmt.test.ts`, `DataTable.test.tsx`) | `frontend/src/lib/` | ✅ |
| P4-13 | Write first critical backend tests (LOS transitions, loan ref uniqueness) | `handlers/los_test.go` | ✅ |

---

### PHASE 5 — Design System Consolidation ✅
*All items complete.*

| # | Task | Status |
|---|------|--------|
| P5-01 | Extract `EmptyState` component → replace 12+ inline instances | ✅ |
| P5-02 | Extract `Tabs` component → replace 4 ad-hoc implementations | ✅ |
| P5-03 | Extract `Stepper` component → replace 3 ad-hoc implementations | ✅ |
| P5-04 | Extract `FormField` component → replace label variant implementations | ✅ |
| P5-05 | Extract `Toggle` component → replace Settings + UserManagement toggles | ✅ |
| P5-06 | Extract `Avatar` component → replace 5 independent implementations | ✅ |
| P5-07 | Extract `DetailField` component → replace 12+ instances | ✅ |
| P5-08 | Extract `InfoCallout` component → replace 8+ instances | ✅ |
| P5-09 | Extract `SearchInput` component → replace ad-hoc inputs | ✅ |
| P5-10 | Extract `FilterBar` component → replace 6+ card wrappers | ✅ |
| P5-11 | Extract `SectionLabel` component | ✅ |
| P5-12 | Extract `Pagination` component → replace 8 independent implementations | ✅ |
| P5-13 | Add `selectable` prop to DataTable | ✅ |
| P5-14 | Migrate `AllApplications` hand-rolled table to DataTable | ✅ |
| P5-15 | Migrate `Employees` hand-rolled table to DataTable | ✅ |
| P5-16 | Migrate Queue, Promises, Visits to DataTable | ✅ |
| P5-17 | Remove local Toast from TicketDetail — use Sonner everywhere | ✅ |
| P5-18 | Fix border-radius fork in LOS/HR/Collections modules | ✅ |
| P5-19 | Fix RED colour token — replace `#DC2626` with `#C00000` throughout | ✅ |
| P5-20 | Fix `'…'` loading placeholder → use `Sk` skeleton | ✅ |
| P5-21 | Raise all `text-[10px]` to `text-[11px]` | ✅ |
| P5-22 | Add 44px minimum touch targets to icon-only buttons | ✅ |
| P5-23 | Add `RoleManagement` to Page wrapper | ✅ |
| P5-24 | Extract `StageBadge` into shared LOS file | ✅ |
| P5-25 | Extract `StatusPill` + `PriorityPill` into shared Helpdesk file | ✅ |

---

### PHASE 6 — Analytics Overhaul ✅
*All items complete.*

| # | Task | Status |
|---|------|--------|
| P6-01 | Add MoM delta badges to all KPI cards | ✅ |
| P6-02 | Redesign Executive Dashboard (8 KPIs, P&L trend, portfolio donut, alerts, LOS pipeline) | ✅ |
| P6-03 | Redesign Finance Overview as management accounts (Income Statement, Balance Sheet, CBN Ratios) | ✅ |
| P6-04 | Collections Dashboard — add Roll Rate Matrix | ✅ |
| P6-05 | Add PTP Kept Rate, Contact Rate, Cure Rate to Collections | ✅ |
| P6-06 | Add DateFilter to Risk Overview, CRM Reports, Recovery Overview, HR pages | ✅ |
| P6-07 | Fix data freshness timestamp — show `data_as_of` from API, not render time | ✅ |
| P6-08 | Fix collections target — wire to actual daily targets | ✅ |
| P6-09 | Allow `risk_head` to see NPL Ratio KPI | ✅ |
| P6-10 | Add LOS pipeline ₦ value to LOS stats | ✅ |
| P6-11 | Add period-over-period comparison to CRM Reports | ✅ |
| P6-12 | Fix cohort average spend denominator | ✅ |
| P6-13 | Fix cohort retention thresholds for prepaid card norms | ✅ |
| P6-14 | Add LOS conversion funnel (stage drop-off chart) | ✅ |

---

### PHASE 7 — Page-Level UX Improvements ⚠️
*16 of 23 done. 7 items remaining (marked ❌).*

| # | Task | File | Status |
|---|------|------|--------|
| P7-01 | Collections Queue — add Last Contacted column | `collections-ops/Queue.tsx` | ✅ |
| P7-02 | Collections Queue — make Outstanding column sortable | `collections-ops/Queue.tsx` | ✅ |
| P7-03 | Collections Queue — combined Log Contact + Promise flow (single modal, 2 steps) | `collections-ops/Queue.tsx` | ✅ |
| P7-04 | Ticket Detail — add Ctrl+Enter to send reply | `helpdesk/TicketDetail.tsx` | ✅ |
| P7-05 | Ticket Detail — confirm before Close/Resolve status change | `helpdesk/TicketDetail.tsx` | ✅ |
| P7-06 | Ticket List — move Mine toggle to primary filter bar | `helpdesk/TicketList.tsx` | ✅ |
| P7-07 | Ticket List — add amber SLA threshold (< 2 hours remaining) | `helpdesk/TicketList.tsx` | ❌ |
| P7-08 | Ticket List — add Last Synced timestamp to Sync button | `helpdesk/TicketList.tsx` | ❌ |
| P7-09 | Customer 360 — add financial summary strip to Overview tab (DPD, outstanding, credit limit, last txn) | `customer360/Customer360.tsx` | ❌ |
| P7-10 | Customer 360 — add quick-action buttons to profile header (New Ticket, Log Promise, Call Customer) | `customer360/Customer360.tsx` | ❌ |
| P7-11 | Customer 360 — debounced live search (300ms, fires on type) | `customer360/Customer360.tsx` | ✅ |
| P7-12 | LOS ApplicationDetail — confirm before terminal stage advance (`booking`, `active`, `declined`) | `los/ApplicationDetail.tsx` | ✅ |
| P7-13 | CRM Pipeline — add New Deal button + `CreateDealModal` | `crm/Pipeline.tsx` | ❌ |
| P7-14 | Audit Trail — 300ms debounce on filter inputs + actor dropdown filter | `compliance/AuditTrail.tsx` | ✅ |
| P7-15 | Collections Promises — interactive sort by promise date + amount column + row colour-coding | `collections-ops/Promises.tsx` | ❌ |
| P7-16 | Approvals — inline Approve/Decline for leave requests on card | `pages/Approvals.tsx` | ✅ |
| P7-17 | Finance Reconciliation — persist filter state across sub-tabs | `finance/Reconciliation.tsx` | ✅ |
| P7-18 | Admin UserManagement — group roles by department in dropdown | `admin/UserManagement.tsx` | ✅ |
| P7-19 | Add cross-tab logout via `storage` event listener | `App.tsx` | ❌ |
| P7-20 | SSE reconnection — re-fetch missed notifications after reconnect | `hooks/useNotifications.ts` | ✅ |
| P7-21 | Fix App.tsx God Component — extract `AppShell` layout | `App.tsx` | ✅ |
| P7-22 | Fix DataTable sort — wrap in `useMemo` | `components/UI.tsx` | ✅ |
| P7-23 | Add AbortController + 30s timeout to `apiFetch` | `lib/api.ts` | ✅ |

**Remaining Phase 7 work (in suggested order):**
1. P7-19 — Cross-tab logout (30 min): `storage` event on `o3c_token` key → call `signOut()`
2. P7-07 — Amber SLA threshold (30 min): add warning colour when `hoursRemaining < 2`
3. P7-08 — Last Synced timestamp (1 hour): show "Last synced: X min ago" after Zoho sync
4. P7-15 — Promises interactive sort (2 hours): clickable column headers, colour-coded rows
5. P7-09 — Customer 360 financial summary (2 hours): DPD, outstanding, credit limit strip in Overview tab
6. P7-10 — Customer 360 quick-actions (3 hours): New Ticket, Log Promise, Call Customer buttons
7. P7-13 — CRM New Deal (3 hours): New Deal button → `CreateDealModal` → `POST /api/crm/deals`

---

### PHASE 8 — Security Phase 2 ⚠️
*2 of 5 done. P8-01 (JWT cookies) is a major architectural change — do on a feature branch.*

| # | Task | Effort | Status |
|---|------|--------|--------|
| P8-01 | Move JWT from localStorage → HttpOnly cookies (BFF pattern). Backend: `Set-Cookie` on login, CSRF token for mutations, `/api/auth/refresh` endpoint. Frontend: remove `localStorage`, remove `Authorization: Bearer` header, add CSRF header, implement silent refresh. | 1 week | ❌ |
| P8-02 | MFA — TOTP for privileged roles (`md`, `cfo`, `coo`, `compliance_head`, `it_admin`, `admin`). Backend: `totp_secret_encrypted`, `totp_enabled` columns, setup/verify/challenge endpoints. Frontend: QR code in Settings, TOTP challenge screen on login. | 1 week | ❌ |
| P8-03 | Reduce JWT lifetime from 8 hours → 30 minutes. Add 7-day httpOnly refresh token (rotated on use). Implement silent refresh in `apiFetch` — retry on 401 with `X-Token-Expired: true`. | 2 hours (after P8-01) | ❌ |
| P8-04 | Idle session timeout — 30 min inactivity → logout. Warning modal at 25 min. Resets on mouse/keyboard/touch/scroll. | 2 hours | ✅ Done 2026-07-01 |
| P8-05 | Per-endpoint rate limits — password change: 3 req/min. `/api/customer360/*`, `/api/compliance/*`, `/api/hr/*`: 30 req/min. CSV exports: 5/hour. | 2 hours | ✅ Done 2026-07-01 |

**Note:** P8-01 (HttpOnly cookies) blocks P8-03. Both require thorough staging environment testing before deploying to production. P8-02 (MFA) is independent and can ship separately.

---

### PHASE 9 — Backend Architecture ❌
*Not started. Estimated 4 weeks.*

| # | Task | File | Effort |
|---|------|------|--------|
| P9-01 | Add API version prefix `/api/v1/`. Keep `/api/` as deprecated alias for 90 days. | `main.go` + all frontend `apiFetch` calls | 1 day |
| P9-02 | Introduce service layer. Extract business logic from HTTP handlers into `services/los/`, `services/helpdesk/`, `services/collections/`, `services/campaigns/`. Start with LOS. | `backend-go/services/` (new) | 2–3 weeks |
| P9-03 | Materialize KPI aggregates into `portfolio_daily_snapshot` table. Midnight batch job computes all dashboard metrics. Handlers read from snapshot instead of live aggregations. | New migration + batch worker + updated handlers | 1 week |
| P9-04 | Fix `activityLogger` — replace goroutine-per-request with buffered channel worker pool (1000-deep buffer, 5 worker goroutines). | `handlers/` activity logger middleware | 3 hours |
| P9-05 | Fix `streamCSV` — stream row-by-row via `csv.NewWriter(w)` instead of collecting all rows in memory. | CSV export handlers | 3 hours |
| P9-06 | Fix campaign dispatch — remove process-local `sync.Map`. Rely solely on `dispatch_lock_until` conditional UPDATE. | `handlers/campaigns.go:36` | 2 hours |
| P9-07 | Add OpenAPI spec generation (`swaggo/swag`). Doc comments on 20 most-used endpoints. Serve at `/api/docs`. | 20 handler functions | 1 week |
| P9-08 | Fix `getActivity` export — remove 200-row cap. Require `date_from`, error if range > 90 days. Stream rows. | Activity log handler | 2 hours |
| P9-09 | Fix `SetConnMaxIdleTime` on DB pool — add `db.SetConnMaxIdleTime(5 * time.Minute)`. | `backend-go/db.go:85` | 5 min |
| P9-10 | Add global request body size limit — `http.MaxBytesReader(w, r.Body, 5<<20)` middleware on non-upload routes. | `main.go` | 1 hour |
| P9-11 | Add PII blind indexes to `campaign_contacts` — `phone_hmac`, `email_hmac` columns. Remove plaintext columns. | New migration + `handlers/campaigns.go` | 3 hours |
| P9-12 | Add Content-Security-Policy header — audit all external resources, build policy, add to security headers middleware. | `main.go` security headers | 2 hours |

---

### PHASE 10 — Observability ❌
*Not started. Estimated 2 weeks.*

| # | Task | Effort |
|---|------|--------|
| P10-01 | Add OpenTelemetry to Go backend — instrument HTTP middleware, DB calls, outbound HTTP (SendGrid, Zoho). Export to Grafana Tempo or Datadog. | 1 week |
| P10-02 | Add Prometheus `/metrics` endpoint — request count by route/status, latency histogram, DB pool stats, SSE connections, circuit breaker state. | 3 hours (after OTel) |
| P10-03 | Set up Grafana Cloud (free tier) — connect Tempo + Loki + Prometheus. Build dashboards: API error rate, p99 latency, DB pool, SSE count, campaign throughput. | 2 hours setup |
| P10-04 | Add alerting (PagerDuty/Opsgenie) — API error rate > 1% for 5 min, p99 > 2s, MSSQL circuit breaker open, sync engine silent for 24h, Supabase pool > 80%. | 2 hours |

---

### PHASE 11 — Quarter 2 Features ❌
*Not started. Estimated 6–8 weeks.*

| # | Feature | Description | Effort |
|---|---------|-------------|--------|
| P11-01 | Global Search (Cmd+K) | Federated search across customers, tickets, loans, cases. `CommandPalette` component with keyboard nav. Backend: `GET /api/search?q=X&types=...` | 1 week |
| P11-02 | LOS Document Upload | `POST /api/los/:id/documents` → R2 storage. Restore Documents tab in ApplicationDetail with drag-and-drop upload zone. | 1 week |
| P11-03 | PDF Export | `GET /api/los/:id/pdf` — loan application summary PDF. Also Board Pack PDF from Executive Overview. | 1 week |
| P11-04 | Batch Approvals | Checkboxes on ApprovalCards + floating bulk bar + `POST /api/approvals/batch`. | 1 week |
| P11-05 | Collections Promises — dedicated endpoint | `GET /api/collections/promises` — all promises across portfolio, filterable. Remove 200-item workaround. | 3 days |
| P11-06 | Notification Preferences | `PATCH /api/users/notification-preferences`. Per-event-type opt-in/out. SSE delivery respects prefs. | 3 days |
| P11-07 | CRM Contact Detail Page | `/crm/contacts/:id` — full profile, activity feed (tickets, loans, calls, campaigns), edit form, related deals, tasks. | 1 week |
| P11-08 | CRM Pipeline — drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable`. On drop → `PATCH /api/crm/deals/:id` with new stage. | 1 week |
| P11-09 | Role Management — affected users preview | Before saving role permission change, show "This affects 12 users: [names]. Confirm?" | 3 days |

---

### PHASE 12 — Regulatory Compliance ❌
*Not started. Estimated 8–12 weeks. Requires compliance officer involvement.*

| # | Item | Description |
|---|------|-------------|
| P12-01 | Data Retention Purge Jobs | NDPR Art. 26 — delete `o3c_activity_log` > 7 years, `user_sessions` > 90 days, `token_denylists` after expiry, `notifications` > 90 days |
| P12-02 | Data Subject Rights API | `GET /api/compliance/data-subject/:id/export` (all PII). `DELETE` pseudonymises PII — does not delete financial records (CBN retention) |
| P12-03 | CBN Prudential Ratio Report | Automated CAR, Liquidity Ratio, NPL Ratio, Single Obligor Limit in CBN's prescribed format |
| P12-04 | Board Pack PDF | Monthly board report auto-generated from Finance Overview data: income statement, portfolio quality, KPI trends, risk summary |
| P12-05 | Credit Bureau Submission File | Monthly CRC/First Central CSV in prescribed format, automated from `loan_applications` |
| P12-06 | Concentration Risk Report | Single borrower exposure as % of portfolio, sectoral breakdown, geographic concentration |
| P12-07 | DPA Documentation | Document processing agreements for SendGrid, Zoho, Termii, Paystack (cross-border PII under NDPR) |
| P12-08 | SOC 2 Type II Readiness | Engage compliance partner. Implement: quarterly access reviews, change management log, vendor assessments, incident response runbook |
| P12-09 | Annual Penetration Test | External pen tester — web application (XSS, IDOR, auth bypasses), API security, webhook endpoints |

---

### Dependency Map

```
Phase 0 → unlocks → Phase 1 (security work builds on fixed baseline)
Phase 1 → unlocks → Phase 2 (safe to build workflow features after auth is sound)
Phase 2 → unlocks → Phase 3 (workflow correctness depends on fixed race conditions)
Phase 3 → unlocks → Phase 9 (service layer extraction easier after race conditions fixed)
Phase 4 → unlocks → Phase 3 (CI must catch race condition regressions)
Phase 5 → ConfirmModal (P2-03) must land before Phase 5 begins (Phase 5 uses it)
Phase 6 → depends on Phase 3 (correct data) and Phase 5 (correct components)
Phase 8 → P8-01/02/03 depend on Phase 1 (JTI revocation from P1-04 required)
Phase 8 → P8-01 must land before P8-03 (silent refresh needs HttpOnly cookie infra)
Phase 11 → depends on Phase 5 (shared components), Phase 4 (R2 for document upload)
Phase 12 → depends on Phase 3 (GL journals), Phase 1 (audit trail integrity)
```

---

### Current Position (as of 2026-07-02)

We are between **Phase 7** and **Phase 8**. The recommended sequence is:

1. **Finish Phase 7** (7 tasks, ~1 day): P7-19 → P7-07 → P7-08 → P7-15 → P7-09 → P7-10 → P7-13
2. **Complete Phase 8** in two tracks:
   - Track A (quick, independent): P8-02 MFA/TOTP — can ship standalone
   - Track B (architectural, feature branch): P8-01 HttpOnly cookies → P8-03 token lifetime reduction
3. **Phase 9** backend architecture follows naturally after Phase 8 stabilises

*Plan source: O3C-IMPLEMENTATION-PLAN.md (2026-06-30) — 200+ items from 11-agent audit. All task detail, file paths, and effort estimates are from that document.*

---

## PART 10 — Native Helpdesk & Zoho Voice Integration

**Decision (approved 2026-07-02):** Replace Zoho Desk with a fully native helpdesk built inside the O3C Workspace. Zoho Voice is retained for both inbound and outbound calls, surfaced via the Zoho Voice API from within the workspace — staff never need to open the Zoho UI.

### 10.1 Why Replace Zoho Desk

Zoho Desk is a generic ticketing tool. It cannot:
- See a customer's loan balance, DPD, outstanding amount, or FD holdings
- Trigger actions in O3C systems (create PTP, escalate to Collections, open a new application)
- Route tickets based on product type against O3C's own data
- Generate CBN Consumer Protection Quarterly Return format
- Connect call events to ticket creation automatically with caller ID lookup
- Integrate with the Collections queue, LOS, or Customer 360

A native helpdesk eliminates the sync lag, the Zoho OAuth dependency, the periodic import jobs, and the data gap. Tickets live in PostgreSQL alongside every other O3C record.

### 10.2 What We Keep from Zoho

| Zoho Product | Status | How Used |
|---|---|---|
| **Zoho Voice** | ✅ KEEP | Inbound + outbound calls via Zoho Voice API. Click-to-call from TicketDetail, Customer 360, Collections Queue. Webhooks for real-time call events. Call recordings linked in tickets. |
| **Zoho Desk** | ❌ REMOVE | All Zoho Desk OAuth, ticket sync, and import jobs removed. `handlers/zoho.go` Desk sections deleted. Voice sections kept and moved to `handlers/voice.go`. |

### 10.3 Native Helpdesk — What It Does Beyond Zoho Desk

#### Customer Context Panel (Zoho Desk cannot do this)
Every ticket shows a live panel pulled from O3C's own data:
- Active loans: product type, outstanding balance, DPD, next due date
- FD holdings: principal, rate, maturity date, pledged status
- Card status: credit limit, utilisation, last statement balance, minimum payment due
- Recent transactions (last 5, from MSSQL)
- Open tickets count (other channels)
- Collections history (any prior PTPs, broken promises)

#### Direct Actions from Ticket (Zoho Desk cannot do this)
Agents can trigger real O3C actions without leaving the ticket:
| Action | Where It Goes |
|---|---|
| Log Promise to Pay | Collections → Promises queue |
| Escalate to Collections | Creates Collections assignment for the account |
| Create New Application | Opens LOS New Application pre-filled with customer CIF |
| Raise Dispute | Creates a structured Card Dispute case |
| Request Statement | Triggers statement generation → email to customer |
| Escalate to Supervisor | Reassigns with escalation flag + notification |

#### Structured Ticket Types with Custom Fields
Each ticket type has its own required fields and SLA:

| Type | Custom Fields | SLA |
|---|---|---|
| General Enquiry | Subject, description | 24 hours |
| Balance Enquiry | Account type (loan/card/FD) | 4 hours |
| Payment Confirmation | Payment date, amount, reference | 4 hours |
| Card Dispute | Transaction date, amount, merchant, dispute reason | 48 hours (CBN requirement) |
| Statement Request | Account type, date range, delivery method | 2 hours |
| Loan Complaint | Loan ref, complaint category | 24 hours |
| FD Enquiry | FD ref, enquiry type (rate/maturity/rollover) | 8 hours |
| Technical / App Issue | Platform, description, screenshot | 8 hours |
| Complaint (CBN reportable) | Category per CBN Consumer Protection framework | 5 business days |

#### Inbound Call → Auto-Ticket (Zoho Desk does this poorly)
When Zoho Voice receives an inbound call:
1. Zoho Voice webhook fires with caller phone number
2. Backend looks up customer by phone HMAC index
3. Ticket auto-created: type = "Inbound Call", customer CIF pre-filled, assigned to the agent who answered
4. Agent sees ticket + full customer context before saying hello
5. After call ends: call duration, recording URL, and Zoho Voice call ID linked to the ticket
6. Agent adds notes and resolution → ticket closed

#### Auto-Routing by Product (Zoho Desk routing is rigid)
Ticket routing reads O3C data to decide the queue:

```
Card Dispute → Cards Ops queue
Missed Payment / PTP → Collections queue
Loan Complaint → LOS team
FD Enquiry → Finance / FD team
Technical Issue → IT / Admin queue
General → Call Centre general queue (round-robin by workload)
```

Rules are configurable from Admin → Helpdesk Settings (queue rules table in PG).

#### CBN Consumer Protection Compliance (Zoho Desk cannot do this)
- All complaint-type tickets are tagged against CBN's complaint category taxonomy
- Resolution within 5 business days is tracked and SLA-breached tickets are flagged
- Quarterly report auto-generates: complaint count by category, resolution rate, average resolution time, in CBN's prescribed format
- Linked to the existing `/compliance/cbn-reports` page

#### Knowledge Base (Zoho charges separately for this)
Internal article library for agents:
- Articles organised by product (Loans, Cards, FD, General)
- Search within the ticket detail view — agent types a keyword, matching articles appear
- Agents can insert article content directly into a reply
- Article feedback ("Did this help?") tracks which articles are actually useful
- Articles version-controlled — compliance can approve new versions before they go live

#### Agent Performance Dashboard (beyond Zoho's analytics)
Extending the existing `/helpdesk/stats` page:
- Per-agent: tickets handled, avg handle time, avg first response time, CSAT score, escalation rate
- Leaderboard (this week / this month)
- SLA breach rate by agent and by ticket type
- Busiest hours heatmap (when to staff up)
- Channel breakdown: call vs email vs WhatsApp per agent

### 10.4 Zoho Voice Integration Points

The workspace connects to Zoho Voice via the Zoho Voice API. Agents never open the Zoho dashboard.

**Outbound (click-to-call):**
- Click phone number anywhere (TicketDetail, Customer 360, Collections Queue, LOS) → Zoho Voice API initiates the call
- Call is bridged to the agent's desk phone or softphone
- Call ID returned immediately → linked to the open ticket or a new auto-created ticket

**Inbound:**
- Zoho Voice webhook → `POST /api/webhooks/zoho-voice`
- Backend receives: caller number, agent who answered, call ID, timestamp
- Caller lookup by phone HMAC → customer CIF resolved
- Ticket auto-created (or existing open ticket found and updated)
- Agent receives notification in workspace: "Inbound call from [Customer Name] — ticket #xxx opened"

**Call log:**
- `GET /api/helpdesk/calls` pulls from Zoho Voice API (already wired in `handlers/voice.go`)
- Call records show: direction (in/out), duration, agent, recording link, linked ticket ref
- Recordings streamed via Zoho Voice API — never stored in O3C systems

**Call disposition (after call ends):**
- Agent selects outcome: Resolved / Follow-up Required / Escalated / Wrong Number / No Answer
- Disposition written to the linked ticket as a note + status update
- If "Follow-up Required" → ticket stays open, due date set to +24h

### 10.5 Multi-Channel Ticket Sources

| Channel | Source | How ticket is created |
|---|---|---|
| Phone (inbound) | Zoho Voice webhook | Auto-created on call answer |
| Phone (outbound) | Agent click-to-call | Auto-created on call initiation |
| Email | Microsoft Graph inbound mail listener | Email body → ticket, thread replies synced |
| WhatsApp | WhatsApp webhook (already in `handlers/whatsapp.go`) | Inbound message → ticket, replies sent via WhatsApp |
| Walk-in / Manual | Agent creates directly | New Ticket button in workspace |
| Web form | Customer self-service (future) | POST to `/api/helpdesk/tickets` |

All channels feed into the same unified queue. Agents see channel icon on each ticket. Replies go back via the originating channel (email reply → email, WhatsApp → WhatsApp).

### 10.6 What Gets Removed from the Codebase

| Item | Action |
|---|---|
| Zoho Desk OAuth flow in `handlers/zoho.go` | Delete |
| Zoho Desk ticket import / resync jobs | Delete |
| Zoho Desk webhook receiver (ticket updates from Zoho) | Delete |
| `zoho_credentials` DB entries for Desk | Remove; keep Voice credentials |
| Periodic Zoho Desk resync scheduler | Delete |
| `zoho_tickets` sync table (if exists) | Drop; tickets now live natively in `helpdesk_tickets` |

### 10.7 What Gets Built (Native Helpdesk Schema)

Core tables (new migrations):
```sql
helpdesk_tickets (
  id, ref TEXT UNIQUE,        -- e.g. TKT-000123 (sequence)
  customer_cif TEXT,
  channel TEXT,               -- 'phone' | 'email' | 'whatsapp' | 'manual'
  ticket_type TEXT,           -- see type list above
  subject TEXT,
  status TEXT,                -- 'open' | 'in_progress' | 'pending_customer' | 'resolved' | 'closed'
  priority TEXT,              -- 'low' | 'medium' | 'high' | 'urgent'
  queue TEXT,                 -- routing destination
  assigned_agent_id BIGINT,
  sla_due_at TIMESTAMPTZ,     -- computed from ticket_type + created_at
  sla_breached BOOL DEFAULT false,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  zoho_call_id TEXT,          -- if created from a call
  custom_fields JSONB,        -- type-specific fields
  created_at, updated_at
)

helpdesk_messages (
  id, ticket_id,
  direction TEXT,             -- 'inbound' | 'outbound'
  body TEXT,
  body_html TEXT,
  channel TEXT,
  sender_type TEXT,           -- 'agent' | 'customer'
  sender_id BIGINT,
  attachments JSONB,
  created_at
)

helpdesk_calls (
  id, ticket_id,
  zoho_call_id TEXT UNIQUE,
  direction TEXT,             -- 'inbound' | 'outbound'
  agent_id BIGINT,
  customer_phone TEXT,
  duration_seconds INT,
  recording_url TEXT,
  disposition TEXT,
  started_at, ended_at
)

helpdesk_knowledge_base (
  id, title, body_html,
  product_tag TEXT,           -- 'loans' | 'cards' | 'fd' | 'general'
  status TEXT,                -- 'draft' | 'published'
  version INT,
  approved_by BIGINT,
  created_at, updated_at
)

helpdesk_routing_rules (
  id, name, conditions JSONB, target_queue TEXT, priority INT, active BOOL
)
```

### 10.8 Implementation Priority

This is a **Phase 11-level** feature (major new module). However, the transition from Zoho Desk to native can be done in stages:

**Stage 1 (can start now — remove Zoho Desk dependency):**
- Remove Zoho Desk sync from `handlers/zoho.go`
- Native ticket creation + reply already exists in the UI — just point it at PG directly
- Existing `helpdesk_tickets` table (or equivalent) becomes source of truth

**Stage 2 (core native features):**
- Inbound call → auto-ticket via Zoho Voice webhook
- Customer context panel in TicketDetail (pull from existing APIs)
- Structured ticket types + custom fields
- SLA timers running natively

**Stage 3 (differentiation features):**
- Direct actions from ticket (Log PTP, Escalate, Create Application)
- Auto-routing rules engine
- Knowledge base
- WhatsApp channel

**Stage 4 (compliance + analytics):**
- CBN Consumer Protection report
- Agent performance dashboard enhancements
- Customer self-service portal (see section 10.12)

### 10.9 Supervisor Live Monitoring Dashboard

A real-time view for the Call Center Head / Supervisor — the "wall board" equivalent.

**Page:** `/helpdesk/supervisor` (role: `call_center_head` only)

| Panel | Content |
|-------|---------|
| Live agents grid | Each agent as a card: name, status (Available / On Call / Wrap-Up / Break / Offline), current ticket ref, time in current status |
| Queue at a glance | Open tickets count, unassigned tickets, tickets breaching SLA in < 30 min, tickets already breached |
| Today's stats | Total tickets opened, closed, avg handle time, CSAT responses received |
| Active calls | Live calls via Zoho Voice: caller, agent, duration (updates every 10s via SSE) |
| SLA breach alert feed | Real-time: "Ticket #TKT-000234 SLA breached — 2h overdue, assigned to Agent A" |

**Agent status** is set by the agent (dropdown in their toolbar: Available / Break / Wrap-Up) and is visible system-wide to supervisors. The status also gates whether Zoho Voice routes inbound calls to that agent.

### 10.10 Ticket Merging

When the same customer contacts via two channels simultaneously (calls in while email is being handled), or raises duplicate tickets, agents need to merge them.

**Rules:**
- Only tickets for the same `customer_cif` can be merged
- Older ticket becomes the "parent" (keeps its ref number)
- All messages from the "child" ticket are moved to the parent thread with a merge note
- Child ticket status → "Merged" (not deleted — preserved in audit trail)
- `merged_into_ticket_id` column added to `helpdesk_tickets`
- CSAT survey is only sent for the parent ticket after resolution

**UI:** In TicketDetail header → "⋯ More" menu → "Merge ticket..." → search for the other ticket ref → confirmation modal showing both ticket subjects → confirm merge.

### 10.11 CSAT Survey Flow

The survey endpoint `/csat/:token` already exists. This documents the full end-to-end flow.

```
1. Ticket resolved or closed
   → Backend generates a time-limited CSAT token (expires 72 hours)
   → Stores: token, ticket_id, customer_cif, created_at, used: false

2. Customer notified (via originating channel):
   - Email → "How did we do? Click here: [link]"
   - WhatsApp → "Rate your experience (1-5): [link]"
   - SMS → Short link (if SMS integration exists)

3. Customer opens /csat/:token
   → No login required — public page
   → Shows: agent name, ticket subject, "How would you rate your experience?"
   → 1–5 star rating + optional comment (max 500 chars)
   → Submitted → token marked as used (one response per ticket)

4. Response stored in helpdesk_tickets:
   - csat_score (1–5)
   - csat_comment TEXT
   - csat_submitted_at TIMESTAMPTZ

5. Agent performance dashboard shows:
   - Per-agent CSAT average (last 30 days)
   - CSAT trend over time
   - Verbatim comments feed (filterable by score)
   - Low-score tickets flagged for supervisor review (score ≤ 2 → auto-notify supervisor)
```

### 10.12 Customer Self-Service Portal

**Planned for Stage 4.** Reduces inbound call volume for common enquiries.

**URL:** `https://help.o3capital.ng` (separate domain, same Go backend via `/api/public/` routes)

**No login for basic enquiries; OTP-verified for account-specific requests:**

| Feature | Auth required | Backend |
|---------|--------------|---------|
| Submit a ticket (general enquiry) | No — just name + phone | `POST /api/public/tickets` |
| Check ticket status (by ref) | No — ticket ref + phone last 4 digits | `GET /api/public/tickets/:ref` |
| Check my account balance | OTP (phone) | `GET /api/public/account` |
| Download statement | OTP (phone) | `POST /api/public/statement-request` |
| View/pay outstanding loan | OTP (phone) | `GET /api/public/loans` |
| Report a lost card | OTP (phone) | `POST /api/public/card-block` |
| Knowledge base search | No auth | `GET /api/public/knowledge-base?q=X` |

**OTP flow:** Customer enters phone → SMS OTP → verified → session cookie (30 min). No password required.

**Integration with workspace:** Tickets from the portal appear in the helpdesk queue with `channel = 'web'`. Agent responses go back via email or SMS. Account-specific actions (statement, card block) trigger the same backend workflows as agent-initiated actions.

---

## PART 11 — Integrations & Vendor Registry

Every external service O3 Capital Workspace connects to, what it does, and what happens if it goes down.

| Integration | Purpose | Direction | Handler | Fallback if down |
|-------------|---------|-----------|---------|-----------------|
| **Zoho Voice** | Inbound + outbound calls, call recording, webhooks | Bidirectional | `handlers/voice.go` | Agents use desk phones manually; tickets created manually |
| **SendGrid** | Transactional email (password resets, statements, loan notifications) | Outbound | `handlers/mail.go` | Queue emails, retry via cron. No silent failure — log error + alert admin |
| **Microsoft Graph** | Inbound email → helpdesk tickets, outbound replies | Bidirectional | `handlers/mail.go` | Emails missed until reconnect; webhook re-subscription required |
| **WhatsApp Business API** | Inbound customer messages → tickets, outbound replies + campaign delivery | Bidirectional | `handlers/whatsapp.go` | Manual follow-up; WhatsApp is optional channel |
| **Supabase (PostgreSQL)** | Primary database — all operational data | Read/write | `core/db.go` (pgx pool) | **Critical — no fallback**. Supabase HA handles failover |
| **MSSQL (on-site)** | Live card/transaction data from core banking | Read-only | `db.go` DualQuery | Serve stale data from PG cache (if materialized); show "data as of [timestamp]" |
| **Cloudflare Tunnel** | Secure tunnel to on-site MSSQL | Infrastructure | Network layer | MSSQL data unavailable — card pages show cached/empty data |
| **Supabase Storage / R2** | File uploads: documents, KYC photos, PDFs | Read/write | `handlers/uploads.go` | Queue upload for retry; do not block workflow on upload failure |
| **Eye service (port 8001)** | Credit scoring: ML model, SHAP, bureau enrichment | Outbound | `X-Service-Key` header | Score unavailable — loan officer can override and proceed with manual assessment note |
| **Credit Bureau (CRC / First Central)** | BVN lookup, credit history, bureau report | Outbound via Eye | Eye service | Log "Bureau unavailable" on application; officer proceeds with available data |
| **Termii / SMS gateway** | SMS notifications, OTP delivery | Outbound | (configured per env) | WhatsApp fallback for OTP; email fallback for notifications |
| **Railway** | Backend hosting, cron services, environment variables | Infrastructure | `railway redeploy` | N/A — Railway IS the deployment platform |
| **Cloudflare Pages** | Frontend hosting, CDN, edge caching | Infrastructure | Git push to main | N/A — Cloudflare IS the frontend platform |
| **Paystack** | Payment processor reconciliation | Read (reconciliation only) | `handlers/reconciliation.go` | Reconciliation delayed; manual import from Paystack dashboard |
| **Interswitch** | Payment processor reconciliation | Read (reconciliation only) | `handlers/reconciliation.go` | Same as Paystack fallback |
| **NIP/NIBSS** | Interbank transfer reconciliation | Read | Not yet wired (Phase 8 gap) | Manual |
| **Sentry** | Frontend error tracking | Outbound | `src/main.tsx` | Errors still logged to console; no alerting until Sentry reconnects |

### Integration Health Monitoring

The CTO system health dashboard (gap identified in section 4.16) should show:
- Last successful API call timestamp for each integration
- Error rate (last 5 min / 1 hour) per integration
- Circuit breaker state for MSSQL (open / closed / half-open)
- Sync engine last-run timestamps

### API Key Rotation Policy

| Service | Rotation frequency | Owner | Where stored |
|---------|-------------------|-------|-------------|
| SendGrid | Annual | IT Admin | Railway env var `SENDGRID_API_KEY` |
| Zoho Voice | Annual (or on staff change) | IT Admin | `zoho_credentials` table (encrypted) |
| WhatsApp token | Per Facebook policy (90 days) | IT Admin | `settings` table (encrypted) |
| Supabase DB password | Annual | IT Admin | Railway env var `DATABASE_URL` |
| Eye Service Key | Annual | IT Admin | Railway env var `EYE_SERVICE_KEY` |
| JWT Secret Key | Annual | IT Admin | Railway env var `SECRET_KEY` |
| Encryption Key | Never rotate without migration | IT Admin | Railway env var `ENCRYPTION_KEY` — changing this invalidates all encrypted fields |

> **Encryption key warning:** `ENCRYPTION_KEY` cannot be rotated without a data migration that re-encrypts all `EncryptedString` columns. Plan carefully before rotation.

---

## PART 12 — Staff Notification Strategy

This documents which system events trigger notifications, via which channel, and who receives them.

### Notification Channels

| Channel | Mechanism | Latency | Notes |
|---------|-----------|---------|-------|
| **In-app bell** | SSE (`pg_notify` → SSE stream) | Real-time | Wired — `handlers/notifications.go` |
| **Email** | SendGrid | Seconds | For non-urgent or out-of-office events |
| **WhatsApp** | WhatsApp Business API | Seconds | For customer-facing events, not staff |
| **SMS** | Termii | Seconds | For customers; staff use in-app |

### Event → Notification Matrix

| Event | Who is notified | Channel | Priority |
|-------|----------------|---------|----------|
| New ticket assigned to me | Assigned agent | In-app | Real-time |
| Ticket SLA breached | Assigned agent + supervisor | In-app + email | 🔴 Urgent |
| Ticket SLA warning (< 2 hours) | Assigned agent | In-app | 🟠 High |
| Ticket escalated to me | Escalation target | In-app | 🔴 Urgent |
| CSAT score ≤ 2 received | Supervisor | In-app | 🟠 High |
| New loan application assigned | Loan officer | In-app | Normal |
| Application approved / declined | Submitting officer | In-app | Normal |
| Application awaiting my approval | Approver | In-app + email | 🟠 High |
| Approval waiting > 48 hours | Approver + their manager | Email | 🟠 High |
| Payment promise (PTP) due today | Assigned collections agent | In-app | 🟠 High |
| PTP broken (payment not received) | Collections agent + head | In-app | 🟠 High |
| Account crosses DPD 90 (recovery threshold) | Collections head | In-app + email | 🔴 Urgent |
| FD maturing in 7 days | Finance officer + assigned sales officer | In-app + email | Normal |
| FD matured today (not actioned) | Finance head | Email | 🟠 High |
| New helpdesk ticket (unassigned > 30 min) | Call center head | In-app | 🟠 High |
| Inbound call received (to me) | Agent | In-app toast | Real-time |
| SAR filed | Compliance head | In-app + email | 🔴 Urgent |
| AML watchlist hit | Compliance officer | In-app | 🔴 Urgent |
| New leave request submitted | HR manager + reporting manager | In-app | Normal |
| Leave approved / declined | Requester | In-app + email | Normal |
| JWT / API key expiry approaching (30 days) | IT Admin | In-app + email | 🟠 High |
| Railway deployment failed | IT Admin + CTO | Email | 🔴 Urgent |
| MSSQL tunnel offline > 5 min | IT Admin + CTO | Email | 🔴 Urgent |
| Low CSAT score (agent) | Agent + supervisor | In-app | Normal |
| Bulk campaign sent | Campaign creator | In-app | Normal |
| Campaign delivery failed | Campaign creator + marketing head | In-app + email | 🟠 High |

### Notification Preferences

Per `P11-06`: users can opt-out of non-critical notification categories. Rules:
- 🔴 Urgent notifications cannot be turned off
- Supervisors cannot opt-out of SLA breach alerts for their team
- Email notifications respect business hours (08:00–20:00 WAT) unless 🔴 Urgent

### Staff Onboarding Notification Checklist

When a new staff account is created:
1. Welcome email sent with temporary password (existing — `handlers/admin.go`)
2. First-login force-change-password screen (existing)
3. In-app tour / getting started notification (❌ not yet built — recommend for PART 11 scope)
4. IT Admin receives: "New account created for [Name] with role [Role]" (audit trail notification)
5. HR Manager receives: "New employee [Name] activated in system" (for onboarding checklist)
