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

// salesProductTypes are the products an officer may raise. Kept explicit rather than
// free text so the LOS queue, Risk and reporting all agree on the vocabulary.
var salesProductTypes = map[string]string{
	"salary_loan":         "Salary Loan",
	"individual_loan":     "Individual Loan",
	"business_loan":       "Business Loan",
	"credit_card":         "Credit Card",
	"card_limit_increase": "Card Limit Increase",
}

func RegisterSalesApplications(r chi.Router, db *core.DB) {
	access := core.RequirePages("sales", "crm_contacts")
	r.With(access).Get("/applications/products", listSalesProducts())
	r.With(access).Get("/applications", listSalesApplications(db))
	r.With(access).Post("/applications", createSalesApplication(db))
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
		if req.AmountRequested <= 0 {
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

		seqRow, err := db.PGQuery(ctx, `SELECT nextval('los_ref_seq') AS seq`)
		if err != nil || len(seqRow) == 0 {
			respondErr(w, 500, "Reference generation failed")
			return
		}
		ref := fmt.Sprintf("LOS-%s-%04d", time.Now().UTC().Format("200601"), toInt64(seqRow[0]["seq"]))

		rows, err := db.PGQuery(ctx, `
			INSERT INTO loan_applications (
			    reference, applicant_name, applicant_cif, applicant_email, applicant_phone,
			    product_type, amount_requested_kobo, tenor_months,
			    purpose, employer, monthly_income_kobo,
			    status, stage, sales_officer_id, assigned_to_user_id,
			    submitted_at, created_by, created_at, updated_at
			) VALUES (
			    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
			    'submitted','risk_review',$12,$12,
			    NOW(),$12,NOW(),NOW()
			) RETURNING id, reference, stage, status, submitted_at`,
			ref, name, req.CIF, email, phone,
			req.ProductType, req.AmountRequested, req.TenorMonths,
			req.Purpose, req.Employer, req.MonthlyIncome, user.ID)
		if err != nil {
			respondErr(w, 500, "Could not raise the application: "+err.Error())
			return
		}
		app := rows[0]

		// Record the submission on the application's own event trail so LOS shows the
		// same history a Risk officer would expect for any other route in.
		_, _ = db.PGExec(ctx, `
			INSERT INTO application_events (application_id, event, to_stage, note, created_by, created_at)
			VALUES ($1,'submitted','risk_review',$2,$3,NOW())`,
			toInt64(app["id"]),
			strings.TrimSpace("Raised by Sales for "+name+". "+req.Note), user.ID)

		// Risk is told immediately. Detached from the request context deliberately: the
		// application is already committed, and a slow mail hop must not fail the call
		// or be cancelled when the officer's browser moves on.
		go NotifyRoles(context.Background(), db, []string{"risk_officer", "risk_head"}, NotifPayload{
			EventType: "los_application_submitted",
			Title:     fmt.Sprintf("New %s application", salesProductTypes[req.ProductType]),
			Body: fmt.Sprintf("%s raised %s for %s (CIF %s) — %s",
				user.FullName, ref, name, req.CIF, fmtKoboServer(req.AmountRequested)),
			ActionURL: fmt.Sprintf("/los/applications/%d", toInt64(app["id"])),
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
		id := chi.URLParam(r, "id")

		var cif, stage, status, product string
		var bookedAt sql.NullTime
		var approved sql.NullInt64
		if err := db.PG.QueryRowContext(r.Context(), `
			SELECT COALESCE(applicant_cif,''), stage, status, product_type,
			       booked_at, amount_approved_kobo
			  FROM loan_applications WHERE id = $1`, id).
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
