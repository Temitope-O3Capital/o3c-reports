package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterFixedDeposit(r chi.Router, db *core.DB) {
	access := core.RequirePages("fixed_deposit")

	r.With(access).Get("/transactions",      fdListTransactions(db))
	r.With(access).Post("/transactions",     fdCreateTransaction(db))
	r.With(access).Get("/transactions/{id}", fdGetTransaction(db))
	r.With(access).Put("/transactions/{id}", fdUpdateTransaction(db))
	r.With(access).Delete("/transactions/{id}", fdDeleteTransaction(db))

	r.With(access).Post("/transactions/{id}/early-withdrawal-request", fdEarlyWithdrawalRequest(db))
	r.With(access).Patch("/transactions/{id}/early-withdrawal/{req_id}/approve", fdEarlyWithdrawalApprove(db))
	r.With(access).Patch("/transactions/{id}/early-withdrawal/{req_id}/reject",  fdEarlyWithdrawalReject(db))

	r.With(access).Post("/transactions/{id}/rollover",  fdRollover(db))
	r.With(access).Post("/transactions/{id}/liquidate", fdLiquidate(db))

	r.With(access).Get("/summary",    fdSummary(db))
	r.With(access).Get("/trend",      fdTrend(db))
	r.With(access).Get("/by-location", fdByLocation(db))
	r.With(access).Get("/by-officer",  fdByOfficer(db))
}

/* ── Transactions ─────────────────────────────────────────────────────────── */

func fdListTransactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "type"); v != "" {
			where += fmt.Sprintf(" AND transaction_type=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "location"); v != "" {
			where += fmt.Sprintf(" AND location=$%d", n); args = append(args, v); n++
		}
		if v := qstr(r, "date_from"); v != "" {
			where += fmt.Sprintf(" AND transaction_date >= $%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "date_to"); v != "" {
			where += fmt.Sprintf(" AND transaction_date <= $%d::date", n); args = append(args, v); n++
		}
		if v := qstr(r, "q"); v != "" {
			where += fmt.Sprintf(" AND customer_name ILIKE $%d", n)
			args = append(args, "%"+v+"%"); n++
		}

		limit  := qint(r, "limit", 200, 1, 1000)
		offset := qint(r, "offset", 0, 0, 1<<30)

		countRows, _ := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS total FROM fd_transactions WHERE %s`, where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		args2 := append(args, limit, offset)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT * FROM fd_transactions WHERE %s ORDER BY transaction_date DESC, id DESC LIMIT $%d OFFSET $%d`,
			where, n, n+1), args2...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func fdCreateTransaction(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			TransactionDate string   `json:"transaction_date"`
			CustomerName    string   `json:"customer_name"`
			TransactionType string   `json:"transaction_type"` // inflow | liquidation
			Principal       *float64 `json:"principal"`
			InterestPaid    *float64 `json:"interest_paid"`
			GrossAmount     *float64 `json:"gross_amount"`
			USDAmount       *float64 `json:"usd_amount"`
			NGNAmount       *float64 `json:"ngn_amount"`
			Currency        string   `json:"currency"`
			Location        string   `json:"location"`
			AccountOfficer  string   `json:"account_officer"`
			MaturityDate    string   `json:"maturity_date"`
			TenorDays       *int     `json:"tenor_days"`
			Rate            *float64 `json:"rate"`
			Notes           string   `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON"); return
		}
		if b.CustomerName == "" {
			respondErr(w, 422, "customer_name is required"); return
		}
		if b.TransactionDate == "" {
			respondErr(w, 422, "transaction_date is required"); return
		}
		if b.TransactionType != "inflow" && b.TransactionType != "liquidation" {
			respondErr(w, 422, "transaction_type must be inflow or liquidation"); return
		}
		if b.Currency == "" {
			b.Currency = "NGN"
		}
		user := core.UserFromCtx(r.Context())
		ns := func(s string) any {
			if s == "" { return nil }
			return s
		}

		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO fd_transactions
			    (transaction_date, customer_name, transaction_type, principal, interest_paid,
			     gross_amount, usd_amount, ngn_amount, currency, location,
			     account_officer, maturity_date, tenor_days, rate, notes, created_by)
			VALUES
			    ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16)
			RETURNING *`,
			b.TransactionDate, b.CustomerName, b.TransactionType,
			b.Principal, b.InterestPaid, b.GrossAmount, b.USDAmount, b.NGNAmount,
			b.Currency, ns(b.Location), ns(b.AccountOfficer),
			ns(b.MaturityDate), b.TenorDays, b.Rate, ns(b.Notes), user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error()); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func fdGetTransaction(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `SELECT * FROM fd_transactions WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Transaction not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func fdUpdateTransaction(db *core.DB) http.HandlerFunc {
	allowed := []string{
		"transaction_date", "customer_name", "transaction_type", "principal",
		"interest_paid", "gross_amount", "usd_amount", "ngn_amount", "currency",
		"location", "account_officer", "maturity_date", "tenor_days", "rate", "notes",
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No updatable fields provided"); return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE fd_transactions SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Transaction not found"); return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func fdDeleteTransaction(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		db.PGExec(r.Context(), `DELETE FROM fd_transactions WHERE id=$1`, id) //nolint:errcheck
		w.WriteHeader(204)
	}
}

/* ── Analytics ────────────────────────────────────────────────────────────── */

func fdSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")
		loc         := qstr(r, "location")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND transaction_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND transaction_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		if loc != "" {
			where += fmt.Sprintf(" AND location=$%d", n); args = append(args, loc); n++
		}
		_ = n

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				COUNT(*) FILTER (WHERE transaction_type='inflow')      AS inflow_count,
				COUNT(*) FILTER (WHERE transaction_type='liquidation')  AS liquidation_count,
				COALESCE(SUM(ngn_amount) FILTER (WHERE transaction_type='inflow'), 0)     AS total_inflow_ngn,
				COALESCE(SUM(usd_amount) FILTER (WHERE transaction_type='inflow'), 0)     AS total_inflow_usd,
				COALESCE(SUM(gross_amount) FILTER (WHERE transaction_type='liquidation'), 0) AS total_liquidated,
				COALESCE(SUM(principal) FILTER (WHERE transaction_type='liquidation'), 0)    AS total_principal,
				COALESCE(SUM(interest_paid) FILTER (WHERE transaction_type='liquidation'), 0) AS total_interest,
				COUNT(*) AS total_transactions
			FROM fd_transactions WHERE %s`, where), args...)
		if err != nil {
			respondErr(w, 500, "Summary failed"); return
		}
		if len(rows) == 0 {
			// Table exists but no transactions yet — return zero summary
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
				"inflow_count": 0, "liquidation_count": 0,
				"total_inflow_ngn": 0, "total_inflow_usd": 0,
				"total_liquidated": 0, "total_principal": 0,
				"total_interest": 0, "total_transactions": 0,
				"net_position": 0,
			})
			return
		}

		s := rows[0]
		inflow := toFloat64(s["total_inflow_ngn"])
		liquid := toFloat64(s["total_liquidated"])
		s["net_position"] = inflow - liquid

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s) //nolint:errcheck
	}
}

func fdTrend(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND transaction_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND transaction_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				TO_CHAR(DATE_TRUNC('month', transaction_date), 'Mon YYYY') AS label,
				DATE_TRUNC('month', transaction_date) AS month_start,
				COALESCE(SUM(ngn_amount)   FILTER (WHERE transaction_type='inflow'), 0)      AS inflow,
				COALESCE(SUM(gross_amount) FILTER (WHERE transaction_type='liquidation'), 0) AS liquidation,
				COUNT(*) FILTER (WHERE transaction_type='inflow')     AS inflow_count,
				COUNT(*) FILTER (WHERE transaction_type='liquidation') AS liquidation_count
			FROM fd_transactions WHERE %s
			GROUP BY DATE_TRUNC('month', transaction_date)
			ORDER BY month_start`, where), args...)

		jsonRows(w, rows)
	}
}

func fdByLocation(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND transaction_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND transaction_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				COALESCE(location, 'Unknown') AS location,
				COUNT(*) FILTER (WHERE transaction_type='inflow')     AS inflow_count,
				COUNT(*) FILTER (WHERE transaction_type='liquidation') AS liquidation_count,
				COALESCE(SUM(ngn_amount)   FILTER (WHERE transaction_type='inflow'), 0)      AS total_inflow,
				COALESCE(SUM(gross_amount) FILTER (WHERE transaction_type='liquidation'), 0) AS total_liquidated
			FROM fd_transactions WHERE %s
			GROUP BY location ORDER BY total_inflow DESC`, where), args...)

		jsonRows(w, rows)
	}
}

func fdByOfficer(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")

		where := "account_officer IS NOT NULL"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND transaction_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND transaction_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		rows, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
				account_officer,
				COUNT(*) FILTER (WHERE transaction_type='inflow')      AS inflow_count,
				COUNT(*) FILTER (WHERE transaction_type='liquidation')  AS liquidation_count,
				COALESCE(SUM(ngn_amount)   FILTER (WHERE transaction_type='inflow'), 0)      AS total_inflow,
				COALESCE(SUM(gross_amount) FILTER (WHERE transaction_type='liquidation'), 0) AS total_liquidated
			FROM fd_transactions WHERE %s
			GROUP BY account_officer ORDER BY total_inflow DESC LIMIT 30`, where), args...)

		jsonRows(w, rows)
	}
}

/* ── Early Withdrawal ─────────────────────────────────────────────────────── */

func fdEarlyWithdrawalRequest(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		fdRows, err := db.PGQuery(ctx, `SELECT id, principal, maturity_date, rate, transaction_type FROM fd_transactions WHERE id=$1`, id)
		if err != nil || len(fdRows) == 0 {
			respondErr(w, 404, "FD not found"); return
		}
		fd := fdRows[0]
		if str(fd["transaction_type"]) != "inflow" {
			respondErr(w, 422, "Only active inflow FDs can be withdrawn early"); return
		}

		// Pending request check
		existing, _ := db.PGQuery(ctx, `SELECT id FROM fd_early_withdrawal_requests WHERE fd_transaction_id=$1 AND status='pending'`, id)
		if len(existing) > 0 {
			respondErr(w, 422, "A pending withdrawal request already exists"); return
		}

		principal := int64(0)
		if v, ok := fd["principal"].(float64); ok {
			principal = int64(v * 100)
		}
		// Flat 10% penalty for early withdrawal
		penalty := principal / 10
		netPayout := principal - penalty

		rows, err := db.PGQuery(ctx,
			`INSERT INTO fd_early_withdrawal_requests
			   (fd_transaction_id, requested_by, status, principal_kobo, penalty_kobo, net_payout_kobo)
			 VALUES ($1,$2,'pending',$3,$4,$5) RETURNING *`,
			id, user.ID, principal, penalty, netPayout)
		if err != nil {
			respondErr(w, 500, "Failed to create request"); return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func fdEarlyWithdrawalApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reqID := chi.URLParam(r, "req_id")
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		reqRows, err := db.PGQuery(ctx,
			`SELECT id, fd_transaction_id, net_payout_kobo, status FROM fd_early_withdrawal_requests WHERE id=$1`, reqID)
		if err != nil || len(reqRows) == 0 {
			respondErr(w, 404, "Request not found"); return
		}
		req := reqRows[0]
		if str(req["status"]) != "pending" {
			respondErr(w, 422, "Request is not pending"); return
		}

		_, err = db.PGQuery(ctx,
			`UPDATE fd_early_withdrawal_requests SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING id`,
			user.ID, reqID)
		if err != nil {
			respondErr(w, 500, "Approve failed"); return
		}
		// Mark the FD as liquidated
		db.PGExec(ctx, `UPDATE fd_transactions SET transaction_type='liquidation', updated_at=NOW() WHERE id=$1`, req["fd_transaction_id"]) //nolint:errcheck

		respond(w, map[string]any{"status": "approved", "net_payout_kobo": req["net_payout_kobo"]}, "json")
	}
}

func fdEarlyWithdrawalReject(db *core.DB) http.HandlerFunc {
	type body struct {
		Reason string `json:"reason"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		reqID := chi.URLParam(r, "req_id")
		ctx := r.Context()
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		reqRows, err := db.PGQuery(ctx, `SELECT status FROM fd_early_withdrawal_requests WHERE id=$1`, reqID)
		if err != nil || len(reqRows) == 0 {
			respondErr(w, 404, "Request not found"); return
		}
		if str(reqRows[0]["status"]) != "pending" {
			respondErr(w, 422, "Request is not pending"); return
		}

		db.PGExec(ctx, //nolint:errcheck
			`UPDATE fd_early_withdrawal_requests SET status='rejected', rejection_reason=$1, updated_at=NOW() WHERE id=$2`,
			b.Reason, reqID)

		respond(w, map[string]any{"status": "rejected"}, "json")
	}
}

/* ── Rollover ─────────────────────────────────────────────────────────────── */

func fdRollover(db *core.DB) http.HandlerFunc {
	type body struct {
		Rate      *float64 `json:"rate"`       // optional override; defaults to current rate
		TenorDays *int     `json:"tenor_days"` // optional override; defaults to current tenor
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()
		user := core.UserFromCtx(ctx)

		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		fdRows, err := db.PGQuery(ctx,
			`SELECT * FROM fd_transactions WHERE id=$1`, id)
		if err != nil || len(fdRows) == 0 {
			respondErr(w, 404, "FD not found"); return
		}
		fd := fdRows[0]
		if str(fd["transaction_type"]) != "inflow" {
			respondErr(w, 422, "Only active inflow FDs can be rolled over"); return
		}

		rate := float64(0)
		if v, ok := fd["rate"].(float64); ok { rate = v }
		if b.Rate != nil { rate = *b.Rate }

		tenor := 0
		if v, ok := fd["tenor_days"].(float64); ok { tenor = int(v) }
		if b.TenorDays != nil { tenor = *b.TenorDays }

		principal := (*float64)(nil)
		if v, ok := fd["principal"].(float64); ok { principal = &v }

		// Mark old FD as rolled over
		db.PGExec(ctx, `UPDATE fd_transactions SET transaction_type='rolled_over', updated_at=NOW() WHERE id=$1`, id) //nolint:errcheck

		// Create new FD starting today
		newRows, err := db.PGQuery(ctx, `
			INSERT INTO fd_transactions
			    (transaction_date, customer_name, transaction_type, principal, currency,
			     location, account_officer, tenor_days, rate, maturity_date, ngn_amount, created_by)
			VALUES
			    (NOW()::date, $1, 'inflow', $2, $3, $4, $5, $6, $7,
			     (NOW()::date + ($6 * INTERVAL '1 day'))::date, $2, $8)
			RETURNING *`,
			fd["customer_name"], principal, fd["currency"],
			fd["location"], fd["account_officer"], tenor, rate, user.ID)
		if err != nil {
			respondErr(w, 500, "Rollover failed: "+err.Error()); return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(newRows[0]) //nolint:errcheck
	}
}

/* ── Liquidate (matured FD) ──────────────────────────────────────────────── */

func fdLiquidate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ctx := r.Context()

		fdRows, err := db.PGQuery(ctx,
			`SELECT id, transaction_type FROM fd_transactions WHERE id=$1`, id)
		if err != nil || len(fdRows) == 0 {
			respondErr(w, 404, "FD not found"); return
		}
		if str(fdRows[0]["transaction_type"]) != "inflow" {
			respondErr(w, 422, "FD is not active"); return
		}

		_, err = db.PGQuery(ctx,
			`UPDATE fd_transactions SET transaction_type='liquidation', updated_at=NOW() WHERE id=$1 RETURNING id`, id)
		if err != nil {
			respondErr(w, 500, "Liquidation failed"); return
		}

		respond(w, map[string]any{"status": "liquidated"}, "json")
	}
}
