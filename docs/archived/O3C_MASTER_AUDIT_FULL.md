# O3 Capital Workspace — Master Audit & Redesign Brief
**Compiled from 11 specialist reviews across 8 disciplines**
**Composite score: 4.9 / 10 — Not yet Fortune 500 ready**

---

## HOW TO USE THIS DOCUMENT

This document is the single source of truth for all gaps, bugs, and redesign priorities in the O3 Capital workspace platform. It covers every page, every role, every gap identified by:
- Software Engineer (6.5/10)
- UI/UX Designer (deep page-by-page review)
- Product Designer (deep design system audit)
- Data/BI Analyst (metrics & analytics review)
- QA Engineer (1.5/10)
- Cybersecurity Analyst (5.5/10)
- Systems Engineer (6.5/10)
- DevOps Engineer (3.5/10)

Read sequentially for a full picture. Jump to **§ PRIORITY ACTIONS** for what to do first.

---

# PART 1: SHIP-BLOCKERS

These must be fixed before the platform handles real customer data or is shown to any enterprise prospect.

## SB-01 | Stored XSS → JWT Theft → Credential Leak (Attack Chain)

**Severity: CRITICAL | Files involved: 3**

Step 1 — `frontend/src/pages/mail/MailCompose.tsx:530`:
```tsx
<span dangerouslySetInnerHTML={{ __html: signature || (sender?.name ?? 'Me') }} />
```
This is the ONLY `dangerouslySetInnerHTML` in the entire codebase that does NOT call `sanitizeHtml()`. An attacker stores a crafted HTML signature via the API. Every staff member who opens MailCompose executes the attacker's script.

Step 2 — The script calls `localStorage.getItem('o3c_token')`. JWT is stored in localStorage (`frontend/src/lib/api.ts:10`). XSS can read it directly.

Step 3 — With the JWT, the attacker calls `GET /api/settings/` (`backend-go/handlers/settings_handler.go:51-74`) which decrypts ALL third-party credentials and returns them in plaintext JSON — R2 secret key, SharePoint client secret, Termii API key, Zoho credentials.

**Fix for SB-01a (XSS):** Wrap the signature in `sanitizeHtml()` — 1 line, 5 minutes.
**Fix for SB-01b (settings exposure):** Return only `has_value: true` and masked preview (`****abc`). Never send decrypted values to the client.
**Fix for SB-01c (JWT in localStorage):** Phase 2 — move to HttpOnly; Secure; SameSite=Strict cookies.

---

## SB-02 | LOS Assign Field Name Mismatch — Live Defect

**Severity: CRITICAL | File: `frontend/src/pages/los/AllApplications.tsx:129`**

Frontend sends: `{ assigned_to_user_id: ... }`
Go handler struct expects: `assign_to_user_id`

`b.AssignToUserID` is always 0. Handler returns `422 "assign_to_user_id is required"`. Every loan assignment silently fails for every team lead. This has been broken since the feature was built. **Fix:** Change `assigned_to_user_id` to `assign_to_user_id` in the frontend payload — 1 line.

---

## SB-03 | Raw User ID Text Inputs — Blocking Workflows

**Severity: HIGH | Files: `collections-ops/Queue.tsx`, `los/AllApplications.tsx`**

Both Reassign (Collections) and Assign (LOS) modals accept a raw UUID text input. Both have `// TODO` comments acknowledging this. An agent or team lead would need IT to look up a user's UUID for them. These workflows are non-functional in practice.

**Fix:** Replace both text inputs with user dropdowns fetched from `/api/admin/users` — 3 hours each.

---

## SB-04 | No Token Revocation

**Severity: CRITICAL | File: `backend-go/core/auth.go`**

Logout deletes the JWT from localStorage only. No server-side invalidation. `user_sessions` table exists but no denylist is maintained. A fired employee's token remains valid for up to 8 hours. A token captured on an open network is permanently valid until expiry.

**Fix:** JTI claim in every JWT, Redis/PostgreSQL denylist, AuthMiddleware checks denylist, logout writes JTI to denylist.

---

## SB-05 | Race Conditions on Financial Operations

**Severity: CRITICAL | Files: `backend-go/handlers/los.go:309-351`, `backend-go/handlers/recovery_ops.go:499-548`**

**LOS stage advance:** SELECT stage → validate transition → UPDATE stage — no row-level lock between steps. Two concurrent `PUT /api/los/42/advance` calls both validate and both succeed. One loan gets dual-advanced through two stages.

**Write-off approval:** Same read-modify-write pattern with no `SELECT FOR UPDATE`. Two managers can simultaneously approve the same write-off.

**Loan reference generation** (`handlers/loans.go:165`): COUNT-based reference (TOCTOU race under concurrent load). LOS correctly uses `nextval('los_ref_seq')` — loans handler does not.

**Fix:** Add `AND current_stage = $expected_stage` to the UPDATE statement (optimistic lock). For write-off, use `SELECT FOR UPDATE`. Replace COUNT-based reference with sequence.

---

## SB-06 | Zoho and WhatsApp Webhooks Unverified

**Severity: HIGH**

`backend-go/handlers/zoho.go:1694-1724`: Accepts all requests when `ZOHO_WEBHOOK_SECRET` is unconfigured. Anyone who knows the URL can POST fake ticket sync data.

`backend-go/handlers/whatsapp.go`: No `X-Hub-Signature-256` HMAC verification (required by Meta Cloud API). Anyone who discovers the URL can inject fake customer messages.

The SMS webhook was correctly fixed to reject when unconfigured. These two were not.

**Fix:** Reject Zoho requests when secret unset. Implement Meta webhook HMAC verification using app secret.

---

## SB-07 | Bcrypt Error Discarded — Account Lockout on Hash Failure

**Severity: HIGH | File: `backend-go/handlers/admin.go:270`**

```go
hash, _ := core.HashPassword(*b.Password)
```

If bcrypt fails (out of memory, entropy exhaustion), the error is discarded, the hash is an empty string, and the account is permanently locked with a blank password. The user cannot log in at all. **Fix:** Check the error, return HTTP 500.

---

## SB-08 | Safari Date Bug — One-Day Off for All iOS Users

**Severity: HIGH | File: `frontend/src/lib/fmt.ts:40`**

```typescript
s + 'T00:00:00'  // no Z
```

`new Date("2026-06-30T00:00:00")` is interpreted as local time in Chrome/Firefox but as UTC in Safari. Result: every date column shows one day earlier for all Safari/iOS users. For a Nigerian fintech where many staff use iPhones, this affects a significant portion of users.

**Fix:** Change to `s + 'T00:00:00Z'` or parse as local time explicitly.

---

## SB-09 | Recovery Rate Formula Wrong (CBN Numbers Are Wrong)

**Severity: HIGH | File: `frontend/src/pages/recovery/Overview.tsx:214-217`**

```tsx
const totalExposure = totalOutstanding + totalRecovered
const recoveryRate = totalExposure > 0 ? (totalRecovered / totalExposure) * 100 : 0
```

This computes `recovered / (outstanding + recovered)`. Industry standard and CBN standard is `recovered / original_referred_exposure`.

Example: ₦500K case, ₦300K recovered, ₦200K outstanding.
- Current formula: 300 / (200 + 300) = **37.5%**
- CBN standard: 300 / 500 = **60%**

The platform is reporting wrong recovery rates. If these numbers are ever shown to CBN, they will be incorrect.

**Fix:** Backend must track `original_exposure_kobo` at referral time. Frontend divides by that value.

---

## SB-10 | Collections Target Banner Never Shows

**Severity: HIGH | File: `frontend/src/pages/collections/Overview.tsx:129`**

```tsx
target_kobo: 0,
target_achievement_pct: 0,
```

Target banner renders only when `target_kobo > 0`. It's hardcoded to 0. The Head of Collections has never seen a target achievement banner. The entire collections targeting UX is broken.

**Fix:** Wire `target_kobo` to actual daily targets from the database.

---

## SB-11 | No Automated Tests — Zero Coverage on Financial Core

**Severity: CRITICAL**

5 backend tests total (narrow, non-critical paths). 0 frontend tests. CI pipeline runs zero tests — it is a pure build-and-deploy pipeline. `go test ./...` is never invoked. The entire financial core (loans, collections, reconciliation, write-offs) is completely untested.

The LOS assign field name mismatch (SB-02) is an example of a defect that a trivial integration test would have caught on day one.

**Fix:** Add `go test ./...` to CI immediately. Install vitest + @testing-library/react. See QA roadmap in §ENGINEERING ROADMAP.

---

## SB-12 | No Staging Environment

**Severity: CRITICAL | DevOps**

Every code change — including schema migrations — deploys directly to production. A failed migration runs against live financial data with no rollback.

Migrations 016-032 (17 migrations) have NO rollback scripts. Rolling back a schema on a financial system under pressure at 3am is a critical unresolved risk.

**Fix:** Create Railway staging environment (~$5/month). Deploy PRs to staging. Promote to production on merge to main.

---

# PART 2: PAGE-BY-PAGE AUDIT

## MODULE 1: AUTHENTICATION

### Login.tsx

**Who uses it:** Every staff member.

**UX gaps:**
- No "Forgot Password" link — staff locked out must call IT
- Single inline error message, not field-level (user can't tell if email or password was wrong)
- No "Remember me" option (8-hour JWT means agents log in multiple times per week)
- ForceChangePassword has no explanation of WHY the change is required

**Design gaps:**
- Right panel uses `#F6F5F2` (not the app canvas token `#F4F6F8`) — inconsistent
- Error display is a local reimplementation of `ErrBanner` with slightly different border-radius — use `<ErrBanner />`
- Submit button uses inline `style={{ background: '#0E2841' }}` instead of `className="btn-primary w-full"`
- `onFocus`/`onBlur` JS handlers conflict with global `index.css` `:focus-visible` rule
- `icon: 'bolt'` in marketing copy doesn't exist in Material Symbols Rounded — use `electric_bolt`

**Quick fixes:**
1. Add Forgot Password link — 5 min
2. Add context paragraph to ForceChangePassword — 10 min
3. Replace local error div with `<ErrBanner msg={error} />` — 15 min

---

## MODULE 2: EXECUTIVE DASHBOARD & FINANCE OVERVIEW

### Overview.tsx (Executive Dashboard)

**Who uses it:** MD, CFO, COO, CMO — 30-minute morning review.

**Data/Analytics problems:**
- 6 KPIs are card-portfolio metrics (Cardholders, Active Accounts, Cards Issued, Txn Volume). These are NOT the right executive KPIs for a lending/MFB business.
- Missing KPIs: Net Portfolio Yield, Cost of Risk (CoR), Return on Assets (RoA), NPL Ratio, PAR30 vs PAR90, Disbursements MTD, Gross Loan Book, NIM, CAC
- "Data updated" shows `new Date().toLocaleTimeString()` — this is component render time, NOT when data was last written
- No period-over-period comparison (no MoM delta) on any KPI card
- KPIs span different time horizons with no period labels ("Total Txn Volume" — all-time? MTD?)

**UX problems:**
- No date range filter
- No drill-down from any KPI card
- SourceBadge (Live vs Snapshot) is a 10px dot — too small; needs full-width amber/green banner
- No export to PDF (required for board packs)

**Design score: 9/10** — Best chart adherence in codebase, but loading state uses `{loading ? '—' : value}` instead of `<Sk />` skeleton.

**Redesign (Executive Dashboard):**
```
Row 1 — 8 KPIs with MoM delta badges:
  Net Portfolio (₦) | Net Interest Income MTD | NPL Ratio [CBN 5% line] | Cost of Risk
  Collections Rate MTD + target | Disbursements MTD | New Accounts MTD | Recovery Rate (30-day sparkline)

Row 2 — Charts:
  Left 2/3: Combined P&L trend (revenue bars + provisions bars + net income line, 12-month)
  Right 1/3: Portfolio health donut (current / 1-30 / 31-60 / 61-90 / 90+ DPD)

Row 3 — Watchlist:
  5 active alerts with severity + drillthrough
  LOS pipeline ₦ value by stage
  Top 5 overdue DPD accounts
```

### finance/Overview.tsx (Finance Overview)

**Current state:** Loads same 5 endpoints as executive dashboard. DateFilter is the only addition. A CFO looking at Finance Overview sees exactly what the CEO sees on the home page.

**Redesign (Finance Overview):**
```
Panel A — Income Statement (MTD | YTD | Budget | Variance%):
  Interest Income | Fee & Commission | FX Income | TOTAL REVENUE
  Provision for Loan Losses | NET REVENUE AFTER PROVISIONS | OpEx | PROFIT BEFORE TAX

Panel B — Balance Sheet Summary:
  Gross Loan Portfolio | Less Provisions | Net Loan Portfolio | Fixed Deposits | Total Assets

Panel C — 5 CBN Ratio Cards with benchmark lines:
  NPL Ratio (vs 5% limit) | Liquidity Ratio (vs 30% min) | CAR (vs 10% for MFBs)
  ROA (vs 2% peer) | Loan-to-Deposit Ratio (vs 80% ceiling)
```

---

## MODULE 3: APPROVALS

### Approvals.tsx

**Who uses it:** Managers, team leads, finance heads — anyone with approval authority. Cross-module.

**Critical UX problem:** To approve anything, the user must navigate AWAY from Approvals to the detail page in another module, take action, and return. 20 approvals = 40 navigation events.

**Other problems:**
- No inline approve/reject for simple approvals (leave requests can be decided without viewing the full detail)
- No urgency color on waiting_days (amber ≥5, red ≥10 days)
- No batch approval
- No decline reason input from this page
- No "Assigned to me" vs "All pending" filter
- `PriorityBadge` uses `bg-[#FEF2F2]`/`bg-[#FFFBEB]` — not brand rgba tokens
- `EmptyState` is a local reimplementation (12 occurrences across codebase — needs to be shared)

**Redesign:** Two-panel layout — left list with priority, waiting days (color-coded), quick-action buttons (Approve / Decline / Review Detail); right slide-over that loads detail without full navigation. Write-offs above threshold force the Review Detail path. Leave and compliance allow inline approve with optional comment.

---

## MODULE 4: COLLECTIONS

### collections/Overview.tsx

**Who uses it:** Collections managers and team leads — daily performance monitoring.

**Data/Analytics problems:**
- Target achievement banner hardcoded to never show (SB-10)
- "Contacted Today: 14" — out of how many assigned? Denominator missing
- DPD buckets show counts but not monetary exposure (₦)
- No day-over-day comparison on any KPI
- No roll rate matrix (most important early-warning metric in any collections operation)

**Missing KPIs:**
- PTP Kept Rate (% of promises actually paid — most important collections efficiency metric, completely absent)
- Right Party Contact Rate
- Cure Rate MTD
- Roll Rate MTD
- Cost per collection

**Collections Dashboard Redesign:**
```
6 KPIs: Collected Today (with target bar — FIX target=0) | MTD Collection Rate
        Right Party Contact Rate | PTP Kept Rate (30-day rolling)
        Cure Rate MTD | Roll Rate MTD

Roll Rate Matrix:
From\To    Current  1-30  31-60  61-90  90+
Current    98.2%    1.8%  0%     0%     0%
1-30       12.4%   65.1%  22.5%  0%     0%
31-60       5.1%    3.2%  70.1%  21.6%  0%
(Rising 31-60 bucket = 60-day early warning for NPL growth)

Agent Performance Panel: Per agent — Target ₦ | Collected ₦ | % Achievement | Contacts | PTP | PTP Kept Rate
DPD Trend Line: 12-week line chart of DPD bucket sizes over time
```

**Design score: 8/10** — Good chart usage in Finance module; collections-ops pages score 6.5/10 for hand-rolled tables.

### collections-ops/Queue.tsx

**Who uses it:** Collections agents — 8 hours/day, 50+ interactions per session. Highest-frequency page.

**Critical UX problems:**
- Reassign modal: raw user ID text input — BLOCKING (SB-03)
- No Last Contacted column
- No Outstanding balance sorting
- Log Contact and Log Promise are separate modals — two modal cycles for one interaction; combined flow needed
- Contact outcome select has no smart defaults (most common outcomes should float to top)
- No DPD color legend
- 50/page with no "show all" for agents with 200 accounts

**Missing columns:** Last Contacted, Next Action Date, Agent-local priority score

**Redesign:** Table-first. Replace three action buttons with one Actions dropdown. Combine Log Contact + Log Promise: if outcome = "PTP", promise fields appear inline in step 2. Column headers clickable for sort. Quick-filter chips: "Mine | DPD 91+ | Uncontacted 7d+".

### collections-ops/Promises.tsx

**Problems:**
- Loads entire queue endpoint (200 records) to extract promises — if portfolio > 200, later promises are invisible
- No date range filter for promise due dates
- "Mark Honoured" and "Mark Broken" buttons sit next to each other with no visual distinction
- No Promise Amount or Promise Date column
- List in database insertion order — soonest promises should be first

**Fix:** Dedicated `/api/collections/promises` endpoint. Sort by promise_date ascending. Color-code rows by status.

### collections-ops/Targets.tsx

**Problems:**
- No way to add new agent rows to the target board
- No bulk set ("all agents ₦500k/day")
- No "copy last week" function
- Inline editing has no discoverability hint (pencil icon on hover)
- No weekly total row

---

## MODULE 5: HELPDESK

### helpdesk/HelpdeskOverview.tsx

**Who uses it:** Call center agents — start of shift queue check.

**Problems:**
- SLA Warnings background `rgba(192,0,0,0.02)` too subtle to notice while on a call — needs solid red banner
- Claim button has no confirmation — agents can accidentally claim tickets
- 5 parallel API calls create waterfall of spinner flashes
- "Resolved Today" shows 0 at 9 AM even after agents resolved 20 tickets — looks wrong to arriving managers

### helpdesk/TicketList.tsx

**Who uses it:** Call center agents, team leads, supervisors — the primary work queue.

**Design score: 7.5/10** — Best-structured data page, correctly uses DataTable.

**Problems:**
- 12 table columns — cognitive overload at 1440px (no column visibility toggle)
- "Mine" toggle buried in collapsed Advanced Filter — agents who work only their tickets expand this every session; should be always visible in primary filter bar
- SLA shows "On Track" for tickets 30 min from breach — needs amber threshold at < 2 hours remaining
- FRT null shows a dash — should show blinking "Not responded yet" indicator
- Sync buttons show no "last synced" timestamp
- `StatusPill` and `PriorityPill` are locally defined — duplicate StatusBadge concept in UI.tsx
- `CHANNEL_ICON` map duplicated in both TicketList and TicketDetail
- BulkBar uses `#0F172A` (slate-950) not brand NAVY (`#0E2841`)
- "Avg CSAT" KpiCard uses `⭐` emoji instead of Material Symbols icon
- Select-all header checkbox has no `aria-label`

### helpdesk/TicketDetail.tsx

**Who uses it:** Call center agents — actively handling tickets during live calls. Highest-stakes page.

**Design score: 8/10** — Correct architectural exception to Page wrapper (full-height layout). Isolated from design system by design.

**Critical UX problems:**
- Three equal columns leave message thread (most critical) with only ~40% of horizontal space
- "Send Email" and "Send SMS" are same visual weight — wrong channel sends under fatigue
- `patchTicket()` fires immediately on status/priority dropdown change — no confirmation for accidental terminal-state changes
- No Ctrl+Enter shortcut for send (industry standard for messaging UIs)
- Local `Toast` component at bottom of file runs alongside Sonner — two toast systems at same screen position. Remove local Toast, use Sonner everywhere.
- `StatusPill` and `PriorityPill` copied from TicketList — should be in shared `helpdesk/components.tsx`
- ZohoDialer failure gives no user-visible error
- No unsaved draft warning on navigate-away
- Auto-save in sidebar selects gives no success confirmation — only shows errors

**Redesign:** 60/40 split — center thread takes 60%, left metadata 20%, right Customer 360 20%. Customer 360 collapsed to a summary strip by default with "Expand 360" toggle. Reply channel selector above reply box showing last-used channel with override option.

### helpdesk/ComposeTicket.tsx

**Design score: 7/10**

**Problems:**
- Fourth different form label implementation (`text-[11px] font-semibold uppercase tracking-wider text-slate-400`)
- `inputStyle` uses raw `React.CSSProperties` — parallel styling system conflicting with Tailwind
- Progress bar is `h-0.5` (2px) — too thin to be clearly visible; should be `h-1` (4px)

### helpdesk/CSAT.tsx, HelpdeskStats.tsx, CallLog.tsx, CannedResponses.tsx

- CSAT: No way to respond to low scores from this page
- HelpdeskStats: No export (team leads can't present weekly stats to management)
- CallLog: No click-through to associated ticket
- CannedResponses: No preview of rendered response (especially with merge tags like `{{customer_name}}`)

---

## MODULE 6: LOAN ORIGINATION SYSTEM

### los/Queue.tsx (My Applications)

**Who uses it:** Sales officers — personal application pipeline.

**Problems:**
- "Assigned To" column always shows same officer's name in personal queue — wasted space
- No urgency coloring on Days in Stage (amber ≥5, red ≥10)
- "Open" button + row click are duplicate interaction targets
- No quick-count chips by stage ("Submitted: 3 | In Review: 5")

### los/AllApplications.tsx

**Who uses it:** Risk officers, managers, finance heads — cross-portfolio visibility.

**Design score: 5.5/10** — Doesn't use DataTable; hand-rolled table with different header background, smaller padding, different column widths.

**Critical problems:**
- Assign modal: raw user ID text input — BLOCKING (SB-03, specifically fixed in SB-02)
- Client-side search/filter against only the current 50-item page — records on other pages are invisible to search
- KPI cards don't respond to active filters
- `StageBadge` color map duplicated verbatim in AllApplications AND ApplicationDetail — shared file needed
- Pagination shows "Page {page+1}" with no total; other pages show "Page X of Y"

### los/NewApplication.tsx

**Who uses it:** Sales officers — customer onboarding.

**Problems:**
- No file upload capability — loan origination without documents means documents are collected out-of-band
- Loan purpose is free-text (AML and credit scoring need standardized values)
- No formatted amount preview during input (₦500,000 displays as 500000)
- No edit links from Review step back to Steps 1/2 — must use Back and re-validate
- `parseInt("abc")` → NaN → null → backend stores 0 months tenor silently
- `parseFloat("abc")` → NaN → backend stores ₦0 loan silently
- Backend `losCreate` validates only `applicant_name` and `product_type` — no `amount > 0` check

### los/ApplicationDetail.tsx

**Who uses it:** Risk officers, sales officers, finance heads — reviewing specific applications.

**Design score: 6/10** — Module-level border-radius fork: LOS uses `rounded-2xl` (16px) throughout; rest of app uses `.card` (10px). LOS feels like a different product.

**Problems:**
- `window.confirm()` for terminal stage transitions — inappropriate for financial commitments (SB-05 context)
- Documents tab is a permanent placeholder — should be removed until built
- No explanation for the 2 Request Info limit
- 4th different tab implementation in the codebase (`border-b-2 -mb-px` pattern)
- No print/PDF export of Summary tab for credit decision documentation
- `window.confirm()` blocks in enterprise browsers — not just a UX issue, an operational risk

---

## MODULE 7: COMPLIANCE

### compliance/AuditTrail.tsx

**Who uses it:** Compliance officers, internal control, IT admins — regulatory audit purposes.

**Design score: 8/10** — Uses DataTable correctly, but filter bar uses plain date inputs instead of DateFilter component.

**Problems:**
- No debounce on filter inputs (fires on every keypress in large audit logs)
- Entity ID truncated with no tooltip/copy capability
- No filter by IP address or by actor/user
- Historical actor role shows empty for terminated employees — should freeze role at time of action
- Export button is a hand-rolled replica of `ExportBtn` from UI.tsx — missing loading state
- "Showing 1–0" display bug when results = 0

### compliance/Findings.tsx

**Problems:**
- Inline respond: 120px text input in a table cell for substantive compliance responses
- "Assigned to" is free-text — misspellings cause silent assignment failures
- No finding detail view or response history
- No due date urgency coloring
- "Inline close" button can be triggered accidentally while scrolling
- Overdue findings look identical to new findings

### compliance/CbnReports.tsx

**Problems:**
- `window.confirm()` for regulatory submission — irreversible compliance action must use designed confirmation
- Sign Off is another 120px inline cell input
- No file attachment for actual report documents
- No regulatory deadline tracking (STRs require CBN submission within 24 hours)
- No rejection workflow with re-submission path

### compliance/Sars.tsx

**Problems:**
- Escalation to MD uses a 110px inline table cell input
- New SAR button is styled in RED — emergency UX for a professional compliance tool
- No NFIU 7-day filing deadline tracking
- Subject name displayed in gray italics — primary identifier should be most prominent

### compliance/WatchList.tsx

**Problems:**
- "Sure?" inline deactivation is colloquial — should say "Remove from active monitoring?"
- Reason column truncated with no tooltip
- No Reactivate button for inactive entries
- No bulk import from regulatory lists (NFIU, CBN)

### compliance/Checklists.tsx

**Problems:**
- Expandable in-row drawer disorienting in tables (inserts between rows)
- Evidence is URL-only — no file upload
- No validation that required items have responses before marking complete
- Progress bar doesn't distinguish required vs optional items

---

## MODULE 8: CRM

### crm/Contacts.tsx

**Problems:**
- 15+ field contact form — overwhelming for agents collecting basic info on calls
- Edit button is `opacity-0` until hover — invisible to keyboard users
- Limit 100, no pagination — if 500+ contacts, 400 are invisible
- No Contact Detail page
- No merge duplicates capability

### crm/Pipeline.tsx

**Problems:**
- No drag-and-drop between Kanban columns — changing a stage requires opening a drawer
- No "Add Deal" button anywhere on the page
- `window.confirm()` for delete deal
- "Delete deal" link has same visual weight as "Save Changes" button

### crm/Tasks.tsx

**Problems:**
- Loads 500 tasks client-side for filtering
- Linked entity uses raw numeric ID — no search/autocomplete
- Checklist stored as unstructured markdown in description text — fragile, invisible to search
- `window.confirm()` on delete
- Double scroll context (page scroll + column scroll)

### crm/Reports.tsx

**Problems:**
- 8 KPI cards with NO date filter — all data is all-time
- Stage conversion funnel uses first array item as 100% denominator — wrong if "Lost" stage is first
- No export from reports page
- 7 parallel API calls with no graceful skeleton loading

---

## MODULE 9: CUSTOMER 360

### customer360/Customer360.tsx

**Who uses it:** Call center agents, collections agents, recovery officers, sales officers — unified customer view.

**Critical problem:** Collections tab loads `/api/collections-ops/queue?account_cif=X` — the AGENT's queue filtered by CIF. If the CIF is not in the current agent's assigned queue, it shows nothing — even if the customer has extensive collection history. Wrong API entirely.

**Other problems:**
- Search triggers on Enter/button only — agents on calls need debounced live search (300ms)
- Financial summary (DPD, outstanding balance, credit limit) not on Overview tab — buried in sub-tabs
- No quick-action buttons from profile header (Create Ticket, Log Promise, Call Customer)
- No unified activity feed (last 5 interactions across all touchpoints)
- Transaction type coloring: `.includes('credit')` is fragile — "Credit Reversal" would incorrectly show green
- Five separate Avatar component implementations in the codebase — this is the fifth

**Redesign:** Overview tab = operational dashboard — DPD, outstanding balance, last contact date, open tickets count, last promise. Profile header has three action buttons: New Ticket, Log Contact, View Ledger.

---

## MODULE 10: FINANCE

### finance/Transactions.tsx

**Problems:**
- Monthly trend chart ignores date filter — always shows last 12 months regardless of DateFilter selection
- Merchant rank computed as client-side row index — breaks with multiple pages
- No drill-down from merchant row to filtered transaction list

### finance/Collections.tsx

**Problems:**
- "Paid" and "Pending" KPIs are amounts but by-mode chart shows counts — inconsistent story
- `agentParam` not passed consistently to all API calls (by-mode and trend ignore filter)

### finance/Reconciliation.tsx

**Who uses it:** Finance officers reconciling payment processor data with internal ledger.

**Current state:** This is the most technically sophisticated page. Paystack live wallet balance, 7 sub-tabs, ComparePanel with delta badges.

**Problems:**
- ComparePanel compares only 2 fields (count + volume) — real reconciliation needs fees, settlement, net position
- Delta thresholds (<1%/<5%) are hardcoded — configurable per institution needed
- Interswitch tab is a peer-level tab showing a "Coming Soon" setup guide — should be behind a "Coming Soon" badge, not a full tab
- Transfer fees are estimated client-side (`amt <= 500000 ? 1000 : amt <= 5000000 ? 2500 : 5000`) displayed alongside real data with only a tiny "est." label
- Filter state is lost when switching between Transactions and Settlements sub-tabs

### finance/Income.tsx, finance/Eod.tsx

**Data/Analytics:**
- Income is an upload tool, not a financial statement — requires manual CSV upload with no period comparison, no budget vs actual
- EOD Report is a transaction log viewer — CFO does not review individual transactions
- Neither page has period-over-period comparison

---

## MODULE 11: HR

### hr/Employees.tsx

**Design score: 5/10** — Doesn't use DataTable; hand-rolled table with 7 occurrences of the card class written inline.

**Problems:**
- Salary field label says "salary_kobo" — HR staff might enter ₦500,000 (naira) and submit 500000 kobo (₦5,000)
- Employee detail sidebar is read-only — no edit flow visible
- Leave balance shows totals but not pending approval count
- `accent="#DC2626"` (Tailwind red-600) instead of brand `RED (#C00000)`
- No offboarding workflow despite "Exiting This Month" KPI implying offboarding data exists
- `KeyValue` pair sidebar pattern is 5th unshared `DetailField` instance

### hr/Leave.tsx, hr/Performance.tsx, hr/Training.tsx, hr/Disciplinary.tsx

**Universal issue:** All CRUD pages with no connection to the employee profile — you cannot go from an employee profile to their performance reviews, training records, or disciplinary history in one click. HR is fragmented.

**Approval flow:** Leave approval state changes should connect to the Approvals module and vice versa. Currently siloed.

---

## MODULE 12: RECOVERY

### recovery/Overview.tsx

**Problems:**
- Recovery Rate formula wrong — CBN-incorrect numbers (SB-09)
- No date filter
- No agent-level breakdown
- "Recent Activity" label doesn't specify if sorted by update date or creation date

### recovery-ops/Cases.tsx

**Who uses it:** Recovery officers managing debt recovery cases.

**Design score:** Complex (~590 lines, ~30 state variables). The ~30 state variables in a single component is a maintenance risk — already likely caused bugs (submitting payment form triggers wrong state reset).

**Problems:**
- Expandable in-row drawer (not slide-over) disrupts table spatial layout — after expanding 5 cases, table looks completely different
- `window.confirm()` for write-off approval — write-offs are irreversible financial decisions
- Add Payment form amount field has no unit label (naira vs kobo ambiguity)
- Log Visit has no geolocation — plain text address for field officers
- Legal proceedings has no document attachment
- No link from case to Customer 360

**Missing analytics:**
- Vintage analysis (which origination months recover better)
- Cost of recovery (legal fees + agent costs / recovered)
- Field visit conversion rate

### recovery-ops/Legal.tsx, recovery-ops/Visits.tsx

- Legal: particularly sparse — DataTable with minimal context, no document attachments
- Visits: hand-rolled table (inconsistent with Cases which uses DataTable)

---

## MODULE 13: RISK

### risk/Overview.tsx

**Who uses it:** Risk officers and head of risk.

**Problems:**
- No date filter anywhere
- NPL callout shows count only — not total monetary exposure (₦)
- `by_product` data returned by API is never rendered
- No risk score distribution from Eye (credit scoring service)
- Application by Stage table rows are not clickable (no drill-through to filtered application list)
- Risk head cannot see NPL Ratio — restricted to MD/CFO/COO by `KpiDashboard.tsx:25-27`. A risk officer without access to portfolio risk metrics cannot do their job.
- NPL Ratio shown with no CBN 5% threshold benchmark line
- No concentration risk (top 10 borrowers as % of portfolio)
- No single obligor limit monitoring (CBN restricts exposure to any single borrower)
- No sectoral breakdown

### risk/Portfolio.tsx

`risk/Portfolio.tsx` is a re-export of `operations/CreditPortfolio.tsx`. Risk module has no dedicated portfolio page.

---

## MODULE 14: SALES

### sales/Overview.tsx

**Problems:**
- Lifecycle Funnel uses `n(data[FUNNEL_STAGES[0].key]) || 1` as denominator — if Registered = 0, shows 100% conversion everywhere (false positive, no error state)
- Funnel drop-off numbers have no drill-through to the customer population
- No year-over-year comparison option (only period-over-period of same duration)
- `ChangeBadge` is one of the best features on this page — underused elsewhere

### sales/Cohort.tsx

**Good:** Heatmap structure, color thresholds, M0/M1/M2 cohort strength card.

**Problems:**
- "Cohort Size" KPI describes one cohort while heatmap shows all cohorts — scope mismatch
- Retention thresholds (≥60% green, 30-60% amber, <30% red) too punishing for prepaid cards — 20-30% M3 transacting retention is industry-normal; chart looks perpetually red when performance is normal
- No revenue per cohort (only transacting %, not spend per cohort)
- No default rate by cohort (which acquisition months have worse credit outcomes)
- Average spend computed as `total_spend / active_users` (excludes ₦0 spenders from denominator) — overstates average spend by 30-80%

---

## MODULE 15: OPERATIONS

### operations/BlinkCard.tsx, CreditPortfolio.tsx, FixedDeposit.tsx, MobileApp.tsx, Settlement.tsx

**Design score: 8.5/10** — Most consistent module, likely built after design system was established.

**Module-specific gaps:**
- BlinkCard: Needs real-time status sync capability, card-level action buttons (block, unblock, replace)
- CreditPortfolio: Needs DPD bucket distribution consistent with Collections DPD display
- FixedDeposit: Needs maturity date alert system (proactive FD management before maturity)
- Settlement: Similar reconciliation issues to Finance Reconciliation

---

## MODULE 16: MAIL

### mail/MailInbox.tsx, MailSent.tsx, MailDrafts.tsx, MailCompose.tsx

**Design score: 8/10** — Correct architectural exception to Page wrapper (full email client UI). Consistent within its own paradigm.

**Critical bug:** `MailCompose.tsx:530` — unsanitized `dangerouslySetInnerHTML` on signature (SB-01 attack vector).

**Other problems:**
- No thread/conversation grouping — emails listed individually
- No inbox search
- No CRM contact autocomplete in To: field
- Outbound emails not linked to customer tickets or loan applications
- No attachment preview

---

## MODULE 17: MARKETING

### Campaigns.tsx

**Design score: 7.5/10** — Largest page in the codebase. Good wizard structure.

**Problems:**
- Three different `Stepper` implementations in the codebase (5-step Campaigns, 3-step NewApplication, progress-bar ComposeTicket)
- `ActionBtn` in campaign table has ~23px tap target — WCAG fail (44px minimum)
- `text-[10px]` for Stepper step labels — below minimum readable threshold
- SMS textarea has no `min-h` — collapses on mobile
- PreflightCard shows estimated send time but not cost — for SMS campaigns, cost per SMS matters
- No A/B test capability
- No recurring campaign scheduling

### marketing/ContactLists.tsx, MessageTemplates.tsx

- ContactLists has no sync with CRM Contacts — marketing lists and CRM contacts are separate databases
- MessageTemplates has no preview of rendered template across email clients

---

## MODULE 18: ADMIN

### admin/AdminOverview.tsx

**Design score: 6.5/10**

**Problems:**
- `KPICard` is a local duplicate of shared `KpiCard` with different proportions (40×40 icon vs 32×32, 22px value vs 26px)
- Loading state uses `'…'` string instead of `<Sk>` skeleton
- `QuickAction` uses `onClick(() => navigate(to))` instead of `<Link>` — breaks right-click, ctrl+click

### admin/UserManagement.tsx

**Design score: 8/10** — Best-in-class admin page.

**Problems:**
- 30+ roles in a flat dropdown — needs grouping by department with `<optgroup>`
- Local `Field`/`SelectField` components with `text-[11px] font-bold uppercase tracking-wide` — 4th different form label style
- Status badge uses Tailwind `bg-green-50 text-green-700` instead of `StatusBadge` — different green shade
- Active toggle uses raw `style` positioning; Settings.tsx Toggle uses Tailwind — same component, different implementation
- Delete confirm modal uses raw `style={{ position: 'fixed', inset: 0 }}` instead of Tailwind `fixed inset-0`
- "Person avatar with initials" appears in 5 places across codebase without shared `Avatar` component
- No role permission preview ("what pages does this role access?")

### admin/RoleManagement.tsx

**Design score: 6/10**

**Critical problems:**
- Only page that does NOT use `Page` wrapper — rolls its own header
- `window.confirm()` for delete
- No preview of affected users before applying permission changes ("This removes helpdesk access from risk_officer — 12 users affected")

### admin/ApiKeys.tsx

**Design score: 8.5/10**

**Security:** `GET /api/settings/` decrypts ALL credentials (SB-01b). This must be fixed.

**Problems:**
- `EditModal` uses `borderRadius: 14` (raw pixel) — all other modals use `rounded-2xl` (16px)
- Key list rows have no row separator (DataTable has them)

### admin/SyncStatus.tsx, ZohoIntegration.tsx, MailHealth.tsx, NotificationSettings.tsx, PlatformSettings.tsx

**Score: 7.5/10 average** — Use Page + SectionCard correctly. All have the unshared `InfoCallout` pattern (amber/green rounded-xl p-4 flex items-start gap-3 banner) appearing without a shared component.

---

## MODULE 19: SETTINGS

### Settings.tsx

**Design score: 8/10**

**Problems:**
- `Toggle` locally implemented; UserManagement drawer has a DIFFERENT Toggle implementation (inline style vs Tailwind)
- Help section uses `cursor-pointer` on `div` — must be `<button>` or `<a>` for keyboard accessibility
- No 2FA setup flow
- No session management (can't see or revoke active sessions)
- Notification preferences not linked from Settings

---

# PART 3: DESIGN SYSTEM & COMPONENT GAPS

## The Two-Table Problem

40% of pages use shared `DataTable` (correct). 60% hand-roll raw `<table>` HTML with inconsistent header backgrounds, row heights, font sizes, border treatment, and hover states.

Pages using hand-rolled tables: Employees, AllApplications, collections-ops/Queue, collections-ops/Promises, recovery-ops/Visits, helpdesk/TicketList (justified — adds checkbox selection DataTable doesn't support).

**Fix:** Migrate all hand-rolled tables to `DataTable`. Add `selectable` prop to DataTable for TicketList checkbox selection.

## Border Radius Fork

LOS, HR, and collections-ops modules use `rounded-2xl` (16px) for cards. The rest of the app uses `.card` (10px border-radius). These modules feel like a different product when navigating from Finance or Operations.

**Fix:** Either update `.card` to `rounded-xl` (12px) as a compromise, or replace all `rounded-2xl` in LOS/HR/collections-ops with `.card` class. The latter is more disruptive but more correct.

## Color Token Inconsistencies

At least 6 files use `#DC2626` (Tailwind red-600) instead of brand `RED (#C00000)`:
- HR Employees `accent="#DC2626"`
- UserManagement status badge `bg-red-50 text-red-600`
- Login error `color: '#B91C1C'` (red-700, not brand RED)
- `ErrBanner` itself uses `color: '#B91C1C'` — the component that should define the standard gets it wrong

**Fix:** Establish `RED = '#C00000'` as the single danger/negative brand token. Update ErrBanner to use it.

## `'…'` vs `<Sk>` Loading State

AdminOverview `KPICard` and AllApplications stats use literal string `'…'` as loading value. `KpiCard` in UI.tsx has a proper `<Sk>` skeleton via the `loading` prop.

**Fix:** Pass `loading` prop correctly to all `KpiCard` instances.

## Two Toast Systems

Sonner is used in ApiKeys, Campaigns, HR Employees, LOS. A local `Toast` component exists at the bottom of `TicketDetail.tsx` at `fixed bottom-6 right-6 z-[500]` — same position as Sonner's default. Two toast systems running simultaneously will conflict visually.

**Fix:** Remove local Toast from TicketDetail. Use Sonner everywhere.

## `text-[10px]` Below Readable Threshold

Multiple components use `text-[10px]` or `text-[10.5px]` for labels — Campaigns preflight, Stepper step names, DataTable column headers. 10px is below the 11px minimum for UI text on standard displays.

**Fix:** Minimum `text-[11px]` everywhere.

## Missing Touch Targets

`ActionBtn` in Campaigns (~23px tap target), icon-only buttons in tables throughout. WCAG minimum is 44×44px.

**Fix:** Add `min-w-[44px] min-h-[44px] flex items-center justify-center` to all icon-only buttons.

---

## Components That Must Be Added to UI.tsx

The following 13 patterns are currently implemented ad-hoc across 3+ pages and must be promoted to shared components:

### 1. `EmptyState` (12+ instances)
```typescript
interface EmptyStateProps {
  icon?: string       // Material Symbols name, default: 'inbox'
  title: string
  subtitle?: string
  action?: ReactNode
}
```
Standard: icon `text-[40px] text-slate-300`, title `text-[14px] font-semibold text-slate-500`, subtitle `text-[12px] text-slate-400`.

### 2. `Tabs` (4 different implementations)
```typescript
interface TabsProps {
  tabs: string[]
  active: string
  onChange: (tab: string) => void
}
```
Standard: `border-b border-slate-200`, each tab `px-4 py-2.5 text-[13px] font-semibold border-b-2 -mb-px`, active `borderColor: NAVY`, inactive `border-transparent text-slate-400`.

### 3. `Stepper` (3 implementations + 1 progress bar)
```typescript
interface StepperProps {
  steps: string[]
  current: number
}
```
Standard: `w-7 h-7 rounded-full` bubble, `text-[11px] font-semibold` label below, `h-px` connector. Completed = green check. Active = NAVY. Future = `rgba(14,40,65,0.08)`.

### 4. `FormField` (4 different label styles)
```typescript
interface FormFieldProps {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
}
```
Standard label: `text-[12px] font-semibold text-slate-600 mb-1.5` — NO uppercase (too shouty at micro sizes). Error: `text-[11px] text-red-600 mt-1`.

### 5. `Toggle` (2 different implementations)
```typescript
interface ToggleProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}
```
Standard: `w-10 h-5 rounded-full`, knob `w-4 h-4`, `role="switch" aria-checked={checked}`. Standardize on Settings.tsx implementation.

### 6. `Avatar` (5 different implementations)
```typescript
interface AvatarProps {
  name: string
  size?: 'sm' | 'md' | 'lg'   // 28px / 40px / 56px
  color?: string               // default: NAVY
}
```

### 7. `DetailField` (12+ instances — key-value pairs in detail pages)
```typescript
interface DetailFieldProps {
  label: string
  value: ReactNode
  mono?: boolean    // for IDs, amounts
}
```
Standard: label `text-[11px] uppercase tracking-wider text-slate-400`, value `text-[13px] text-slate-800`.

### 8. `InfoCallout` (8+ instances — amber/green rounded banners)
```typescript
interface InfoCalloutProps {
  type: 'info' | 'success' | 'warning' | 'error'
  icon?: string
  title?: string
  children: ReactNode
}
```
Token map: success `rgba(5,150,105,0.06)/green-800`, warning `#FFFBEB/amber-800`, error `rgba(220,38,38,0.06)/#B91C1C`, info `rgba(14,40,65,0.04)/slate-600`.

### 9. `ConfirmModal` (replaces all `window.confirm()` calls)
```typescript
interface ConfirmModalProps {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
  loading?: boolean
}
```
Standard: 400px centered, `rounded-2xl`, warning icon for danger variant. Cancel = border/ghost. Confirm = NAVY (default) or RED (danger).

### 10. `SearchInput` (6+ instances)
```typescript
interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  width?: string
}
```
Standard: search icon `text-[15px] text-slate-400` left, `pl-8 pr-3 py-1.5 rounded-lg border text-[12px]`.

### 11. `FilterBar` (6+ instances)
```typescript
interface FilterBarProps {
  children: ReactNode
}
```
Standard: `.card` class (stops the `border-black/[0.06]` vs `.card` syntax inconsistency).

### 12. `SectionLabel` (4+ instances)
```typescript
interface SectionLabelProps {
  children: string
}
```
Standard: `text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3`.

### 13. `Pagination` (8 independent implementations)
```typescript
interface PaginationProps {
  page: number
  totalPages?: number
  pageSize: number
  onPrev: () => void
  onNext: () => void
  hasNext: boolean
}
```
Add as prop to `DataTable` or as standalone wrapper component.

---

# PART 4: ANALYTICS & METRICS REDESIGN

## The Core Problem

The platform has solid data piping but a thin, sometimes incorrect KPI layer. It is an operational interface with grafted analytics — not an analytics platform. KPIs are:
- Often wrong (recovery rate formula, collections target always 0)
- Missing context (no period labels, no denominators, no MoM deltas)
- Missing entirely for key business functions (P&L, cost of risk, NIM, NPL trend)
- Restricted from the wrong roles (risk head can't see NPL ratio)

## Module-Level Analytics Gaps

| Module | What's Missing |
|---|---|
| LOS | Pipeline ₦ value (count without ₦ is insufficient), average processing time (submission → booking), conversion rate per stage, decline reason distribution |
| Collections | PTP Kept Rate, Right Party Contact Rate, Roll Rate Matrix, Cost per collection, Cure Rate MTD |
| Finance | P&L, income statement, provision coverage, cost-of-funds — Finance Overview duplicates executive dashboard |
| Recovery | True recovery rate formula, vintage analysis, cost of recovery, field visit conversion |
| HR | Zero aggregate KPIs — every HR page is record management only; no productivity ratios, no attrition rate |
| Risk | No DPD distribution chart, no NPL trend, no concentration risk, no single obligor limit monitoring, no Capital Adequacy Ratio impact |
| Cohort | Revenue per cohort, default rate by cohort, vintage loss rate; thresholds too punishing for prepaid cards |

## Report Catalogue Gap

Currently: 8 reports.
MFB minimum: 50+ reports.

Missing regulatory reports:

| Report | Need |
|---|---|
| CBN Prudential Ratio Report | CAR, Liquidity Ratio, Single Obligor Limit |
| BOD Pack (PDF) | Monthly board report — required by every regulated entity |
| AML/CFT Risk Assessment | CBN Anti-Money Laundering circular |
| Credit Bureau Submission File | Monthly CRC/First Central submission in prescribed format |
| Fixed Deposit Maturity Report | Proactive FD management |
| Concentration Risk Report | Single borrower, sector, geographic |
| Interest Rate Sensitivity Report | Gap analysis for treasury |
| FATF Correspondent Banking Report | For USD card operations |
| Operational Risk Events | NFIU requires fraud/operational loss reporting |
| NDPR Data Processing Report | Required annually |

## Data Quality Warnings

- `new Date().toLocaleTimeString()` shown as "data updated time" — it's the component render time
- Recovery rate computed client-side from `limit=200` — if portfolio has 2,000 cases, rate is from 10% of data silently
- `ChangeBadge` component exists and works — but is only used on the Sales page; zero MoM comparisons elsewhere

---

# PART 5: SECURITY ROADMAP

## Phase 1 — Before Any Real Data (Immediate)

| Fix | File | Time |
|---|---|---|
| Sanitize mail signature XSS | MailCompose.tsx:530 | 5 min |
| Mask settings API response | settings_handler.go:51-74 | 2 hours |
| Reject Zoho webhook when secret unset | zoho.go:1694-1724 | 30 min |
| Implement WhatsApp HMAC verification | whatsapp.go | 2 hours |
| Add RequireAccess to /approvals and /reports | App.tsx:643,736 | 30 min |
| JTI revocation denylist | core/auth.go | 1 day |
| Randomize OAuth state parameter | voice.go | 3 hours |
| Require auth on /api/health or strip topology | main.go:84 | 1 hour |
| Never return temp_password in API responses | admin.go:136 | 2 hours |
| Page-name allowlist on POST /api/admin/activity | | 2 hours |
| Enforce 12-char minimum password server-side | | 3 hours |
| Make BOOTSTRAP_SECRET required in production | | 1 hour |
| Fix bcrypt error discarded in admin.go:270 | admin.go:270 | 30 min |

## Phase 2 — Within 30 Days

- JWT → HttpOnly cookies (eliminates XSS token theft path entirely)
- MFA (TOTP) for privileged roles: admin, md, coo, cfo, compliance_head, it_admin
- 30-minute tokens + silent refresh
- Permission changes → force re-login
- Dependency scanning in CI (Dependabot/Renovate)
- `govulncheck` in CI
- Per-endpoint rate limits (30-60/min on sensitive endpoints)
- Global request body size limit

## Phase 3 — Within 90 Days (Regulatory Compliance)

- Data retention purge jobs (NDPR Art. 26)
- Data Subject Rights API (NDPR Ch. 3 Art. 28-37, right to erasure)
- Idle session timeout (15 min per PCI-DSS 8.2.8)
- CSP nonce-based (remove `unsafe-inline`)
- External log shipping to append-only SIEM (PCI-DSS 10.3.2)
- Envelope encryption / KMS for credential storage
- DPA documentation for SendGrid/Zoho/Termii cross-border PII transfer
- Annual penetration test

---

# PART 6: ENGINEERING ROADMAP

## Immediate Fixes (1-2 days)

1. Fix `assign_to_user_id` field name mismatch (SB-02) — 5 min
2. Fix Safari date parsing: `fmt.ts:40` → `s + 'T00:00:00Z'` — 5 min
3. Fix XSS in MailCompose signature — 5 min
4. Fix `hash, _ :=` bcrypt error in admin.go:270 — 30 min
5. Fix recovery rate formula — 1 hour
6. Fix collections target_kobo hardcoded to 0
7. Fix Zoho webhook secret check
8. Fix WhatsApp webhook HMAC
9. Replace raw user ID inputs in Reassign (collections) and Assign (LOS) with user dropdowns — 3 hours each
10. Add `go test ./...` to CI in deploy.yml

## Backend Architecture

**No service layer:** All business logic lives in HTTP handler closures. A `service/` layer between handlers and database is needed for testability and reuse.

**Missing:**
- Idempotency keys on `POST /api/los` and `POST /loans` (prevents duplicate submissions on network retry)
- `AbortController` + 30s timeout in `apiFetch` (Railway cold start causes infinite spinner)
- `SELECT FOR UPDATE` on write-off approval and LOS stage advance
- `AND current_stage = $expected_stage` optimistic lock on LOS advance
- Sequence-based reference generation replacing COUNT-based (TOCTOU race)
- Global `http.MaxBytesReader(w, r.Body, 1<<20)` for request body size

**Float64 in reconciliation:** `eodTotals` struct uses `float64` for `TotalDR`/`TotalCR`/`TotalVol`. PostgreSQL NUMERIC → pgx → float64 loses precision on large naira values. Use `int64` (kobo) throughout.

## DevOps Roadmap

**Immediate (cost-free):**
- Fix `FROM golang:1.25-alpine` → `FROM golang:1.23-alpine` (1.25 doesn't exist)
- Add `.dockerignore` (prevents .env and uploads/ leaking into Docker layer history)
- Add `go test ./...` and `govulncheck` to CI
- Add `build.sourcemap: true` to vite.config.ts (production errors are currently undebuggable)
- Move Zoho Voice SDK to role-conditional lazy load (currently loads for all users on page load)
- Make `migrate.go` fail-fast on error (currently logs error and `continue` — server starts with partial schema)

**Short-term ($5-50/month):**
- Create Railway staging environment — deploy PRs to staging, not production
- Move sync engine from office Windows PC to Railway-hosted cron service
- Wire R2 integration for file uploads (config keys already exist in settings table; uploads currently lost on every redeploy)
- Add `slog.NewJSONHandler` for log aggregation
- Add rollback scripts for migrations 016-032

**Medium-term (observability):**
- OpenTelemetry SDK in Go backend (traces + metrics)
- Grafana Cloud free tier: Tempo + Loki + Prometheus
- Sentry for frontend error tracking
- PagerDuty/Opsgenie for on-call alerting

**Long-term (scale):**
- Railway Pro for multi-replica support
- Supabase Pro for PITR backups and read replica for analytical queries
- `pgqueue` or Asynq with Redis for durable background jobs
- Redis for: SSE pub/sub (multi-replica), rate limiter state, session cache

## Testing Roadmap (QA)

**Week 1 — Scaffold + Critical Defects:**
- Fix assign_to_user_id mismatch (if not already done)
- Fix Safari date parsing
- Install vitest + @testing-library/react
- `TestLosAdvanceRejectsInvalidTransition`
- `TestLosCreateRejectsZeroAmount`
- `TestLosAssignRequiresValidUserId`

**Week 2 — Frontend Unit Tests:**
- `fmt.test.ts`: fmtKobo, fmtDate for null/NaN/zero/negative/large/ISO-on-Safari
- `NewApplication.test.tsx`: kobo conversion for integers/decimals/empty/NaN
- `DataTable.test.tsx`: empty array, null rows, loading skeleton

**Week 3 — Handler Integration Tests (test DB):**
- Postgres service container in GitHub Actions
- Full LOS state machine tests
- Concurrent `losAdvance` test (race condition verification)
- `losAssign` with non-existent user ID

**Week 4 — Financial Accuracy:**
- Reconciliation delta calculation with known Paystack vs EOD totals
- `fmt.ts` display boundary tests
- Concurrent `createLoan` stress test for duplicate references

**Week 5 — E2E (Playwright):**
- Login → Overview → Logout
- Create LOS application → advance to `document_collection`
- Date filter change → network request → data update
- CSV export → file download

---

# PART 7: PLATFORM-WIDE UX IMPROVEMENTS

## Must-Add Features (No Fortune 500 without these)

### Global Search (Cmd+K / Ctrl+K)
20+ modules with no way to search across customers, tickets, applications, cases. Every lookup requires navigating to the module you think the data lives in. A command palette that searches by: customer name/phone/CIF, ticket reference, LOS reference, case number, employee name.

### `ConfirmModal` Component
Replace all `window.confirm()` calls (6+ confirmed files: recovery-ops/Cases.tsx, compliance/CbnReports.tsx, crm/Pipeline.tsx, crm/Tasks.tsx, los/ApplicationDetail.tsx, admin/RoleManagement.tsx). Build once — 4 hours. Replace all call sites — 8 hours.

### Period-over-Period Delta on All KPI Cards
`ChangeBadge` component already exists and is used correctly on the Sales page. It should be on every KPI card throughout the platform. This is the single highest-ROI analytics improvement available today.

### Breadcrumb Navigation
Pages within modules (LOS Application Detail, Ticket Detail, Customer 360) have no breadcrumb. Browser back button is the only way back. For agents navigating via cross-module links, the back stack becomes deep and unpredictable.

### `DateFilter` Deployed Universally
`DateFilter` component exists and works well. Pages that lack it: Risk Overview, CRM Reports, Recovery Overview, Admin Overview, HR pages, LOS Queue. Each of these should accept a date filter.

---

# PRIORITY ACTION PLAN

## Sprint 1 — Ship-Blockers (This Week)

| # | Task | Effort | Impact |
|---|---|---|---|
| 1 | Fix XSS in MailCompose signature (sanitizeHtml) | 5 min | CRIT |
| 2 | Fix assign_to_user_id field name mismatch | 5 min | CRIT |
| 3 | Fix Safari date parsing (T00:00:00Z) | 5 min | HIGH |
| 4 | Fix bcrypt error discard in admin.go | 30 min | HIGH |
| 5 | Mask /api/settings/ response (no decrypted values) | 2 hours | CRIT |
| 6 | Reject Zoho webhook when secret unset | 30 min | HIGH |
| 7 | WhatsApp HMAC webhook verification | 2 hours | HIGH |
| 8 | Add go test ./... and govulncheck to CI | 1 hour | CRIT |
| 9 | Fix FROM golang:1.25-alpine in Dockerfile | 5 min | HIGH |
| 10 | Add .dockerignore | 15 min | HIGH |
| 11 | Fix migrate.go fail-fast (remove continue on error) | 30 min | HIGH |
| 12 | Fix collections target_kobo hardcoded to 0 | 1 hour | HIGH |

## Sprint 2 — Workflow Blockers (Next Week)

| # | Task | Effort |
|---|---|---|
| 1 | Replace Reassign modal (Collections) raw ID with user dropdown | 3 hours |
| 2 | Replace Assign modal (LOS) raw ID with user dropdown | 3 hours |
| 3 | Fix recovery rate formula | 1 hour |
| 4 | Fix Customer 360 Collections tab API endpoint | 2 hours |
| 5 | Add Forgot Password link to Login | 30 min |
| 6 | Build ConfirmModal component + replace all window.confirm() | 12 hours |
| 7 | Add waiting_days urgency coloring to Approvals | 30 min |
| 8 | Remove Documents placeholder tab in LOS ApplicationDetail | 5 min |
| 9 | Add RequireAccess to /approvals and /reports routes | 30 min |
| 10 | Fix safari date display bug (T00:00:00Z) | 5 min |

## Sprint 3 — Design System Consolidation

| # | Task | Effort |
|---|---|---|
| 1 | Extract `Tabs` into UI.tsx → replace 4 ad-hoc implementations | 3 hours |
| 2 | Extract `FormField` into UI.tsx → replace 4 label variants | 2 hours |
| 3 | Extract `EmptyState` into UI.tsx → replace 12+ implementations | 2 hours |
| 4 | Extract `InfoCallout` into UI.tsx → replace 8+ implementations | 2 hours |
| 5 | Extract `Toggle` into UI.tsx → consolidate 2 implementations | 1 hour |
| 6 | Extract `Avatar` into UI.tsx → consolidate 5 implementations | 1 hour |
| 7 | Migrate AllApplications hand-rolled table to DataTable | 3 hours |
| 8 | Migrate Employees hand-rolled table to DataTable | 3 hours |
| 9 | Add `selectable` prop to DataTable for TicketList | 2 hours |
| 10 | Remove local Toast from TicketDetail → use Sonner | 30 min |
| 11 | Fix border-radius fork (LOS/HR rounded-2xl → .card) | 2 hours |
| 12 | Fix RED token (#DC2626 → #C00000 throughout, fix ErrBanner) | 1 hour |

## Sprint 4 — Analytics Depth

| # | Task |
|---|---|
| 1 | Add MoM delta badges (ChangeBadge) to every KPI card |
| 2 | Redesign Finance Overview as P&L statement |
| 3 | Add NPL Ratio and PAR30 to Executive Dashboard |
| 4 | Add PTP Kept Rate and Roll Rate Matrix to Collections |
| 5 | Add pipeline ₦ value to LOS stats |
| 6 | Add date filter to Risk Overview, CRM Reports, Recovery Overview |
| 7 | Fix data freshness timestamp (snapshot age, not render time) |
| 8 | Allow risk head to see NPL Ratio |

## Sprint 5 — JWT + Auth Hardening

| # | Task |
|---|---|
| 1 | JTI revocation denylist (Redis/PostgreSQL) |
| 2 | Randomize OAuth state parameter |
| 3 | JWT → HttpOnly cookies (eliminates XSS token theft entirely) |
| 4 | MFA/TOTP for privileged roles |
| 5 | 30-minute tokens + silent refresh |
| 6 | Idle session timeout (15 min) |
| 7 | Require auth on /api/health |

## Quarter 2 — Power Features

| Feature | Priority |
|---|---|
| Global search (Cmd+K) | HIGH |
| Inline approval actions in Approvals page | HIGH |
| LOS document upload | HIGH |
| Staging environment | CRIT |
| Observability stack (OpenTelemetry + Grafana) | HIGH |
| Sentry for frontend errors | HIGH |
| Breadcrumb navigation | MEDIUM |
| DateFilter on all remaining pages | MEDIUM |
| Collections Promises dedicated endpoint | MEDIUM |
| CRM Pipeline drag-and-drop | MEDIUM |
| Contact Detail page in CRM | MEDIUM |
| PDF export of executive dashboard | MEDIUM |
| Role Management affected-users preview | MEDIUM |

## Quarter 3 — Regulatory & Scale

| Item | Priority |
|---|---|
| Data retention purge jobs (NDPR Art. 26) | HIGH |
| Data Subject Rights API (NDPR erasure) | HIGH |
| CBN Prudential Ratio Report | HIGH |
| BOD Pack PDF generation | HIGH |
| Credit Bureau submission file format | HIGH |
| Concentration Risk Report | HIGH |
| Supabase Pro + read replica for analytics | HIGH |
| Redis for SSE pub/sub (multi-replica support) | HIGH |
| react-window virtualization in DataTable | MEDIUM |
| Server-side pagination (replace limit=500 fetches) | MEDIUM |
| Self-hosted fonts for LCP optimization | LOW |

---

# WHAT FORTUNE 500 READINESS LOOKS LIKE

A Fortune 500 company's IT security and procurement team will ask for:

1. **SOC 2 Type II** — not achievable without: append-only audit logs, MFA, revocable sessions, access reviews, encryption at rest documentation, annual pen test
2. **NDPR/CBN Compliance** — not achievable without: data retention policies, right-to-erasure API, idle session timeout, DPA documentation for third parties
3. **Staging environment** — any enterprise requiring change management will reject a system with no staging
4. **Zero automated tests** — no enterprise will accept deployment without test gates
5. **SBOM** — most Fortune 500 procurement requires a Software Bill of Materials
6. **Incident response documentation** — runbook, on-call rotation, RTO/RPO definitions
7. **Penetration test report** — required annually by most enterprise security frameworks

The platform's composite score is **4.9/10**. The foundation is architecturally sound and the UI/UX is ahead of most Nigerian fintech internal tools. The path to Fortune 500 readiness is achievable in 12 months with disciplined sprint execution following this roadmap.

The most impactful single thing: **create a staging environment**. Everything else becomes safer the moment changes stop going directly to production.

---

---

# PART 8: ADDITIONAL ENGINEERING & ARCHITECTURE ISSUES

*Items from the Software Engineering and Systems Engineering reports not captured in Parts 1–7.*

---

## A. Additional Ship-Blocker Bugs

### BUG-A: JWT Never Signature-Verified on Client
**File: `frontend/src/App.tsx:499-522`**

`parseToken()` does a Base64 decode only — no signature verification whatsoever. A tampered JWT with a modified `role`, `pages`, or `exp` field passes the client-side expiry check and renders the full layout with the attacker's chosen role. The backend will reject API calls, but the UI renders as if the user has that role until the first API call fails.

**Fix:** Stop trusting the parsed JWT client-side entirely. Call `GET /api/auth/me` on load and use its response as the single canonical user object. Delete `parseToken()`.

---

### BUG-B: ROLE_PAGES Diverges Between Frontend and Backend — Latent Privilege Bug
**Files: `frontend/src/hooks/useAuth.ts:38-92` vs `backend-go/core/auth.go:231-452`**

The `executive` role grants these pages in the frontend: `income, transactions, credit_portfolio, fixed_deposit, eod`. The backend only grants: `overview, executive, kpi_dashboard, reports, statements`. Users with `executive` tokens see these sidebar links, click them, and get 403 errors. Users whose tokens were issued before the `pages` JWT field existed see an entirely different permission set depending on which system evaluates them.

**Fix:** Create `GET /api/auth/role-pages` endpoint. Delete `ROLE_PAGES` from the frontend entirely. Frontend always fetches the authoritative map from the backend.

---

### BUG-C: Base64 Logo Stored Raw in `encrypted_value` Column
**File: `backend-go/handlers/admin.go:933-948`**

`uploadEmailLogo` stores the logo as a raw `data:image/png;base64,...` string in the `encrypted_value` column. This column is supposed to hold encrypted values — `decryptValue()` will crash if it's ever called on a logo row. A 512KB logo image becomes a 682KB base64 string that is returned in every API response that reads this settings column. The logo is also stored in the DB instead of object storage, which means it is not backed up independently and grows the DB unnecessarily.

**Fix:** Store logo in Supabase Storage (or R2), save only the URL in the settings table.

---

### BUG-D: AuditTrail Export Bypasses `apiFetch` — Downloads JSON Error as CSV
**File: `frontend/src/pages/compliance/AuditTrail.tsx:59-72`**

The export button uses a raw `fetch()` call, not the shared `apiFetch`/`apiExport` wrapper. When the token expires mid-session, the backend returns a 401 with JSON body `{"detail":"Invalid or expired token"}`. The raw `fetch` converts this 401 to a Blob and triggers a file download. The compliance officer receives a 43-byte "CSV" file containing the JSON error string — with no error message shown in the UI.

**Fix:** Use `apiExport()` which handles 401 responses correctly.

---

### BUG-E: Approvals Polling — Stale Closure + Double Sign-Out Toast
**File: `frontend/src/App.tsx:244-248`**

`fetchSummary` is in a `useCallback` with `[]` (no dependencies). On token expiry, the in-flight request returns 401 → `signOut()` is called → `auth:expired` event is dispatched → a second `signOut()` call may fire from the event handler. This produces a double sign-out toast and can leave the app in a partially-signed-out state where some state is cleared and some is not.

**Fix:** Add `fetchSummary` to the `useCallback` dependency array. Add a ref guard to prevent double sign-out.

---

### BUG-F: Leave Approval — Balance Deducted Twice Under Concurrency
**File: `backend-go/handlers/hr.go:360-381`**

Two HR managers simultaneously approving the same leave request both read `status = pending`, both pass validation, both execute the UPDATE to `approved`, and both execute the `UPDATE leave_balances SET used_days = used_days + X`. The leave balance is deducted twice. The employee is debited more leave than they requested.

This is the same class of race condition as SB-05 (LOS advance, write-off). The same fix applies: `UPDATE WHERE status='pending' RETURNING id`, check `RowsAffected == 1`.

---

### BUG-G: Promise Mark-Honoured — No Ownership Check
**File: `backend-go/handlers/collections_ops.go:226-237`**

Any collections agent with the `collections_ops` page permission can mark any promise kept or broken — regardless of which agent owns the case. An agent can manipulate a colleague's performance metrics (PTP Kept Rate) or mark a payment as received for a case they have no relationship with.

**Fix:** Add `AND assigned_agent_id = $current_user_id` to the UPDATE, or a JOIN to verify case ownership.

---

### BUG-H: `sales_officer` Can Advance LOS to `finance_approval`
**File: `backend-go/handlers/los.go:309`**

`losAdvance` validates the transition against the allowed graph (e.g., `submitted → risk_review`) but does NOT check whether the requesting user's role is permitted to make that transition. A sales officer can submit an application and then also advance it to `risk_review` or even `finance_approval` without being a risk officer or finance head.

**Fix:** Add a role-to-allowed-transition map in `los.go` and check it before accepting the advance.

---

### BUG-I: No GL Journal Entries — CLAUDE.md Financial Integrity Requirement Not Met
**Scope: Entire backend**

CLAUDE.md §8 states: *"Every financial operation (credit, debit, disburse, repay, transfer) must post a double-entry GL journal via `_post_journal()`."* There are zero GL journal postings anywhere in the Go backend codebase. Loan bookings, collection payments, recovery payments, write-offs, FD maturities — none post to a GL. Financial integrity in the event of a dispute, audit, or reconciliation failure has no ledger to fall back on.

**Fix:** Identify all financial mutations in: `los.go` (booking), `loans.go` (disbursement), `collections_ops.go` (payment), `recovery_ops.go` (payment, write-off), `operations.go` (FD). Add double-entry journal inserts within the same DB transaction.

---

### BUG-J: Two Parallel Loan Systems — Dual-Write Risk
**Files: `backend-go/handlers/loans.go` and `backend-go/handlers/los.go`**

Both operate on the same `loan_applications` table with divergent stage vocabularies and separate endpoint paths (`/api/loans` vs `/api/los`). A dual-write through both systems can produce impossible application state (loan booked via `loans.go` but stage in `los.go` still shows `risk_review`). The `listLoans` handler has no OFFSET parameter — the frontend cannot paginate past page 1.

**Fix:** Audit which UI surfaces use `/api/loans` vs `/api/los`. Merge into one or establish a clear boundary with explicit ownership of each application state field.

---

## B. Data Integrity Issues

### Missing DB Transactions
- Collection payment logging in `collections_ops.go` does NOT use a transaction — payment insert and running total update can diverge on partial failure
- LOS booking in `los.go` does NOT use a transaction — stage update and booking record can diverge
- `hrLeaveApprove` at `hr.go:370`: leave balance deduction is a separate UPDATE from approval UPDATE — on partial failure, leave is approved but balance not deducted (or vice versa), giving employees infinite leave

### `respondErr(w, 200, "Assigned successfully")` — HTTP 200 with Error Shape
Multiple handlers return HTTP 200 with an error-shaped body `{"detail": "..."}`. Any client branching on HTTP status code will treat these as successes. The `apiFetch` error-checking logic may not catch them.

### `normalizeVal` Returns JSON as String
`backend-go/db.go:207`: JSONB columns are returned as Go strings, not parsed JSON. The frontend receives a JSON-escaped string inside a JSON response and must double-parse. If this ever silently changes, all JSONB columns return garbled data.

### `getActivity` Hard-Caps at 200 Rows
Compliance audit export via `getActivity` returns at most 200 rows. For a CBN audit covering months of activity, exports are silently truncated. There is no indication in the API response or the UI that data was omitted.

---

## C. Missing Database Indexes

These indexes are missing (inferred from query patterns in handler code). Without them, queries degrade linearly as data grows:

| Index | Reason |
|---|---|
| `notifications(user_id, is_read, id)` | Polled every 2 seconds per active user |
| `loan_applications(assigned_to_user_id)` | LOS queue filter |
| `loan_applications(stage, status, updated_at)` | All Applications filter + sort |
| `o3c_activity_log(user_id, ts DESC)` | Audit trail by actor |
| `collection_assignments(agent_user_id, dpd_bucket, current_stage)` | Collections queue multi-filter |
| `recovery_cases(status, assigned_agent_id)` | Recovery case list |

At 50k loan applications with no index on `(stage, status, updated_at)`, the LOS All Applications page degrades to a full table scan.

---

## D. SSE Architecture — `pg_notify` Never Consumed

**File: `backend-go/handlers/notifications.go:250-265`**

`pg_notify` IS called at line 309 but the SSE handler ignores it entirely. The SSE handler uses a 2-second ticker to poll the database — it never calls `pgx.Conn.WaitForNotification`. Result: `pg_notify` calls are dead code. Every active SSE connection generates one DB query every 2 seconds regardless of whether there are any new notifications. At 50 concurrent users: 25 queries/second sustained, 24/7, competing for the 25-connection pool.

**Fix:** Remove the 2-second ticker. Use `pgx.Conn.WaitForNotification` on the `pg_notify` channel — the infrastructure is already in place on the DB side.

---

## E. Frontend Architecture Issues

### `App.tsx` is a 818-Line God Component
Re-renders on any state change and evaluates the entire route tree on every render. All notification state, all approval polling, all auth state, and all route definitions live in one file.

**Fix:** Break into `AppLayout` (shell, notifications, approval polling) + domain route groups (`LOSRoutes`, `CollectionsRoutes`, etc.).

### Dual Auth State
`App.tsx` manages user state independently from `useAuth.ts`. Two parallel auth systems that can drift apart. A component that imports from `useAuth` can see a different user object than one that reads from `App` context.

**Fix:** Single source of truth — eliminate one of the two systems.

### `DataTable` Sort Without `useMemo`
`[...rows].sort(...)` runs on every render. For server-paginated data, this also sorts only the current page — silently giving wrong results for multi-page datasets where the user expects global sort.

**Fix:** Wrap sort in `useMemo`. Add `onSortChange` callback for server-side sort.

### No `storage` Event Listener
Logging out in one browser tab does not notify other open tabs. Other tabs continue polling and making authenticated requests until the next API call fails (up to 30 seconds). For a platform where privileged users might share machines, this is a security gap.

**Fix:** Add `window.addEventListener('storage', ...)` listening for `o3c_token` removal.

### SSE Reconnection Loses Missed Notifications
**File: `frontend/src/hooks/useNotifications.ts:53-109`**

On reconnect, the in-memory notification array is NOT refreshed from the server. Notifications that arrived during the outage (network drop, container restart) are permanently missed. The unread badge count will be wrong until next page load.

**Fix:** On first `ping` event after reconnect, call `GET /api/notifications?per_page=30&page=1` and merge results.

### AuditTrail Filter Race Condition
In `AuditTrail.tsx`, the `cancelled` variable is a closure variable over `load`, not a `useEffect` cleanup ref. Two quick filter changes can produce out-of-order state updates — the second filter's results can arrive first and then be overwritten by the first filter's late-arriving results.

**Fix:** Use `AbortController` in the `useEffect` cleanup, same pattern used in other pages.

### No `apiFetch` Timeout
`apiFetch` has no `AbortController` or timeout. Railway cold starts take 3-8 seconds. On cold start, the user sees an infinite spinner with no error message or retry option.

**Fix:** Add 30-second timeout with AbortController. Show "Request timed out — click to retry" on timeout.

### Campaign Dispatch Lock is Process-Local
**File: `backend-go/handlers/campaigns.go:36`**

`sync.Map` dispatch lock is per-process. On Railway multi-replica deployments, two replicas can each hold the "lock" simultaneously, causing the same campaign to dispatch twice. The real guard is `dispatch_lock_until` in the DB, but the process-level map creates a false sense of safety.

**Fix:** Remove `sync.Map` guard. Rely solely on the DB-level `dispatch_lock_until` + conditional UPDATE.

---

## F. RBAC Gaps

### Page-Level Only — No Record-Level Authorization
RBAC enforces which pages a user can access. It does NOT enforce which records within a page they can see. A collections agent sees ALL collection assignments in the queue endpoint, not just their own portfolio. A sales officer can see all LOS applications, not just those assigned to them.

**Fix:** Add `AND assigned_to_user_id = $current_user_id` to relevant listing queries when the user's role implies personal-portfolio scope (sales_officer, collections_officer, recovery_officer).

### `campaign_contacts` Stores PII Without HMAC Blind Index
CLAUDE.md §8 requires HMAC blind indexes for PII fields (phone, email). `campaign_contacts` stores `phone` and `email` as plain columns. If the DB is ever compromised, these are immediately readable without key material.

---

## G. Performance Issues Not Yet Addressed

### Backend
- `activityLogger` spawns one goroutine per HTTP request — at scale, thousands of goroutines compete for the 25-connection pool. **Fix:** Buffered channel + 5-worker pool.
- `streamCSV` collects all rows in memory before writing — a 100k-row export holds all rows in memory simultaneously. **Fix:** Stream directly to the response writer row-by-row.
- `approvalsPending` executes up to 8 sequential DB queries per request. **Fix:** Single query with UNION or parallel execution using `errgroup`.
- `recoveryOpsCaseDetail` executes 5 sequential queries per case — at 50 concurrent users, 250 round-trips per page load.
- No query caching on overview KPIs — same aggregations computed on every page load, including potentially slow MSSQL cross-queries.

### Frontend
- Material Symbols font loaded from Google CDN — blocking network request on cold page load, GDPR concern (IP sent to Google).
- `manualChunks` catch-all `if (id.includes('node_modules')) return 'vendor'` creates one giant vendor chunk invalidated by any dependency update. The correct approach is per-library chunks for large dependencies (recharts, tiptap, d3).
- `apiFetch<T = any>` — default generic type is `any`. Most call sites omit the type parameter entirely. Runtime type errors are invisible until production.
- Brand color `#0E2841` appears as a string literal in 30+ locations instead of importing `NAVY` from UI.tsx.

---

## H. Missing API Infrastructure

| Gap | Impact |
|---|---|
| No API version prefix (`/api/v1/`) | Breaking contract changes have no migration path |
| No OpenAPI/Swagger spec | Field name changes like `assigned_to_user_id` vs `assign_to_user_id` are runtime surprises, not compile-time errors |
| `SetConnMaxIdleTime` missing on DB pool | Connections can linger; server-side idle timeouts cause errors on first use |
| No per-endpoint rate limits on data-read endpoints | Aggressive scraping of financial data at 300 req/min global limit |
| `Content-Security-Policy` header missing from `securityHeaders` in `main.go` | Not confirmed in security headers output |
| Nightly batch (`RunBatchNightly`) runs inside web server | Competes with HTTP handlers for DB connections and CPU |

---

## I. Scalability Ceiling

The current architecture hits its limits at approximately:

| Threshold | Bottleneck |
|---|---|
| ~100 concurrent authenticated users | SSE polling + dashboards → 100-200 DB queries/second → Supabase 25-connection pool exhausted |
| ~50k loan applications | `losAll` without composite index → full table scan |
| ~1M notification rows | SSE poll without `(user_id, id)` index → full scan per user every 2 seconds |
| Multiple Railway replicas | Campaign dispatch race (sync.Map is per-process), SSE fan-out broken (events on instance A not delivered to client on instance B) |
| Nightly batch at scale | Runs in web server process — DB connections competed between batch and HTTP handlers |

**The SSE fan-out problem is architectural.** Once Railway scales to 2+ replicas, SSE events generated on instance A are never delivered to clients connected to instance B. Redis pub/sub (or the `pg_notify` path, if the SSE listener is fixed) is required before multi-replica deployment.

---

*Document compiled from 11 specialist reviews. Every page, every role, every gap documented.*
*Last updated: 2026-06-30*
