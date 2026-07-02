# O3 Capital Workspace — Design Brief
**Version 1.0 · June 2026 · Pre-build reference**

This document is the authoritative specification for the complete frontend rebuild.
Nothing gets built until it is described here. Nothing described here gets skipped.

---

## 1. Project Scope

A complete rebuild of the `frontend/` directory from scratch.
- **Keep:** Go backend (unchanged), React Router v7, TanStack Query, Lucide icons, Sonner
- **Replace:** Plain CSS + design.css → Tailwind CSS v4, Recharts → Apache ECharts via `echarts-for-react`, hand-rolled tables → TanStack Table v8
- **Add:** shadcn/ui (Radix UI primitives), React Hook Form + Zod (all forms)
- **Reference:** `frontend-old/` for patterns, `demo/o3c-demo.html` for page structure. Do not copy — learn and improve.

---

## 2. Tech Stack (Confirmed)

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript + Vite |
| Styling | Tailwind CSS v4 (with O3C design tokens) |
| UI Primitives | shadcn/ui (built on Radix UI) |
| Charts | Apache ECharts via `echarts-for-react` |
| Tables | TanStack Table v8 |
| Data Fetching | TanStack Query (keep) |
| Forms | React Hook Form + Zod |
| Routing | React Router v7 (keep) |
| Icons | Lucide React (keep) |
| Notifications | Sonner (keep) |

---

## 3. Brand & Design Tokens

### Colors

```
Navy:       #0E2841   (sidebar — ALWAYS dark, never theme-switches)
Red:        #C00000   (logo accent, danger signals ONLY — not for interactive states)
Blue/Sky:   #0EA5E9   (primary interactive: active nav, focus rings, CTAs, links)
Green:      #16a34a   (positive metrics, success states)
Amber:      #d97706   (warnings, snapshot mode)
```

**Dark theme (default):**
```
bg:         #07090f
surface:    #0d1117
surface2:   #111827
border:     #1e293b
border2:    #263044
text:       #f1f5f9
text2:      #94a3b8
text3:      #475569
text4:      #334155
```

**Light theme (user-selectable, persisted):**
```
bg:         #f0f4f8
surface:    #ffffff
surface2:   #f8fafc
border:     #e2e8f0
text:       #0f172a
text2:      #475569
text3:      #94a3b8
```

**Three critical decisions:**
1. Dark by default. Light mode kept, preference saved to localStorage.
2. Sidebar is always navy — it does NOT switch with theme. Fixed brand identity.
3. Blue (#0ea5e9) is the interactive color — active states, focus, CTAs. Red = danger signals only.

### Typography

```
Body/UI:     DM Sans (body font)
Numbers/IDs: DM Mono (all amounts, CIFs, dates, IDs must be monospace)
```

Font scale:
- Page title (h1): 24px / 700
- Panel header: 12px / 700
- Body / table cells: 12.5–13px / 400–500
- KPI value: 22px / 700 / letter-spacing: -0.02em
- Sub-label / meta: 11px
- Table header: 10px / 700 uppercase
- Badge/chip: 11px / 700

### Chart Color Series (ECharts multi-series order)
1. `#0ea5e9` — sky blue (primary)
2. `#22c55e` — green (secondary)
3. `#a78bfa` — purple (tertiary)
4. `#f59e0b` — amber (targets/warnings)
5. `#ef4444` — red (negative series)
6. `#0891b2` — cyan (extra)

---

## 4. Role Hierarchy

### 4 Tiers

**Tier 1 — C-Suite (5 roles):** `md`, `coo`, `cfo`, `cmo`, `executive`
- Home: `/` (Executive Dashboard)
- See: all departments summary, read-only queues, audit trail
- Cannot: edit user data, create users, change system config

**Tier 2 — Department Heads (12 roles):** `finance_head`, `head_sales`/`sales_head`, `risk_head`, `cards_ops_head`, `collections_head`, `recovery_head`, `call_center_head`, `head_hr`, `compliance_head`, `internal_control_head`, `head_ops`, `head_it`
- Home: their department overview
- See: full dept visibility + read-only summary of related depts
- Cannot: user creation (except `head_it`), system config (except `head_it`)

**Tier 3 — Officers (7 roles):** `finance_officer`, `sales_officer`, `risk_officer`, `cards_ops_officer`, `hr_officer`, `hr_manager`, `compliance_officer`, `head_of_reconciliation`
- Home: their department sub-page
- See: team/region filtered views, department analytics

**Tier 4 — Agents (9 roles):** `collections_agent`, `collections`, `recovery_agent`, `recovery`, `call_center_agent`, `call_centre`, `cards_ops`, `sales`
- Home: their personal queue (e.g. `/collections/queue`)
- See: ONLY their assigned cases/tickets. Principle of least privilege.

**Legacy/Admin (6 roles):** `admin`, `management`, `head_it` → treat as C-suite + system config access

### Home Page by Role

```typescript
const HOME_ROUTES: Record<string, string> = {
  // C-Suite → Dashboard
  md: '/', coo: '/', cfo: '/', cmo: '/', executive: '/',
  admin: '/', management: '/',

  // Dept Heads → Dept Home
  head_ops: '/', head_it: '/admin',
  finance_head: '/finance', head_sales: '/sales', sales_head: '/sales',
  risk_head: '/risk', cards_ops_head: '/cards',
  collections_head: '/collections', recovery_head: '/recovery',
  call_center_head: '/helpdesk', head_hr: '/hr',
  compliance_head: '/compliance', internal_control_head: '/compliance',

  // Officers → Dept Sub-page
  finance_officer: '/finance', sales_officer: '/sales',
  risk_officer: '/risk', cards_ops_officer: '/cards',
  hr_officer: '/hr', hr_manager: '/hr', compliance_officer: '/compliance',
  head_of_reconciliation: '/settlements/recon',

  // Agents → Their Queue
  collections_agent: '/collections/queue', collections: '/collections',
  recovery_agent: '/recovery/cases', recovery: '/recovery',
  call_center_agent: '/helpdesk/tickets', call_centre: '/helpdesk',
  cards_ops: '/cards', sales: '/sales',
}
```

### Role-Based Bug Fix (BUG-4)

**Do NOT use a hardcoded `ROLE_PAGES` map on the frontend.** Read the `pages: string[]` array from the JWT payload. Fall back to `ROLE_PAGES` only as a last resort. The backend is the source of truth.

```typescript
const pages: string[] = user.pages?.length
  ? user.pages
  : (ROLE_PAGES[user.role] ?? [])
```

---

## 5. Sidebar Navigation Structure

### Visual Spec

- Width: 222px (expanded), 52px (collapsed icon-only)
- Background: always `#0E2841` (never theme-switches)
- Collapse toggle: top-right chevron icon
- Keyboard shortcut: `[` (left bracket) to toggle collapse
- Collapsed state persisted to `localStorage('sidebar-collapsed')`
- Transition: `width 0.20s cubic-bezier(0.4, 0, 0.2, 1)`

### Zones (top to bottom)

**Logo Block (78px):**
- Logo icon (32x32, sky-blue, card SVG)
- "O3C" white 16px/800 + "Reports" in #0ea5e9
- Sub-label: "CARDS PLATFORM" 10px uppercase, 30% white opacity

**Data Source Strip (48px):**
- Live: green dot (pulsing) + "Live · MSSQL"
- Snapshot: amber dot + "Snapshot · Supabase" + "Last synced HH:MM"
- This is the primary data freshness indicator — always visible

**Navigation Body (scrollable):**

```
OVERVIEW
  • Dashboard               /
  • Transactions            /transactions

CARDS
  ▼ Cards & Channels        /cards
    - Overview              /cards
    - Trends & Analytics    /cards/trends
    - Card Management       /cards/management
    - Products              /cards/products
    - Blink Card            /cards/blink
    - Mobile App            /cards/mobile-app

OPERATIONS
  ▼ Collections             /collections
    - Overview              /collections
    - Queue (agents)        /collections/queue
    - DPD Tracking          /collections/dpd
    - Targets               /collections/targets
    - Promises to Pay       /collections/promises

  ▼ Recovery                /recovery
    - Overview              /recovery
    - Case Tracker          /recovery/cases
    - Legal Stage           /recovery/legal
    - Field Visits          /recovery/visits
    - Write-offs            /recovery/write-offs

GROWTH
  ▼ Sales                   /sales
    - Overview              /sales
    - Customers             /sales/customers
    - CRM Pipeline          /sales/crm
    - Tasks                 /sales/tasks
    - Applications          /sales/applications
    - Trends                /sales/targets

RISK
  ▼ Risk & Credit           /risk
    - Overview              /risk
    - Credit Portfolio      /risk/portfolio
    - All Applications      /risk/applications
    - Scorecard             /risk/scorecard

FINANCE
  ▼ Finance                 /finance
    - Overview              /finance
    - Income                /finance/income
    - Fixed Deposits        /finance/fixed-deposit
    - End of Day            /finance/eod
    - Settlements           /settlements
    - Reconciliation        /settlements/recon

CUSTOMER
  ▼ Helpdesk                /helpdesk
    - Overview              /helpdesk
    - Tickets               /helpdesk/tickets
    - Call Log              /helpdesk/calls
    - Stats                 /helpdesk/stats
    - Canned Responses      /helpdesk/canned

PEOPLE
  ▼ HR                      /hr
    - Employees             /hr/employees
    - Leave                 /hr/leave
    - Performance           /hr/performance
    - Disciplinary          /hr/disciplinary
    - Training              /hr/training

  ▼ Compliance              /compliance
    - Checklists            /compliance/checklists
    - Watch List            /compliance/watchlist
    - SAR Filing            /compliance/sars
    - CBN Reports           /compliance/cbn-reports
    - Audit Findings        /compliance/findings
    - Audit Trail           /compliance/audit-trail

PLATFORM
  ▼ Campaigns               /campaigns
    - Overview              /campaigns/overview
    - All Campaigns         /campaigns
    - Analytics             /campaigns/analytics
    - Contact Lists         /campaigns/lists
    - Templates             /campaigns/templates

  • Reports                 /reports
  • Statements              /statements
  • Customer 360            /customer360

  ▼ Admin (admin/head_it only)
    - Overview              /admin/overview
    - Users                 /admin/users
    - Roles                 /admin/roles
    - API Keys              /admin/api-keys
    - Settings              /admin/settings
    - Sync Status           /admin/sync
    - Email Senders         /admin/email-senders
    - Integrations          /admin/integrations

MAIL
  ▼ Mail                    /mail
    - Inbox [3]             /mail/inbox
    - Sent                  /mail/sent
    - Compose               /mail/compose
    - Drafts                /mail/drafts
```

### Sidebar Role Filtering Rules

Only show sections the user's role can access:

| Section | Visible For |
|---------|-------------|
| OVERVIEW | All roles |
| CARDS | C-Suite, admin, cards_ops* |
| OPERATIONS → Collections | C-Suite, admin, collections*, recovery_head (summary) |
| OPERATIONS → Recovery | C-Suite, admin, recovery*, collections_head (summary) |
| GROWTH | C-Suite, admin, sales* |
| RISK | C-Suite, admin, risk*, collections_head, finance_head |
| FINANCE | C-Suite, admin, finance*, cards_ops_head (EOD only) |
| CUSTOMER | C-Suite, admin, call_center* |
| PEOPLE → HR | C-Suite (MD/COO only), admin, hr* |
| PEOPLE → Compliance | C-Suite, admin, compliance*, internal_control_head |
| PLATFORM → Campaigns | C-Suite, admin, head_sales/sales_head |
| PLATFORM → Admin | admin, head_it only |
| MAIL | All roles |

Rule: never show a section or item the user cannot access. No locked/greyed items.

### Active States

- Active flat link: `color: #0ea5e9`, `background: rgba(14,165,233,0.10)`, `left border: 3px solid #0ea5e9`
- Active group parent (has-active child): `color: rgba(255,255,255,0.90)`, no background
- Active sub-item: `color: #0ea5e9`, sub-item dot `background: #0ea5e9`
- Hover: `color: rgba(255,255,255,0.90)`, `background: rgba(255,255,255,0.06)`

---

## 6. Topbar Specification

Height: 54px, `background: var(--surface)`, `border-bottom: 1px solid var(--border)`

### Left: Breadcrumb

Format: `Module` / `Sub-page` (3 levels for detail pages: `Module / Sub / Record ID`)
- Module: 13px / 600 / `var(--text)`
- Separator + sub: `color: var(--text3)` / 400

### Right: Global Controls (left to right)

1. **System health pill** — mirrors sidebar data source strip. Green = live, amber = snapshot.
2. **UTC Clock** — `HH:MM:SS UTC`, monospace. Shown on analytics pages only.
3. **Customer 360 search** — icon button, opens C360 Drawer.
4. **Mail icon** — link to `/mail/inbox`.
5. **Approvals button** — icon + count badge. Role-gated (management/compliance/admin).
6. **Notification bell** — icon + badge count. Opens notification drawer.
7. **⌘K** — ghost button, opens Command Palette.
8. **Export** — shown on list and analytics pages only.
9. **Refresh** — shown on all data pages.

---

## 7. Page Templates

### Template A — Analytics/Overview

Used by: Dashboard, Cards Overview, Collections Overview, Recovery Overview, Sales Overview, Finance Overview, Risk Overview, Helpdesk Overview, Campaigns Overview

```
[ Period control row: "Portfolio Snapshot · Jun 2026" | DateFilter ]
[ KPI Strip: 4–5 KpiCard grid, gap 12px ]
[ Chart Row 1: 2fr primary trend + 1fr breakdown donut (or 1fr+1fr) ]
[ Chart Row 2: optional ]
[ Signal Strip: optional 4 attainment tiles ]
[ Bottom Table: optional full-width panel with leaderboard/top accounts ]
```

### Template B — Operational List

Used by: Transactions, Collections Log, Collections Queue, Recovery Cases, Helpdesk Tickets, Sales Customers, HR Employees, HR Leave, Admin Users, Compliance Watchlist, Campaigns List

```
[ Filter Bar: search input | select dropdowns | DateFilter | action buttons ]
[ Active Filter Chips: (conditional) chip per active filter + "Clear all" ]
[ Summary Row: "Showing N of M records · Total: ₦X.XM" + Export button ]
[ Panel: title + count badge | DataTable with sort, empty state, loading skeletons ]
```

### Template C — Detail/Form

Used by: Recovery Cases (individual), Helpdesk Tickets, LOS Application Detail, Admin User Edit, Compliance Findings, HR Employee Profile

```
[ Page Header: record title + status badge | action buttons ]
[ 2-column grid (2fr left + 1fr right):
  Left: KV grid + tabs (Overview | Timeline | Documents | Notes)
  Right: metadata panel + status timeline + assigned agent ]
[ Sticky approval bar (conditional): stage | Reject | Approve ]
```

### Template D — Split-Pane

Used by: Mail (all sub-pages), Helpdesk Tickets (dual-mode)

```
[ Two columns: 320px fixed list pane | flex-1 detail pane ]
  List pane: search + folder tabs + item rows (sender, subject, preview, time, unread dot)
  Detail pane: header + body + reply bar
  Empty detail: centered icon + "Select a message to read"
```

**Shell note:** Split-pane routes suppress the standard 20px page padding. Add `SPLIT_PANE_ROUTES` set to Shell; when active, apply `content--flush` class.

---

## 8. Component Inventory

### 8.1 Layout

| Component | Status | Notes |
|-----------|--------|-------|
| `Shell` | Rebuild | Add split-pane detection, data source context |
| `Sidebar` | Rebuild | Add collapse, role filtering, unread badge |
| `PageRoot` | New | Wrapper div with page padding + flex column |
| `AnalyticsPage` | New | Template A wrapper |
| `ListPage` | New | Template B wrapper |
| `DetailPage` | New | Template C wrapper |
| `SplitPane` | New | Template D wrapper |

### 8.2 Data Display

| Component | Source | Props |
|-----------|--------|-------|
| `KpiCard` | Port from UI.tsx | `label, value, sub?, change?, icon, accent?, loading?, sparkline?` |
| `SectionCard` | Port from UI.tsx | `title, subtitle?, badge?, actions?, children, loading?` |
| `DataTable<T>` | Port + enhance | `cols, rows, loading?, onRowClick?, stickyHeader?` |
| `StatusBadge` | Port from UI.tsx | `status: string` |
| `ChannelBadge` | Port from UI.tsx | `channel: string` |
| `ChangeBadge` | Port from UI.tsx | `value: number, suffix?` |
| `DpdChip` | Port from UI.tsx | `dpd: number` |
| `ProgressList` | Port from UI.tsx | `title, data, nameKey, valueKey, currency?` |
| `SignalTile` | New | `label, value, sub?, state: ok/warn/alert, pct: number` |
| `SourceBanner` | Retire | Replaced by sidebar strip + topbar pill |

### 8.3 Charts (ECharts wrappers)

| Component | Description |
|-----------|-------------|
| `AreaChartCard` | Time series area chart in panel wrapper |
| `BarChartCard` | Vertical or horizontal bar chart |
| `ComposedChartCard` | Multi-series: bars + lines |
| `DonutCard` | Donut chart with legend list |
| `SparklineCard` | Mini spark line for KpiCard |
| `HeatmapCard` | Cohort retention heatmap (ECharts built-in) |
| `MultiLineCard` | Multiple line series (trend comparisons) |
| `ChartTooltip` | Shared tooltip component |

All chart cards: `panel` wrapper + `panel-hd` header + `panel-body` body.

### 8.4 Filter/Input

| Component | Status | Notes |
|-----------|--------|-------|
| `FilterBar` | New | Layout wrapper for .fbar + .fchips |
| `FilterSearch` | New | Input + search icon + X clear |
| `FilterSelect` | New | Styled native `<select>` |
| `DateFilter` | Port from UI.tsx | Preset picker + custom date range |
| `FilterChip` | New | Active filter chip with X dismiss |
| `Button` | New | Primary, ghost, danger, sm variants |
| `FormGroup` | New | Label + input container with error state |

### 8.5 Overlays

| Component | Status | Notes |
|-----------|--------|-------|
| `Drawer` | New | 480px right-slide panel, backdrop, focus trap |
| `Modal` | New | Centered dialog, variants: alert/confirm/form |
| `Toast` | Sonner | Already in stack. Configure theme + toaster position |
| `CommandPalette` | New | ⌘K overlay, nav search, customer search |
| `NotificationDrawer` | New | Right drawer listing alerts + approvals |
| `C360Drawer` | Port | Customer 360 right drawer (existing in frontend-old) |

### 8.6 Feedback

| Component | Status | Notes |
|-----------|--------|-------|
| `Sk` (Skeleton) | Port from UI.tsx | `w?, h?` props |
| `Spinner` | Port from UI.tsx | `size?` |
| `PageLoader` | Keep | `<Suspense>` fallback |
| `ErrBanner` | Port from UI.tsx | `msg: string` |
| `EmptyState` | New | Icon + title + subtitle + optional action |

---

## 9. Keyboard Shortcuts

### Global (always active via `useKeyboard` hook)

| Key | Action |
|-----|--------|
| `Cmd/Ctrl+K` | Open command palette |
| `[` | Toggle sidebar collapse |
| `Escape` | Close any open overlay |
| `G then D` | Go to Dashboard |
| `G then T` | Go to Transactions |
| `G then C` | Go to Collections |
| `G then R` | Go to Recovery |
| `G then S` | Go to Sales |
| `G then F` | Go to Finance |
| `G then H` | Go to Helpdesk |
| `G then M` | Go to Mail Inbox |

### In list pages
- `/` — focus search input
- `Arrow Up/Down` — navigate rows (when row selection active)
- `Enter` — open selected row detail

### In overlays
- `Tab` — cycle focus within (focus trap)
- `Enter` — submit primary action
- `Escape` — close

---

## 10. Loading State Strategy

**Tier 1 — Page skeleton (initial load):**
Never blank. Always show skeleton placeholders — KPI strip (4–5 skeleton cards), chart placeholders (gray rectangles), skeleton table rows (5).

**Tier 2 — Refetch indicator (filter change / Refresh click):**
Thin 2px progress bar at topbar top, `background: var(--blue2)`. Existing data stays visible. Stale-while-revalidate.

**Tier 3 — Inline (individual async op):**
Spinner inside the triggering button or component only.

**Timeout:** Show `ErrBanner` after 15 seconds with no response.

---

## 11. Error State Strategy

| Tier | Trigger | UI |
|------|---------|-----|
| Full page fail | All API calls fail | Centered icon + "Could not load X" + "Try again" button |
| Partial fail | One panel fails | Inline error inside the panel + "Reload this section" |
| Action fail | Export/approve fails | `toast.error(...)` + re-enable the button |
| Form validation | Invalid input | Field-level: red border + error text below field |

**Staleness warning:** Single amber toast once per session when `syncedAt` > 24 hours old.

---

## 12. Data Freshness Indicators

Source of truth: `data_source` field in every API response (`mssql_live` | `supabase_snapshot`).

Shown in:
1. **Sidebar strip** (permanent — always visible)
2. **Topbar system pill** (compact — always visible)
3. **Panel-level tooltip** (hover-only info icon on data-heavy panels)

NOT shown as inline page banners (too noisy). The old `SourceBanner` component is retired.

Staleness thresholds:
- 0–30 min: no change beyond strip
- 30m–6h: strip sub-label shows "Updated Xh ago"
- 6–24h: strip turns amber regardless of MSSQL connection
- >24h: one-time session toast + amber strip

---

## 13. Complete Page Inventory (94 pages)

### Executive
- `/` — Executive Dashboard (C-Suite + Dept Heads read-only)
- `/transactions` — Transactions ledger

### Finance (permission gated)
- `/finance` — Finance Overview
- `/finance/income` — Income management
- `/finance/fixed-deposit` — Fixed deposits
- `/finance/eod` — End of Day / Branch reconciliation
- `/settlements` — Settlements overview
- `/settlements/recon` — Processor reconciliation

### Sales
- `/sales` — Sales overview + funnel
- `/sales/customers` — Customer directory
- `/sales/crm` — CRM pipeline (Kanban)
- `/sales/tasks` — Sales tasks
- `/sales/applications` — LOS queue (sales view)
- `/sales/applications/new` — New application form
- `/sales/applications/:id` — Application detail (full lifecycle)
- `/sales/targets` — Sales targets

### Risk & Credit
- `/risk` — Risk overview
- `/risk/portfolio` — Credit portfolio health
- `/risk/applications` — All applications (risk view)
- `/risk/scorecard` — Credit scorecard

### Cards & Channels
- `/cards` — Cards overview (KPIs + product mix + status trend)
- `/cards/trends` — Card performance analytics
- `/cards/management` — Card management (ops)
- `/cards/products` — Product configuration
- `/cards/blink` — Blink card analytics
- `/cards/mobile-app` — Mobile wallet analytics

### Collections
- `/collections` — Collections overview (aggregate view)
- `/collections/queue` — Agent daily worklist
- `/collections/dpd` — DPD aging analysis
- `/collections/targets` — Collection targets
- `/collections/promises` — Payment promises tracker

### Recovery
- `/recovery` — Recovery overview (legal stage pipeline)
- `/recovery/cases` — Case worklist
- `/recovery/legal` — Legal proceedings tracker
- `/recovery/visits` — Field visit log
- `/recovery/write-offs` — Write-off management

### Settlements
- `/settlements` — Settlement KPIs + processor reconciliation

### Customer 360
- `/customer360` — Unified customer view (search + profile)
- `/customer360/:cif` — Direct CIF profile

### Helpdesk / Customer Service
- `/helpdesk` — Helpdesk overview (SLA, CSAT, ticket KPIs)
- `/helpdesk/tickets` — Ticket list (filtered by role)
- `/helpdesk/:id` — Ticket detail (conversation + metadata)
- `/helpdesk/stats` — Helpdesk performance analytics
- `/helpdesk/canned` — Canned response library
- `/helpdesk/calls` — Call log
- `/csat/:token` — CSAT survey (public, no auth)

### HR
- `/hr/employees` — Employee directory
- `/hr/leave` — Leave requests
- `/hr/performance` — Performance reviews
- `/hr/disciplinary` — Disciplinary actions
- `/hr/training` — Training programs

### Compliance
- `/compliance/checklists` — Compliance checklists
- `/compliance/watchlist` — OFAC/Sanctions watchlist
- `/compliance/sars` — SAR filing
- `/compliance/cbn-reports` — CBN regulatory reports
- `/compliance/findings` — Audit findings tracker
- `/compliance/audit-trail` — System audit log

### Campaigns & Marketing
- `/campaigns` — Campaign list
- `/campaigns/overview` — Campaigns KPI dashboard
- `/campaigns/:id/report` — Campaign performance report
- `/campaigns/analytics` — Cross-campaign analytics
- `/campaigns/templates` — Message templates
- `/campaigns/lists` — Contact lists
- `/campaigns/compose` — Campaign creation wizard

### Mail
- `/mail/inbox` — Inbox (Template D, flush layout)
- `/mail/sent` — Sent
- `/mail/compose` — Compose
- `/mail/drafts` — Drafts
- `/mail/tracking` — Email open/click tracking

### Reports & Approvals
- `/reports` — Report builder
- `/statements` — Customer statement generation
- `/approvals` — Unified approval queue

### Admin
- `/admin/overview` — Admin dashboard
- `/admin/users` — User management
- `/admin/roles` — Role management
- `/admin/api-keys` — API key management
- `/admin/settings` — Platform settings
- `/admin/sync` — Sync status + manual trigger
- `/admin/mail` — Mail health
- `/admin/notification-settings` — Alert configuration
- `/admin/email-senders` — Sender pool
- `/admin/integrations` — Zoho + third-party

### Settings
- `/settings/notifications` — User notification preferences
- `/settings/voice` — VoiceConnect (IVR) setup
- `/watch` — Redirect to watchlist

---

## 14. Known Bugs to Fix During Rebuild

| Bug | Location | Fix |
|-----|----------|-----|
| BUG-3: Monetary 100× too large | `fmt.ts` | `fmt()` must divide by 100 before formatting |
| BUG-4: 20/24 roles get blank app | `useAuth.ts` | Read `user.pages[]` from JWT, not ROLE_PAGES map |
| Structural: No shared component layer | All pages | Enforce all pages use shared `KpiCard`, `DataTable`, etc. |
| Structural: All data from stubs | All pages | Wire real API calls from Go backend |

---

## 15. Build Order

### Phase 1 — Foundation (build before any pages)

1. **Tailwind v4 config** — map all O3C brand tokens to Tailwind variables
2. **`components/UI.tsx`** — complete shared component library (KpiCard, DataTable, StatusBadge, ChannelBadge, ChangeBadge, DpdChip, ProgressList, SignalTile, DateFilter, Sk, Spinner, ErrBanner, EmptyState, ExportBtn, SourceBadge)
3. **`components/Charts.tsx`** — ECharts wrappers (AreaChartCard, BarChartCard, ComposedChartCard, DonutCard, SparklineCard, HeatmapCard, MultiLineCard)
4. **`components/Sidebar.tsx`** — complete rebuild: collapse, role filtering, data source strip, mail unread badge, active state, section headers
5. **`components/Shell.tsx`** — rebuild: topbar zones, split-pane detection, data source context
6. **`components/Drawer.tsx`** — right-slide drawer component
7. **`components/Modal.tsx`** — dialog component
8. **`components/CommandPalette.tsx`** — ⌘K overlay
9. **`hooks/useKeyboard.ts`** — global keyboard binding manager
10. **`lib/fmt.ts`** — fix BUG-3: audit all formatting functions
11. **`lib/navigation.ts`** — NAV_SECTIONS array with role filtering
12. **`hooks/useAuth.ts`** — fix BUG-4: read pages from JWT

### Phase 2 — Pages (in priority order)

Module order by business criticality:
1. Executive Dashboard + Transactions
2. Finance (Overview, Income, EOD, Settlements)
3. Collections (Overview, Queue, DPD)
4. Recovery (Overview, Cases, Legal)
5. Cards (Overview, Trends, Management)
6. Sales (Overview, Customers, CRM)
7. Risk (Overview, Portfolio, Applications)
8. Customer 360
9. Helpdesk (Overview, Tickets, Ticket Detail, Call Log)
10. Campaigns (Overview, List, Report)
11. Mail (Inbox, Sent, Compose)
12. HR, Compliance, Reports/Statements, Approvals
13. Admin (Users, Roles, Settings, Sync)

---

## 16. What "Done" Means

Per the CLAUDE.md definition — a page is complete when:
1. Component is written with no syntax errors or logic gaps
2. Real API call is made (no stubs)
3. Loading state shows skeleton
4. Error state shows ErrBanner + retry
5. Role guard is applied (`<RequireAccess>`)
6. Correct page template is used
7. All shared components used — no local duplicates of KpiCard, ChartTip, etc.
