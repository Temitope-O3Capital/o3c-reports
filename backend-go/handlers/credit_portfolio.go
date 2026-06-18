package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCreditPortfolio(r chi.Router, db *core.DB) {
	access := core.RequirePages("credit_portfolio")

	// Applications
	r.With(access).Get("/applications",        cpListApplications(db))
	r.With(access).Post("/applications",        cpCreateApplication(db))
	r.With(access).Get("/applications/{id}",   cpGetApplication(db))
	r.With(access).Put("/applications/{id}",   cpUpdateApplication(db))
	r.With(access).Delete("/applications/{id}", cpDeleteApplication(db))

	// Repayments (nested under application)
	r.With(access).Get("/applications/{id}/repayments",  cpListRepayments(db))
	r.With(access).Post("/applications/{id}/repayments", cpAddRepayment(db))
	r.With(access).Put("/repayments/{rid}",              cpUpdateRepayment(db))
	r.With(access).Delete("/repayments/{rid}",           cpDeleteRepayment(db))

	// Collateral (nested under application)
	r.With(access).Get("/applications/{id}/collateral",  cpListCollateral(db))
	r.With(access).Post("/applications/{id}/collateral", cpAddCollateral(db))
	r.With(access).Put("/collateral/{cid}",              cpUpdateCollateral(db))
	r.With(access).Delete("/collateral/{cid}",           cpDeleteCollateral(db))

	// Analytics
	r.With(access).Get("/summary",   cpSummary(db))
	r.With(access).Get("/pipeline",  cpPipeline(db))
	r.With(access).Get("/by-officer", cpByOfficer(db))
	r.With(access).Get("/overdue",   cpOverdue(db))
}

/* ── Applications ─────────────────────────────────────────────────────────── */

func cpListApplications(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "type"); v != "" {
			where += fmt.Sprintf(" AND type=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "status"); v != "" {
			where += fmt.Sprintf(" AND status=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "location"); v != "" {
			where += fmt.Sprintf(" AND location=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "account_officer"); v != "" {
			where += fmt.Sprintf(" AND account_officer ILIKE $%d", n); args = append(args, "%"+v+"%"); n++
		}
		if v := qstr(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND date_received >= $%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND date_received <= $%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "q"); v != "" {
			where += fmt.Sprintf(" AND (customer_name ILIKE $%d OR company ILIKE $%d OR loan_id ILIKE $%d)", n, n, n)
			args = append(args, "%"+v+"%"); n++
		}

		limit  := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		// total count
		countRows, _ := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT COUNT(*) AS total FROM credit_applications WHERE %s`, where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		args2 := append(args, limit, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT * FROM credit_applications WHERE %s ORDER BY date_received DESC, id DESC LIMIT $%d OFFSET $%d`,
			where, n, n+1), args2...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func cpCreateApplication(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			DateReceived    string   `json:"date_received"`
			CustomerName    string   `json:"customer_name"`
			Company         string   `json:"company"`
			Type            string   `json:"type"`
			RequestedAmount *int64   `json:"requested_amount"`
			Status          string   `json:"status"`
			ApprovedAmount  *int64   `json:"approved_amount"`
			DeclinedReason  string   `json:"declined_reason"`
			DateProcessed   string   `json:"date_processed"`
			DisbursedAmount *int64   `json:"disbursed_amount"`
			DisbursedDate   string   `json:"disbursed_date"`
			Mandate         string   `json:"mandate"`
			LoanID          string   `json:"loan_id"`
			Tenor           *int     `json:"tenor"`
			Rate            *float64 `json:"rate"`
			RepaymentAmount *int64   `json:"repayment_amount"`
			MaturityDate    string   `json:"maturity_date"`
			Location        string   `json:"location"`
			AccountOfficer  string   `json:"account_officer"`
			Introducer      string   `json:"introducer"`
			ApplicationType string   `json:"application_type"`
			Notes           string   `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.CustomerName == "" {
			respondErr(w, 422, "customer_name is required"); return
		}
		if b.DateReceived == "" {
			respondErr(w, 422, "date_received is required"); return
		}
		if b.Type != "loan" && b.Type != "card" {
			b.Type = "loan"
		}
		if b.Status == "" {
			b.Status = "pending"
		}
		if b.ApplicationType == "" {
			b.ApplicationType = "new"
		}
		user := core.UserFromCtx(r.Context())

		nullStr := func(s string) any {
			if s == "" { return nil }
			return s
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO credit_applications
			    (date_received, customer_name, company, type, requested_amount, status,
			     approved_amount, declined_reason, date_processed, disbursed_amount, disbursed_date,
			     mandate, loan_id, tenor, rate, repayment_amount, maturity_date,
			     location, account_officer, introducer, application_type, notes, created_by)
			VALUES
			    ($1::date,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11::date,$12,$13,$14,$15,$16,$17::date,$18,$19,$20,$21,$22,$23)
			RETURNING *`,
			b.DateReceived, b.CustomerName, nullStr(b.Company), b.Type,
			b.RequestedAmount, b.Status, b.ApprovedAmount, nullStr(b.DeclinedReason),
			nullStr(b.DateProcessed), b.DisbursedAmount, nullStr(b.DisbursedDate),
			nullStr(b.Mandate), nullStr(b.LoanID), b.Tenor, b.Rate, b.RepaymentAmount,
			nullStr(b.MaturityDate), nullStr(b.Location), nullStr(b.AccountOfficer),
			nullStr(b.Introducer), b.ApplicationType, nullStr(b.Notes), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error()); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpGetApplication(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `SELECT * FROM credit_applications WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Application not found"); return
		}
		// Also fetch repayments and collateral
		reps, _ := db.PGQuery(r.Context(), `SELECT * FROM loan_repayments WHERE application_id=$1 ORDER BY created_at`, id)
		cols, _ := db.PGQuery(r.Context(), `SELECT * FROM loan_collateral  WHERE application_id=$1 ORDER BY created_at`, id)
		app := rows[0]
		app["repayments"] = reps
		app["collateral"] = cols
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(app) //nolint:errcheck
	}
}

func cpUpdateApplication(db *core.DB) http.HandlerFunc {
	allowed := []string{
		"date_received", "customer_name", "company", "type", "requested_amount",
		"status", "approved_amount", "declined_reason", "date_processed",
		"disbursed_amount", "disbursed_date", "mandate", "loan_id",
		"tenor", "rate", "repayment_amount", "maturity_date",
		"location", "account_officer", "introducer", "application_type", "notes",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No updatable fields provided"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE credit_applications SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Application not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpDeleteApplication(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		res, err := db.PGQuery(r.Context(), `DELETE FROM credit_applications WHERE id=$1 RETURNING id`, id)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 404, "Application not found")
			return
		}
		w.WriteHeader(204)
	}
}

/* ── Repayments ──────────────────────────────────────────────────────────────── */

func cpListRepayments(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(),
			`SELECT * FROM loan_repayments WHERE application_id=$1 ORDER BY created_at`, id)
		jsonRows(w, rows)
	}
}

func cpAddRepayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "id")
		var b struct {
			PaymentMonth   string `json:"payment_month"`
			ExpectedAmount *int64 `json:"expected_amount"`
			PaidAmount     *int64 `json:"paid_amount"`
			PaymentDate    string `json:"payment_date"`
			DPD            *int   `json:"dpd"`
			PaymentStatus  string `json:"payment_status"`
			Comment        string `json:"comment"`
			ActionTaken    string `json:"action_taken"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.PaymentMonth == "" {
			respondErr(w, 422, "payment_month is required"); return
		}
		if b.PaymentStatus == "" {
			b.PaymentStatus = "pending"
		}
		user := core.UserFromCtx(r.Context())
		nullStr := func(s string) any {
			if s == "" { return nil }
			return s
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO loan_repayments
			    (application_id, payment_month, expected_amount, paid_amount,
			     payment_date, dpd, payment_status, comment, action_taken, created_by)
			VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10) RETURNING *`,
			appID, b.PaymentMonth, b.ExpectedAmount, b.PaidAmount,
			nullStr(b.PaymentDate), b.DPD, b.PaymentStatus,
			nullStr(b.Comment), nullStr(b.ActionTaken), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error()); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpUpdateRepayment(db *core.DB) http.HandlerFunc {
	allowed := []string{
		"payment_month", "expected_amount", "paid_amount", "payment_date",
		"dpd", "payment_status", "comment", "action_taken",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		rid := chi.URLParam(r, "rid")
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No updatable fields"); return
		}
		args = append(args, rid)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE loan_repayments SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Repayment not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpDeleteRepayment(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rid := chi.URLParam(r, "rid")
		res, err := db.PGQuery(r.Context(), `DELETE FROM loan_repayments WHERE id=$1 RETURNING id`, rid)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 404, "Repayment not found")
			return
		}
		w.WriteHeader(204)
	}
}

/* ── Collateral ──────────────────────────────────────────────────────────────── */

func cpListCollateral(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, _ := db.PGQuery(r.Context(),
			`SELECT * FROM loan_collateral WHERE application_id=$1 ORDER BY created_at`, id)
		jsonRows(w, rows)
	}
}

func cpAddCollateral(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		appID := chi.URLParam(r, "id")
		var b struct {
			SecurityType     string `json:"security_type"`
			VehicleInfo      string `json:"vehicle_info"`
			LastLocation     string `json:"last_location"`
			GuarantorName    string `json:"guarantor_name"`
			GuarantorPhone   string `json:"guarantor_phone"`
			GuarantorEmail   string `json:"guarantor_email"`
			GuarantorAddress string `json:"guarantor_address"`
			Notes            string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		ns := func(s string) any {
			if s == "" { return nil }
			return s
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO loan_collateral
			    (application_id, security_type, vehicle_info, last_location,
			     guarantor_name, guarantor_phone, guarantor_email, guarantor_address, notes)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
			appID, ns(b.SecurityType), ns(b.VehicleInfo), ns(b.LastLocation),
			ns(b.GuarantorName), ns(b.GuarantorPhone), ns(b.GuarantorEmail),
			ns(b.GuarantorAddress), ns(b.Notes))
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error()); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpUpdateCollateral(db *core.DB) http.HandlerFunc {
	allowed := []string{
		"security_type", "vehicle_info", "last_location",
		"guarantor_name", "guarantor_phone", "guarantor_email", "guarantor_address", "notes",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		cid := chi.URLParam(r, "cid")
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No updatable fields"); return
		}
		args = append(args, cid)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE loan_collateral SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Collateral record not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func cpDeleteCollateral(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cid := chi.URLParam(r, "cid")
		res, err := db.PGQuery(r.Context(), `DELETE FROM loan_collateral WHERE id=$1 RETURNING id`, cid)
		if err != nil {
			respondErr(w, 500, "Delete failed")
			return
		}
		if len(res) == 0 {
			respondErr(w, 404, "Collateral record not found")
			return
		}
		w.WriteHeader(204)
	}
}

/* ── Analytics ────────────────────────────────────────────────────────────── */

func cpSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		loc  := qstr(r, "location")
		typ  := qstr(r, "type")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND date_received >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND date_received <= $%d::date", n); args = append(args, dateTo); n++
		}
		if loc != "" {
			where += fmt.Sprintf(" AND location=$%d", n); args = append(args, loc); n++
		}
		if typ != "" {
			where += fmt.Sprintf(" AND type=$%d", n); args = append(args, typ); n++
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				COUNT(*)                                                        AS total_applications,
				COUNT(*) FILTER (WHERE status='approved' OR status='disbursed') AS approved,
				COUNT(*) FILTER (WHERE status='declined')                       AS declined,
				COUNT(*) FILTER (WHERE status='pending')                        AS pending,
				COUNT(*) FILTER (WHERE status='incomplete')                     AS incomplete,
				COUNT(*) FILTER (WHERE status='disbursed')                      AS disbursed,
				COALESCE(SUM(requested_amount)  FILTER (WHERE requested_amount IS NOT NULL), 0) AS total_requested,
				COALESCE(SUM(approved_amount)   FILTER (WHERE approved_amount IS NOT NULL), 0)  AS total_approved,
				COALESCE(SUM(disbursed_amount)  FILTER (WHERE disbursed_amount IS NOT NULL), 0) AS total_disbursed,
				COUNT(*) FILTER (WHERE type='loan')                             AS loan_count,
				COUNT(*) FILTER (WHERE type='card')                             AS card_count
			FROM credit_applications WHERE %s`, where), args...)
		if err != nil {
			respondErr(w, 500, "Summary failed"); return
		}
		if len(rows) == 0 {
			rows = []core.Row{{
				"total_applications": 0, "approved": 0, "declined": 0,
				"pending": 0, "incomplete": 0, "disbursed": 0,
				"total_requested": 0, "total_approved": 0, "total_disbursed": 0,
				"loan_count": 0, "card_count": 0,
			}}
		}

		// Approval rate
		s := rows[0]
		total := toInt64(s["total_applications"])
		approved := toInt64(s["approved"])
		approvalRate := 0.0
		if total > 0 {
			approvalRate = float64(approved) / float64(total) * 100
		}
		s["approval_rate"] = approvalRate

		// DPD / overdue count
		overdueRows, _ := db.PGQuery(r.Context(), `
			SELECT COUNT(DISTINCT application_id) AS overdue_loans
			FROM loan_repayments
			WHERE payment_status='overdue' OR dpd > 0`)
		if len(overdueRows) > 0 {
			s["overdue_loans"] = overdueRows[0]["overdue_loans"]
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s) //nolint:errcheck
	}
}

func cpPipeline(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		loc         := qstr(r, "location")
		typ         := qstr(r, "type")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND date_received >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND date_received <= $%d::date", n); args = append(args, dateTo); n++
		}
		if loc != "" {
			where += fmt.Sprintf(" AND location=$%d", n); args = append(args, loc); n++
		}
		if typ != "" {
			where += fmt.Sprintf(" AND type=$%d", n); args = append(args, typ); n++
		}
		_ = n

		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				status,
				type,
				COUNT(*) AS count,
				COALESCE(SUM(approved_amount),0) AS total_approved,
				COALESCE(SUM(disbursed_amount),0) AS total_disbursed
			FROM credit_applications WHERE %s
			GROUP BY status, type ORDER BY count DESC`, where), args...)

		jsonRows(w, rows)
	}
}

func cpByOfficer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND date_received >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND date_received <= $%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				account_officer,
				COUNT(*)                                                        AS total,
				COUNT(*) FILTER (WHERE status='approved' OR status='disbursed') AS approved,
				COUNT(*) FILTER (WHERE status='declined')                       AS declined,
				COUNT(*) FILTER (WHERE status='disbursed')                      AS disbursed,
				COALESCE(SUM(disbursed_amount) FILTER (WHERE disbursed_amount IS NOT NULL),0) AS total_disbursed
			FROM credit_applications WHERE %s AND account_officer IS NOT NULL
			GROUP BY account_officer ORDER BY total DESC`, where), args...)

		jsonRows(w, rows)
	}
}

func cpOverdue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT
				a.id, a.customer_name, a.company, a.type, a.disbursed_amount,
				a.account_officer, a.location, a.maturity_date,
				r.payment_month, r.expected_amount, r.paid_amount, r.dpd,
				r.payment_status, r.comment, r.action_taken
			FROM credit_applications a
			JOIN loan_repayments r ON r.application_id = a.id
			WHERE r.payment_status = 'overdue' OR r.dpd > 0
			ORDER BY r.dpd DESC NULLS LAST, a.customer_name`)

		jsonRows(w, rows)
	}
}
