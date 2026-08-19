package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

// Applications raised by Sales on behalf of a customer.
//
// An account officer raises a loan or credit-card application for someone on their
// book, it goes straight to Risk, and they can then watch it through to booking —
// including whether it actually landed in Udara, which is the part that silently fails.
//
// This does not duplicate the LOS workflow. It creates the same loan_applications row
// the LOS queue works from, submits it, and notifies Risk; every subsequent stage is
// LOS's business. What is added is the sales-side view: raise for MY customer, and see
// what happened to it.

// salesProductTypes are the products an officer may raise, across all three lines
// (Cards, Loans, Fixed Deposit). Kept explicit rather than free text so the LOS queue,
// Risk, the ops queues and reporting all agree on the vocabulary. Codes match the
// shared taxonomy (handlers/products.go).
var salesProductTypes = map[string]string{
	"salary_loan":         "Salary Loan",
	"business_loan":       "Business Loan",
	"individual_loan":     "Individual Loan",
	"credit_card":         "Credit Card",
	"card_limit_increase": "Card Limit Increase",
	"prepaid":             "Prepaid Card",
	"fixed_deposit":       "Fixed Deposit",
}

// salesAppRouting decides where a submitted application goes and who is told, by
// product. Decision (2026-08-18): credit products (loans + credit cards, which need a
// credit decision) go to Risk/LOS; prepaid cards and fixed deposits carry no credit
// risk, so they go to the relevant operations desk for issuance/booking.
func salesAppRouting(productType string) (stage string, notifyRoles []string) {
	switch productType {
	case "prepaid":
		return "ops_review", []string{"cards_ops_officer", "cards_ops_head"}
	case "fixed_deposit":
		return "ops_review", []string{"finance_officer", "finance_head"}
	default: // salary_loan, business_loan, individual_loan, credit_card, card_limit_increase
		return "risk_review", []string{"risk_officer", "risk_head"}
	}
}

func RegisterSalesApplications(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/applications/products", listSalesProducts())
	r.With(access).Get("/applications", listSalesApplications(db))
	r.With(access).Post("/applications", createSalesApplication(db))
	r.With(access).Patch("/applications/{id}", updateSalesAppDraft(db))
	r.With(access).Post("/applications/{id}/submit", submitSalesAppDraft(db))
	r.With(access).Delete("/applications/{id}", deleteSalesAppDraft(db))
	r.With(access).Get("/applications/{id}/booking", applicationBooking(db))
}

func listSalesProducts() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := make([]map[string]any, 0, len(salesProductTypes))
		for code, label := range salesProductTypes {
			out = append(out, map[string]any{"code": code, "label": label})
		}
		respond(w, out, "static")
	}
}

// listSalesApplications shows an officer what they have raised and where it has got to,
// with the Udara booking check alongside so "approved" and "actually booked" are not
// confused for each other.
func listSalesApplications(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}

		where := []string{"1=1"}
		args := []any{}
		nArg := 1

		if !isSalesHead(user) {
			where = append(where, fmt.Sprintf("a.sales_officer_id = $%d", nArg))
			args = append(args, user.ID)
			nArg++
		} else if q := qstr(r, "officer_id"); q != "" {
			id, err := parseUserID(q)
			if err != nil {
				respondErr(w, 400, err.Error())
				return
			}
			where = append(where, fmt.Sprintf("a.sales_officer_id = $%d", nArg))
			args = append(args, id)
			nArg++
		}
		if s := qstr(r, "stage"); s != "" {
			where = append(where, fmt.Sprintf("a.stage = $%d", nArg))
			args = append(args, s)
			nArg++
		}
		if c := qstr(r, "cif"); c != "" {
			where = append(where, fmt.Sprintf("a.applicant_cif = $%d", nArg))
			args = append(args, c)
			nArg++
		}

		cond := strings.Join(where, " AND ")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1_000_000)

		var total int64
		if err := db.PG.QueryRowContext(r.Context(),
			`SELECT COUNT(*) FROM loan_applications a WHERE `+cond, args...).Scan(&total); err != nil {
			respondErr(w, 500, "Count failed")
			return
		}

		rows, err := db.PGQuery(r.Context(), `
			SELECT a.id, a.reference, a.applicant_name, a.applicant_cif,
			       a.product_type, a.stage, a.status,
			       a.amount_requested_kobo, a.amount_approved_kobo,
			       a.submitted_at, a.risk_reviewed_at, a.booked_at,
			       a.decline_reason, a.created_at, a.updated_at,
			       u.full_name AS officer_name,
			       -- Booked in the workspace is not the same as booked in the core
			       -- system. Surfacing both is the whole point of the monitoring ask.
			       EXISTS (
			           SELECT 1 FROM cbs_loans l WHERE l.cbs_customer_id = a.applicant_cif
			       ) AS present_in_cbs
			  FROM loan_applications a
			  LEFT JOIN o3c_users u ON u.id = a.sales_officer_id
			 WHERE `+cond+`
			 ORDER BY a.created_at DESC
			 LIMIT `+fmt.Sprintf("$%d OFFSET $%d", nArg, nArg+1),
			append(args, limit, offset)...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"data": rows, "total": total, "limit": limit, "offset": offset,
		})
	}
}

type salesAppReq struct {
	CIF             string `json:"cif"`
	ProductType     string `json:"product_type"`
	AmountRequested int64  `json:"amount_requested_kobo"`
	TenorMonths     int    `json:"tenor_months"`
	Purpose         string `json:"purpose"`
	MonthlyIncome   int64  `json:"monthly_income_kobo"`
	Employer        string `json:"employer"`
	Note            string `json:"note"`
	// Draft parks the application for later instead of submitting it to Risk/Ops.
	// A draft skips amount validation and the duplicate/notify machinery; it can be
	// resumed (PATCH) and pushed (POST /submit) any time.
	Draft bool `json:"draft"`
}

// createSalesApplication raises an application for a customer and hands it to Risk in
// one action.
//
// Unlike the LOS draft flow this submits immediately: an officer sitting with a
// customer wants it in front of Risk, not parked in a draft they must remember to push.
func createSalesApplication(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req salesAppReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		req.CIF = strings.TrimSpace(req.CIF)
		if req.CIF == "" {
			respondErr(w, 400, "cif is required")
			return
		}
		if _, ok := salesProductTypes[req.ProductType]; !ok {
			respondErr(w, 400, "Unknown product_type")
			return
		}
		// A draft can be saved with an amount still to be worked out; a submission cannot.
		if !req.Draft && req.AmountRequested <= 0 {
			respondErr(w, 400, "amount_requested_kobo must be greater than zero")
			return
		}

		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		ctx := r.Context()

		// The customer must exist, and — unless the caller is a head — must be on the
		// officer's own book. Raising credit for someone else's customer is a decision
		// for a team lead, not a side effect of knowing a CIF.
		var name, email, phone string
		var ownerID sql.NullInt64
		err := db.PG.QueryRowContext(ctx, `
			SELECT c.full_name, COALESCE(c.email,''), COALESCE(c.phone,''), o.officer_id
			  FROM app.customers c
			  LEFT JOIN customer_officers o ON o.cif = c.cif
			 WHERE c.cif = $1`, req.CIF).Scan(&name, &email, &phone, &ownerID)
		if err != nil {
			respondErr(w, 404, "No customer with that CIF")
			return
		}
		if !isSalesHead(user) && (!ownerID.Valid || ownerID.Int64 != user.ID) {
			respondErr(w, 403, "That customer is not on your book")
			return
		}

		// ── Draft path ──────────────────────────────────────────────────────────
		// Park it. No reference/notify/dup machinery — a draft is private working
		// state until the officer pushes it. It still gets an LOS reference so the
		// row is identifiable, and lands with status/stage 'draft'.
		if req.Draft {
			var dseq int64
			if err := db.PG.QueryRowContext(ctx, `SELECT nextval('los_ref_seq')`).Scan(&dseq); err != nil {
				respondErr(w, 500, "Reference generation failed")
				return
			}
			dref := fmt.Sprintf("LOS-%s-%04d", time.Now().UTC().Format("200601"), dseq)
			var dID int64
			if err := db.PG.QueryRowContext(ctx, `
				INSERT INTO loan_applications (
				    reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
				    product_type, amount_requested_kobo, tenor_months, purpose, employer,
				    monthly_income_kobo, status, stage, sales_officer_id, assigned_to_user_id,
				    created_by, created_at, updated_at
				) VALUES (
				    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft','draft',$12,$12,$12,NOW(),NOW()
				) RETURNING id`,
				dref, name, req.CIF, email, phone, req.ProductType, req.AmountRequested,
				req.TenorMonths, req.Purpose, req.Employer, req.MonthlyIncome, user.ID).Scan(&dID); err != nil {
				respondErr(w, 500, "Could not save the draft: "+err.Error())
				return
			}
			respond(w, map[string]any{"id": dID, "reference": dref, "stage": "draft", "status": "draft", "draft": true}, "pg")
			return
		}

		// Idempotency. A double-submit — the officer double-clicks, or the browser
		// silently retries the POST — must not raise two applications with two
		// references. Honour a client idempotency header when one is sent, and in every
		// case fall back to a short server-side window keyed on customer+product+officer:
		// a second genuine application for the same product within seconds is not
		// something an officer does on purpose, whereas a retried request is.
		idemKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if idemKey == "" {
			idemKey = strings.TrimSpace(r.Header.Get("Request-Reference"))
		}

		// The whole raise is one transaction: the loan_applications row and its opening
		// event commit together or not at all, so an application can never exist without
		// the submission event that explains how it reached Risk.
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		// Serialise concurrent submissions for the same customer+product+officer (and the
		// same idempotency key, when one is supplied) so two near-simultaneous POSTs
		// cannot both slip past the duplicate check below. The advisory lock is
		// transaction-scoped and is released automatically on commit or rollback.
		lockKey := fmt.Sprintf("sales_app:%d:%s:%s:%s", user.ID, req.CIF, req.ProductType, idemKey)
		if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lockKey); err != nil {
			respondErr(w, 500, "Could not acquire application lock")
			return
		}

		// If an identical application was raised in the last 60 seconds, treat this as a
		// retry: hand back the existing one untouched rather than minting a second
		// reference and notifying Risk twice.
		var (
			dupID                       int64
			dupRef, dupStage, dupStatus string
			dupSubmitted                sql.NullTime
		)
		dupErr := tx.QueryRowContext(ctx, `
			SELECT id, reference, stage, status, submitted_at
			  FROM loan_applications
			 WHERE applicant_cif = $1 AND product_type = $2 AND sales_officer_id = $3
			   AND created_at >= NOW() - INTERVAL '60 seconds'
			 ORDER BY created_at DESC
			 LIMIT 1`, req.CIF, req.ProductType, user.ID).
			Scan(&dupID, &dupRef, &dupStage, &dupStatus, &dupSubmitted)
		if dupErr == nil {
			// Commit to release the advisory lock; nothing was written on this path.
			if err := tx.Commit(); err != nil {
				respondErr(w, 500, "Commit failed")
				return
			}
			existing := map[string]any{
				"id": dupID, "reference": dupRef, "stage": dupStage,
				"status": dupStatus, "duplicate": true,
			}
			if dupSubmitted.Valid {
				existing["submitted_at"] = dupSubmitted.Time
			}
			respond(w, existing, "pg")
			return
		}
		if dupErr != sql.ErrNoRows {
			respondErr(w, 500, "Duplicate check failed")
			return
		}

		// Allocate the reference inside the transaction. los_ref_seq is a Postgres
		// sequence, so a rolled-back application simply leaves a gap in the numbering —
		// acceptable, and far preferable to two applications racing for a number.
		var seq int64
		if err := tx.QueryRowContext(ctx, `SELECT nextval('los_ref_seq')`).Scan(&seq); err != nil {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		ref := fmt.Sprintf("LOS-%s-%04d", time.Now().UTC().Format("200601"), seq)

		routedStage, notifyRoles := salesAppRouting(req.ProductType)

		var (
			appID                       int64
			appRef, appStage, appStatus string
			appSubmitted                time.Time
		)
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO loan_applications (
			    reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
			    product_type, amount_requested_kobo, tenor_months,
			    purpose, employer, monthly_income_kobo,
			    status, stage, sales_officer_id, assigned_to_user_id,
			    submitted_at, created_by, created_at, updated_at
			) VALUES (
			    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
			    'submitted',$13,$12,$12,
			    NOW(),$12,NOW(),NOW()
			) RETURNING id, reference, stage, status, submitted_at`,
			ref, name, req.CIF, email, phone,
			req.ProductType, req.AmountRequested, req.TenorMonths,
			req.Purpose, req.Employer, req.MonthlyIncome, user.ID, routedStage).
			Scan(&appID, &appRef, &appStage, &appStatus, &appSubmitted); err != nil {
			respondErr(w, 500, "Could not raise the application: "+err.Error())
			return
		}

		// Record the submission on the application's own event trail so LOS shows the same
		// history a Risk officer would expect for any other route in. This writes the
		// canonical application_events columns (event_type / actor_user_id / notes) that
		// los.go and batch.go use; the previous code wrote non-existent columns
		// (event / note / created_by) and swallowed the resulting error, so no sales-raised
		// application ever recorded its submission event. The error is now propagated: if
		// the event cannot be written the whole application is rolled back rather than
		// committed with no trail.
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO application_events (application_id, event_type, to_stage, actor_user_id, notes, created_at)
			VALUES ($1,'submitted',$4,$2,$3,NOW())`,
			appID, user.ID,
			strings.TrimSpace("Raised by Sales for "+name+". "+req.Note), routedStage); err != nil {
			respondErr(w, 500, "Could not record the application event: "+err.Error())
			return
		}

		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		app := map[string]any{
			"id": appID, "reference": appRef, "stage": appStage,
			"status": appStatus, "submitted_at": appSubmitted,
		}

		// Risk is told immediately, and only for a genuinely new application. Detached from
		// the request context deliberately: the application is already committed, and a
		// slow mail hop must not fail the call or be cancelled when the officer's browser
		// moves on.
		go NotifyRoles(context.Background(), db, notifyRoles, NotifPayload{
			EventType: "los_application_submitted",
			Title:     fmt.Sprintf("New %s application", salesProductTypes[req.ProductType]),
			Body: fmt.Sprintf("%s raised %s for %s (CIF %s), %s",
				user.FullName, ref, name, req.CIF, fmtKoboServer(req.AmountRequested)),
			ActionURL: fmt.Sprintf("/los/applications/%d", appID),
			EntityRef: ref,
		})

		respond(w, app, "pg")
	}
}

// applicationBooking answers "did this actually get booked in the core system?".
//
// A workspace application can sit at booked while nothing exists in Udara — the sync
// currently returns zero loans and zero FDs, so today this endpoint will honestly
// report every application as unconfirmed rather than implying success.
func applicationBooking(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")

		// Scope like listSalesApplications: an officer may only inspect applications they
		// raised (which would otherwise leak other customers' core-banking loan data); a
		// head may inspect any. Enforced in the WHERE so a wrong id reads as 404.
		scope := ""
		args := []any{id}
		if !isSalesHead(user) {
			scope = " AND sales_officer_id = $2"
			args = append(args, user.ID)
		}

		var cif, stage, status, product string
		var bookedAt sql.NullTime
		var approved sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(), `
			SELECT COALESCE(applicant_cif,''), stage, status, product_type,
			       booked_at, amount_approved_kobo
			  FROM loan_applications WHERE id = $1`+scope, args...).
			Scan(&cif, &stage, &status, &product, &bookedAt, &approved); err != nil {
			respondErr(w, 404, "Application not found")
			return
		}

		out := map[string]any{
			"cif": cif, "stage": stage, "status": status, "product_type": product,
			"booked_in_workspace": bookedAt.Valid,
		}
		if bookedAt.Valid {
			out["booked_at"] = bookedAt.Time
		}

		if cif == "" {
			out["cbs"] = map[string]any{
				"confirmed": false,
				"reason":    "The application has no CIF, so it cannot be matched against the core system",
			}
			respond(w, out, "pg")
			return
		}

		// Match on customer and, where the amount was approved, on amount too — a
		// customer with several loans should not have an unrelated one counted as
		// confirmation of this application.
		rows, err := db.PGQuery(r.Context(), `
			SELECT cbs_account_number, product_name, status, loan_amount_kobo,
			       start_date, maturity_date, synced_at
			  FROM cbs_loans
			 WHERE cbs_customer_id = $1
			 ORDER BY start_date DESC NULLS LAST
			 LIMIT 25`, cif)
		if err != nil {
			respondErr(w, 500, "Core-system lookup failed")
			return
		}

		var match core.Row
		for _, l := range rows {
			if approved.Valid && approved.Int64 > 0 && toInt64(l["loan_amount_kobo"]) != approved.Int64 {
				continue
			}
			match = l
			break
		}

		cbs := map[string]any{"candidates": rows, "confirmed": match != nil}
		if match != nil {
			cbs["match"] = match
		} else if len(rows) == 0 {
			cbs["reason"] = "No loan exists in the core system for this customer. " +
				"Note the Udara sync currently returns zero loans overall, so this may " +
				"reflect the sync rather than the booking."
		} else {
			cbs["reason"] = "Loans exist for this customer but none matches the approved amount"
		}
		out["cbs"] = cbs

		respond(w, out, "pg")
	}
}

// fmtKoboServer renders kobo as naira for notification text. The frontend has its own
// formatter; notifications are composed server-side and need one here.
func fmtKoboServer(kobo int64) string {
	neg := kobo < 0
	if neg {
		kobo = -kobo
	}
	whole := kobo / 100
	s := fmt.Sprintf("%d", whole)
	// Thousands separators, inserted from the right.
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := "₦" + b.String()
	if neg {
		return "-" + out
	}
	return out
}

// draftScope returns the WHERE fragment + args that restrict a draft to the caller:
// an officer may only touch their own drafts; a head may touch any.
func draftScope(user *core.Claims, startArg int) (string, []any) {
	if isSalesHead(user) {
		return "", nil
	}
	return fmt.Sprintf(" AND sales_officer_id = $%d", startArg), []any{user.ID}
}

// updateSalesAppDraft edits a parked draft. Only fields the sales-side form owns are
// touchable, and only while the application is still a draft.
func updateSalesAppDraft(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")
		var req salesAppReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if req.ProductType != "" {
			if _, ok := salesProductTypes[req.ProductType]; !ok {
				respondErr(w, 400, "Unknown product_type")
				return
			}
		}
		scope, sargs := draftScope(user, 8)
		args := []any{req.ProductType, req.AmountRequested, req.TenorMonths, req.Purpose,
			req.Employer, req.MonthlyIncome, id}
		args = append(args, sargs...)
		res, err := db.PGExec(r.Context(), `
			UPDATE loan_applications
			   SET product_type          = COALESCE(NULLIF($1,''), product_type),
			       amount_requested_kobo = $2,
			       tenor_months          = $3,
			       purpose               = $4,
			       employer              = $5,
			       monthly_income_kobo   = $6,
			       updated_at            = NOW()
			 WHERE id = $7 AND status = 'draft'`+scope, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not update the draft", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "No draft you can edit with that id")
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// submitSalesAppDraft pushes a draft to Risk or the relevant ops desk, applying the
// same product routing a fresh submission gets.
func submitSalesAppDraft(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")
		scope, sargs := draftScope(user, 2)
		args := append([]any{id}, sargs...)

		var appID, amount int64
		var product, cif, name, ref string
		if err := db.PG.QueryRowContext(r.Context(), `
			SELECT id, product_type, COALESCE(amount_requested_kobo,0),
			       COALESCE(applicant_cif,''), COALESCE(applicant_name,''), reference
			  FROM loan_applications
			 WHERE id = $1 AND status = 'draft'`+scope, args...).
			Scan(&appID, &product, &amount, &cif, &name, &ref); err != nil {
			respondErr(w, 404, "No draft you can submit with that id")
			return
		}
		if amount <= 0 {
			respondErr(w, 400, "Set an amount before submitting this application")
			return
		}
		routedStage, notifyRoles := salesAppRouting(product)

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck
		res, err := tx.ExecContext(r.Context(), `
			UPDATE loan_applications
			   SET status='submitted', stage=$2, submitted_at=NOW(), updated_at=NOW()
			 WHERE id=$1 AND status='draft'`, appID, routedStage)
		if err != nil {
			respondErr(w, 500, "Could not submit the draft: "+err.Error())
			return
		}
		// A concurrent submit already pushed it — don't submit or notify twice.
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 409, "That application has already been submitted")
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO application_events (application_id, event_type, to_stage, actor_user_id, notes, created_at)
			VALUES ($1,'submitted',$2,$3,$4,NOW())`,
			appID, routedStage, user.ID, "Submitted from draft by Sales"); err != nil {
			respondErr(w, 500, "Could not record the event: "+err.Error())
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}

		go NotifyRoles(context.Background(), db, notifyRoles, NotifPayload{
			EventType: "los_application_submitted",
			Title:     fmt.Sprintf("New %s application", salesProductTypes[product]),
			Body: fmt.Sprintf("%s submitted %s for %s (CIF %s), %s",
				user.FullName, ref, name, cif, fmtKoboServer(amount)),
			ActionURL: fmt.Sprintf("/los/applications/%d", appID),
			EntityRef: ref,
		})
		respond(w, map[string]any{"id": appID, "reference": ref, "stage": routedStage, "status": "submitted"}, "pg")
	}
}

// deleteSalesAppDraft discards a draft. Only drafts can be deleted this way — a
// submitted application is Risk/Ops's to close, not the officer's to erase.
func deleteSalesAppDraft(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if user == nil {
			respondErr(w, 401, "Unauthorized")
			return
		}
		id := chi.URLParam(r, "id")
		scope, sargs := draftScope(user, 2)
		args := append([]any{id}, sargs...)
		res, err := db.PGExec(r.Context(),
			`DELETE FROM loan_applications WHERE id=$1 AND status='draft'`+scope, args...)
		if err != nil {
			respondErrLog(w, 500, "Could not delete the draft", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			respondErr(w, 404, "No draft you can delete with that id")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
