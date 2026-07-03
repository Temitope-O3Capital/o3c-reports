# O3 Capital Workspace — Full Implementation Plan
**Source: O3C-WORKSPACE-MASTER-AUDIT.md (all 11 specialist reviews)**
**Total estimated effort: ~6 months for a 2-engineer team**

---

## HOW TO READ THIS PLAN

Each phase is a sprint. Items are sequenced so later phases depend on earlier ones. Each task has:
- **What** — description
- **Where** — exact file(s)
- **How** — what to change
- **Effort** — realistic estimate
- **Blocks** — what it unblocks

Do not skip phases. Phase 0 fixes live security holes. Phase 1 fixes broken workflows. Phase 2 fixes financial data integrity. Only after those three phases is it safe to spend time on design polish.

---

# PHASE 0 — DAY 1 HOTFIXES
**Theme: Zero-risk trivial fixes. Ship today.**
**Effort: ~4 hours total**

These are single-file, 1–5 line changes. No refactoring risk. Do all of them before anything else.

---

### P0-01 | Fix XSS in MailCompose signature
- **File:** `frontend/src/pages/mail/MailCompose.tsx:530`
- **Change:** Wrap the `dangerouslySetInnerHTML` value in `sanitizeHtml()`
  ```tsx
  // Before
  <span dangerouslySetInnerHTML={{ __html: signature || (sender?.name ?? 'Me') }} />
  // After
  <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(signature || (sender?.name ?? 'Me')) }} />
  ```
- **Effort:** 5 min
- **Blocks:** The entire XSS → JWT theft → credential leak attack chain (SB-01)

---

### P0-02 | Fix LOS assign field name mismatch
- **File:** `frontend/src/pages/los/AllApplications.tsx:129`
- **Change:** Rename key in the PATCH body
  ```tsx
  // Before
  { assigned_to_user_id: selectedUserId }
  // After
  { assign_to_user_id: selectedUserId }
  ```
- **Effort:** 5 min
- **Blocks:** Every loan assignment since this feature was built

---

### P0-03 | Fix Safari date parsing
- **File:** `frontend/src/lib/fmt.ts:40`
- **Change:**
  ```typescript
  // Before
  return new Date(s + 'T00:00:00')
  // After
  return new Date(s + 'T00:00:00Z')
  ```
- **Effort:** 5 min
- **Blocks:** All date columns showing one day off for every iOS/Safari user

---

### P0-04 | Fix bcrypt error silently discarded
- **File:** `backend-go/handlers/admin.go:270`
- **Change:**
  ```go
  // Before
  hash, _ := core.HashPassword(*b.Password)
  // After
  hash, err := core.HashPassword(*b.Password)
  if err != nil {
      slog.Error("resetPassword: bcrypt failed", "err", err)
      respondErr(w, 500, "Failed to hash password")
      return
  }
  ```
- **Effort:** 10 min
- **Blocks:** Accounts being permanently locked when bcrypt fails

---

### P0-05 | Fix migrate.go continues on error — server starts with broken schema
- **File:** `backend-go/migrate.go` (approximately line 95)
- **Change:** Find the `if err != nil { log.Printf("Error..."); continue }` inside the migration loop and replace `continue` with `log.Fatalf("Migration failed: %v", err)`
- **Effort:** 10 min
- **Blocks:** Server silently starting with a partial database schema after a failed migration

---

### P0-06 | Fix Dockerfile base image — golang:1.25 does not exist
- **File:** `backend-go/Dockerfile` (line 1)
- **Change:**
  ```dockerfile
  # Before
  FROM golang:1.25-alpine
  # After
  FROM golang:1.23-alpine
  ```
- **Effort:** 2 min
- **Blocks:** Docker build may be pulling a non-existent or pre-release image

---

### P0-07 | Remove Documents placeholder tab in LOS ApplicationDetail
- **File:** `frontend/src/pages/los/ApplicationDetail.tsx`
- **Change:** Remove the "Documents" tab from the `TABS` array (or its equivalent). Remove the corresponding tab panel render. Add the tab back only when document upload is actually built (Phase 5).
- **Effort:** 5 min
- **Blocks:** User-hostile experience of clicking a tab and seeing "coming soon"

---

### P0-08 | Fix AuditTrail export — replace raw fetch with apiExport
- **File:** `frontend/src/pages/compliance/AuditTrail.tsx:59-72`
- **Change:** Replace the raw `fetch('/api/...')` call in the export handler with `apiExport('/api/compliance/audit-trail/export', ...)` which handles 401 correctly
- **Effort:** 20 min
- **Blocks:** Compliance officers downloading a JSON error string labelled as a CSV file

---

### P0-09 | Reject Zoho webhook when secret is unconfigured
- **File:** `backend-go/handlers/zoho.go:1694-1724`
- **Change:** Move the secret check before the request is processed:
  ```go
  secret := zohoCred(ctx, db, "ZOHO_WEBHOOK_SECRET")
  if secret == "" {
      respondErr(w, 503, "Webhook secret not configured")
      return
  }
  // existing HMAC verification
  ```
- **Effort:** 20 min
- **Blocks:** Anyone with the URL injecting fake ticket sync events

---

### P0-10 | Add .dockerignore
- **File:** `backend-go/.dockerignore` (create new)
- **Content:**
  ```
  .env
  .env.*
  uploads/
  *.log
  .git/
  **/*_test.go
  ```
- **Effort:** 5 min
- **Blocks:** `.env` files and local uploads appearing in Docker layer history

---

### P0-11 | Fix collections target_kobo hardcoded to 0
- **Files:** `frontend/src/pages/collections/Overview.tsx:129`, and the relevant backend endpoint
- **Change (frontend):** Remove the hardcoded `target_kobo: 0` — read it from the API response instead
- **Change (backend):** Ensure the collections overview endpoint returns the actual daily target for the current date from a `collection_daily_targets` table (create table if needed with columns: `date DATE`, `target_kobo BIGINT`, `created_by UUID`)
- **Effort:** 2 hours (includes the backend table + endpoint change)
- **Blocks:** Head of Collections seeing the target achievement banner ever

---

# PHASE 1 — SPRINT 1: SECURITY EMERGENCY
**Theme: Close the active attack vectors. No new features until this sprint is done.**
**Effort: ~3-4 days**
**Team: 1 backend engineer + 1 frontend engineer**

---

### P1-01 | Mask /api/settings/ — never return decrypted credentials
- **File:** `backend-go/handlers/settings_handler.go:51-74`
- **Change:** For each setting row returned, check if the key is a credential type. If so, replace the value with `"****" + last4chars` or `has_value: true` only. Return the full plaintext value ONLY in a separate privileged endpoint (`GET /api/settings/:key/reveal`) requiring a fresh re-authentication or a dedicated `settings_reveal` permission.
- **Effort:** 3 hours
- **Blocks:** The credential theft leg of the SB-01 attack chain

---

### P1-02 | Implement WhatsApp webhook HMAC verification
- **File:** `backend-go/handlers/whatsapp.go`
- **Change:**
  ```go
  func verifyWhatsAppSignature(r *http.Request, secret string) bool {
      sig := r.Header.Get("X-Hub-Signature-256")
      if sig == "" { return false }
      body, _ := io.ReadAll(r.Body)
      r.Body = io.NopCloser(bytes.NewBuffer(body))
      mac := hmac.New(sha256.New, []byte(secret))
      mac.Write(body)
      expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
      return hmac.Equal([]byte(sig), []byte(expected))
  }
  ```
  Call this at the start of the WhatsApp webhook handler. Reject when secret is unconfigured (same pattern as P0-09).
- **Effort:** 2 hours
- **Blocks:** Anyone injecting fake customer WhatsApp messages

---

### P1-03 | Add RequireAccess guards to /approvals and /reports routes
- **File:** `frontend/src/App.tsx:643` (approvals route), `frontend/src/App.tsx:736` (reports route)
- **Change:** Wrap both routes with the `<RequireAccess page="approvals">` and `<RequireAccess page="reports">` components already used elsewhere in App.tsx
- **Effort:** 30 min
- **Blocks:** Any authenticated user navigating directly to these URLs

---

### P1-04 | JTI-based token revocation denylist
- **Files:** `backend-go/core/auth.go`, `backend-go/handlers/auth.go`, new migration file
- **Step 1 — Migration:** Add table:
  ```sql
  CREATE TABLE token_denylists (
      jti TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX ON token_denylists (expires_at); -- for cleanup job
  ```
- **Step 2 — JWT generation:** Add `jti` claim (UUID) to every token in `core/auth.go`
- **Step 3 — AuthMiddleware:** After validating the JWT signature, check `SELECT 1 FROM token_denylists WHERE jti = $1`. If found, return 401.
- **Step 4 — Logout endpoint:** `POST /api/auth/logout` — write the token's `jti` and `exp` to `token_denylists`
- **Step 5 — Cleanup:** Add a periodic job (in the existing APScheduler equivalent) to `DELETE FROM token_denylists WHERE expires_at < now()`
- **Step 6 — Frontend:** Call `POST /api/auth/logout` before clearing localStorage
- **Effort:** 1 day
- **Blocks:** Stolen tokens remaining valid for up to 8 hours, fired-employee access

---

### P1-05 | Randomize OAuth state parameter
- **File:** `backend-go/handlers/voice.go`
- **Change:** Replace `base64(userID)` with a cryptographically random nonce:
  ```go
  // Generate
  nonce := make([]byte, 32)
  rand.Read(nonce)
  stateToken := hex.EncodeToString(nonce)
  // Store: INSERT INTO oauth_states (state, user_id, expires_at) VALUES ($1, $2, now()+interval '10 minutes')
  // On callback: SELECT user_id FROM oauth_states WHERE state=$1 AND expires_at > now()
  // DELETE after use
  ```
- **Effort:** 3 hours
- **Blocks:** CSRF attack where attacker overwrites victim's Zoho OAuth tokens

---

### P1-06 | Strip infrastructure topology from /api/health
- **File:** `backend-go/main.go:84` (health handler)
- **Change:** The unauthenticated health response should return only `{"status": "ok"}`. Move the MSSQL/Supabase status to `GET /api/admin/system-health` which requires authentication and the `admin` page permission.
- **Effort:** 30 min
- **Blocks:** Unauthenticated callers mapping the database topology

---

### P1-07 | Never return temp_password in API responses
- **Files:** `backend-go/handlers/admin.go:136`, `backend-go/handlers/settings_handler.go:227,295`
- **Change:** Generate the temporary password, email it directly, and return only `{"message": "Temporary password sent to user's email"}`. Never include the plaintext password in the API response body.
- **Effort:** 2 hours

---

### P1-08 | Page-name allowlist on POST /api/admin/activity
- **File:** `backend-go/handlers/` (find the activity log handler)
- **Change:** Define a `var allowedPages = map[string]bool{"overview": true, "los": true, ...}` covering every valid page name. Validate `b.Page` against the allowlist before insert. Return 422 for unknown page names.
- **Effort:** 2 hours
- **Blocks:** Any authenticated user polluting the audit trail with arbitrary log entries

---

### P1-09 | Enforce 12-character minimum password server-side
- **File:** `backend-go/handlers/auth.go` (password change handler), `backend-go/handlers/admin.go` (create user)
- **Change:** Add validation: `if len(*b.Password) < 12 { respondErr(w, 422, "Password must be at least 12 characters") }`
- **Effort:** 1 hour
- **Blocks:** CBN/ISO 27001 password policy requirements

---

### P1-10 | Make BOOTSTRAP_SECRET required in production
- **File:** `backend-go/config.go` (the startup secret validator)
- **Change:** Add `BOOTSTRAP_SECRET` to the `_WEAK_DEFAULTS` check. If the environment is detected as production (via `RAILWAY_ENVIRONMENT` or `APP_ENV=production`) and `BOOTSTRAP_SECRET` is unset or weak, call `log.Fatalf(...)` to halt startup.
- **Effort:** 1 hour

---

### P1-11 | Fix ROLE_PAGES divergence — serve from backend
- **Files:** `frontend/src/hooks/useAuth.ts:38-92`, `backend-go/core/auth.go:231-452`
- **Step 1 — Backend:** Add `GET /api/auth/role-pages` that returns the canonical `map[string][]string` for the requesting user's role
- **Step 2 — Frontend:** In `useAuth.ts`, fetch role pages on login and on token refresh. Replace the static `ROLE_PAGES` constant with the fetched value.
- **Step 3 — Delete:** Remove the `ROLE_PAGES` constant from `useAuth.ts` entirely
- **Effort:** 4 hours
- **Blocks:** `executive` role users hitting 403 on pages the frontend grants them

---

### P1-12 | Stop trusting client-parsed JWT — call /api/auth/me on load
- **File:** `frontend/src/App.tsx:499-522`
- **Change:** Replace `parseToken(token)` with a call to `GET /api/auth/me` on app load. Use the response as the canonical user object. Delete `parseToken()`.
- **Effort:** 2 hours
- **Blocks:** Tampered JWTs with modified role/pages being trusted by the UI

---

# PHASE 2 — SPRINT 2: WORKFLOW UNBLOCKERS
**Theme: Make key workflows actually function for the people who use them daily.**
**Effort: ~1 week**
**Team: 2 frontend engineers**

---

### P2-01 | Replace Reassign modal in Collections Queue with user dropdown
- **File:** `frontend/src/pages/collections-ops/Queue.tsx`
- **Change:** Replace the text `<input>` for user ID with a `<select>` (or searchable combobox) populated from `GET /api/admin/users`. Display `full_name` in the option label, submit `user_id` as the value. Add loading state and error handling.
- **Effort:** 3 hours
- **Blocks:** Collections supervisors being unable to reassign any case

---

### P2-02 | Replace Assign modal in LOS All Applications with user dropdown
- **File:** `frontend/src/pages/los/AllApplications.tsx`
- **Change:** Same pattern as P2-01. Fetch users filtered by roles that can handle LOS applications (`risk_officer`, `risk_head`, `sales_officer`, etc.). Display name + role badge in dropdown.
- **Effort:** 3 hours
- **Blocks:** LOS team leads being unable to assign any application

---

### P2-03 | Build ConfirmModal shared component
- **File:** `frontend/src/components/UI.tsx` (add to exports)
- **Implementation:**
  ```tsx
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
  export function ConfirmModal({ open, title, body, confirmLabel = 'Confirm',
    cancelLabel = 'Cancel', variant = 'default', onConfirm, onCancel, loading }: ConfirmModalProps) { ... }
  ```
  Standard: 400px centered, `rounded-2xl`, backdrop blur, warning icon for `danger` variant, red confirm button for `danger`.
- **Effort:** 3 hours

---

### P2-04 | Replace all window.confirm() calls with ConfirmModal
- **Files (confirmed):**
  - `frontend/src/pages/recovery-ops/Cases.tsx` — write-off approval
  - `frontend/src/pages/compliance/CbnReports.tsx` — regulatory submission
  - `frontend/src/pages/crm/Pipeline.tsx` — delete deal
  - `frontend/src/pages/crm/Tasks.tsx` — delete task
  - `frontend/src/pages/los/ApplicationDetail.tsx` — terminal stage transitions
  - `frontend/src/pages/admin/RoleManagement.tsx` — delete role
- **Change:** For each file: add `const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)`. Replace `if (window.confirm(...))` with `setConfirmState({ title, body, onConfirm: () => { ... } })`. Render `<ConfirmModal open={!!confirmState} {...confirmState} onCancel={() => setConfirmState(null)} />`.
- **Effort:** 8 hours total (all 6 files)
- **Depends on:** P2-03

---

### P2-05 | Fix Customer 360 Collections tab — wrong API endpoint
- **File:** `frontend/src/pages/customer360/Customer360.tsx`
- **Change:** The Collections tab currently calls `/api/collections-ops/queue?account_cif=X`. Replace with `/api/collections/history?account_cif=X` (create this backend endpoint if it doesn't exist — it should return all historical collection activity for a given CIF, not the agent's current queue).
- **Effort:** 3 hours (includes backend endpoint)

---

### P2-06 | Add Forgot Password link to Login
- **File:** `frontend/src/pages/Login.tsx`
- **Change:** Add below the submit button:
  ```tsx
  <div className="text-center mt-3">
    <a href="/auth/forgot-password" className="text-[13px] text-slate-500 hover:text-[#0E2841]">
      Forgot password?
    </a>
  </div>
  ```
  Create `/auth/forgot-password` route: a simple email-input form that calls `POST /api/auth/forgot-password`. Backend: generate a time-limited reset token, email a reset link.
- **Effort:** 4 hours (frontend + backend + email template)

---

### P2-07 | Fix recovery rate formula
- **Files:** `frontend/src/pages/recovery/Overview.tsx:214-217`, backend recovery overview endpoint
- **Change (backend):** Add `original_exposure_kobo` column to `recovery_cases` table (the balance at referral time). Populate it on case creation. Return the sum in the overview endpoint as `total_original_exposure_kobo`.
- **Change (frontend):**
  ```tsx
  // Before
  const totalExposure = totalOutstanding + totalRecovered
  const recoveryRate = totalExposure > 0 ? (totalRecovered / totalExposure) * 100 : 0
  // After
  const recoveryRate = totalOriginalExposure > 0
    ? (totalRecovered / totalOriginalExposure) * 100 : 0
  ```
- **Effort:** 3 hours (includes migration for new column)

---

### P2-08 | Add urgency color-coding to Approvals waiting_days
- **File:** `frontend/src/pages/Approvals.tsx`
- **Change:** In `ApprovalCard`, find where `waiting_days` is rendered. Wrap it:
  ```tsx
  <span className={cn(
    'text-[12px] font-semibold',
    waiting_days >= 10 ? 'text-red-600' :
    waiting_days >= 5  ? 'text-amber-600' : 'text-slate-500'
  )}>
    {waiting_days}d waiting
  </span>
  ```
- **Effort:** 30 min

---

### P2-09 | Add context text to ForceChangePassword
- **File:** `frontend/src/pages/Login.tsx` (or wherever ForceChangePassword renders)
- **Change:** Add a gray info well at the top of the form: `"Your password has been reset by an administrator. Please set a new password to continue."` Detect if it was forced via first-login or admin-reset and show the appropriate message.
- **Effort:** 30 min

---

### P2-10 | Fix Compliance Findings — replace inline respond with slide-over
- **File:** `frontend/src/pages/compliance/Findings.tsx`
- **Change:** Remove the 120px inline `<input>` from the table cell. Add a `FindingDetailPanel` slide-over (480px right panel) that opens when a finding row is clicked. It should show: finding title, severity, description, full response history, and a `<textarea>` for the response. Submit via `POST /api/compliance/findings/:id/respond`.
- **Effort:** 4 hours

---

### P2-11 | Fix CBN Reports — add ConfirmModal for regulatory submission
- **File:** `frontend/src/pages/compliance/CbnReports.tsx`
- **Change (if not handled by P2-04):** The CBN submission confirm should display the specific report type, period, and a bolded warning "This action cannot be undone and will be logged in the compliance audit trail." Use the `danger` variant of `ConfirmModal`.
- **Effort:** 1 hour (if P2-04 already handled the window.confirm)

---

### P2-12 | Add period labels to every KPI card on Overview
- **File:** `frontend/src/pages/Overview.tsx`
- **Change:** In each `KpiCard` component call, add a `sub` prop (if the component supports it) or a subtitle element showing the time horizon: `"MTD"`, `"All Time"`, `"Today"`, etc. This requires knowing what each metric covers — document this per card as you add it.
- **Effort:** 1 hour

---

# PHASE 3 — SPRINT 3: FINANCIAL DATA INTEGRITY
**Theme: Fix race conditions, add DB transactions, fix the GL gap.**
**Effort: ~2 weeks**
**Team: 1 backend engineer**

---

### P3-01 | Fix LOS stage advance — add optimistic lock
- **File:** `backend-go/handlers/los.go:309-351`
- **Change:** Change the UPDATE statement to:
  ```sql
  UPDATE loan_applications
  SET stage = $new_stage, updated_at = now()
  WHERE id = $id AND stage = $current_stage
  RETURNING id
  ```
  Check `RowsAffected == 1`. If 0, return 409 "Application was modified by another user — please refresh."
- **Effort:** 2 hours

---

### P3-02 | Fix write-off double-approval — add conditional UPDATE
- **File:** `backend-go/handlers/recovery_ops.go:499-548`
- **Change:** Same optimistic locking pattern:
  ```sql
  UPDATE recovery_cases
  SET write_off_status = $new_status, updated_at = now()
  WHERE id = $id AND write_off_status = $current_status
  RETURNING id
  ```
  Check RowsAffected == 1. Return 409 on conflict.
- **Effort:** 2 hours

---

### P3-03 | Fix leave approval double-deduction — add conditional UPDATE + transaction
- **File:** `backend-go/handlers/hr.go:360-381`
- **Change:** Wrap both UPDATEs (approval status + balance deduction) in a single DB transaction. Use conditional UPDATE on the approval status:
  ```sql
  BEGIN;
  UPDATE leave_requests SET status='approved' WHERE id=$id AND status='pending' RETURNING id;
  -- check RowsAffected; if 0, ROLLBACK and return 409
  UPDATE leave_balances SET used_days=used_days+$days WHERE employee_id=$emp AND leave_type=$type;
  COMMIT;
  ```
- **Effort:** 3 hours

---

### P3-04 | Fix promise mark-honoured — add ownership check
- **File:** `backend-go/handlers/collections_ops.go:226-237`
- **Change:** Add `AND (assigned_agent_id = $current_user_id OR $current_user_role IN ('collections_head', 'admin'))` to the UPDATE WHERE clause.
- **Effort:** 1 hour

---

### P3-05 | Fix LOS stage advance — add role check against transition matrix
- **File:** `backend-go/handlers/los.go`
- **Change:** Define a map of allowed roles per transition:
  ```go
  var transitionRoles = map[string][]string{
    "submitted->risk_review":    {"risk_officer", "risk_head"},
    "risk_review->finance_approval": {"risk_head", "coo"},
    "finance_approval->booking": {"cfo", "md"},
    // etc.
  }
  ```
  Check user's role against `transitionRoles[currentStage+"->"+newStage]`. Return 403 if not permitted.
- **Effort:** 3 hours

---

### P3-06 | Fix loan reference — replace COUNT with sequence
- **File:** `backend-go/handlers/loans.go:163-165`
- **Change:** 
  - Add migration: `CREATE SEQUENCE IF NOT EXISTS loan_ref_seq START 1;`
  - Replace: `ref = "LN" + fmt.Sprintf("%06d", count+1)` with `ref = "LN" + fmt.Sprintf("%06d", nextval('loan_ref_seq'))`
- **Effort:** 1 hour

---

### P3-07 | Wrap collection payment in DB transaction
- **File:** `backend-go/handlers/collections_ops.go` (payment logging section)
- **Change:** Wrap the payment INSERT and running-total UPDATE in an explicit `BEGIN; ... COMMIT;` transaction with `ROLLBACK` on error.
- **Effort:** 2 hours

---

### P3-08 | Wrap LOS booking in DB transaction
- **File:** `backend-go/handlers/los.go` (booking section)
- **Change:** Same as P3-07 — booking record insert + stage update must be atomic.
- **Effort:** 2 hours

---

### P3-09 | Fix hrLeaveApprove — wrap balance deduction in transaction
- **Already covered by P3-03** (done together)

---

### P3-10 | Add GL journal entries to all financial operations
- **Files:** `backend-go/handlers/los.go` (booking, disbursement), `backend-go/handlers/loans.go` (disbursement), `backend-go/handlers/collections_ops.go` (payment), `backend-go/handlers/recovery_ops.go` (payment, write-off)
- **Step 1 — Migration:** Create `gl_journal_entries` table:
  ```sql
  CREATE TABLE gl_journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    posted_at TIMESTAMPTZ DEFAULT now(),
    reference TEXT NOT NULL,
    description TEXT,
    debit_account TEXT NOT NULL,
    credit_account TEXT NOT NULL,
    amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
    entity_type TEXT, -- 'loan', 'collection_payment', 'recovery_payment', 'write_off'
    entity_id UUID,
    posted_by UUID REFERENCES o3c_users(id)
  );
  ```
- **Step 2 — Helper:** Create `postJournal(db, debit, credit, amount, ref, desc, entityType, entityID, userID) error`
- **Step 3 — Add calls:** Inside each financial mutation's DB transaction, call `postJournal()` AFTER the primary mutation. If `postJournal` fails, the transaction rolls back the primary mutation too.
- **Effort:** 2 days (schema + all call sites + testing)
- **Blocks:** CLAUDE.md financial integrity requirement; audit readiness

---

### P3-11 | Fix MSSQL DECIMAL → float64 precision loss
- **Files:** `backend-go/db.go` (MSSQL driver configuration / column scan)
- **Change:** Configure the MSSQL driver to return DECIMAL/NUMERIC columns as strings, then parse them as `int64` (kobo) in the application layer. Alternatively, use `github.com/shopspring/decimal` for intermediate representation before converting to kobo.
- **Effort:** 4 hours

---

### P3-12 | Fix eodTotals struct — replace float64 with int64
- **File:** `backend-go/handlers/eod.go` (eodTotals struct)
- **Change:** Change `TotalDR`, `TotalCR`, `TotalVol` from `float64` to `int64`. Update all arithmetic. Verify the MSSQL query returns integer-scaled amounts.
- **Effort:** 2 hours

---

### P3-13 | Add missing DB indexes
- **File:** New migration file
- **Migration:**
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_id_id
    ON notifications (user_id, id DESC);

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_applications_assigned_to
    ON loan_applications (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loan_applications_stage_status
    ON loan_applications (stage, status, updated_at DESC);

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_log_user_ts
    ON o3c_activity_log (user_id, ts DESC);

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collection_assignments_agent_dpd
    ON collection_assignments (agent_user_id, dpd_bucket, current_stage);

  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_recovery_cases_status_agent
    ON recovery_cases (status, assigned_agent_id);
  ```
- **Effort:** 1 hour (use CONCURRENTLY to avoid locking)

---

### P3-14 | Fix SSE — replace 2-second polling with pg_notify listener
- **File:** `backend-go/handlers/notifications.go:250-265`
- **Change:** Remove the `time.NewTicker(2 * time.Second)` ticker. Replace with a `pgx.Conn.WaitForNotification` loop on the `notifications` channel. `pg_notify` is already being called on the server side — just wire up the listener.
- **Effort:** 4 hours
- **Blocks:** 25 queries/second sustained load from 50 concurrent users

---

### P3-15 | Add record-level RBAC — scope listings to personal portfolio
- **Files:** `backend-go/handlers/collections_ops.go`, `backend-go/handlers/los.go`, `backend-go/handlers/recovery_ops.go`
- **Change:** For roles that imply personal-portfolio scope (`collections_officer`, `sales_officer`, `recovery_officer`), add `AND assigned_to_user_id = $current_user_id` (or equivalent) to the listing queries. Role-based branching: if user is a head/manager, return all; if individual contributor, return only theirs.
- **Effort:** 4 hours

---

# PHASE 4 — SPRINT 4: CI/CD & DEVOPS FOUNDATION
**Theme: You cannot build quality software without a safety net. This sprint creates the net.**
**Effort: ~1 week**
**Team: 1 DevOps / backend engineer**

---

### P4-01 | Add go test ./... to CI pipeline
- **File:** `.github/workflows/deploy.yml`
- **Change:** Add a `test` job before the `build` job:
  ```yaml
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: o3c_test
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - run: go test ./... -v -race -timeout 120s
        working-directory: backend-go
        env:
          DATABASE_URL: postgres://postgres:testpass@localhost:5432/o3c_test
  ```
  Add `needs: [test]` to the deploy job so failing tests block deployment.
- **Effort:** 3 hours

---

### P4-02 | Add govulncheck to CI
- **File:** `.github/workflows/deploy.yml`
- **Change:** Add step to the test job:
  ```yaml
  - run: go install golang.org/x/vuln/cmd/govulncheck@latest && govulncheck ./...
    working-directory: backend-go
  ```
- **Effort:** 30 min

---

### P4-03 | Add tsc --noEmit to CI
- **File:** `.github/workflows/deploy.yml`
- **Change:** Add to the frontend build job (before `npm run build`):
  ```yaml
  - run: npx tsc --noEmit
    working-directory: frontend
  ```
- **Effort:** 30 min

---

### P4-04 | Create Railway staging environment
- **How:** In Railway dashboard, duplicate the production environment and name it "staging". Connect it to the same GitHub repo but deploy from PRs/feature branches rather than main. Give it its own set of environment variables pointing to a separate Supabase project and Railway DB.
- **Cost:** ~$5/month additional Railway usage
- **Effort:** 2 hours (setup) + ongoing discipline to use it
- **Blocks:** Every migration and code change currently goes directly to production data

---

### P4-05 | Add build.sourcemap to vite.config.ts
- **File:** `frontend/vite.config.ts`
- **Change:**
  ```typescript
  build: {
    sourcemap: true,  // add this
    // ... existing config
  }
  ```
- **Effort:** 5 min
- **Blocks:** Production JavaScript errors being undebuggable (only minified stack traces)

---

### P4-06 | Wire R2 for file uploads — replace filesystem storage
- **Files:** `backend-go/handlers/admin.go` (logo upload, P0-03 companion), any handler writing to `/uploads/`
- **Change:** The R2 credentials already exist in the settings table (populated but unused). Write an `uploadToR2(key, data, contentType) (url string, err error)` helper using the AWS S3-compatible R2 API. Replace all filesystem writes with R2 uploads.
- **Effort:** 4 hours
- **Blocks:** Campaign images and logos being wiped on every Railway redeploy

---

### P4-07 | Move sync engine off office Windows PC to Railway cron service
- **How:** Create a new Railway service (scheduled worker). Port the sync engine logic to a Go binary or a simple Python script that runs on Railway's cron schedule (Mon-Fri 18:00 WAT). The Cloudflare Tunnel MSSQL connection is still used — the sync engine just moves to Railway instead of the office PC.
- **Effort:** 1-2 days
- **Blocks:** Sync silently failing whenever the office PC loses power or is restarted

---

### P4-08 | Add structured JSON logging
- **File:** `backend-go/main.go` (logger initialization)
- **Change:**
  ```go
  // Before
  slog.NewTextHandler(os.Stdout, nil)
  // After
  slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
  ```
- **Effort:** 30 min
- **Blocks:** Log aggregation systems being unable to parse Railway logs for querying/alerting

---

### P4-09 | Write rollback scripts for migrations 016-032
- **Files:** `backend-go/migrations/rollback/` (create 017 through 032)
- **Change:** For each applied migration that lacks a rollback, write the inverse SQL (DROP TABLE for CREATE TABLE, etc.)
- **Effort:** 4 hours
- **Blocks:** Being able to safely roll back a bad migration on production at 3am

---

### P4-10 | Add Sentry for frontend error tracking
- **File:** `frontend/src/main.tsx`
- **Change:**
  ```tsx
  import * as Sentry from "@sentry/react"
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  })
  ```
  Also wrap `PageErrorBoundary` with `Sentry.ErrorBoundary`.
- **Effort:** 2 hours
- **Blocks:** Blank pages in production having no record of the JavaScript exception that caused them

---

### P4-11 | Install vitest + @testing-library/react
- **File:** `frontend/package.json`, `frontend/vite.config.ts`, `frontend/vitest.config.ts` (new)
- **Change:**
  ```bash
  npm install --save-dev vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
  ```
  Add `"test": "vitest run"` to package.json scripts. Add to CI pipeline: `npm test` before `npm run build`.
- **Effort:** 2 hours setup

---

### P4-12 | Write first critical frontend tests
- **Files:** `frontend/src/lib/fmt.test.ts`, `frontend/src/components/DataTable.test.tsx`
- **Tests:**
  ```typescript
  // fmt.test.ts
  describe('fmtDate', () => {
    it('returns correct date on Chrome', () => expect(fmtDate('2026-01-15')).toBe('Jan 15, 2026'))
    it('returns correct date on Safari (T00:00:00Z fix)', () => ...)
    it('handles null gracefully', () => expect(fmtDate(null)).toBe('—'))
  })
  describe('fmtKobo', () => {
    it('converts 100 kobo to ₦1.00', () => expect(fmtKobo(100)).toBe('₦1.00'))
    it('handles zero', () => expect(fmtKobo(0)).toBe('₦0.00'))
    it('handles large amounts without float imprecision', () => ...)
  })
  ```
- **Effort:** 2 hours

---

### P4-13 | Write first critical backend tests
- **Files:** `backend-go/handlers/los_test.go`, `backend-go/handlers/loans_test.go`
- **Tests:**
  - `TestLosAdvanceRejectsInvalidTransition` — attempt invalid stage advance, expect 422
  - `TestLosAdvanceConcurrentRace` — two goroutines advance same application, verify only one succeeds
  - `TestLosCreateRejectsZeroAmount` — POST with amount_kobo=0, expect 422
  - `TestLoanRefNoDuplicatesUnderLoad` — 50 concurrent loan creates, verify all refs unique
- **Effort:** 1 day

---

# PHASE 5 — SPRINT 5: DESIGN SYSTEM CONSOLIDATION
**Theme: One component for each pattern. Remove all ad-hoc duplicates.**
**Effort: ~2-3 weeks**
**Team: 1 frontend engineer**

All new shared components go into `frontend/src/components/UI.tsx` unless they are module-specific.

---

### P5-01 | Extract EmptyState component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Standard: icon `text-[40px] text-slate-300`, title `text-[14px] font-semibold text-slate-500`, subtitle `text-[12px] text-slate-400`.
- **Then replace** all 12+ inline empty states across: Approvals, ApplicationDetail, TicketList, Employees, AllApplications, RoleManagement, ApiKeys, AdminOverview, CRM Pipeline, Collections, Recovery, and others.
- **Effort:** 2 hours (build) + 2 hours (replace all instances)

---

### P5-02 | Extract Tabs component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Standard border-bottom underline tab.
- **Then replace** all 4 ad-hoc tab implementations in: Approvals, ApplicationDetail, UserManagement drawer, TicketDetail.
- **Effort:** 2 hours (build) + 3 hours (replace)

---

### P5-03 | Extract Stepper component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. `w-7 h-7 rounded-full` bubble, connector line, completed/active/future states.
- **Then replace** 3 ad-hoc implementations in: Campaigns (5-step), NewApplication (3-step), ComposeTicket (replace progress bar with Stepper).
- **Effort:** 3 hours (build) + 2 hours (replace)

---

### P5-04 | Extract FormField component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Standard label: `text-[12px] font-semibold text-slate-600 mb-1.5`. No uppercase.
- **Then replace** all 4 label variant implementations across: Campaigns, UserManagement, NewApplication, ComposeTicket, HR Employees modal.
- **Effort:** 2 hours (build) + 4 hours (replace)

---

### P5-05 | Extract Toggle component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** Based on Settings.tsx canonical implementation. `w-10 h-5 rounded-full`, knob `w-4 h-4`, `role="switch" aria-checked`.
- **Then replace** Settings.tsx local Toggle and UserManagement drawer inline-style toggle.
- **Effort:** 1 hour (build) + 1 hour (replace)

---

### P5-06 | Extract Avatar component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Sizes: sm=28px, md=40px, lg=56px. Initials from first two words.
- **Then replace** all 5 independent implementations in: UserManagement, UserDrawer, Settings, TicketDetail MsgAvatar, Employees sidebar.
- **Effort:** 1 hour (build) + 2 hours (replace)

---

### P5-07 | Extract DetailField component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Label `text-[11px] uppercase tracking-wider text-slate-400`, value `text-[13px] text-slate-800`. `mono` prop applies `font-mono`.
- **Then replace** all 12+ instances in: ApplicationDetail, Employees sidebar, Customer360, Compliance Findings, Settings.
- **Effort:** 1 hour (build) + 3 hours (replace)

---

### P5-08 | Extract InfoCallout component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Types: info/success/warning/error with appropriate background tokens.
- **Then replace** all 8+ instances in: Settings, ApiKeys, Campaigns, ApplicationDetail, AuditTrail hints.
- **Effort:** 1 hour (build) + 2 hours (replace)

---

### P5-09 | Extract SearchInput component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Search icon left, `pl-8 pr-3 py-1.5 rounded-lg border text-[12px]`.
- **Then replace** ad-hoc search inputs in: UserManagement, AllApplications, Employees, TicketList, Collections Queue.
- **Effort:** 1 hour (build) + 2 hours (replace)

---

### P5-10 | Extract FilterBar component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** Wrapper using `.card` CSS class + `flex flex-wrap gap-3`.
- **Then replace** 6+ `bg-white rounded-2xl border border-black/[0.06] shadow-sm p-4 mb-4` divs in: AllApplications, Employees, AuditTrail, Collections Queue, Recovery Cases, Transactions.
- **Effort:** 30 min (build) + 1 hour (replace)

---

### P5-11 | Extract SectionLabel component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** `text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3`
- **Then replace** instances in: Finance Overview, KPI Dashboard, Sales Overview.
- **Effort:** 30 min

---

### P5-12 | Extract Pagination component
- **File:** `frontend/src/components/UI.tsx`
- **Implementation:** See interface in master audit §3. Previous/Next with "Page X of Y" display and item range.
- **Then replace** 8 independent pagination implementations in: AllApplications, Employees, TicketList, AuditTrail, Recovery Cases, Collections Queue, Finance Transactions, Statements.
- **Effort:** 2 hours (build) + 4 hours (replace)

---

### P5-13 | Add selectable prop to DataTable for TicketList
- **File:** `frontend/src/components/UI.tsx` (DataTable definition)
- **Change:** Add `selectable?: boolean`, `onSelectionChange?: (selected: T[]) => void` props. When `selectable=true`, render a checkbox column and track selected rows.
- **Effort:** 3 hours

---

### P5-14 | Migrate AllApplications hand-rolled table to DataTable
- **File:** `frontend/src/pages/los/AllApplications.tsx`
- **Change:** Replace the raw `<table>` block with `<DataTable cols={...} rows={applications} />`. Define `ColDef[]` covering all current columns plus the `StageBadge` custom render.
- **Effort:** 3 hours

---

### P5-15 | Migrate Employees hand-rolled table to DataTable
- **File:** `frontend/src/pages/hr/Employees.tsx`
- **Change:** Same as P5-14. Include custom name render (Avatar + name).
- **Effort:** 3 hours

---

### P5-16 | Migrate remaining hand-rolled tables to DataTable
- **Files:** `collections-ops/Queue.tsx`, `collections-ops/Promises.tsx`, `recovery-ops/Visits.tsx`
- **Effort:** 2 hours per file (6 hours total)

---

### P5-17 | Remove local Toast from TicketDetail — use Sonner everywhere
- **File:** `frontend/src/pages/helpdesk/TicketDetail.tsx`
- **Change:** Delete the local `Toast` component at the bottom of the file. Replace all `showToast(...)` calls with `import { toast } from 'sonner'` and `toast.success(...)` / `toast.error(...)`.
- **Effort:** 1 hour

---

### P5-18 | Fix border-radius fork — LOS/HR modules
- **Files:** `los/AllApplications.tsx`, `los/ApplicationDetail.tsx`, `los/Queue.tsx`, `los/NewApplication.tsx`, `hr/Employees.tsx`, `hr/Leave.tsx`, `hr/Performance.tsx`, `hr/Training.tsx`, `hr/Disciplinary.tsx`, `collections-ops/Queue.tsx`, `collections-ops/Promises.tsx`
- **Change:** Replace all `rounded-2xl` on card-level elements with the `.card` CSS class. Remove the inline `className` border/shadow props that duplicate `.card`.
- **Effort:** 3 hours

---

### P5-19 | Fix RED color token — replace #DC2626 throughout
- **Search:** `grep -r "#DC2626\|#dc2626\|text-red-600\|bg-red-50" frontend/src --include="*.tsx"`
- **Change:** Replace with brand `RED = '#C00000'` in all non-Tailwind usages. For Tailwind classes: use `text-[#C00000]` and `bg-[rgba(192,0,0,0.08)]` to match the StatusBadge token pattern.
- Also fix `ErrBanner` in `UI.tsx` which uses `#B91C1C` — align to `#C00000`.
- **Effort:** 2 hours

---

### P5-20 | Fix '…' loading placeholder — use Sk skeleton
- **Files:** `admin/AdminOverview.tsx`, `los/AllApplications.tsx`, any other file using `'…'` as a loading value
- **Change:** Replace `{loading ? '…' : value}` with `{loading ? <Sk w="w-16" /> : value}`
- **Effort:** 1 hour

---

### P5-21 | Raise all text-[10px] to text-[11px]
- **Search:** `grep -r "text-\[10px\]\|text-\[10.5px\]" frontend/src --include="*.tsx"`
- **Change:** Replace with `text-[11px]` in all instances
- **Effort:** 1 hour

---

### P5-22 | Add 44px minimum touch targets to icon-only buttons
- **Files:** `Campaigns.tsx` (ActionBtn), and any other icon-only buttons in tables
- **Change:** Add `className="min-w-[44px] min-h-[44px] flex items-center justify-center"` to all icon-only interactive elements
- **Effort:** 2 hours

---

### P5-23 | Add RoleManagement to Page wrapper
- **File:** `frontend/src/pages/admin/RoleManagement.tsx`
- **Change:** Wrap the entire page return with `<Page title="Role Management" dept="Admin">...</Page>`. Remove the hand-built header div.
- **Effort:** 30 min

---

### P5-24 | Extract StageBadge into shared LOS file
- **File:** Create `frontend/src/pages/los/components.tsx`
- **Change:** Move the `StageBadge` component and its `STAGE_COLORS` map (currently duplicated in AllApplications.tsx, ApplicationDetail.tsx, and Queue.tsx) into this shared file. Import from all three pages.
- **Effort:** 1 hour

---

### P5-25 | Extract StatusPill + PriorityPill into shared Helpdesk file
- **File:** Create `frontend/src/pages/helpdesk/components.tsx`
- **Change:** Move `StatusPill`, `PriorityPill`, `CHANNEL_ICON` map (duplicated between TicketList and TicketDetail) into this shared file.
- **Effort:** 1 hour

---

# PHASE 6 — SPRINT 6: ANALYTICS OVERHAUL
**Theme: Give executives, managers, and specialists the data they actually need to make decisions.**
**Effort: ~3-4 weeks**
**Team: 1 frontend + 1 backend engineer**

---

### P6-01 | Add MoM delta badges to all KPI cards
- **Files:** All pages with `KpiCard` usage
- **Change:** Each `KpiCard` call should pass a `change` prop (number) and a `changePeriod` prop (e.g., `"vs last month"`). The backend endpoints for KPIs need to also return `prev_period_value` so the delta can be computed. Update each dashboard endpoint to include previous-period values.
- **Effort:** 1 week (backend changes + frontend changes across all dashboard pages)

---

### P6-02 | Redesign Executive Dashboard
- **File:** `frontend/src/pages/Overview.tsx`
- **Design:** Per master audit §PART 4:
  - Row 1: 4 KPIs — Net Portfolio (₦) | Net Interest Income MTD | NPL Ratio | Cost of Risk
  - Row 2: 4 KPIs — Collections Rate MTD + target bar | New Accounts MTD | Disbursements MTD | Recovery Rate
  - Row 3: P&L trend chart (12-month) + Portfolio health donut
  - Row 4: 5 active alerts + LOS pipeline ₦ by stage + Top 5 overdue accounts
- **Depends on:** Backend exposing these metrics (new/updated API endpoints)
- **Effort:** 1 week (backend endpoint updates + frontend redesign)

---

### P6-03 | Redesign Finance Overview as management accounts
- **File:** `frontend/src/pages/finance/Overview.tsx`
- **Design:** Per master audit §PART 4 — Panel A (Income Statement), Panel B (Balance Sheet Summary), Panel C (5 CBN Ratio Cards with benchmark lines)
- **Effort:** 1 week

---

### P6-04 | Collections Dashboard — add Roll Rate Matrix
- **Files:** `frontend/src/pages/collections/Overview.tsx`, backend collections overview endpoint
- **Change:** Add `GET /api/collections/roll-rate` endpoint that returns a matrix of month-over-month DPD bucket transition rates. Render as a table in the Collections Overview with color coding (rising cells = red, falling = green).
- **Effort:** 4 hours (backend) + 3 hours (frontend)

---

### P6-05 | Add PTP Kept Rate, Contact Rate, Cure Rate to Collections
- **Files:** Collections overview endpoint + `collections/Overview.tsx`
- **Change:** Backend tracks promise honoured/broken status (already exists from P3-04). Add aggregation: `kept / total_promises` for PTP Kept Rate. Add `right_party_contacts / total_contacts` for contact rate. Expose in the overview endpoint.
- **Effort:** 3 hours backend + 2 hours frontend

---

### P6-06 | Add DateFilter to Risk Overview, CRM Reports, Recovery Overview, HR pages
- **Files:** `risk/Overview.tsx`, `crm/Reports.tsx`, `recovery/Overview.tsx`, HR dashboard pages
- **Change:** Import and render `<DateFilter ... />` in each page header. Pass the selected range to all API calls on the page.
- **Effort:** 1-2 hours per page (5 pages = ~8 hours)

---

### P6-07 | Fix data freshness timestamp — snapshot age not render time
- **Files:** `Overview.tsx`, `finance/Overview.tsx`, and any page showing an update time
- **Change:** Backend: add `data_as_of` timestamp to each API response (the actual write time of the underlying data). Frontend: display this timestamp, not `new Date().toLocaleTimeString()`.
- **Effort:** 3 hours

---

### P6-08 | Fix collections target — wire to actual daily targets
- **Depends on:** P0-11 (already done if followed the plan)
- **Backend:** Expose daily target via the collections overview endpoint from the new `collection_daily_targets` table
- **Frontend:** Remove the hardcoded `target_kobo: 0`
- **Effort:** Already done in P0-11

---

### P6-09 | Allow risk head to see NPL Ratio
- **File:** `frontend/src/pages/kpi/KpiDashboard.tsx:25-27`
- **Change:** Add `risk_head` to the allowed roles for the NPL Ratio KPI card display
- **Effort:** 10 min

---

### P6-10 | Add LOS pipeline ₦ value to LOS stats
- **File:** `frontend/src/pages/los/Queue.tsx`, `los/AllApplications.tsx`, and the LOS stats backend endpoint
- **Change:** Backend: sum `amount_requested_kobo` grouped by stage. Frontend: show total pipeline value alongside count in KPI cards.
- **Effort:** 2 hours

---

### P6-11 | Add period-over-period comparison to CRM Reports
- **File:** `frontend/src/pages/crm/Reports.tsx`
- **Change:** Add DateFilter. Pass date range to all 7 API calls. Backend: each endpoint returns current-period and previous-period values. Frontend: show ChangeBadge on each KPI.
- **Effort:** 3 hours frontend + 2 hours backend

---

### P6-12 | Fix cohort average spend denominator
- **File:** `frontend/src/pages/sales/Cohort.tsx`
- **Change:** `avg_spend` must be `total_spend / cohort_size` (all members), not `total_spend / active_users`. Fix in the backend aggregation query.
- **Effort:** 1 hour

---

### P6-13 | Fix cohort retention thresholds for prepaid cards
- **File:** `frontend/src/pages/sales/Cohort.tsx`
- **Change:** Change the heatmap thresholds: ≥40% = green (not 60%), 20-40% = amber (not 30-60%), <20% = red (not 30%). Add a note explaining these are adjusted for prepaid card industry norms.
- **Effort:** 30 min

---

### P6-14 | Add LOS conversion funnel (stage drop-off chart)
- **File:** `frontend/src/pages/los/AllApplications.tsx` or a new `los/Analytics.tsx`
- **Backend:** Add `/api/los/funnel` endpoint: for each stage, count applications and average days spent.
- **Frontend:** Render as a horizontal funnel chart or waterfall (using existing BarChartCard or custom).
- **Effort:** 4 hours

---

# PHASE 7 — SPRINT 7: PAGE-LEVEL UX IMPROVEMENTS
**Theme: Eliminate every remaining friction point that slows staff down daily.**
**Effort: ~3 weeks**
**Team: 2 frontend engineers**

---

### P7-01 | Collections Queue — add Last Contacted column
- **File:** `frontend/src/pages/collections-ops/Queue.tsx`
- **Backend:** Expose `last_contact_at` on each queue item (from the most recent contact log entry for that assignment)
- **Frontend:** Add column with `fmtDate` display and urgency coloring (red if > 7 days)
- **Effort:** 2 hours

---

### P7-02 | Collections Queue — make Outstanding column sortable
- **File:** `frontend/src/pages/collections-ops/Queue.tsx`
- **Change:** Add `onSortChange` to the DataTable (after P5-13) or add client-side sort on the `outstanding_kobo` column
- **Effort:** 1 hour

---

### P7-03 | Collections Queue — combined Log Contact + Promise flow
- **File:** `frontend/src/pages/collections-ops/Queue.tsx`
- **Change:** Merge the two separate modals into one. Step 1: contact type + outcome. Step 2 (conditional, only if outcome = PTP): promise date + amount. Submit both in a single API call.
- **Effort:** 4 hours

---

### P7-04 | Ticket Detail — add Ctrl+Enter to send reply
- **File:** `frontend/src/pages/helpdesk/TicketDetail.tsx`
- **Change:** On the reply `<textarea>`, add:
  ```tsx
  onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendReply() } }}
  ```
- **Effort:** 15 min

---

### P7-05 | Ticket Detail — confirm before Close/Resolve status change
- **File:** `frontend/src/pages/helpdesk/TicketDetail.tsx`
- **Change:** In the `patchTicket` handler, when `status` is being changed to `closed` or `resolved`, show a ConfirmModal first. Other status changes (open → in_progress) remain instant.
- **Depends on:** P2-03 (ConfirmModal)
- **Effort:** 1 hour

---

### P7-06 | Ticket List — move Mine toggle to primary filter bar
- **File:** `frontend/src/pages/helpdesk/TicketList.tsx`
- **Change:** Move the `assignedToMe` boolean toggle out of the collapsed Advanced Filter row and into the always-visible primary filter bar (next to the search input)
- **Effort:** 30 min

---

### P7-07 | Ticket List — add amber SLA threshold (< 2 hours)
- **File:** `frontend/src/pages/helpdesk/TicketList.tsx`
- **Change:** In `slaDisplay()`, add a warning color when remaining time < 2 hours (but not yet breached):
  ```tsx
  if (hoursRemaining < 2 && hoursRemaining > 0) return { label: `${Math.round(hoursRemaining*60)}m left`, color: '#D97706' }
  ```
- **Effort:** 30 min

---

### P7-08 | Ticket List — add Last Synced timestamp to Sync buttons
- **File:** `frontend/src/pages/helpdesk/TicketList.tsx`
- **Change:** Store `lastSyncedAt` in state. Update it after each sync call. Display "Last synced: X min ago" next to the sync button. Show spinner while syncing.
- **Effort:** 1 hour

---

### P7-09 | Customer 360 — add financial summary to Overview tab
- **File:** `frontend/src/pages/customer360/Customer360.tsx`
- **Change:** In the Overview tab, add a summary strip showing: DPD (from loan_applications), outstanding balance (total of active loans), credit limit, and last transaction date. These are already fetched in other tabs — reference the same data.
- **Effort:** 2 hours

---

### P7-10 | Customer 360 — add quick-action buttons to profile header
- **File:** `frontend/src/pages/customer360/Customer360.tsx`
- **Change:** Add three buttons to the profile header: "New Ticket" (opens ComposeTicket modal pre-filled with customer CIF), "Log Promise" (opens a mini promise modal), "Call Customer" (triggers ZohoDialer if available, or shows phone number).
- **Effort:** 3 hours

---

### P7-11 | Customer 360 — add debounced live search
- **File:** `frontend/src/pages/customer360/Customer360.tsx`
- **Change:** Replace "search on Enter/button" with `useEffect` that fires the search after 300ms debounce on query change.
- **Effort:** 30 min

---

### P7-12 | LOS ApplicationDetail — replace window.confirm() for stage advance
- **Depends on:** P2-04 (already handled, if stage advance confirm was included)
- If not already handled in P2-04: wrap terminal stage advances (`booking`, `active`, `declined`) in ConfirmModal showing the stage name and amount.
- **Effort:** 2 hours

---

### P7-13 | CRM Pipeline — add New Deal button
- **File:** `frontend/src/pages/crm/Pipeline.tsx`
- **Change:** Add a "New Deal" button in the page header that opens a CreateDealModal (stage, title, contact, expected value, probability, close date). POST to `/api/crm/deals`.
- **Effort:** 3 hours

---

### P7-14 | Audit Trail — add 300ms debounce + actor filter
- **File:** `frontend/src/pages/compliance/AuditTrail.tsx`
- **Change (debounce):** Wrap filter input handlers in a 300ms debounce (use `useEffect` + `setTimeout` pattern or `useDebouncedCallback`)
- **Change (actor filter):** Add a `<select>` dropdown populated from `GET /api/admin/users`. Pass `actor_user_id` to the audit trail query.
- **Effort:** 2 hours

---

### P7-15 | Collections Promises — sort by promise date, add amount column
- **File:** `frontend/src/pages/collections-ops/Promises.tsx`
- **Change:** Sort promises by `promise_date` ascending (soonest due first). Add `promise_date` column and `amount_kobo` column (formatted). Color-code rows: green (honoured), red (broken/past-due), white (pending).
- **Effort:** 2 hours

---

### P7-16 | Approvals — add inline approve for leave requests
- **File:** `frontend/src/pages/Approvals.tsx`
- **Change:** For `ApprovalCard` items with `module === 'leave'`, show Approve and Decline buttons directly on the card. Approve calls the leave approval endpoint directly. Decline opens a small inline textarea for reason. Write-offs and LOS still require "Review" navigation.
- **Effort:** 4 hours

---

### P7-17 | Finance Reconciliation — persist filter state across sub-tabs
- **File:** `frontend/src/pages/finance/Reconciliation.tsx`
- **Change:** Lift filter state (page, status filter, date range) up to the parent component so it's preserved when switching between Transactions, Settlements, Fees sub-tabs.
- **Effort:** 2 hours

---

### P7-18 | Admin UserManagement — group roles by department
- **File:** `frontend/src/pages/admin/UserManagement.tsx`
- **Change:** Replace the flat `<option>` list in the role dropdown with `<optgroup label="Sales">`, `<optgroup label="Risk">`, `<optgroup label="Finance">`, etc. Group all 30+ roles into their departments.
- **Effort:** 1 hour

---

### P7-19 | Add Missing Nav Guards
- **File:** `frontend/src/App.tsx`
- **Change:** `storage` event listener for cross-tab logout:
  ```tsx
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === 'o3c_token' && !e.newValue) signOut()
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])
  ```
- **Effort:** 30 min

---

### P7-20 | SSE reconnection — re-fetch missed notifications
- **File:** `frontend/src/hooks/useNotifications.ts:53-109`
- **Change:** On the first `ping` event after an EventSource reconnect, call `GET /api/notifications?per_page=30&page=1` and merge the results with the current in-memory array, deduplicating by notification ID.
- **Effort:** 2 hours

---

### P7-21 | Fix App.tsx God Component — extract layout and route groups
- **File:** `frontend/src/App.tsx`
- **Change:** Extract `<AppLayout>` (handles shell, sidebar, notification polling, approval polling), `<LOSRoutes>`, `<CollectionsRoutes>`, `<FinanceRoutes>`, `<ComplianceRoutes>`, `<HRRoutes>` into separate files. `App.tsx` becomes a thin root that composes these.
- **Effort:** 1 day
- **Blocks:** App.tsx re-rendering on every state change and re-evaluating the entire route tree

---

### P7-22 | Fix DataTable sort — wrap in useMemo
- **File:** `frontend/src/components/UI.tsx` (DataTable sort logic)
- **Change:** Wrap `const sortedRows = [...rows].sort(...)` in `useMemo([rows, sortCol, sortDir])`.
- **Effort:** 30 min

---

### P7-23 | Add AbortController + 30s timeout to apiFetch
- **File:** `frontend/src/lib/api.ts`
- **Change:**
  ```typescript
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    // ...
  } finally {
    clearTimeout(timeout)
  }
  ```
- **Effort:** 1 hour

---

# PHASE 8 — SPRINT 8: SECURITY PHASE 2
**Theme: JWT in localStorage is the root of most security risk. This sprint eliminates it.**
**Effort: ~3 weeks**
**Team: 1 backend + 1 frontend engineer**
**Note: This is a significant architectural change. Do it on a feature branch. Test thoroughly on staging.**

---

### P8-01 | Move JWT to HttpOnly cookies (BFF pattern)
- **Backend changes:**
  - Login response: `Set-Cookie: o3c_access=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=1800`
  - All authenticated endpoints: read token from cookie instead of `Authorization: Bearer` header
  - Add CSRF token (`X-CSRF-Token` header) for state-mutating requests
  - Refresh endpoint: `POST /api/auth/refresh` — validates refresh token cookie, issues new access token cookie
- **Frontend changes:**
  - Remove `localStorage.setItem('o3c_token', ...)` everywhere
  - Remove `Authorization: Bearer ${token}` header from `apiFetch` — cookies sent automatically
  - Add CSRF token to all POST/PATCH/DELETE/PUT requests in `apiFetch`
  - Implement silent refresh: when API returns 401 with `X-Token-Expired: true`, call `/api/auth/refresh` then retry
- **Effort:** 1 week
- **Blocks:** The entire XSS → token theft path. After this, XSS can no longer steal the JWT.

---

### P8-02 | MFA — TOTP for privileged roles
- **Backend:**
  - Add `totp_secret_encrypted TEXT` and `totp_enabled BOOL` to `o3c_users`
  - `POST /api/auth/mfa/setup` — generate TOTP secret, return QR code data URL
  - `POST /api/auth/mfa/verify` — validate TOTP code, mark `totp_enabled = true`
  - On login for `md`, `cfo`, `coo`, `compliance_head`, `it_admin`, `admin` roles: if `totp_enabled`, return a partial token that only works for `POST /api/auth/mfa/challenge`. On correct TOTP, return full access token.
- **Frontend:**
  - Settings page: "Enable 2FA" section with QR code display + verification code input
  - Login page: TOTP challenge screen appears after password for MFA-required roles
- **Effort:** 1 week

---

### P8-03 | Reduce token lifetime + add silent refresh
- **Backend:** Change JWT expiry from 8 hours to 30 minutes. Add refresh token (httpOnly cookie, 7-day expiry, rotated on use).
- **Frontend:** Implement silent refresh in `apiFetch` (covered in P8-01).
- **Effort:** 2 hours (after P8-01)

---

### P8-04 | Idle session timeout — 15 minutes
- **Frontend:** Track last user interaction time. After 15 minutes of inactivity, call logout and redirect to Login with a "Session expired due to inactivity" message.
- **Effort:** 2 hours

---

### P8-05 | Add rate limits per sensitive endpoint
- **File:** `backend-go/core/limiter.go` (or equivalent)
- **Change:** Apply stricter per-endpoint limits:
  - `/api/customer360/*`: 30/min
  - `/api/compliance/*`: 30/min
  - `/api/hr/*`: 30/min
  - `/api/*/export` (CSV exports): 5/hour
  - `/api/auth/*`: already 5/min — keep
- **Effort:** 2 hours

---

# PHASE 9 — SPRINT 9: BACKEND ARCHITECTURE
**Theme: Scale the data layer and make the backend testable.**
**Effort: ~4 weeks**
**Team: 1-2 backend engineers**

---

### P9-01 | Add API version prefix /api/v1/
- **Files:** All route registrations in `backend-go/main.go` or router files
- **Change:** Add `/v1/` prefix to all routes. Keep old `/api/` routes as deprecated aliases for 90 days, then remove. Update all frontend `apiFetch` calls to use `/api/v1/`.
- **Effort:** 1 day

---

### P9-02 | Introduce service layer
- **New directory:** `backend-go/services/los/`, `backend-go/services/helpdesk/`, `backend-go/services/collections/`, `backend-go/services/campaigns/`
- **Change:** Extract business logic from HTTP handlers into service structs. Handlers become thin: parse request → call service method → write response. Service methods take plain Go types, return plain Go types — no `http.ResponseWriter`.
- **Start with LOS** (most complex business logic, most needed for testing).
- **Effort:** 2-3 weeks (do incrementally, starting with LOS)
- **Blocks:** All backend unit tests — handlers are untestable without a DB; services can be tested with mocks

---

### P9-03 | Materialize KPI aggregates into snapshot table
- **Migration:** Create `portfolio_daily_snapshot (date DATE, metric_key TEXT, metric_value BIGINT, PRIMARY KEY (date, metric_key))`
- **Worker:** Add a scheduled job that runs at midnight and computes/stores all dashboard KPI values for the day
- **Handlers:** Overview, Finance Overview, KPI Dashboard endpoints read from the snapshot table instead of running live aggregations on every page load
- **Effort:** 1 week
- **Blocks:** Supabase primary being hit by every executive dashboard refresh

---

### P9-04 | Fix activityLogger — replace goroutine-per-request with worker pool
- **File:** `backend-go/handlers/` (activity logger middleware)
- **Change:**
  ```go
  var activityCh = make(chan ActivityEvent, 1000) // buffered channel
  // In main(): start 5 worker goroutines that drain the channel
  // In middleware: send to channel (non-blocking, drop if full)
  ```
- **Effort:** 3 hours

---

### P9-05 | Fix streamCSV — stream row-by-row
- **File:** `backend-go/handlers/` (CSV export handlers)
- **Change:** Use `csv.NewWriter(w)` directly and write rows as they come from the DB cursor. Don't collect all rows in memory first. Set `Content-Type: text/csv` and `Transfer-Encoding: chunked` before starting the DB query.
- **Effort:** 3 hours

---

### P9-06 | Fix campaign dispatch — remove process-local sync.Map
- **File:** `backend-go/handlers/campaigns.go:36`
- **Change:** Delete the `sync.Map` dispatch guard. Rely solely on `dispatch_lock_until` conditional UPDATE in the DB:
  ```sql
  UPDATE campaigns
  SET dispatch_lock_until = now() + interval '1 hour'
  WHERE id = $id AND (dispatch_lock_until IS NULL OR dispatch_lock_until < now())
  RETURNING id
  ```
  If 0 rows returned, another instance already holds the lock.
- **Effort:** 2 hours

---

### P9-07 | Add OpenAPI spec generation
- **Tool:** `swaggo/swag` for Go
- **Change:** Add `// @Summary`, `// @Param`, `// @Success` doc comments to the 20 most-used endpoints. Generate `swagger.json`. Serve at `/api/docs`.
- **Value:** Field name bugs like `assign_to_user_id` become visible at spec review time instead of runtime.
- **Effort:** 1 week (incremental, start with LOS and Collections)

---

### P9-08 | Fix getActivity export — remove 200-row cap for compliance
- **File:** Backend activity log handler
- **Change:** For the export endpoint (`GET /api/compliance/audit-trail/export`), stream all matching rows without the 200-row cap. Add a `date_from` requirement to prevent unbounded exports (error if range > 90 days).
- **Effort:** 2 hours

---

### P9-09 | Fix SetConnMaxIdleTime on DB pool
- **File:** `backend-go/db.go:85-87`
- **Change:** Add `db.SetConnMaxIdleTime(5 * time.Minute)` (same as `SetConnMaxLifetime`)
- **Effort:** 5 min

---

### P9-10 | Add global request body size limit
- **File:** `backend-go/main.go` (middleware chain)
- **Change:** Add `http.MaxBytesReader(w, r.Body, 5<<20)` in a middleware that wraps all non-file-upload routes (1MB cap). File upload routes keep their existing per-handler cap.
- **Effort:** 1 hour

---

### P9-11 | Add PII blind indexes to campaign_contacts
- **File:** New migration + `backend-go/handlers/campaigns.go`
- **Change:** Add `phone_hmac TEXT` and `email_hmac TEXT` columns to `campaign_contacts`. Populate them using `hmac_field(value, tenant_id)` from `app.core.hmac_index` (or equivalent). Index these columns for lookup. Remove plaintext `phone`/`email` columns (or encrypt them).
- **Effort:** 3 hours

---

### P9-12 | Add Content-Security-Policy header
- **File:** `backend-go/main.go` (security headers middleware)
- **Change:** Add `Content-Security-Policy: default-src 'self'; script-src 'self' https://js.zohocdn.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.railway.app` to the `securityHeaders` middleware function.
- **Effort:** 2 hours (audit all external resources first to build the policy correctly)

---

# PHASE 10 — SPRINT 10: OBSERVABILITY
**Theme: You cannot operate what you cannot see.**
**Effort: ~2 weeks**
**Team: 1 backend engineer**

---

### P10-01 | Add OpenTelemetry to Go backend
- **Change:**
  ```go
  import "go.opentelemetry.io/otel"
  // Initialize OTLP exporter (Grafana Tempo or Datadog)
  // Instrument: HTTP middleware (request tracing), DB calls, outbound HTTP (SendGrid, Zoho)
  ```
- **Effort:** 1 week

---

### P10-02 | Add Prometheus metrics endpoint
- **Change:** `GET /metrics` (internal, not public). Expose: request count by route/status, request latency histogram, DB pool stats, SSE connection count, circuit breaker state, campaign dispatch count/failure.
- **Effort:** 3 hours (after OTel is instrumented)

---

### P10-03 | Set up Grafana Cloud (free tier)
- **Services:** Grafana Cloud free tier includes Tempo (traces) + Loki (logs) + Prometheus (metrics).
- **Connect:** Configure the Railway service to push metrics and traces to Grafana Cloud.
- **Build dashboards:** API error rate, p99 latency by route, DB pool usage, SSE connections, campaign throughput.
- **Effort:** 2 hours setup + ongoing dashboard refinement

---

### P10-04 | Add PagerDuty/Opsgenie alerting
- **Alerts to configure:** API error rate > 1% for 5 minutes, p99 latency > 2s, MSSQL circuit breaker open, sync engine not reporting for 24 hours, Supabase connection pool > 80%.
- **Effort:** 2 hours

---

# PHASE 11 — QUARTER 2 FEATURES
**Theme: Power features that multiply team productivity.**
**Effort: ~6-8 weeks**
**Team: Full team**

---

### P11-01 | Global Search (Cmd+K / Ctrl+K)
- **Backend:** `GET /api/search?q=X&types=customer,ticket,loan,case` — federated search across customers (by CIF/name/phone), helpdesk tickets (by ref/subject), LOS applications (by ref/applicant), recovery cases (by ref/CIF)
- **Frontend:** `CommandPalette` component triggered by Cmd+K. Results grouped by type. Keyboard navigation. Recent searches cached in localStorage.
- **Effort:** 1 week

---

### P11-02 | LOS Document Upload
- **Backend:** `POST /api/los/:id/documents` — accepts multipart form, stores file in R2 (after P4-06), records metadata in `loan_documents` table
- **Frontend:** Restore the Documents tab in ApplicationDetail. List uploaded documents with download links. Drag-and-drop upload zone.
- **Effort:** 1 week

---

### P11-03 | PDF Export — Board Pack / Application Summary
- **Backend:** `GET /api/los/:id/pdf` — generates a PDF of the loan application summary using a Go PDF library (`go-pdf/fpdf` or `chromedp` for HTML-to-PDF)
- **Frontend:** Add "Export PDF" button to ApplicationDetail Summary tab and to Executive Overview
- **Effort:** 1 week

---

### P11-04 | Inline Approvals — batch capability
- **File:** `frontend/src/pages/Approvals.tsx`
- **Change:** Add checkboxes to ApprovalCards. "Approve Selected" button in a floating bar (same pattern as TicketList BulkBar). Batch approve calls `POST /api/approvals/batch` with an array of approval IDs.
- **Effort:** 1 week (frontend + backend batch endpoint)

---

### P11-05 | Collections Promises — dedicated endpoint
- **Backend:** `GET /api/collections/promises` — returns all promises across the portfolio (not piggybacking on the queue endpoint). Filterable by agent, status, due date range.
- **Frontend:** Refactor Promises.tsx to use this endpoint. Remove the 200-item workaround.
- **Effort:** 3 days

---

### P11-06 | Notification Preferences wired to SSE events
- **Backend:** `PATCH /api/users/notification-preferences` — stores per-event-type preferences
- **Frontend:** NotificationPreferences page controls these preferences. SSE delivery respects them.
- **Effort:** 3 days

---

### P11-07 | CRM Contact Detail Page
- **Route:** `/crm/contacts/:id`
- **Page:** Full contact profile with activity feed (linked tickets, loans, calls, campaign interactions), edit form, related deals, tasks.
- **Effort:** 1 week

---

### P11-08 | CRM Pipeline — drag-and-drop
- **Package:** `@dnd-kit/core` + `@dnd-kit/sortable`
- **File:** `frontend/src/pages/crm/Pipeline.tsx`
- **Change:** Wrap Kanban columns and cards in dnd-kit context. On drop, call `PATCH /api/crm/deals/:id` with the new stage.
- **Effort:** 1 week

---

### P11-09 | Role Management — affected users preview
- **Change:** Before saving a role permission change, call `GET /api/admin/roles/:role/affected-users` and show a summary: "This change affects 12 users: [list of names]. Confirm?"
- **Effort:** 3 days

---

# PHASE 12 — QUARTER 3: REGULATORY COMPLIANCE
**Theme: CBN, NDPR, and enterprise security frameworks.**
**Effort: ~8-12 weeks**
**Team: 1 backend engineer + compliance officer involvement**

---

### P12-01 | Data Retention Purge Jobs
- NDPR Art. 26 requires a defined retention period. Implement scheduled jobs:
  - `o3c_activity_log`: delete records > 7 years (CBN audit requirement)
  - `user_sessions`: delete records > 90 days (already flagged in DevOps report)
  - `token_denylists`: delete where `expires_at < now()` (from P1-04)
  - `notifications`: delete > 90 days

---

### P12-02 | Data Subject Rights API (NDPR)
- `GET /api/compliance/data-subject/:user_id/export` — returns all PII for a data subject in JSON
- `DELETE /api/compliance/data-subject/:user_id` — pseudonymises all PII fields (replaces with hashes/tokens, does not delete financial records which must be retained)

---

### P12-03 | CBN Prudential Ratio Report
- Automated report generation: CAR, Liquidity Ratio, NPL Ratio, Single Obligor Limit — in CBN's prescribed format

---

### P12-04 | BOD Pack PDF Generation
- Monthly board report auto-generated from the Finance Overview data: income statement, portfolio quality, KPI trends, risk summary

---

### P12-05 | Credit Bureau Submission File
- Monthly CRC/First Central submission in their prescribed CSV format — automated from loan_applications data

---

### P12-06 | Concentration Risk Report
- Single borrower exposure as % of portfolio, sectoral breakdown, geographic concentration

---

### P12-07 | DPA Documentation
- Document data processing agreements for SendGrid, Zoho, Termii, Paystack (cross-border PII transfer under NDPR)

---

### P12-08 | SOC 2 Type II Readiness Assessment
- Engage a compliance partner for gap analysis
- Implement: access reviews (quarterly), change management log, vendor assessments, incident response runbook

---

### P12-09 | Annual Penetration Test
- Engage external pen tester. Prioritize: web application (XSS, IDOR, auth bypasses), API security, webhook endpoints

---

# SUMMARY TIMELINE

| Phase | Theme | Effort | Team |
|---|---|---|---|
| **Phase 0** | Day 1 hotfixes | 4 hours | Any engineer |
| **Phase 1** | Security emergency | 3-4 days | 1 backend + 1 frontend |
| **Phase 2** | Workflow unblockers | 1 week | 2 frontend |
| **Phase 3** | Financial data integrity | 2 weeks | 1 backend |
| **Phase 4** | CI/CD & DevOps foundation | 1 week | 1 DevOps |
| **Phase 5** | Design system consolidation | 2-3 weeks | 1 frontend |
| **Phase 6** | Analytics overhaul | 3-4 weeks | 1 frontend + 1 backend |
| **Phase 7** | Page-level UX improvements | 3 weeks | 2 frontend |
| **Phase 8** | Security Phase 2 (JWT cookies, MFA) | 3 weeks | 1 backend + 1 frontend |
| **Phase 9** | Backend architecture | 4 weeks | 1-2 backend |
| **Phase 10** | Observability | 2 weeks | 1 backend |
| **Phase 11** | Quarter 2 features | 6-8 weeks | Full team |
| **Phase 12** | Regulatory compliance | 8-12 weeks | Full team + compliance |

**Total calendar time with a 2-engineer team:** ~6 months to end of Phase 10 (production-grade). Phases 11-12 continue in parallel with normal product development.

---

## DEPENDENCY MAP

```
Phase 0 → unlocks → Phase 1 (security work builds on fixed baseline)
Phase 1 → unlocks → Phase 2 (safe to build workflow features after auth is sound)
Phase 2 → unlocks → Phase 3 (workflow correctness depends on fixed race conditions)
Phase 3 → unlocks → Phase 9 (service layer extraction easier after race conditions fixed)
Phase 4 → unlocks → Phase 3 (CI must catch race condition regressions)
Phase 5 → ConfirmModal (P2-03) must land before P5 begins (P5 uses it)
Phase 6 → depends on Phase 3 (correct data) and Phase 5 (correct components)
Phase 8 → depends on Phase 1 (JTI revocation from P1-04 required before HttpOnly cookies)
Phase 11 → depends on Phase 5 (shared components), Phase 4 (R2 for document upload)
Phase 12 → depends on Phase 3 (GL journals), Phase 1 (audit trail integrity)
```

---

*Plan covers all 200+ items from the O3C-WORKSPACE-MASTER-AUDIT.md.*
*Every task has: what, where, how, and estimated effort.*
*Last updated: 2026-06-30*
