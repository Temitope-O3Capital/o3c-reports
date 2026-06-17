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
