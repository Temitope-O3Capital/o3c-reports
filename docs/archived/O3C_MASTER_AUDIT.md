# O3C REPORTS — MASTER PLATFORM AUDIT
**Date:** 2026-06-21  
**Agents:** 9 specialists (SE, Frontend, DevOps, Data/BI, Product Designer, UI/UX, QA, CEO/Operations, Systems Analyst)  
**Scope:** Full codebase — `backend-go/`, `frontend/src/`, `sync/`, `.github/`, migrations, design system

---

## OVERALL PLATFORM SCORE: 6.5 / 10

> The bones are right. Architecture is sound, the dual-source pattern is well-designed, and 7 of 10 operational modules are genuinely usable. But 5 platform-breaking bugs make the approval system, portfolio KPIs, financial display, and role access non-functional. Fix those 5 things in one sprint and the score jumps to 8.5/10.

---

## PART 1 — PLATFORM-BREAKING BUGS
*Issues confirmed by 3+ specialist agents. Fix these before touching anything else.*

---

### BUG-1: The Entire Approvals System Returns Empty — Always
**Agents flagged:** SE, Systems Analyst, QA, CEO  
**Files:** `backend-go/handlers/approvals.go` — lines 61, 70, 115–117, 156, 188

`approvals.go` queries five tables/columns that do not exist in any migration:

| What the code says | What actually exists |
|---|---|
| `FROM write_off_requests` | `recovery_write_off_approvals` |
| `FROM leave_requests` | `leave_applications` |
| `FROM compliance_findings` | `audit_findings` |
| `FROM users u` | `o3c_users u` |
| `la.borrower_name` | `la.applicant_name` |

**Result:** `/api/approvals/pending` and `/api/approvals/summary` always return empty lists. The ApprovalsButton badge permanently shows 0. The MD, COO, and CFO see no pending items. The entire approval workflow is invisible from the central queue.

**Fix:**
```go
// approvals.go line 70
LEFT JOIN o3c_users u ON u.id = la.created_by   // was: users

// approvals.go line 111
la.applicant_name AS borrower_name               // was: la.borrower_name

// approvals.go lines 115-117
FROM recovery_write_off_approvals w              // was: write_off_requests

// approvals.go line 156
FROM leave_applications la                       // was: leave_requests

// approvals.go line 188
FROM audit_findings f                            // was: compliance_findings
```

---

### BUG-2: Portfolio Batch Fails Nightly — All KPI Numbers Show Zero
**Agents flagged:** SE, Data/BI, Systems Analyst, CEO  
**Files:** `backend-go/handlers/batch.go` lines ~155–190

`batchPortfolioSnapshot()` runs every night and queries:
```sql
SELECT ... FROM loan_applications WHERE dpd > 90
```
There is no `dpd` column on `loan_applications` (not in migrations 001–015). The batch fails with a column-not-found error **every single night**. Downstream:
- `portfolio_daily_snapshot` is never populated → NPL ratio, PAR30, total outstanding all show zero
- `loan_dpd_daily_snapshot` is **also** never populated (no batch step writes it) → DPD bucket breakdown in executive dashboards always empty
- `collections_daily_kpi` is **also** never populated → all collections KPI dashboard zeros

**Fix:** Add migration 016:
```sql
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS dpd INTEGER NOT NULL DEFAULT 0;
```
Then add a batch step that computes DPD from `booked_at`:
```sql
UPDATE loan_applications 
SET dpd = GREATEST(0, CURRENT_DATE - booked_at::date)
WHERE status IN ('active','repaying','overdue');
```
Also add batch steps to populate `loan_dpd_daily_snapshot` and `collections_daily_kpi` from source tables.

---

### BUG-3: Every Monetary Amount Displays 100× Too Large
**Agents flagged:** SE (CRITICAL), Frontend, UI/UX  
**File:** `frontend/src/lib/fmt.ts` lines 1–15

`fmt()` formats raw numbers directly as ₦ without dividing by 100. All database values are stored in kobo. Every page that calls `fmt(someKoboValue)` displays ₦500,000 where the correct display is ₦5,000.

**Fix — Option A (safest):** Create a dedicated function and update all call sites:
```ts
// lib/fmt.ts
export function fmtKobo(n: unknown): string {
  const x = Number(n) / 100
  if (!isFinite(x)) return '—'
  return '₦' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
```
Audit every call to `fmt()` — if the data comes from a `_kobo` column, replace with `fmtKobo()`. If it comes from MSSQL (amounts already in naira), keep `fmt()`.

**Note:** `fmtExact()` has the same bug. Both must be fixed together.

---

### BUG-4: 20 of 24 Roles Get a Blank App
**Agents flagged:** SE (HIGH), Frontend (CRITICAL), Systems Analyst  
**File:** `frontend/src/hooks/useAuth.ts` — `ROLE_PAGES` map (lines 25–43)

The frontend `ROLE_PAGES` map only covers 7 legacy roles. The backend defines 24 canonical roles. When a user with role `collections_agent`, `hr_manager`, `compliance_officer`, `risk_officer`, etc. logs in, `canAccess()` returns `false` for everything — the sidebar hides all items and pages reject access.

**Fix (fastest):** Strip `ROLE_PAGES` out of the frontend entirely. The backend already embeds `pages[]` in the JWT. Use that exclusively:
```ts
// hooks/useAuth.ts
const canAccess = useCallback((page: string): boolean => {
  if (!user) return false
  // Use JWT pages array — backend is the source of truth
  return (user.pages ?? []).includes(page)
}, [user])
```
Remove the `ROLE_PAGES` constant. Also remove the duplicate `ROLE_PAGES` from `lib/roles.ts` and the one in `App.tsx`.

---

### BUG-5: Collections Ops Targets Endpoint Always Returns 500
**Agents flagged:** SE (CRITICAL), Data/BI, QA, Systems Analyst  
**File:** `backend-go/handlers/collections_ops.go` lines 258–284

```go
FROM collections_daily_kpi
LEFT JOIN o3c_users u ON ct.agent_user_id = u.id  // 'ct' alias never defined
```

Every call to `GET /api/collections-ops/targets` panics at the database with "column ct.agent_user_id does not exist."

**Fix (one line):**
```go
FROM collections_daily_kpi ct   // add alias
```

Additionally: the `collectionsOpsUpsertTarget` handler writes to `collection_targets` but `collectionsOpsTargets` reads from `collections_daily_kpi` — **two different tables**. Target writes never show up in the targets page. Consolidate to one table.

---

## PART 2 — CRITICAL BUGS (fix this sprint)

### C-1: confirmDocument Writes User ID into Document FK Column
**Agent:** SE  
**File:** `backend-go/handlers/loans.go:309`
```go
// WRONG — writes user ID into document_id (FK to documents table)
UPDATE application_documents SET document_id=$1 WHERE id=$2
// args: user.ID, docID
```
Fix: Add `confirmed_by BIGINT REFERENCES o3c_users(id), confirmed_at TIMESTAMPTZ` column (migration 016), then:
```go
UPDATE application_documents SET confirmed_by=$1, confirmed_at=NOW() WHERE id=$2
```

### C-2: Write-off Approval Has No Confirmation — Irreversible Action, One Click
**Agents:** UI/UX, QA  
**File:** `frontend/src/pages/recovery-ops/Cases.tsx:515–529`  
Clicking Approve/Reject on a write-off executes immediately. Gate behind a styled confirmation modal showing the write-off amount and reason. This is a permanent financial action.

### C-3: Recovery/Legal Fires N×200 HTTP Requests on Page Load
**Agent:** UI/UX  
**File:** `frontend/src/pages/recovery-ops/Legal.tsx:72–104`  
Fetches 200 cases then fires one `apiFetch` per case in `Promise.all`. 200 concurrent requests — some fail silently under rate limiting, showing fewer proceedings than exist. Cap at 20 cases or add a dedicated `/api/recovery-ops/legal` endpoint.

### C-4: LOS Stage Advance Has No Confirmation for Irreversible Transitions
**Agent:** UI/UX  
**File:** `frontend/src/pages/los/ApplicationDetail.tsx:129–135`  
`finance_approval → booking` and `booking → active` are one-click with zero confirmation. Add a confirm dialog for these two terminal transitions.

### C-5: Customer 360 Collections Tab Always Empty
**Agents:** CEO, UI/UX, Systems Analyst, Frontend  
**File:** `frontend/src/pages/customer360/Customer360.tsx:319`  
Tab renders `profile.recent_transactions` (wrong field) instead of collections history. The backend endpoint exists and works. Three-line fix.

### C-6: SAR Reference Numbers Generated with Race-Condition
**Agent:** SE  
**File:** `backend-go/handlers/compliance.go:460–468`  
Uses `COUNT(*)+1` — two concurrent SAR creates generate the same ref. Migration 015 created `sar_ref_seq` but it's never used.
```go
// Replace COUNT approach with:
SELECT nextval('sar_ref_seq') AS seq
```

### C-7: Recovery/Watch Lists Show Mock Data in Production
**Agent:** Frontend  
**File:** `frontend/src/pages/Watch.tsx`  
Renders `MOCK_ENTRIES` hardcoded array. No API calls. Not reachable from sidebar but accessible by URL. Delete this file and remove its route from `App.tsx`.

### C-8: Webhook Secret Comparison Is Not Constant-Time
**Agent:** SE  
**File:** `backend-go/handlers/campaigns.go:594–610`  
Custom loop comparison leaks timing information. Replace with:
```go
return hmac.Equal([]byte(provided), []byte(expected))
```

### C-9: Email Block Editor File Upload Silently Fails
**Agent:** Frontend  
**File:** `frontend/src/components/EmailBlockEditor.tsx:~339`  
`apiFetch` sets `Content-Type: application/json` unconditionally, overriding the `multipart/form-data` boundary. Image uploads are broken on every browser.

### C-10: NPL Provision Rate Is Flat 25% — CBN Regulatory Violation
**Agent:** Data/BI  
**File:** `backend-go/handlers/reports.go:613`  
CBN Prudential Guidelines require tiered provisioning: Substandard (31–90 DPD) = 10%, Doubtful (91–180) = 50%, Lost (>180) = 100%. Flat 25% misrepresents regulatory submissions.
```sql
-- Replace single calculation with per-bucket:
SUM(CASE WHEN dpd BETWEEN 31  AND 90  THEN outstanding_kobo * 0.10 END) AS prov_substandard,
SUM(CASE WHEN dpd BETWEEN 91  AND 180 THEN outstanding_kobo * 0.50 END) AS prov_doubtful,
SUM(CASE WHEN dpd > 180              THEN outstanding_kobo * 1.00 END) AS prov_lost
```

### C-11: `admin_activity_log` Table Does Not Exist — Audit Trail Export Fails
**Agent:** Data/BI, SE  
**File:** `backend-go/handlers/reports.go:529`  
`reportAuditTrailExport` queries `admin_activity_log`. Only `audit_logs` and `o3c_activity_log` exist. The Audit Trail Export report — a CBN examination requirement — always returns an error.  
Fix: Point the query at `o3c_activity_log` (adjusting column names: `ts` not `created_at`).

### C-12: Golang 1.25 Does Not Exist — Railway Builds Failing
**Agent:** DevOps  
**File:** `backend-go/Dockerfile:1`, `backend-go/go.mod:3`  
`FROM golang:1.25-alpine` fails at Docker pull. Change to `golang:1.23-alpine`.

### C-13: Wrong Body Font — DM Sans Never Loads
**Agent:** Product Designer  
**File:** `frontend/src/index.css:7`  
`font-family: 'Plus Jakarta Sans'` overrides Tailwind's DM Sans config. Every page renders in the wrong typeface.
```css
/* Fix: */
font-family: 'DM Sans', ui-sans-serif, system-ui, sans-serif;
```
Also fix line 73: `IBM Plex Mono` → `DM Mono`. Also fix line 9: `#F6F5F2` → `#F4F6F8` (canvas).

### C-14: DataTable Column Headers Fail WCAG AA
**Agent:** Product Designer  
**File:** `frontend/src/components/UI.tsx:168`  
`color: 'rgba(255,255,255,0.6)'` on navy background = ~3.1:1 contrast ratio. WCAG AA minimum is 4.5:1 for small text. Change header to light background per design system spec: `bg-gray-50`, `text-gray-500` dark text.

### C-15: GREEN Token Fails WCAG AA
**Agent:** Product Designer  
**File:** `frontend/src/components/UI.tsx:12`  
`GREEN = '#059669'` (3.1:1 on white). Design system specifies `#166534` (7.6:1). Every "active/approved/paid" badge fails accessibility.

### C-16: LOS `confirmDocument` JOIN Uses Timestamp as FK
**Agent:** SE  
**File:** `backend-go/handlers/loans.go:119`  
```go
LEFT JOIN o3c_users u ON u.id = ad.created_at  // created_at is a timestamp, not a user ID
```
`confirmed_by_name` is always NULL.

### C-17: `loan_applications.loan_amount` Column Is NUMERIC(20,2) — Violates Kobo Rule
**Agent:** Data/BI  
**File:** `backend-go/migrations/015_schema_fixes.sql:330`  
All other financial columns are `BIGINT` kobo. This column stores decimal NGN. Any SUM mixing this with kobo columns produces wrong results. Change to `BIGINT` and rename to `loan_amount_kobo`.

### C-18: CORS Missing DELETE and PATCH Methods
**Agent:** SE  
**File:** `backend-go/main.go:318`  
```go
"Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS"
// Missing: DELETE (used by deleteUser, deleteRole), PATCH (used by updateCampaign)
```
Browser preflight for DELETE/PATCH fails → those endpoints broken from browser.

### C-19: Sync Engine Destroys All Indexes on Every Sync Run
**Agent:** DevOps  
**File:** `sync/sync_engine.py:187–189`  
DROP TABLE → RENAME removes indexes. 1M-row Transactions table becomes a full scan after every nightly sync. Add `CREATE INDEX` statements after the rename, or switch to TRUNCATE + INSERT.

### C-20: Recovery Reporting KPIs Always Zero (RecoveryMasterSheet Not Synced)
**Agent:** Systems Analyst  
`dbo.RecoveryMasterSheet` is not in sync_engine.py's `TABLES` list. The PG `"Recovery Master Sheet"` table is not created in any migration. In PG-fallback mode, all recovery KPIs return zero/empty. Add to sync engine and create migration.

---

## PART 3 — HIGH PRIORITY ISSUES

### Security

**S-1: Rate Limiter Uses Wrong IP (Spoofable)**  
`httprate.LimitByIP` uses `RemoteAddr` or leftmost `X-Forwarded-For`. Railway appends real IP last. Attackers bypass rate limits by spoofing the leftmost XFF header.
```go
// Fix: use rightmostIP() helper already defined in main.go
httprate.LimitByFunc(100, time.Minute, func(r *http.Request) (string, error) {
    return rightmostIP(r), nil
})
```

**S-2: JWT Stored in localStorage — XSS Exfiltrable**  
Move to `httpOnly; Secure; SameSite=Strict` cookies, or at minimum tighten CSP (S-3 first).

**S-3: CSP Allows `unsafe-inline` Scripts**  
`frontend/public/_headers` — remove `'unsafe-inline'` from `script-src`. Vite-built apps don't need it.

**S-4: Audit Trail Export Passes JWT in URL**  
`frontend/src/pages/compliance/AuditTrail.tsx:59` — `window.open(...&token=${token})`. Token appears in server logs and browser history. Use `apiExport()` instead.

**S-5: ENCRYPTION_KEY Not Validated at Startup**  
If `ENCRYPTION_KEY` is set but not exactly 32 bytes, API key saves fail at runtime with a 500. If unset, API keys stored in plaintext with only a `slog.Warn`. Make startup fatal if key is wrong length.

**S-6: `checkWebhookToken` Accepts Any Request When Secret Not Set**  
`campaigns.go` — if `SMS_WEBHOOK_SECRET` not configured, returns `true` unconditionally. Change to `return false` when secret is empty.

**S-7: `frontend/dist/` Committed to Git**  
Build artifacts tracked despite being in `.gitignore`. Run `git rm -r --cached frontend/dist/`.

**S-8: Migrations 012/013 Reference Non-Existent `users` Table**  
`backend-go/migrations/012_api_credentials.sql` uses `REFERENCES users(id)`. Only `o3c_users` exists. Migration 015 patches it with a DROP/re-add, but fresh installs fail at 012.

### Data Integrity

**D-1: Leave Balance Never Decremented on Approval**  
`hrLeaveApprove` sets status to 'approved' but does not update `leave_balances.days_used`. Employees can take unlimited leave without balance depletion.
```sql
-- Add after status update:
UPDATE leave_balances 
SET days_used = days_used + $days_requested
WHERE employee_id = $emp_id AND leave_type_id = $type_id AND year = $year
```

**D-2: custom_roles.pages Stored as TEXT[] but Read as []any**  
`migrations/015` defines `pages TEXT[]`. `admin.go` marshals to JSON string. `auth.go` reads with `.([]any)` type assertion — fails for PG arrays. Custom role pages never load into JWT.  
Fix: Standardize on `JSONB` for `pages` column.

**D-3: Recovery Rate Formula Is Wrong**  
`overview.go:76–81`: `recovered / (collected + recovered) × 100` is share-of-receipts, not a recovery rate. Correct: `recovered_kobo / total_npls_kobo × 100`.

**D-4: Monthly Business Report Double-Counts Active Loans**  
`WHERE status IN ('booked','active','repaying')` — loans booked before the period but still active appear as "new disbursements." Change filter to `status NOT IN ('draft','cancelled')`.

**D-5: Settlement Recon Doesn't Actually Reconcile**  
`reportSettlementRecon` returns two separate totals side-by-side but never computes open exposure per loan. Add per-loan join: disbursed vs. total repaid → show the break.

**D-6: DPD Bucket ORDER BY Is Lexicographic, Not Numeric**  
`GROUP BY dpd_bucket ORDER BY dpd_bucket` — if bucket '120+' is ever added, it sorts before '31-60'. Add CASE expression for deterministic ordering. Add CHECK constraint on valid bucket values.

**D-7: Collections KPI MTD Ignores User-Selected Date Range**  
`collections.go` hardcodes `DATE_TRUNC('month', CURRENT_DATE)` regardless of `date_from`/`date_to` params. Querying March collections in June returns June's MTD.

**D-8: `incSummary` Queries `income_cycles.report_date` — Column Does Not Exist**  
`income.go:479` — should be `cycle_date`. Income summary page shows zeros for any user who hasn't explicitly selected a cycle.

**D-9: `validDate` Accepts Calendar-Invalid Dates**  
Regex `^\d{4}-\d{2}-\d{2}$` passes `2026-02-30` and `2026-13-01`. Use `time.Parse("2006-01-02", s)` instead.

**D-10: Agent Performance Report Omits Zero-Activity Agents**  
INNER JOIN on `collections_daily_kpi` excludes agents with targets but zero contacts. Change to LEFT JOIN starting from users filtered by role.

### Architecture / Performance

**A-1: SSE Polls DB Every 2 Seconds Per Connected User**  
`notifications.go:169–204` — 50 users = 25 queries/second on idle. `NOTIFY` is already called on every insert but SSE listener ignores it and polls. Switch to PG `LISTEN/NOTIFY` via `pgx.WaitForNotification`.

**A-2: No Migration Runner — Schema Drift Risk**  
15 migration files exist but must be applied manually. No tracking of which have run. Add `golang-migrate` or `pressly/goose` and apply automatically on startup.

**A-3: `ALLOWED_ORIGINS` Empty = Silent Frontend Break**  
If env var not set, CORS middleware denies all browser requests. Currently only a log warning — should be a fatal startup error.

**A-4: No Staging Environment**  
All deployments go directly to production. Schema changes, API contract changes, and migration runs are always live. Create Railway staging environment on PRs.

**A-5: `document.execCommand` Removed from Browsers**  
`EmailBlockEditor.tsx` — Bold/italic/underline formatting broken on Chrome 127+, Firefox 109+. Replace with Selection API or Tiptap.

---

## PART 4 — MEDIUM PRIORITY

### UX / Product

**U-1: UUID Inputs Where Name Pickers Are Required**  
Three places require raw UUID input: LOS Assign (`AllApplications.tsx:80`), Collections Queue Reassign (`Queue.tsx:353`), HR Leave Employee ID (`Leave.tsx:209`). Replace all with typeahead search against `/api/admin/users`.

**U-2: HR and Compliance Home Routes Are Placeholders**  
`/hr` and `/compliance` render `<Placeholder>` components. `hr_manager` and `compliance_officer` land on "Being built" screens. Redirect `/hr` → `/hr/employees` and `/compliance` → `/compliance/checklists`.

**U-3: No Success Toast on Most Actions**  
LOS stage advance, note addition, leave approval, assignment, contact log — all silently reload. Add `toast.success()` calls after each successful mutation.

**U-4: Modal z-index = 50 — Below Dropdowns (z:100) and Drawers (z:200)**  
All modals use `z-50`. Any open dropdown renders on top of modals. Extend Tailwind z-index tokens: `modal: 300`, `toast: 400`.

**U-5: Recovery Cases Form State Bleeds Between Expanded Rows**  
`Cases.tsx:69–97` — pay amount, court name, etc. persist when expanding a different case. Reset all fields in `expandCase()`.

**U-6: Collections Queue Has No Clear Filters Button**  
Once DPD + Stage + search filters are applied, clearing requires resetting each individually. Add "Clear Filters" button.

**U-7: Queue Pagination Shows No Total Count**  
"Page 2" with no indication of total. Add `total` to API responses, display "Page 2 of 7 (340 items)".

**U-8: Compliance Findings Response Field Is 120px Wide**  
Formal compliance responses need a paragraph. Replace inline input with a modal containing `<textarea rows={4}>`.

**U-9: No Phone Number or Customer Name in Collections Queue Rows**  
Agents must leave the queue to find phone numbers. Add `customer_name` and `phone` to `QueueItem` API response. Add `<a href="tel:...">` click-to-call.

**U-10: WatchList Deactivate Uses Native `confirm()` Dialog**  
Replace with the styled confirmation modal used throughout the rest of the app.

**U-11: LOS `NewApplication` Navigates to Dead Route After Submit**  
`nav(\`/los/${id}\`)` should be `nav(\`/sales/applications/${id}\`)`.

**U-12: AuditTrail Filter Requires Knowing Internal Action String Names**  
Free-text input with no examples. Replace with dropdowns populated from distinct values endpoint.

**U-13: Collections Queue Has No Default Sort by Urgency**  
Agents see randomly ordered accounts. Default sort should be `dpd_bucket DESC` (91+ DPD first).

**U-14: Sidebar AML Watchlist Duplicated**  
`Sidebar.tsx:115–116` — identical entry twice. Remove one.

**U-15: Promises Page Likely Always Empty**  
`Promises.tsx` flatmaps `item.promises` from the queue endpoint — which doesn't embed promises. Add `/api/collections-ops/promises` dedicated endpoint.

### Design System

**DS-1: Dark Mode CSS Present Despite "No Dark Mode" Decision**  
Delete `html.dark` and `.dark .card` rules from `index.css`. Contradicts documented design decision D8.

**DS-2: StageBadge Duplicated Across 3 Pages with Divergent Colors**  
`AllApplications.tsx`, `ApplicationDetail.tsx`, `Queue.tsx` each define their own `StageBadge`. Extract to `UI.tsx` as a shared component.

**DS-3: No Toast/Notification System Component**  
`sonner` is imported in some files but there is no platform-wide Toast provider. Users get zero feedback on most successful actions. Add `<Toaster />` to `App.tsx` and add `toast.success()` calls.

**DS-4: DataTable Sorts Client-Side on Paginated Data**  
Sorts the current page slice, not the full dataset. Misleads users. Emit `onSortChange(key, dir)` callback to wire to API params.

**DS-5: SectionCard Title Is 14px — Design System Specifies 16px**  
`UI.tsx:107` — `text-[14px]` should be `text-heading-md` (16px/600).

**DS-6: Sidebar Width Is 220px — Design System Specifies 240px**  
`Sidebar.tsx:271` — change `w-[220px]` to `w-60`.

**DS-7: No Focus Ring on Any Modal Button — WCAG 2.4.7 Failure**  
Add `focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-brand-red` to all interactive elements.

**DS-8: No aria-sort on Sortable Table Headers — WCAG 1.3.1 Failure**  
DataTable column headers need `aria-sort="ascending|descending|none"`. Tab navigation needs `role="grid"`.

**DS-9: Compliance Findings `execDocument` Tabs Missing ARIA**  
`ApplicationDetail.tsx` tabs need `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`.

### Missing Business Logic

**BL-1: No Concurrent Loan Policy Check**  
`losCreate` does not validate if the applicant already has an active loan. Policy matrix (PL+PL blocked unless top-up) is documented but not enforced.

**BL-2: No Leave Balance Validation Before Approval**  
`hrLeaveApprove` does not check if `leave_balances.days_available >= days_requested` before approving.

**BL-3: No Appraisal Score Write Path**  
`hrAppraisalGet` returns items with `self_score`, `manager_score`, `final_score` columns. No `PUT` endpoint exists to write scores.

**BL-4: Compliance Checklist Auto-Generation Not Implemented**  
`compliance_checklist_templates.frequency` field exists but no batch job creates checklists from templates. Must be manually created.

**BL-5: Only 3 of 7 Defined Alert Types Are Evaluated**  
`batch.go` switch statement handles `npl_ratio`, `par30`, `sar_draft_aging`, `compliance_overdue`. Types `daily_collections_below_target`, `dpd_90_new_entries`, `write_off_pending_hours` are in the DB schema but never evaluated.

**BL-6: Notification Triggers Are Inconsistent**  
LOS assign fires notification ✓. LOS stage advance does NOT ✗. LOS decline does NOT ✗. Leave approved does NOT ✗. Write-off approved does NOT ✗. SAR escalated does NOT ✗. Add `sendNotification()` calls to: `losAdvance`, `losDecline`, `hrLeaveApprove`, `hrLeaveDecline`, `recoveryOpsApproveWriteOff`, `complianceSAREscalate`.

**BL-7: No Sync Engine Health Reporting**  
`sync_engine_status` table exists but sync engine never writes to it. Admin SyncStatus page has no data. Add INSERT at end of each sync run.

**BL-8: Audit Log Partitions Expire 2027-12**  
Hard-coded monthly partitions in migration 008 only go to 2027-12. Inserts after 2028-01-01 go to `audit_logs_default`. Add a year-ahead auto-provisioning batch step.

---

## PART 5 — MISSING REGULATORY REPORTS
*CBN Compliance Assessment*

| Return | Status | Blocking Issue |
|---|---|---|
| NPL Return (DPD buckets) | Partial — data exists, report endpoint built | Flat 25% provision (fix C-10), `portfolio_daily_snapshot` never written (fix BUG-2) |
| Credit Return / CRMS (C01/C02) | **MISSING** | No endpoint, no schema column for sector classification on `loan_applications` |
| AML/CFT Return to NFIU | Tracking only — no auto-detection | SAR workflow is sound; no automated STR/CTR threshold monitoring |
| Consumer Protection Quarterly Return | **MISSING** | No complaints module, no resolution tracking |
| FIRS WHT on Fixed Deposits | **MISSING** | Completely absent |
| Chargeback/Dispute Ageing Report | **MISSING** | No dispute tracking past card scheme |
| Audit Trail (CBN examination request) | Broken — wrong table name | Fix C-11: point to `o3c_activity_log` |

**CBN Compliance Rating: 3/10**  
Data exists for NPL Return. Three of five mandatory monthly returns are absent. Audit trail export is broken. The platform cannot pass a CBN examination today.

---

## PART 6 — ZERO TESTS

Every specialist agent confirmed: **no tests exist anywhere in the codebase.**

- 0 `*_test.go` files in `backend-go/`
- 0 `*.test.ts` / `*.spec.ts` files in `frontend/`
- No `vitest`, `jest`, or `@testing-library` in `package.json`
- No `go test` step in CI pipeline

**Minimum test suite needed before next deploy:**

| Test | Why |
|---|---|
| `TestPortfolioSnapshot_ZeroLoans` | Division-by-zero guard in batch.go |
| `TestNPLRatio_Normal` | Core regulatory metric correctness |
| `TestPTPKeptRate_BrokenExceedsPromises` | Would show negative rate on dashboard |
| `TestRoleAccess_CollectionsAgentHitsExecutive` | Core RBAC invariant |
| `TestRoleAccess_WriteOffWrongStage` | Financial control bypass |
| `TestLOSTransition_InvalidJump` | Skip-approval bypass |
| `TestApprovals_TablesExist` | Would have caught BUG-1 immediately |
| `TestBatchSnapshot_DPDColumnExists` | Would have caught BUG-2 immediately |
| `TestFmt_KoboToNaira` | Would have caught BUG-3 immediately |
| `TestDualSource_MSSQLDown` | Fallback path validation |
| `TestDateRange_FromGreaterThanTo` | Returns empty silently — should be 400 |

---

## PART 7 — INFRASTRUCTURE GAPS

| Gap | Severity | Fix |
|---|---|---|
| No backend CI/CD — frontend deploys independently | CRITICAL | Add Railway deploy step to `.github/workflows/deploy.yml` gated on `go build` succeeding |
| No database backups | CRITICAL | Nightly `pg_dump` → Cloudflare R2 via GitHub Actions cron, or upgrade Supabase plan |
| Sync engine HTTP has no TLS | HIGH | Tunnel through Cloudflare, or trigger via cron-only (no Flask API needed) |
| No staging environment | HIGH | Create Railway staging environment, deploy PRs there |
| No observability (Sentry, metrics, alerts) | HIGH | Add `sentry-go` to Go backend at minimum; set up UptimeRobot on `/api/health` |
| `railway.json` restartPolicyMaxRetries: 3 — after 3 crashes service stays down | MEDIUM | Increase to 5 or use ALWAYS restart |
| `sync/` env var mismatch: code reads `PG_URL`, example sets `SUPABASE_URL` | MEDIUM | Rename to be consistent |
| DEPLOYMENT.md still documents old Python/FastAPI stack | LOW | Rewrite to reflect Go backend |
| `CLAUDE.md` at repo root documents old Python stack | LOW | Update to reflect current architecture |

---

## PART 8 — WHAT IS WORKING WELL

*Preserve these. They are production-grade.*

1. **Dual-source MSSQL/PG fallback pattern** — `DualQuery`/`DualScalar` with circuit breaker is well-designed and consistently applied. Graceful fallback is transparent to callers.

2. **Parameterized queries throughout** — Zero SQL injection surface. Every query uses `@p1`/`$N` placeholders. The `buildSet` whitelist approach is correct.

3. **JWT implementation** — `aud` claim scoped per token purpose (`o3c:api`, `o3c:sse`). SSE uses a separate 2-minute ticket — the right pattern. Strict audience verification on every request.

4. **AES-256-GCM for API key encryption** — Random nonce per encryption, correct authenticated encryption, proper 32-byte key enforcement in the encryption function itself.

5. **Recovery write-off 3-tier approval chain** — `stageProgressions` cleanly maps role → required role for each stage. Role check enforced at handler level before any DB write. The payment INSERT + case total UPDATE uses a proper DB transaction.

6. **Graceful shutdown** — `SIGTERM`/`SIGINT` handling with 30-second drain window. Batch scheduler context cancelled properly. Railway sends SIGTERM before SIGKILL — this will complete in-flight requests.

7. **LOS stage machine** — `allowedTransitions` map is comprehensive. `maxRequestInfoCycles` is enforced. SLA breach detection runs nightly and writes to the event log.

8. **Password hashing** — bcrypt cost 12. `genPassword()` uses `crypto/rand`. Both are correct.

9. **Rightmost X-Forwarded-For** — Auth handler and activity logger correctly extract the rightmost (real) IP from Railway's proxy topology.

10. **Campaign dispatch rate limiting** — `sendDelay` and `campaign_daily_email_limit` are runtime-configurable from the settings table. The dispatch goroutine checks for `paused` status on every contact. Status is checked from DB not memory.

11. **Sidebar is well-executed** — Auto-opens active section from URL, accordion state persistent in localStorage, keyboard accessible (`tabIndex`, `onKeyDown`), active item has red left-border accent.

12. **DataTable shared component** — Used consistently across all list pages. Client-side sorting, loading skeletons, empty states. New pages immediately look consistent.

13. **Finance EOD parser** — Regex-based fixed-width Interswitch file parsing is thorough, handles multi-product context propagation, and bulk-inserts in batches of 500. Replaces a manual Excel process correctly.

14. **Login force-change-password wall** — Clean implementation, correctly blocks entire app, provides sign-out escape hatch.

15. **Approvals slide-over** — 30-second polling, badge count, deep-links to context. Well-designed for operations team.

---

## PART 9 — REMEDIATION ROADMAP

### Sprint 1 — Platform Unblockers (1 week, 2 engineers)
Fix the 5 platform-breaking bugs. Nothing else matters until these are done.

| # | Task | File | Est. |
|---|---|---|---|
| 1 | Fix approvals.go table/column names (5 wrong references) | `handlers/approvals.go` | 1h |
| 2 | Add `dpd` column migration, fix batch portfolio snapshot | `migrations/016.sql`, `handlers/batch.go` | 3h |
| 3 | Fix `fmt.ts` — separate `fmtKobo()`, audit all call sites | `lib/fmt.ts` + all pages | 4h |
| 4 | Strip ROLE_PAGES from frontend, use JWT pages[] only | `hooks/useAuth.ts`, `App.tsx` | 2h |
| 5 | Fix `ct` alias in collections_ops targets SQL | `handlers/collections_ops.go:264` | 5min |
| 6 | Fix Dockerfile golang version (1.25→1.23) | `backend-go/Dockerfile`, `go.mod` | 5min |
| 7 | Fix CORS allowed methods (add DELETE, PATCH) | `backend-go/main.go:318` | 5min |
| 8 | Fix `admin_activity_log` → `o3c_activity_log` | `handlers/reports.go:529` | 15min |

### Sprint 2 — Financial Integrity (1 week)
| # | Task | Priority |
|---|---|---|
| 1 | Fix `confirmDocument` — add `confirmed_by` column, fix UPDATE | HIGH |
| 2 | Fix CBN provision rates (tiered by DPD bucket) | HIGH (regulatory) |
| 3 | Fix recovery rate formula | HIGH |
| 4 | Add `RecoveryMasterSheet` to sync engine + migration | HIGH |
| 5 | Fix `incSummary` `report_date` → `cycle_date` | HIGH |
| 6 | Fix SAR ref to use `sar_ref_seq` | MEDIUM |
| 7 | Fix leave balance deduction on approval | MEDIUM |
| 8 | Fix `custom_roles.pages` — standardize on JSONB | MEDIUM |
| 9 | Write 10 minimum backend tests | MEDIUM |

### Sprint 3 — UX Polish (1 week, frontend-focused)
| # | Task |
|---|---|
| 1 | Fix fonts: `DM Sans` body, `DM Mono` mono, canvas `#F4F6F8` |
| 2 | Fix Customer 360 Collections tab |
| 3 | Replace UUID inputs with name typeaheads (LOS assign, Collections reassign, HR leave) |
| 4 | Fix `/hr` and `/compliance` home routes to redirect to working pages |
| 5 | Add `toast.success()` to all mutation handlers |
| 6 | Add confirmation dialogs to write-off approve and LOS terminal stage advance |
| 7 | Fix DataTable WCAG failures (header contrast, aria-sort, role="grid") |
| 8 | Delete `Watch.tsx` and `AdminUsers.tsx` dead code |
| 9 | Fix `document.execCommand` in EmailBlockEditor |
| 10 | Fix image upload Content-Type in `apiFetch` |

### Sprint 4 — Regulatory & Infrastructure (2 weeks)
| # | Task |
|---|---|
| 1 | Build Credit Return (CRMS) report + add sector_code to loan_applications schema |
| 2 | Build FIRS WHT report |
| 3 | Wire NPL Return to CBN Report creation form (auto-populate from snapshot) |
| 4 | Add automated audit trail writes to all state-change handlers |
| 5 | Add backend CI/CD to Railway in GitHub Actions |
| 6 | Set up Sentry Go SDK + UptimeRobot on `/api/health` |
| 7 | Set up database backup (nightly pg_dump → R2) |
| 8 | Create Railway staging environment |
| 9 | Fix sync engine: add TLS, fix index recreation, add health reporting to PG |
| 10 | Migrate SAR encryption to use `decryptValue` (stub exists, not implemented) |

---

## APPENDIX — FINDING COUNT BY AGENT

| Specialist | Critical | High | Medium | Low |
|---|---|---|---|---|
| Software Engineer | 6 | 11 | 14 | 10 |
| Frontend Engineer | 6 | 12 | 15 | 10 |
| DevOps | 4 | 6 | 9 | 7 |
| Data / BI Analyst | 5 | 7 | 7 | 6 |
| Product Designer | 7 | 9 | 11 | 8 |
| UI/UX Engineer | 6 | 14 | 18 | — |
| QA Engineer | 7 | 6 | — | — |
| CEO / Operations | — | — | — | — (narrative) |
| Systems Analyst | — | — | — | — (structural) |
| **TOTAL (deduplicated)** | **~20** | **~30** | **~35** | **~25** |

**Note:** Backend Engineer agent hit session rate limit before completing. Its domain (Go handler correctness, schema gaps, DualQuery SQL validation) was partially covered by the SE and Data/BI agents. Re-run that agent as a targeted follow-up on: `handlers/collections_ops.go`, `handlers/income.go`, `handlers/executive.go`, `handlers/credit_portfolio.go`, and `handlers/fixed_deposit.go`.

---

*Report generated by 9 specialist audit agents — 2026-06-21*  
*O3C Cards Internal Platform — Confidential*
