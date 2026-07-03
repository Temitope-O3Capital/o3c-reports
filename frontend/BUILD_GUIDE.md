# O3 Capital Workspace — Frontend Build Guide

> **How to use this document**
> Read this at the start of every build session. It is the single source of truth for all
> decisions made about the frontend rebuild. Every page spec, every design rule, every
> architectural principle is recorded here. Update it when decisions change.

---

## Part 1 — Organisational Context

O3 Capital has **14 departments**. The sidebar is organised around them.

| # | Department | Sidebar section |
|---|---|---|
| 1 | Call Centre / Telemarketing | Contact Centre |
| 2 | Customer Service | Contact Centre |
| 3 | Cards | Cards |
| 4 | Collections | Operations |
| 5 | Settlement & Reconciliation | Operations |
| 6 | Recovery | Operations |
| 7 | Finance | Finance |
| 8 | Sales | Sales & BD |
| 9 | Business Development | Sales & BD |
| 10 | BI | Intelligence |
| 11 | HR | People |
| 12 | IT | Admin |
| 13 | Compliance | Compliance |
| 14 | Risk | Operations |

Dept 1 and Dept 2 share a **Contact Centre** section. Telemarketing is outbound
lead-gen/soft-collection calls. Customer Service is inbound support ticketing. Same
physical team, different workflows. One Supervisor page covers both.

BD (dept 9) sits under **Sales & BD** — not a separate section.

---

## Part 2 — Core Architecture Principles

### 2.1 Each module is a complete workspace

Nobody crosses module boundaries to do their job. A Collections agent never
navigates to the Loan Book module. A Helpdesk agent never navigates to Sales.
All cross-module data is surfaced **inline** via context panels powered by the
Customer360 API.

### 2.2 RLS filters the data — the frontend reflects it

Backend Row Level Security already scopes data to the user's role/team. The
frontend does not re-filter. It just calls the endpoint and renders what comes back.
This means the SAME endpoint can serve multiple roles and return different rows.

### 2.3 Role-aware rendering — not duplicate files

Where the same page is accessed by multiple roles, use **one component file** with
role-based conditional rendering for tabs, columns, and action buttons. Only create
a separate file when the LIST shape is fundamentally different (different endpoint,
different columns, different filters).

### 2.4 Three navigation patterns within a module

| Pattern | When | Example |
|---|---|---|
| **Split View** | Browse + act without leaving the list | Collections Queue, Helpdesk Tickets, Telemarketing Queue |
| **Full Page Slide** | Deep detail with tabs and multiple actions | LOS Application Detail, Ticket Detail, Loan Detail, Payroll Run |
| **Modal** | Quick create / confirm / destructive action | New Campaign, Add Employee, Approve confirmation, Block card |
| **Inline Expand** | Row-level supplementary detail | Checklist items, EOD account breakdown, Approval history |

**Never** navigate a user to a different sidebar section to complete a task in their
current section.

### 2.5 No floating dark bulk bars

Batch/bulk action bar is always **inline at the top of the table**, `background: #F0F4FF`,
inside the table card. Never a floating dark bar at the bottom of the screen.

---

## Part 3 — Design System Rules

### 3.1 Tokens — always use CSS variables for neutrals

```
var(--bg)         page background
var(--sb)         sidebar + topbar background
var(--sb-bdr)     sidebar border
var(--card)       card background
var(--card-bdr)   card border
var(--card-shadow)card shadow
var(--txt)        primary text
var(--txt2)       secondary/muted text
var(--txt3)       placeholder/disabled text
var(--bdr)        general border colour
var(--row-hvr)    table row hover
var(--row-sel)    table row selected
var(--th-bg)      table header background
var(--input-bg)   input field background
var(--input-bdr)  input field border
var(--chip-bg)    chip/tag background
var(--chip-txt)   chip/tag text
var(--chart-grid) recharts grid line colour
var(--chart-lbl)  recharts axis label colour
var(--grp)        sidebar section header text
var(--nav-txt)    sidebar nav item text
var(--nav-act-txt)sidebar active item text
var(--nav-act-bg) sidebar active item background
var(--nav-dot)    active indicator bar (red)
var(--nav-hvr-bg) sidebar hover background
var(--sub-txt)    sub-item text
var(--sub-act)    sub-item active text
```

Brand colours are **hardcoded** (same in light and dark):
```ts
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE } from '../lib/design'
// NAVY=#0E2841  RED=#C00000  GREEN=#16A34A  AMBER=#D97706
// BLUE=#2563EB  PURPLE=#7C3AED
```

### 3.2 Typography

```ts
import { SORA, INTER, NUM } from '../lib/design'
// SORA  = body text, headings, labels
// INTER = numbers, badges, tags
// NUM   = CSS properties object: { fontFamily: INTER, fontVariantNumeric: 'tabular-nums', ... }
//         Spread onto any element displaying a number: <span style={NUM}>
```

### 3.3 Every page uses the Page shell from UI.tsx

```tsx
import { Page } from '../components/UI'
export default function MyPage() {
  return (
    <Page title="Page Title" subtitle="Optional subtitle" actions={<button>...</button>}>
      {/* content */}
    </Page>
  )
}
```

Never use a raw `<div>` as the page root.

### 3.4 Cards

```tsx
import { SectionCard, KpiCard } from '../components/UI'

// KPI strip — always 4 columns in a CSS grid
<div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:20 }}>
  <KpiCard label="Label" value="₦1.2B" icon="payments" change={4.2} />
</div>

// Section card wraps every table or chart
<SectionCard title="Title" subtitle="subtitle" badge={42} actions={<ExportBtn />}>
  ...
</SectionCard>
```

### 3.5 Tables — always DataTable or manual table with these exact classes

```tsx
import { DataTable } from '../components/UI'
// thead: background var(--th-bg)
// tbody rows: onMouseEnter → var(--row-hvr), selected → var(--row-sel)
// Sort: click column header → chevron icon rotates
// Bulk: checkbox column on left, batch bar appears above table when any selected
```

### 3.6 CSS variables do NOT work inside SVG attributes

Recharts `stroke`, `fill`, `stopColor` must use hardcoded hex:
```tsx
// WRONG:
<Area stroke="var(--nav-dot)" />
// CORRECT:
<Area stroke="#C00000" />
```

Use `var(--chart-grid)` only for CartesianGrid `stroke` if the value is passed
through a style prop on a wrapper div — not directly into Recharts props.
Use `'var(--chart-grid)'` as a JS string only when Recharts supports it. When in
doubt, use `'#E8EBF2'` (light) and accept it's slightly off in dark mode.

### 3.7 Money is always in kobo on the wire

All API amounts are integers in kobo. Use `fmt(amount)` from `lib/fmt` for display.
Never store or display floats. Never divide manually — use `fmt()`.

### 3.8 Status badges

```tsx
import { StatusBadge } from '../components/UI'
<StatusBadge status="Active" />   // green
<StatusBadge status="Pending" />  // amber
<StatusBadge status="Declined" /> // red
<StatusBadge status="Closed" />   // grey
```

Custom pill for LOS stages and other non-standard statuses:
```tsx
import { PILL_STYLES } from '../lib/design'
const p = PILL_STYLES[status] ?? PILL_STYLES.Lost
<span style={{ background: dark ? p.dkBg : p.bg, color: dark ? p.dkTxt : p.txt, ... }}>
  {status}
</span>
```

---

## Part 4 — Chrome (present on every page)

### 4.1 Sidebar (Sidebar.tsx)

- Width: 236px expanded, 64px collapsed
- Background: `var(--sb)` — white in light, `#04060C` in dark
- Border right: `1px solid var(--sb-bdr)`
- Logo row (50px): O3 navy square badge + "O3 **Capital**" text + WORKSPACE chip inline
- Section headers: 8.5px, uppercase, letterSpacing 1.3px, `var(--grp)`
- Nav item: height 32px, borderRadius 7px, margin 1px 0
  - Active: `var(--nav-act-bg)` bg, `var(--nav-act-txt)` text, 3×16px `var(--nav-dot)` bar at left -7px
  - Hover: `var(--nav-hvr-bg)` bg
- Sub-items: height 28px, 1×14px vertical line (red active, `var(--bdr)` inactive)
- Badge on module: red dot (urgent) or grey count pill
- Footer (from bottom): user row (navy gradient avatar, name, role, logout icon)

### 4.2 TopBar (in App.tsx header)

- Height: 48px
- Background: `var(--sb)` (must match sidebar)
- Border bottom: `1px solid var(--bdr)`
- Left: hamburger (mobile only, hidden md+)
- Right (L→R): dark/light toggle pill → Customer360 icon → Tasks icon → Mail icon
  → `|` divider → Approvals button (badge) → Notification Bell

### 4.3 Global overlays (always mounted)

- `C360Drawer` — Customer360 search slide-over, triggered from topbar icon
- `Toaster` — Sonner, top-right
- `ApprovalsPanel` — slide-over from Approvals button
- Idle warning modal (appears at 25 min inactivity, logs out at 30 min)
- `PageFade` — crossfade wrapper on every route change (`key={location.pathname}`)
- `PageErrorBoundary` — per route, shows Retry button

---

## Part 5 — Final Sidebar Structure

The canonical list of sections, modules, icons, routes, and sub-items.
**This is the ONLY correct sidebar structure. Do not add sections without updating here.**

```
── [no section header]
   Overview             space_dashboard    /                   no subs

── Sales & BD
   Business Dev         corporate_fare     /bd                 sub:
     All Leads            /bd/leads
     My Pipeline          /bd/pipeline
     Employer Register    /bd/employers
     BD Analytics         /bd/analytics
   Campaigns            campaign           /campaigns          sub:
     All Campaigns        /campaigns
     Templates            /campaigns/templates
     Contact Lists        /campaigns/lists
     Analytics            /campaigns/analytics
   Sales                trending_up        /sales              sub:
     Overview             /sales
     Cohort Analysis      /sales/cohort
     Reports              /sales/reports
   CRM                  contacts           /sales/crm          sub:
     Contacts             /sales/customers
     Pipeline             /sales/crm
     Tasks                /sales/tasks
   Loan Origination     receipt_long       /sales/applications sub:
     My Queue             /sales/applications
     New Application      /sales/applications/new
     [detail: /sales/applications/:id — Full Page Slide]

── Contact Centre
   Telemarketing        call               /telemarketing      sub:
     Outbound Queue       /telemarketing/queue
     DNC List             /telemarketing/dnc
     Performance          /telemarketing/performance
   Customer Service     support_agent      /helpdesk           sub:
     All Tickets          /helpdesk/tickets
     New Ticket           /helpdesk/new
     Call Log             /helpdesk/calls
     Supervisor           /helpdesk/supervisor
     Analytics            /helpdesk/stats
     Knowledge Base       /helpdesk/knowledge-base
     Canned Responses     /helpdesk/canned
     [detail: /helpdesk/:id — Full Page Slide]

── Cards
   Card Operations      credit_card        /cards              sub:
     Overview             /cards
     Cardholder Mgmt      /cards/management
     Issuance Queue       /cards/issuance
     Disputes             /cards/disputes
     Credit Limit Review  /cards/credit-limit   (also accessible to risk_officer)
     Billing Cycles       /cards/billing

── Operations
   Risk                 shield             /operations/risk    sub:
     App Review           /operations/risk/applications
     Portfolio Health     /operations/risk/portfolio
     Eye Credit Score     /operations/risk/eye
     Vintage Analysis     /operations/risk/vintage
   Collections          collections_bookmark /collections      sub:
     Overview             /collections
     Agent Queue          /collections/queue
     Promises to Pay      /collections/promises
     Repayment Plans      /collections/repayment-plans
     Write-off Queue      /collections/writeoffs
   Recovery             gavel              /recovery           sub:
     Overview             /recovery
     Cases                /recovery/cases
     Legal Tracker        /recovery/legal
     TPA Management       /recovery/tpa
   Settlements          compare_arrows     /settlements        sub:
     Batches              /settlements
     NIP Reconciliation   /settlements/nip
     Failed Transactions  /settlements/failed
     Manual Postings      /settlements/manual-postings

── Finance
   Finance              account_balance    /finance            sub:
     Overview             /finance
     Transactions         /finance/transactions
     Income               /finance/income
     Fixed Deposits       /finance/fixed-deposit
     EOD / EOB            /finance/eod
     P&L                  /finance/pnl

── Compliance
   Compliance           verified_user      /compliance         sub:
     AML Watchlist        /compliance/watchlist
     Regulatory Calendar  /compliance/regulatory
     Findings             /compliance/findings
     Checklists           /compliance/checklists
     Audit Trail          /compliance/audit-trail

── People
   HR                   badge              /hr                 sub:
     Employees            /hr/employees
     Leave                /hr/leave
     Performance          /hr/performance
     Disciplinary         /hr/disciplinary
     Training             /hr/training
   Payroll              payments           /payroll            sub:
     Overview             /payroll
     Monthly Runs         [list on overview, run detail: /payroll/runs/:id]
     [payslip: /payroll/runs/:runId/items/:itemId]

── Intelligence
   Reports & BI         bar_chart          /reports            sub:
     Cross-Module         /reports
     KPI Tracker          /reports/kpi
     Data Export          /reports/export
   Statements           receipt_long       /statements         no subs

── Admin
   Admin                admin_panel_settings /admin            sub:
     Overview             /admin/overview
     Users                /admin/users
     Roles                /admin/roles
     Email Senders        /admin/email-senders
     Mail Health          /admin/mail
     API Keys             /admin/api-keys
     Settings             /admin/settings
     Notif. Settings      /admin/notification-settings
     Integrations         /admin/integrations
     Audit Log            /admin/audit
     Sync Status          /admin/sync
```

---

## Part 6 — Role → Sidebar Visibility

Each role sees ONLY the sections relevant to their department.
Management roles (md, coo, cfo, cmo, executive, admin) see everything.

| Role | Sees |
|---|---|
| `sales_officer`, `sales_head` | Sales & BD, Contact Centre (Customer Service only) |
| `bd_officer`, `bd_head` | Sales & BD, Contact Centre (Customer Service only) |
| `telemarketing_agent`, `telemarketing_head` | Contact Centre |
| `call_center_agent`, `call_center_head` | Contact Centre |
| `cards_ops_officer`, `cards_ops_head` | Cards |
| `risk_officer`, `risk_head` | Operations (Risk + view of Cards Credit Limit) |
| `collections_agent`, `collections_head` | Operations (Collections only) |
| `recovery_agent`, `recovery_head` | Operations (Recovery only) |
| `settlement_officer` | Operations (Settlements only) |
| `finance_officer`, `finance_head` | Finance |
| `compliance_officer`, `compliance_head` | Compliance |
| `hr_officer`, `hr_manager` | People |
| `payroll_officer`, `payroll_manager` | People (Payroll only) |
| `it_admin`, `head_it` | Admin |
| `bi_analyst`, `bi_head` | Intelligence |
| `internal_control_head` | Compliance + Intelligence |

---

## Part 7 — Page Specifications

### How to read a page spec

Each spec lists:
- **Route** — the URL
- **Layout** — Full Page / Split View / Full Page Slide
- **KPIs** — 4-column strip at top (if present)
- **Charts** — Recharts chart types and what they show
- **Table** — columns, filters, sort, bulk actions
- **Right panel** — Split View detail panel contents
- **Modals** — what triggers them, what fields
- **Actions** — buttons and who can use them
- **Role rendering** — what changes per role

---

### 7.1 Overview (`/`)

**Layout:** Full Page  
**Access:** Management only (md, coo, cfo, cmo, executive, admin, management)  
**KPIs:** Portfolio Outstanding ₦ · Collections Rate % · Disbursements MTD ₦ · Active Customers  
**Charts:**
- Row 1L: Area chart — 12-month monthly disbursements (₦M)
- Row 1R: Donut — product mix (Salary Loan / Business Loan / Credit Card / Fixed Deposit / Prepaid)
- Row 2L: Stacked bar — DPD trend 6 months (PAR30 / PAR60 / PAR90 counts)
- Row 2R: Funnel / progress list — acquisition pipeline (Bureau Leads → Campaign → Telemarketing → Hot Lead → Application → Customer Won)
**Table:** Top performers — name, dept, amount MTD, count, sparkline trend  
**Strip:** LOS pipeline stage chip counts (Draft · Doc Collection · Risk Review · Pending · Finance · Booking · Active)

---

### 7.2 BD — BD Leads Overview (`/bd`)

**Layout:** Full Page  
**KPIs:** Total Leads · Hot Leads · Converted This Month · Conversion Rate %  
**Charts:**
- Bar — leads by stage (Prospect/Contacted/Proposal/Negotiation/Won/Lost)
- Progress list — top BD officers (name, leads owned, pipeline value)
**Table:** Recent activity (company, contact, product interested in, officer, score pill, status pill)

---

### 7.3 BD — My Pipeline (`/bd/pipeline`)

**Layout:** Full Page table  
**FilterBar:** Status pill filter · Assigned officer · Product type · Date added range  
**Table columns:** Company · Sector/headcount · Contact name · Product · Assigned · Score (colour-coded 0–100) · Status pill · Est. value ₦ · Actions  
**Sort:** Score desc default  
**Batch bar:** Reassign selected · Export CSV  
**Row click → Modal:** Lead detail — company info, contacts, activity log, notes, convert-to-LOS-application button  
**Button:** New Lead (modal: company, contact, product, source, assigned, notes)

---

### 7.4 BD — Employer Register (`/bd/employers`)

**Layout:** Full Page table  
**FilterBar:** Sector · Partnership status · Account officer  
**Table columns:** Company name · Sector · Staff count · Partnership status pill · Account officer · Added date  
**Batch bar:** Export  
**Button:** Add Employer (modal: company name, sector, address, HR contact, staff count, account officer)  
**Row click → Modal:** Employer detail — contact list, linked loan applications count, active loan book exposure

---

### 7.5 BD — BD Analytics (`/bd/analytics`)

**Layout:** Full Page  
**Charts:**
- Area — lead volume by month, 12 months
- Bar — conversion rate by officer
- Donut — lead source breakdown (Referral / Walk-in / Campaign / Digital / Corporate)
- Table — employer tier ranking by application volume

---

### 7.6 Campaigns — All Campaigns (`/campaigns`)

**Layout:** Full Page table  
**FilterBar:** Type (Email/SMS/WhatsApp) · Status (Draft/Scheduled/Sending/Sent/Failed) · Date range  
**Table columns:** Name · Type pill · Status pill · Recipients · Delivered · Opened · Clicked · Conversion · Created  
**Sort:** Created desc default  
**Batch bar:** Archive · Export  
**Button:** New Campaign → navigate to compose flow  
**Row click:** Navigate to Campaign Report (`/campaigns/:id/report`)

---

### 7.7 Campaigns — Campaign Report (`/campaigns/:id/report`)

**Layout:** Full Page Slide (breadcrumb: Campaigns → [Campaign Name])  
**Header:** Campaign name, type, status pill, period  
**KPIs:** Delivered · Opens · Clicks · Bounces · Unsubscribes  
**Charts:**
- Bar — delivery funnel (Sent → Delivered → Opened → Clicked → Converted)
- Area — opens over time (hourly/daily)
**Table:** Error log (address, error type, timestamp)  
**Actions:** Resend to failed (confirm modal) · Export report CSV

---

### 7.8 Campaigns — Templates (`/campaigns/templates`)

**Layout:** Full Page table  
**Table columns:** Name · Channel pill · Category · Last used · Created by  
**Button:** New Template (modal: name, channel, category, body with rich text)  
**Row actions:** Preview (modal) · Edit (modal) · Delete (confirm modal)

---

### 7.9 Campaigns — Contact Lists (`/campaigns/lists`)

**Layout:** Full Page table  
**Table columns:** List name · Contact count · Source · Created · Last used  
**Button:** New List (modal: name, description) · Import CSV  
**Row click → Slide-over:** Contact detail — paginated list of contacts in the list, add/remove individual

---

### 7.10 Campaigns — Analytics (`/campaigns/analytics`)

**Layout:** Full Page  
**Charts:**
- Area — total sends by month (Email / SMS / WhatsApp stacked)
- Bar — average open rate by channel, last 6 months
- Bar — top 5 templates by click rate
**Table:** Campaign performance summary (name, sent, open rate, click rate, conversion)

---

### 7.11 Sales — Overview (`/sales`)

**Layout:** Full Page  
**KPIs:** Applications Submitted MTD · Disbursed MTD ₦ · Pipeline Value ₦ · Win Rate %  
**Charts:**
- Area — monthly disbursements 12 months
- Bar — top performers (name, disbursements ₦)
**Table:** Recent applications (App#, applicant, product, amount, stage pill, officer, last updated)  
**Role rendering:**  
- `sales_head` sees all officers' data  
- `sales_officer` sees only their own

---

### 7.12 Sales — Cohort Analysis (`/sales/cohort`)

**Layout:** Full Page  
**Charts:**
- Area — cohort retention (customers still active at 3/6/12 months after origination)
- Bar — disbursement volume by booking month
**Table:** Cohort matrix — booking month × age (1m/3m/6m/12m) × % still active

---

### 7.13 CRM — Contacts / Customers (`/sales/customers`)

**Layout:** Full Page table  
**FilterBar:** Product · Status · Account officer  
**Table columns:** CIF · Name · Phone · Product pill · Officer · Status pill · Last activity  
**Sort:** Last activity desc default  
**Row click:** Opens C360 Drawer (NOT navigate away — inline customer context)  
**Batch bar:** Export · Assign officer (modal: select officer)

---

### 7.14 CRM — Pipeline (`/sales/crm`)

**Layout:** Full Page with view toggle (Table | Kanban)  
**Table columns:** Company/Name · Stage pill · Est. value ₦ · Owner · Last activity · Next action  
**Kanban columns:** Lead → Qualified → Proposal → Negotiation → Won / Lost  
  Each card: name, value, owner avatar, days in stage  
**Row/card click → Modal:** Deal detail — full info, notes, activity log, convert-to-LOS button  
**Batch bar (table view):** Reassign · Export

---

### 7.15 CRM — Tasks (`/sales/tasks`)

**Layout:** Full Page table  
**FilterBar:** Status (Open/Done/Overdue) · Priority · Owner · Due date  
**Table columns:** Title · Related (customer/deal name) · Due date · Priority dot · Status pill · Owner  
**Batch bar:** Complete selected · Reassign  
**Button:** New Task (modal: title, related record, due date, priority, assignee, notes)  
**Row actions:** Mark complete (inline) · Edit (modal)

---

### 7.16 LOS — My Queue (`/sales/applications`)

**Layout:** Full Page table  
**KPI strip (mini, 4 chips):** In Queue · Pending Docs · Awaiting Risk · Disbursed Today  
**FilterBar:** Stage · Product · Date submitted  
**Table columns:** App# · Applicant · Product pill · Amount ₦ · Stage pill · Officer · Last updated  
**Sort:** Last updated desc default  
**Row click:** Navigate to Application Detail (Full Page Slide)  
**Button:** New Application → `/sales/applications/new`  
**Role rendering:**  
- `sales_officer` → sees only their own applications (RLS)  
- `sales_head` → sees all sales applications

---

### 7.17 LOS — New Application (`/sales/applications/new`)

**Layout:** Full Page, multi-step form  
**Step indicator (top):** 1 Personal Info → 2 Employment → 3 Loan Request → 4 Documents → 5 Review → Submit  
**Step 1 — Personal Info:** Full name, DOB, gender, phone, email, BVN, NIN, address  
**Step 2 — Employment:** Employer (typeahead from Employer Register), job title, monthly salary ₦, employment type, start date  
**Step 3 — Loan Request:** Product type, amount ₦, tenor (months), purpose  
**Step 4 — Documents:** Upload checklist (ID, payslip, bank statement, offer letter) — each slot shows upload button + status  
**Step 5 — Review:** Summary card of all inputs, edit links per section  
**Navigation:** Next / Back buttons. Cannot skip steps. Submit triggers API call, redirects to created application detail.

---

### 7.18 LOS — Application Detail (`/sales/applications/:id`)

**Layout:** Full Page Slide  
**Header:** App# · Applicant name · Product pill · Amount ₦ · Status pill · Stage breadcrumb trail  
**Tabs (role-aware):**

| Tab | Sales | Risk | Finance |
|---|---|---|---|
| Summary | ✓ | ✓ | ✓ |
| Documents | ✓ | ✓ | ✓ |
| Verification | ✓ | ✓ | — |
| Credit Assessment | — | ✓ | — |
| Approval Chain | — | ✓ | ✓ |
| Bank Details | — | — | ✓ |
| Timeline | ✓ | ✓ | ✓ |

**Tab contents:**
- **Summary:** Personal info, employment info, loan terms
- **Documents:** Upload list with status pill per doc (Uploaded/Pending/Rejected), download links
- **Verification:** BVN match, NIN match, employer confirmation, bank account validation
- **Credit Assessment:** Eye score strip (score, band, colour), SHAP factor bars, bureau result card, DTI calculation, income validation
- **Approval Chain:** Approval steps with approver name, role, decision, timestamp, notes
- **Bank Details:** Account name, bank, account number, BVN linkage
- **Timeline:** Chronological activity log (who did what when)

**Action bar (role-aware, fixed bottom or right column):**

| Action | Sales | Risk | Finance |
|---|---|---|---|
| Advance Stage | ✓ | — | — |
| Request Docs | ✓ | ✓ | — |
| Approve | — | ✓ | — |
| Decline | — | ✓ | — |
| Refer to Committee | — | ✓ | — |
| Disburse | — | — | ✓ |
| Hold | — | — | ✓ |

Approve, Decline, Disburse → always require a ConfirmModal (with reason/notes field for Decline and Hold).

---

### 7.19 Operations — Risk — App Review (`/operations/risk/applications`)

**Layout:** Full Page table  
**FilterBar:** Stage (Risk Review / Pending Committee / Referred) · Product · Risk band · Date  
**Table columns:** App# · Applicant · Eye Score (coloured) · Risk Band pill · Income ₦ · DTI % · Amount ₦ · Product · Submitted  
**Sort:** Eye Score asc default (worst first)  
**Row click:** Navigate to Application Detail with Risk role context (Credit Assessment tab default)  
**Batch bar:** Export

---

### 7.20 Operations — Risk — Portfolio Health (`/operations/risk/portfolio`)

**Layout:** Full Page  
**KPIs:** NPL Ratio % · PAR30 Rate % · Avg Credit Score · Top Employer Exposure ₦  
**Charts:**
- Area — PAR30/PAR60/PAR90 trend, 12 months
- Donut — risk band distribution (Prime/Near-Prime/Sub-Prime/High-Risk)
- Bar — sector concentration (top 8 sectors by book %)
**Table:** Top employers by exposure (company, staff loans count, book ₦, % of total book, PAR30 count)

---

### 7.21 Operations — Risk — Vintage Analysis (`/operations/risk/vintage`)

**Layout:** Full Page  
**Table:** Cohort matrix — booking month (rows) × age (1m/3m/6m/12m cols) × % PAR30 at that age  
**Chart:** Heatmap or colour-coded table cells (green=<3%, amber=3-8%, red=>8%)  
**FilterBar:** Product type

---

### 7.22 Contact Centre — Telemarketing Queue (`/telemarketing/queue`)

**Layout:** Split View  
**Left list columns:** Name · Phone · Outstanding ₦ (if existing customer) · Priority dot · Last called · Last disposition  
**Left FilterBar:** Agent (head/manager only) · Priority · Disposition · DPD range  
**Left Batch bar:** Reassign · Skip selected · Export  
**Right panel (on row select):**
- Customer strip: name, phone, CIF (if existing), product
- Relationship summary: if existing customer — loan outstanding, DPD badge
- Call history: last 5 entries (date, duration, disposition, agent, notes)
- **Action form:**
  - Disposition selector (Answered-Interested / Answered-Not Interested / No Answer / Wrong Number / PTP / Callback)
  - Notes text area
  - PTP fields (if PTP selected): date, amount
  - Log Call button

---

### 7.23 Contact Centre — Telemarketing DNC List (`/telemarketing/dnc`)

**Layout:** Full Page table  
**Table columns:** Phone · Reason · Added by · Added date  
**Batch bar:** Remove from DNC (confirm modal)  
**Button:** Add to DNC (modal: phone number, reason)  
**FilterBar:** Date range

---

### 7.24 Contact Centre — Telemarketing Performance (`/telemarketing/performance`)

**Layout:** Full Page  
**FilterBar:** Agent · Date range  
**KPIs:** Total calls · Connected · PTP count · Conversion rate  
**Charts:**
- Bar — calls by disposition (all agents stacked)
- Bar — hourly call volume today
**Table:** Agent performance (name, calls, connected %, PTPs, conversion %)

---

### 7.25 Contact Centre — All Tickets (`/helpdesk/tickets`)

**Layout:** Split View  
**Left list columns:** Ticket# · Subject · Customer · Type pill · Priority dot · Status pill · Agent · SLA timer  
**Left FilterBar:** Status · Type · Priority · Agent · Date  
**Left Batch bar:** Reassign · Close selected · Export  
**Right panel (on row select):**
- Ticket preview: subject, type, first message, customer name/phone
- Customer context: CIF, product, DPD badge (if has loan)
- Quick actions: Assign to me · Open full detail  
**Row double-click OR "Open" button:** Navigate to Ticket Detail (Full Page Slide)

---

### 7.26 Contact Centre — Ticket Detail (`/helpdesk/:id`)

**Layout:** Full Page Slide  
**Left 60% — Conversation:**
- Header: Ticket# · Type pill · Status pill · Priority dot · SLA remaining timer
- Message thread (newest at bottom)
- Reply compose area (Tiptap rich text, attachments)
- Status action buttons: Resolve · Transfer · Escalate · Merge

**Right 40% — Context panel (tabbed):**
- **Customer Info:** Name, phone, CIF, email, address, ID verification status
- **Loans:** Active loans list (product, outstanding ₦, DPD badge, next payment date)
- **Cards:** Active cards (type, status, limit, balance, last tx date)
- **Compliance:** Watchlist hit (yes/no), open SARs, KYC expiry

**Quick action buttons (below context tabs):**
- Log PTP (modal: amount + date — sends to Collections)
- Request Statement (triggers statement email)
- Create SAR (modal: pre-fills customer)
- Escalate to Head (confirm modal with reason)

---

### 7.27 Contact Centre — New Ticket (`/helpdesk/new`)

**Layout:** Full Page form  
**Section 1 — Ticket Type:** 9 type cards (Card Dispute / Loan Query / Account Freeze / Transfer Issue / POS Complaint / App Issue / General Inquiry / Complaint / Other) — selecting changes dynamic fields  
**Section 2 — Customer:** Search by name/phone/CIF (typeahead hitting `/api/customer360/search`)  
**Section 3 — Details (static):** Subject, Priority (Low/Medium/High/Urgent), Assigned agent  
**Section 4 — Details (dynamic by type):**
- Card Dispute: card number, transaction date, disputed amount, dispute type
- Loan Query: loan reference, query details
- Account Freeze: reason, authorised by
- etc.
**Section 5 — Description:** Rich text, file attachments  
**Submit:** Creates ticket, redirects to Ticket Detail

---

### 7.28 Contact Centre — Supervisor (`/helpdesk/supervisor`)

**Layout:** Full Page  
**KPIs:** Queue depth · SLA breached today · Avg first response (min) · CSAT today  
**Agent status grid:** Card per agent — avatar, name, status dot (green=Available / amber=Busy / red=Offline / grey=Away), current ticket# if active  
**Real-time SLA breach feed:** scrolling list of tickets that crossed SLA in last 2 hours  
**Table:** Agent performance today (name, tickets handled, avg handle time, CSAT, escalations)  
**Charts (below table):**
- Bar — tickets by type (today)
- Line — queue depth over last 8 hours

---

### 7.29 Contact Centre — Helpdesk Stats (`/helpdesk/stats`)

**Layout:** Full Page  
**FilterBar:** Date range · Agent  
**Charts:**
- Line — CSAT trend (daily/weekly)
- Bar — avg handle time by ticket type
- Bar — resolution rate by agent
- Donut — ticket type distribution

---

### 7.30 Contact Centre — Knowledge Base (`/helpdesk/knowledge-base`)

**Layout:** Full Page  
**FilterBar:** Category · Status (Draft/Live/Archived)  
**List:** Article cards — title, category pill, status pill, "Helpful" % badge, last updated  
**Row click → Inline expand:** Article body renders below the row (not a new page)  
**Button:** New Article (modal: title, category, body rich text)  
**Row actions:** Edit (modal) · Publish/Unpublish · Archive  
**Search:** Full-text search across titles and bodies

---

### 7.31 Contact Centre — Canned Responses (`/helpdesk/canned`)

**Layout:** Full Page table  
**Table columns:** Title · Category · Last used · Created by  
**Button:** New Response (modal: title, category, body rich text)  
**Row actions:** Preview (modal) · Edit (modal) · Delete (confirm modal)

---

### 7.32 Contact Centre — Call Log (`/helpdesk/calls`)

**Layout:** Full Page table  
**FilterBar:** Agent · Outcome · Date range  
**Table columns:** Agent · Customer · Phone · Direction (Inbound/Outbound) pill · Duration · Outcome pill · Ticket# (link) · Date  
**Sort:** Date desc default

---

### 7.33 Cards — Overview (`/cards`)

**Layout:** Full Page  
**KPIs:** Active Cards · Transactions MTD · Open Disputes · Avg Utilization %  
**Charts:**
- Bar — transaction volume by type (Purchase/ATM/Online/Transfer) this month
- Donut — card type mix (Prepaid / Credit / Blink)
**Table:** Recent disputes (customer, card type, amount, dispute type, status pill, days open)

---

### 7.34 Cards — Cardholder Management (`/cards/management`)

**Layout:** Full Page table  
**FilterBar:** Card type · Status · BVN linked  
**Table columns:** CIF · Name · Card type pill · Status pill · Limit ₦ · Balance ₦ · Last transaction date  
**Sort:** Last transaction desc default  
**Batch bar:** Export  
**Row click → Modal:** Card detail — card info, recent transactions (last 10), BVN linkage status  
**Row actions:** Block (confirm modal with reason) · Unblock (confirm modal)

---

### 7.35 Cards — Issuance Queue (`/cards/issuance`)

**Layout:** Full Page table  
**FilterBar:** Card type · Status (Draft/Submitted/Approved/Issued/Rejected)  
**Table columns:** Request# · Customer · Card type · Status pill · Requested by · Submitted date · Last updated  
**Button:** New Issuance Request (modal: customer search, card type, delivery address)  
**Row click → Modal:** Issuance detail — customer KYC check result, card type, workflow steps  
**Role actions:**
- `cards_ops_officer`: can create, can submit
- `cards_ops_head`: can approve, can reject, can mark issued

---

### 7.36 Cards — Disputes (`/cards/disputes`)

**Layout:** Full Page table  
**FilterBar:** Dispute type · Status · Date range  
**Table columns:** Dispute# · Customer · Card type · Amount ₦ · Dispute type pill · Status pill · Filed date · Days open  
**Button:** New Dispute (modal: customer, card, amount, date, merchant, dispute type, description)  
**Row click → Modal:** Dispute detail — timeline of status changes, investigation notes, resolution  
**Status flow:** Filed → Investigating → Provisional Credit → Resolved / Referred to CBN

---

### 7.37 Cards — Credit Limit Review (`/cards/credit-limit`)

**Layout:** Full Page table  
**Access:** `cards_ops_officer`, `cards_ops_head`, `risk_officer`, `risk_head`  
**FilterBar:** Status · Review trigger  
**Table columns:** Customer · Card type · Current limit ₦ · Proposed limit ₦ · Utilization % · Eye Score · Status pill  
**Role actions:**
- Cards role: can view, can recommend limit
- Risk role: can approve or decline limit change

---

### 7.38 Cards — Billing Cycles (`/cards/billing`)

**Layout:** Full Page table  
**Table columns:** Product · Cycle start · Cycle end · Accounts · Total balance ₦ · Statements generated · Status pill  
**Button (head only):** Generate Statements for cycle (confirm modal)  
**Row click → Inline expand:** Accounts in the cycle, individual statement download links

---

### 7.39 Collections — Overview (`/collections`)

**Layout:** Full Page  
**KPIs:** PAR30 Total ₦ · PAR90 Total ₦ · Collected MTD ₦ · Avg Recovery Rate %  
**Charts:**
- Stacked area — DPD trend 6 months (PAR30/PAR60/PAR90)
- Bar — collected vs target by agent this month
**Table:** Agent performance (name, accounts assigned, calls made, PTP count, collected ₦, attainment %)

---

### 7.40 Collections — Agent Queue (`/collections/queue`)

**Layout:** Split View  
**Left list columns:** Customer name · Outstanding ₦ · DPD (colour badge: 1–30=amber, 31–90=red, 90+=dark-red) · Last contact date · Next action date · Disposition pill  
**Left FilterBar:** DPD range · Last contact · Disposition · Agent (head only)  
**Left Batch bar:** Reassign · Export · Bulk send SMS  
**Right panel (on row select):**
- Customer strip (name, phone, CIF, employer)
- Loan summary (product, principal, outstanding, DPD, maturity date)
- Contact history (last 5: date, agent, outcome, notes, PTP if any)
- PTP history (last 3 PTPs, status: Kept/Broken)
- **Action tabs:**
  - Log Call: disposition dropdown + notes + submit
  - Record PTP: amount, date, notes + submit
  - Escalate to Recovery: reason + confirm modal

---

### 7.41 Collections — Promises to Pay (`/collections/promises`)

**Layout:** Full Page table  
**FilterBar:** Status (Pending/Kept/Broken) · Due date range · Agent  
**Table columns:** Customer · Outstanding ₦ · PTP Amount ₦ · Due date · Status pill · Agent · Created date  
**Sort:** Due date asc default  
**Batch bar:** Export  
**Row actions:** Mark Kept (confirm) · Mark Broken (confirm) — inline

---

### 7.42 Collections — Repayment Plans (`/collections/repayment-plans`)

**Layout:** Full Page table  
**FilterBar:** Status (Active/Completed/Defaulted) · Agent  
**Table columns:** Customer · Total agreed ₦ · Paid so far ₦ · Remaining ₦ · Instalments (done/total) · Next payment date · Status pill  
**Button:** New Plan (modal: customer search, payment schedule builder — add rows with date + amount)  
**Row click → Modal:** Plan detail — instalment table with status per instalment, mark paid button

---

### 7.43 Collections — Write-off Queue (`/collections/writeoffs`)

**Layout:** Full Page table  
**FilterBar:** DPD range (auto-populated: DPD > 180) · Agent  
**Table columns:** Customer · Outstanding ₦ · DPD · Last payment date · Recovery attempts count · Recommended by  
**Access:**  
- `collections_agent`: view only — accounts appear here automatically (DPD>180 + exhausted)  
- `collections_head`: can approve write-off (confirm modal → triggers GL entry) or return to Recovery  
**Batch bar (head only):** Bulk approve write-offs

---

### 7.44 Recovery — Overview (`/recovery`)

**Layout:** Full Page  
**KPIs:** Total In Recovery ₦ · Recovered MTD ₦ · Success Rate % · Avg Days in Recovery  
**Charts:**
- Area — monthly recovery amounts, 12 months
- Progress list — recovery by channel (TPA / Field Visit / Legal / Self-Cure)
**Table:** Agent performance (name, cases, recovered ₦, success rate %)

---

### 7.45 Recovery — Cases (`/recovery/cases`)

**Layout:** Split View  
**Left list columns:** Customer · Outstanding ₦ · Stage pill (TPA / Legal / Field / Closed) · DPD · Assigned agent · Days in recovery  
**Left FilterBar:** Stage · Agent · DPD range  
**Left Batch bar:** Reassign · TPA Assign · Export  
**Right panel:**
- Loan summary (product, outstanding, original amount, DPD)
- Collections history summary (total calls, PTPs, broken PTPs)
- Case timeline (stage transitions, events, notes)
- **Actions:**
  - Assign to TPA (modal: select TPA agency)
  - Log Field Visit (modal: date, agent, location, outcome)
  - Move to Legal (confirm modal)
  - Record Recovery (modal: amount, channel, date)
  - Close Case (confirm modal with reason)

---

### 7.46 Recovery — Legal Tracker (`/recovery/legal`)

**Layout:** Full Page table  
**FilterBar:** Legal milestone · Solicitor  
**Table columns:** Customer · Outstanding ₦ · Current milestone pill · Solicitor · Next court date · Days in legal  
**Row click → Inline expand:** Legal milestone timeline —  
  Demand Letter → Pre-Litigation Notice → Court Filing → Hearing dates (multi) → Judgment → Enforcement  
  Each milestone: date, note, completed checkbox  
**Button:** Add Milestone (inline within expanded row)

---

### 7.47 Recovery — TPA Management (`/recovery/tpa`)

**Layout:** Full Page table  
**Table columns:** Agency name · Licence # · Contact · Commission % · Accounts assigned · Recovered ₦ · Commission accrued ₦  
**Button:** Register TPA (modal: name, licence, address, commission %, contact)  
**Row click → Modal:** TPA detail — account list assigned, recovery performance chart, commission statement  
**Row actions:** Assign accounts (select from recovery cases), Edit, Deactivate

---

### 7.48 Settlements — Batches (`/settlements`)

**Layout:** Full Page table  
**KPIs:** Settled Today ₦ · Pending ₦ · Failed count · Success Rate %  
**FilterBar:** Status (Pending/Settled/Failed) · Date  
**Table columns:** Batch ref · Date · Count · Total amount ₦ · Status pill · Generated by  
**Sort:** Date desc  
**Row click → Inline expand:** Individual transactions in the batch (ref, amount, customer, status)

---

### 7.49 Settlements — NIP Reconciliation (`/settlements/nip`)

**Layout:** Full Page table  
**FilterBar:** Date · Status (Matched/Unmatched/Exception)  
**Table columns:** NIP ref · Amount ₦ · Value date · Customer · Core banking credit · Match status pill · Exception type  
**Sort:** Status (exceptions first)  
**Row actions:** Resolve exception (modal: resolution type + notes)  
**Batch bar:** Export exceptions · Mark resolved

---

### 7.50 Settlements — Failed Transactions (`/settlements/failed`)

**Layout:** Full Page table  
**FilterBar:** Failure reason · Date range · Amount range  
**Table columns:** Ref · Amount ₦ · Customer · Channel · Failure reason · Failed date · Retry count  
**Row actions:** Retry (confirm modal) · Resolve manually (modal: resolution notes) · Escalate

---

### 7.51 Settlements — Manual Postings (`/settlements/manual-postings`)

**Layout:** Full Page table  
**FilterBar:** Status (Pending Approval / Approved / Rejected) · Initiator  
**Table columns:** Ref · Type (Credit/Debit) · Amount ₦ · Account · Description · Initiated by · Status pill  
**Button (officer only):** New Posting (modal: type, amount, account, description, supporting doc upload)  
**Role actions:**
- `settlement_officer`, `finance_officer`: can create
- `finance_head`: can approve (confirm modal) or reject (modal with reason)

---

### 7.52 Finance — Overview (`/finance`)

**Layout:** Full Page  
**KPIs:** Interest Income MTD ₦ · FD Outstanding ₦ · Total Loan Book ₦ · Net Liquidity ₦  
**Charts:**
- Area — interest income trend, 12 months
- Donut — P&L contribution by product (Salary Loan / Business Loan / Credit Card / Fixed Deposit)
**Table:** Today's large transactions (ref, customer, amount, type, channel)

---

### 7.53 Finance — Transactions (`/finance/transactions`)

**Layout:** Full Page table  
**FilterBar:** Type · Channel · Date range · Amount range  
**Search:** by ref or customer name/CIF  
**Table columns:** Date · Ref · Customer · Type pill · Amount ₦ · Balance ₦ · Channel pill  
**Sort:** Date desc default  
**Batch bar:** Export

---

### 7.54 Finance — Income (`/finance/income`)

**Layout:** Full Page  
**FilterBar:** Type · Date range  
**Table columns:** Date · Source · Type pill · Amount ₦ · Ref  
**Charts:**
- Bar — income by type this month vs last month (Interest / Fees / Charges / Commission)

---

### 7.55 Finance — Fixed Deposits (`/finance/fixed-deposit`)

**Layout:** Full Page table  
**FilterBar:** Status (Active/Matured/Liquidated/Rolled Over) · Maturity range  
**Table columns:** FD# · Investor · Amount ₦ · Rate % · Start date · Maturity date · Status pill · Days to maturity  
**Sort:** Maturity date asc default (soonest first)  
**Row click → Modal:** FD detail — interest accrual to date, maturity options  
**Row actions (head only):** Rollover (modal: new rate, new tenor) · Liquidate (confirm modal)  
**Button:** New FD (modal: investor search, amount, rate, tenor, start date)

---

### 7.56 Finance — EOD / EOB (`/finance/eod`)

**Layout:** Full Page table  
**Table columns:** Date · EOD ref · Total credits ₦ · Total debits ₦ · Closing balance ₦ · Status pill · Processed by  
**Sort:** Date desc  
**Row click → Inline expand:** Account-by-account balance table for that EOD  
**Button (head only):** Run EOD for today (confirm modal)

---

### 7.57 Finance — P&L (`/finance/pnl`)

**Layout:** Full Page  
**FilterBar:** Period (MTD/QTD/YTD/Custom) · Product line  
**KPIs:** Revenue ₦ · Cost of Funds ₦ · Provisioning ₦ · Net Income ₦  
**Charts:**
- Bar — P&L by product line (Salary Loan / Business Loan / Credit Card / Fixed Deposit)
- Area — net income trend by month
**Table:** P&L line items (revenue lines, cost lines, net)

---

### 7.58 Compliance — AML Watchlist (`/compliance/watchlist`)

**Layout:** Full Page table  
**FilterBar:** Type (PEP/Sanction/Internal) · Status · Date added range  
**Table columns:** Name · Type pill · Source · Added date · Matched transactions count · Status pill  
**Button:** Add to watchlist (modal: name, type, source, notes)  
**Row actions:** Create SAR (modal pre-filled) · Escalate · Remove (confirm modal with reason)

---

### 7.59 Compliance — Regulatory Calendar (`/compliance/regulatory`)

**Layout:** Full Page table  
**FilterBar:** Status (Upcoming/Overdue/Done) · Horizon (30d/60d/90d)  
**Table columns:** Requirement · Regulatory body · Due date · Days remaining · Owner · Status pill  
**Sort:** Due date asc default  
**Button:** New entry (modal: requirement, regulatory body, due date, owner, notes)  
**Row actions:** Mark done · Edit

---

### 7.60 Compliance — Findings (`/compliance/findings`)

**Layout:** Full Page table  
**FilterBar:** Severity (Critical/High/Medium/Low) · Status (Open/In Progress/Closed) · Owner  
**Table columns:** Ref# · Finding summary · Severity pill · Status pill · Owner · Due date · Days overdue (red if past due)  
**Button:** New finding (modal: finding, severity, owner, due date, evidence upload)  
**Row click → Modal:** Full finding detail — description, evidence attachments, status history, update status button

---

### 7.61 Compliance — Checklists (`/compliance/checklists`)

**Layout:** Full Page table  
**Table columns:** Checklist name · Type · Period · Items done / total · Completion % progress bar  
**Row click → Inline expand:** List of checklist items — each row has a checkbox, item description, evidence upload button, completed by, completed date

---

### 7.62 Compliance — Audit Trail (`/compliance/audit-trail`)

**Layout:** Full Page table  
**FilterBar:** User · Module · Action type · Date range  
**Table columns:** Timestamp · User · Action · Module · Resource · Old value · New value · IP address  
**Sort:** Timestamp desc  
**Export:** CSV button in section card header  
**No edit/delete actions — read only**

---

### 7.63 HR — Employees (`/hr/employees`)

**Layout:** Full Page table  
**FilterBar:** Department · Status (Active/Inactive/Suspended) · Grade  
**Table columns:** Staff ID · Name · Department · Job title · Grade · Status pill  
**Batch bar:** Export · Deactivate selected (confirm modal)  
**Button:** Add Employee (modal: full form — personal, employment, payroll details)  
**Row click → Modal:** Employee detail, tabbed:
- Personal: DOB, gender, phone, address, emergency contact
- Employment: staff ID, dept, title, grade, start date, manager, contract type
- Payroll: bank name, account number, gross salary ₦, pension RSA PIN, HMO plan
- Leave: leave balance by type (annual/sick/maternity/paternity)
- Loans: active staff loans — amount, monthly deduction, outstanding

---

### 7.64 HR — Leave (`/hr/leave`)

**Layout:** Full Page table + calendar toggle  
**FilterBar:** Type · Status (Pending/Approved/Rejected) · Employee · Date range  
**Table columns:** Employee · Type pill · From · To · Days · Status pill · Applied date  
**Role actions:**
- `hr_officer`, `hr_manager`: Approve (confirm) · Reject (modal with reason)
**Toggle:** Calendar view shows approved leaves by employee as colour bars  
**Button:** New Leave Request (modal: employee, type, from, to, reason)

---

### 7.65 HR — Performance (`/hr/performance`)

**Layout:** Full Page table  
**FilterBar:** Period · Department · Status  
**Table columns:** Employee · Department · Period · Score (0–5) · Rating pill · Reviewer · Status pill  
**Chart:** Bar — score distribution across departments  
**Button:** New Review (modal: employee, period, score, notes, reviewer)

---

### 7.66 HR — Disciplinary (`/hr/disciplinary`)

**Layout:** Full Page table  
**FilterBar:** Type · Status · Date range  
**Table columns:** Employee · Type pill · Date · Outcome pill · Issued by · Status pill  
**Button:** New Case (modal: employee, type, description, outcome, date)  
**Row click → Modal:** Case detail — full description, supporting docs, status history

---

### 7.67 HR — Training (`/hr/training`)

**Layout:** Full Page table  
**FilterBar:** Status · Date range  
**Table columns:** Training name · Type pill · Date · Attendees count · Status pill  
**Button:** New Training (modal: name, type, date, description, trainer)  
**Row click → Modal:** Training detail — attendee list, attendance checkboxes, completion certificates

---

### 7.68 Payroll — Overview (`/payroll`)

**Layout:** Full Page  
**KPIs:** Headcount · Gross Payroll MTD ₦ · Net Payroll MTD ₦ · PAYE Deducted MTD ₦  
**Table:** Monthly run history — Year · Month · Status pill · Headcount · Gross ₦ · Net ₦ · PAYE ₦ · Actions  
**Row click:** Navigate to Run Detail  
**Button (officer only):** New Payroll Run (modal: select period, confirm headcount → creates draft run)

---

### 7.69 Payroll — Run Detail (`/payroll/runs/:id`)

**Layout:** Full Page Slide  
**Header strip:** Period · Status pill · Headcount · Gross ₦ · Net ₦ · PAYE ₦  
**FilterBar:** Department  
**Table columns:** Employee · Dept · Gross ₦ · PAYE ₦ · NHF ₦ · Pension ₦ · Loan Deduction ₦ · Other Deductions ₦ · Net ₦  
**Batch bar:** Export itemised  
**Role actions:**
- `payroll_officer`, `hr_manager`: can edit items (draft only), submit for approval
- `payroll_manager`, `cfo`: can approve (confirm modal) or reject (modal with reason)
- `finance_officer`, `finance_head`: can download NIBSS file, mark as paid  
**Row click:** Navigate to Payslip

---

### 7.70 Payroll — Payslip (`/payroll/runs/:runId/items/:itemId`)

**Layout:** Full Page (print-optimised)  
**Content:** Formatted payslip — company header, employee info, earnings table, deductions table, net pay highlighted, employer pension contribution  
**Actions:** Print · Download PDF

---

### 7.71 Reports & BI (`/reports`)

**Layout:** Full Page  
**FilterBar:** Module (dropdown of all modules) · Metrics (multi-select, changes per module) · Date range · Granularity (Daily/Weekly/Monthly)  
**Preview chart:** Updates on filter change — type depends on selected metrics  
**Table:** Report output rows, paginated  
**Buttons:** Save Report (modal: name, description) · Export CSV · Schedule (modal: frequency + recipients)

---

### 7.72 Reports — KPI Tracker (`/reports/kpi`)

**Layout:** Full Page  
**KPI grid:** All platform KPIs in cards — each shows current value, target, MoM change, RAG dot  
**FilterBar:** Period  
**Table:** KPI history by period (week/month)

---

### 7.73 Statements (`/statements`)

**Layout:** Full Page  
**Search:** Customer name / CIF / phone (typeahead)  
**Date range picker**  
**Table:** Date · Ref · Description · Debit ₦ · Credit ₦ · Balance ₦  
**Buttons:** Download PDF · Download CSV

---

### 7.74 Admin — Users (`/admin/users`)

**Layout:** Full Page table  
**FilterBar:** Role · Status · Department  
**Table columns:** Name · Email · Role pill · Department · Status pill · Last login · Created  
**Button:** Invite User (modal: name, email, role, department)  
**Row click → Modal:** User detail — edit role, reset password, activate/deactivate, page permissions override  
**Batch bar:** Deactivate · Export

---

### 7.75 Admin — Roles (`/admin/roles`)

**Layout:** Full Page table  
**Table columns:** Role name · Assigned users count · Page permissions count · Description  
**Row click → Modal:** Role detail — list of page permission checkboxes, affected users preview  
**Button:** Create Role (modal)

---

### 7.76 Admin — Integrations (`/admin/integrations`)

**Layout:** Full Page table  
**Table columns:** Integration name · Type · Status dot (green/amber/red) · Last ping · Key expiry · Owner · Notes  
**Integrations tracked:** SendGrid · Zoho Voice · Microsoft Graph · Supabase · Railway · Cloudflare · MSSQL Tunnel · Eye Service · NIP/NIBSS · WhatsApp API · CRC Bureau · FirstCentral  
**Row actions:** Ping Now · Edit (modal) · Flag for key rotation  
**Button:** Register Integration (modal)

---

## Part 8 — Build Order

Build in this sequence. Each module builds on the chrome established before it.

```
Phase 0 — Chrome (do first, everything depends on this)
  [ ] Sidebar.tsx — rewrite to final structure (Part 5)
  [ ] App.tsx — topbar background to var(--sb), update all routes to new paths
  [ ] UI.tsx — verify Page, KpiCard, SectionCard, DataTable, FilterBar, Tabs, ConfirmModal all built

Phase 1 — High visibility, high traffic pages
  [ ] Overview (/)
  [ ] LOS Queue + New Application + Application Detail
  [ ] Collections Queue
  [ ] Helpdesk Tickets + Ticket Detail

Phase 2 — Sales & BD
  [ ] Sales Overview + CRM Pipeline + CRM Tasks
  [ ] Customers list
  [ ] BD Leads + Employer Register

Phase 3 — Operations
  [ ] Risk App Review + Portfolio Health
  [ ] Collections Overview + PTPs + Targets
  [ ] Recovery Cases + Legal + TPA
  [ ] Settlements Batches + NIP Recon + Failed Tx

Phase 4 — Contact Centre
  [ ] Telemarketing Queue + DNC + Performance
  [ ] Supervisor
  [ ] Helpdesk Stats + KB + Canned Responses
  [ ] Call Log + New Ticket

Phase 5 — Cards (standalone)
  [ ] Cards Overview + Management + Issuance + Disputes + Credit Limit + Billing

Phase 6 — Finance
  [ ] Finance Overview + Transactions + Income + Fixed Deposits + EOD + P&L

Phase 7 — People
  [ ] HR Employees + Leave + Performance + Disciplinary + Training
  [ ] Payroll Overview + Run Detail + Payslip

Phase 8 — Compliance
  [ ] Watchlist + Regulatory Calendar + Findings + Checklists + Audit Trail

Phase 9 — Intelligence + Admin
  [ ] Reports & BI + KPI Tracker + Statements
  [ ] Admin Users + Roles + Integrations + other sub-pages

Phase 10 — Campaigns
  [ ] Campaigns list + Report + Templates + Contact Lists + Analytics
```

---

## Part 9 — Per-session Checklist

Before starting any page:
1. Read the spec for that page in Part 7 of this document
2. Check the route exists in `App.tsx`
3. Check the sidebar entry exists in `Sidebar.tsx`
4. Identify which role(s) access this page and what differs per role
5. Use `<Page>` shell — never a raw div root

After finishing any page:
1. `cd frontend && npx tsc --noEmit` → zero errors
2. Check in browser: loading state, empty state, error state, populated state
3. Check dark mode toggle — all colours must flip correctly
4. Check that no hardcoded hex colours appear where CSS vars should be used

---

## Part 10 — Common Pitfalls

| Pitfall | Rule |
|---|---|
| Hardcoded colours in content areas | Use CSS vars for all neutral colours. Brand constants (NAVY, RED, etc.) are ok |
| CSS vars in Recharts SVG props | Use hardcoded hex for stroke/fill inside Recharts components |
| Money as float | Always kobo integers on the wire, `fmt()` for display |
| Cross-module navigation | Surface context inline via C360 API panel — never redirect to another section |
| Duplicate sidebar sections | Check Part 5 before adding any new module |
| Floating dark bulk bar | Inline-top #F0F4FF bar only — no floating dark bar |
| Raw div as page root | Always `<Page title="...">` from UI.tsx |
| New role not in ROLE_PAGES | Add to `useAuth.ts` canAccess() and backend `auth.go` |
| New migration editing existing file | Always create a new numbered migration file — never edit shipped ones |
| Tailwind classes for colours | Prefer inline styles with CSS vars for themed colours — Tailwind colours don't respond to theme |
