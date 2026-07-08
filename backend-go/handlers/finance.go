package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterFinance(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance", "income")

	// GL Accounts (Chart of Accounts)
	r.With(access).Get("/gl-accounts",        finGLList(db))
	r.With(access).Post("/gl-accounts",       finGLCreate(db))
	r.With(access).Patch("/gl-accounts/{id}", finGLUpdate(db))

	// Manual Postings
	r.With(access).Get("/manual-postings",                  finPostingsList(db))
	r.With(access).Post("/manual-postings",                 finPostingsCreate(db))
	r.With(access).Patch("/manual-postings/{id}/approve",   finPostingsApprove(db))
	r.With(access).Patch("/manual-postings/{id}/reject",    finPostingsReject(db))

	// P&L
	r.With(access).Get("/pnl", finPnL(db))

	// Budget
	r.With(access).Get("/budget",  finBudgetList(db))
	r.With(access).Post("/budget", finBudgetCreate(db))

	// Cost entries
	r.With(access).Get("/costs",  finCostsList(db))
	r.With(access).Post("/costs", finCostsCreate(db))

	// Treasury (derived from EOD + FD positions)
	r.With(access).Get("/treasury", finTreasury(db))

	// FD Accrual (per-FD daily interest)
	r.With(access).Get("/fd-accrual", finFDAccrual(db))

	// Income ledger (sourced from card cycle data)
	r.With(access).Get("/income",            finIncomeList(db))
	r.With(access).Get("/income/chart",      finIncomeChart(db))
	r.With(access).Get("/income/loans",      finIncomeLoans(db))
	r.With(access).Get("/income/fee-types",  finIncomeFeeTypes(db))
	r.With(access).Get("/income/summary",    finIncomeSummary(db))
}

/* ── GL Accounts ─────────────────────────────────────────────────────────── */

func finGLList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		class := qstr(r, "class")
		where := "1=1"
		var args []any
		n := 1
		if class != "" {
			where += fmt.Sprintf(" AND class=$%d", n)
			args = append(args, class)
			n++
		}
		if qstr(r, "active") == "true" {
			where += " AND is_active=TRUE"
		}
		_ = n
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT * FROM gl_accounts WHERE %s ORDER BY code ASC`, where), args...)
		if err != nil {
			respondErr(w, 500, "GL accounts query failed")
			return
		}
		jsonRows(w, rows)
	}
}

func finGLCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Code          string `json:"code"`
			Name          string `json:"name"`
			Class         string `json:"class"`
			NormalBalance string `json:"normal_balance"`
			Currency      string `json:"currency"`
			ParentID      *int64 `json:"parent_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Code == "" || b.Name == "" || b.Class == "" {
			respondErr(w, 422, "code, name and class are required")
			return
		}
		if b.NormalBalance == "" {
			b.NormalBalance = "Dr"
		}
		if b.Currency == "" {
			b.Currency = "NGN"
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO gl_accounts (code, name, class, normal_balance, currency, parent_id, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			RETURNING *`,
			b.Code, b.Name, b.Class, b.NormalBalance, b.Currency, b.ParentID, user.ID)
		if err != nil {
			if strings.Contains(err.Error(), "unique") {
				respondErr(w, 409, "Account code already exists")
				return
			}
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func finGLUpdate(db *core.DB) http.HandlerFunc {
	allowed := []string{"name", "class", "normal_balance", "currency", "parent_id", "is_active"}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		parts, args := buildSet(body, allowed, 1)
		if len(parts) == 0 {
			respondErr(w, 422, "No updatable fields")
			return
		}
		parts = append(parts, "updated_at=NOW()")
		args = append(args, id)
		rows, err := db.PGQuery(r.Context(),
			fmt.Sprintf("UPDATE gl_accounts SET %s WHERE id=$%d RETURNING *",
				strings.Join(parts, ","), len(args)), args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Account not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Manual Postings ─────────────────────────────────────────────────────── */

func finPostingsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		where := "1=1"
		var args []any
		n := 1
		if status != "" {
			where += fmt.Sprintf(" AND status=$%d", n)
			args = append(args, status)
			n++
		}
		limit := qint(r, "limit", 100, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)
		_ = n

		countRows, _ := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS total FROM manual_postings WHERE %s`, where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		args2 := append(args, limit, offset)
		n2 := len(args) + 1
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT mp.*,
			        u1.full_name AS initiated_by_name,
			        u2.full_name AS approved_by_name
			 FROM manual_postings mp
			 LEFT JOIN o3c_users u1 ON u1.id=mp.initiated_by
			 LEFT JOIN o3c_users u2 ON u2.id=mp.approved_by
			 WHERE %s
			 ORDER BY mp.initiated_at DESC
			 LIMIT $%d OFFSET $%d`, where, n2, n2+1), args2...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func finPostingsCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			DrAccount  string `json:"dr_account"`
			CrAccount  string `json:"cr_account"`
			AmountKobo int64  `json:"amount_kobo"`
			Narrative  string `json:"narrative"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.DrAccount == "" || b.CrAccount == "" || b.Narrative == "" {
			respondErr(w, 422, "dr_account, cr_account and narrative are required")
			return
		}
		if b.AmountKobo <= 0 {
			respondErr(w, 422, "amount_kobo must be positive")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO manual_postings
			    (dr_account, cr_account, amount_kobo, narrative, initiated_by)
			VALUES ($1,$2,$3,$4,$5)
			RETURNING *`,
			b.DrAccount, b.CrAccount, b.AmountKobo, b.Narrative, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		NotifyRole(r.Context(), db, "finance_head", NotifPayload{
			EventType: "manual_posting_submitted",
			Title:     "Manual Posting Awaiting Approval",
			Body:      fmt.Sprintf("MP-%v submitted for GL approval — %s", rows[0]["id"], b.Narrative),
			ActionURL: "/finance/manual-postings",
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func finPostingsApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())

		// Fetch posting
		existing, err := db.PGQuery(r.Context(),
			`SELECT * FROM manual_postings WHERE id=$1`, id)
		if err != nil || len(existing) == 0 {
			respondErr(w, 404, "Posting not found")
			return
		}
		if fmt.Sprintf("%v", existing[0]["status"]) != "pending" {
			respondErr(w, 409, "Only pending postings can be approved")
			return
		}

		// Approve and post GL journal entry
		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, "Transaction failed")
			return
		}
		_, err = tx.ExecContext(r.Context(), `
			UPDATE manual_postings
			SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
			WHERE id=$2`, user.ID, id)
		if err != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "Approve failed")
			return
		}
		// Post GL journal
		p := existing[0]
		glErr := postJournalTx(r.Context(), tx, glEntry{
			Description:   fmt.Sprintf("%v", p["narrative"]),
			Reference:     fmt.Sprintf("MP-%v", id),
			DebitAccount:  fmt.Sprintf("%v", p["dr_account"]),
			CreditAccount: fmt.Sprintf("%v", p["cr_account"]),
			AmountKobo:    toInt64(p["amount_kobo"]),
			SourceType:    "manual_posting",
			SourceID:      toInt64(p["id"]),
			PostedBy:      user.ID,
		})
		if glErr != nil {
			tx.Rollback() //nolint:errcheck
			respondErr(w, 500, "GL journal failed")
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		// Notify the initiator that their posting has been approved and posted.
		Notify(r.Context(), db, NotifPayload{
			EventType: "manual_posting_approved",
			UserID:    toInt64(p["initiated_by"]),
			Title:     "Manual Posting Approved",
			Body:      fmt.Sprintf("MP-%v has been approved and posted to the GL", id),
			ActionURL: "/finance/manual-postings",
		})
		rows, _ := db.PGQuery(r.Context(), `SELECT * FROM manual_postings WHERE id=$1`, id)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func finPostingsReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Reason string `json:"reason"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		rows, err := db.PGQuery(r.Context(), `
			UPDATE manual_postings
			SET status='rejected', approved_by=$1, approved_at=NOW(),
			    rejection_reason=$2, updated_at=NOW()
			WHERE id=$3 AND status='pending'
			RETURNING *`, user.ID, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Posting not found or already actioned")
			return
		}
		// Notify the initiator that their posting has been rejected.
		Notify(r.Context(), db, NotifPayload{
			EventType: "manual_posting_rejected",
			UserID:    toInt64(rows[0]["initiated_by"]),
			Title:     "Manual Posting Rejected",
			Body:      fmt.Sprintf("MP-%v was rejected. Reason: %s", id, b.Reason),
			ActionURL: "/finance/manual-postings",
		})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── P&L ─────────────────────────────────────────────────────────────────── */

func finPnL(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateFrom, _ := validDate(r, "from")
		dateTo, _   := validDate(r, "to")
		product     := qstr(r, "product")

		where := "1=1"
		var args []any
		n := 1
		if dateFrom != "" {
			where += fmt.Sprintf(" AND txn_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND txn_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		if product != "" {
			where += fmt.Sprintf(" AND product_name ILIKE $%d", n)
			args = append(args, "%"+product+"%"); n++
		}
		_ = n

		// Revenue from EOD credits, Cost from EOD debits — approximate P&L from transaction data
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    COALESCE(product_name, 'Other') AS product,
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0) AS revenue,
			    COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS cost,
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0)
			    - COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS net
			FROM eod_transactions
			WHERE %s
			GROUP BY COALESCE(product_name, 'Other')
			ORDER BY revenue DESC`, where), args...)
		if err != nil {
			// eod_transactions may not exist yet — return empty stub
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"lines":          []any{},
				"total_revenue":  0,
				"total_cost":     0,
				"net_income":     0,
				"data_available": false,
			})
			return
		}

		totRev, totCost := int64(0), int64(0)
		for _, row := range rows {
			totRev += toInt64(row["revenue"])
			totCost += toInt64(row["cost"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"lines":          rows,
			"total_revenue":  totRev,
			"total_cost":     totCost,
			"net_income":     totRev - totCost,
			"data_available": true,
		})
	}
}

/* ── Budget ──────────────────────────────────────────────────────────────── */

func finBudgetList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		period := qstr(r, "period")
		where := "1=1"
		var args []any
		n := 1
		if period != "" {
			where += fmt.Sprintf(" AND period=$%d", n); args = append(args, period); n++
		}
		_ = n

		// Budget lines joined with actual spend from cost_entries.
		// LATERAL is required because the subquery references bl.period from the outer row.
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT bl.*,
			    COALESCE(ce.actual, 0) AS actual_amount
			FROM budget_lines bl
			LEFT JOIN LATERAL (
			    SELECT department AS cost_centre, category,
			           SUM(amount_kobo) AS actual
			    FROM cost_entries
			    WHERE entry_date::text LIKE CONCAT(bl.period, '%%')
			    GROUP BY department, category
			) ce ON ce.cost_centre=bl.cost_centre AND ce.category=bl.category
			WHERE %s ORDER BY bl.cost_centre, bl.category`, where), args...)
		if err != nil {
			// Fallback: return budget lines without actuals
			rows, err = db.PGQuery(r.Context(), fmt.Sprintf(
				`SELECT *, 0 AS actual_amount FROM budget_lines WHERE %s ORDER BY cost_centre, category`, where), args...)
			if err != nil {
				respondErr(w, 500, "Budget query failed")
				return
			}
		}
		jsonRows(w, rows)
	}
}

func finBudgetCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			CostCentre      string `json:"cost_centre"`
			Category        string `json:"category"`
			Period          string `json:"period"`
			BudgetAmount    int64  `json:"budget_amount"`
			CommittedAmount int64  `json:"committed_amount"`
			Notes           string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.CostCentre == "" || b.Category == "" || b.Period == "" {
			respondErr(w, 422, "cost_centre, category and period are required")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO budget_lines
			    (cost_centre, category, period, budget_amount, committed_amount, notes, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (cost_centre, category, period)
			DO UPDATE SET budget_amount=EXCLUDED.budget_amount,
			              committed_amount=EXCLUDED.committed_amount,
			              notes=EXCLUDED.notes,
			              updated_at=NOW()
			RETURNING *`,
			b.CostCentre, b.Category, b.Period, b.BudgetAmount, b.CommittedAmount, b.Notes, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Cost Entries ────────────────────────────────────────────────────────── */

func finCostsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dept     := qstr(r, "department")
		cat      := qstr(r, "category")
		dateFrom, _ := validDate(r, "date_from")
		dateTo, _   := validDate(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if dept != "" {
			where += fmt.Sprintf(" AND department=$%d", n); args = append(args, dept); n++
		}
		if cat != "" {
			where += fmt.Sprintf(" AND category=$%d", n); args = append(args, cat); n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND entry_date >= $%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND entry_date <= $%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		limit  := qint(r, "limit",  200, 1, 1000)
		offset := qint(r, "offset", 0,   0, 1<<30)

		countRows, _ := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS total FROM cost_entries ce WHERE %s`, where), args...)
		total := int64(0)
		if len(countRows) > 0 {
			total = toInt64(countRows[0]["total"])
		}

		args2 := append(args, limit, offset)
		n2 := len(args) + 1
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(
			`SELECT ce.*, u.full_name AS recorded_by_name
			 FROM cost_entries ce
			 LEFT JOIN o3c_users u ON u.id=ce.recorded_by
			 WHERE %s ORDER BY ce.entry_date DESC
			 LIMIT $%d OFFSET $%d`, where, n2, n2+1), args2...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func finCostsCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			EntryDate       string `json:"entry_date"`
			Department      string `json:"department"`
			Category        string `json:"category"`
			Description     string `json:"description"`
			AmountKobo      int64  `json:"amount_kobo"`
			BudgetAmountKobo int64 `json:"budget_amount_kobo"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.EntryDate == "" || b.Department == "" || b.Description == "" {
			respondErr(w, 422, "entry_date, department and description are required")
			return
		}
		if b.AmountKobo <= 0 {
			respondErr(w, 422, "amount_kobo must be positive")
			return
		}
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO cost_entries
			    (entry_date, department, category, description, amount_kobo, budget_amount_kobo, recorded_by)
			VALUES ($1::date,$2,$3,$4,$5,$6,$7)
			RETURNING *`,
			b.EntryDate, b.Department, b.Category, b.Description,
			b.AmountKobo, b.BudgetAmountKobo, user.ID)
		if err != nil {
			respondErr(w, 500, "Create failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

/* ── Treasury ────────────────────────────────────────────────────────────── */

func finTreasury(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// EOD net position as cash proxy
		eodRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0) AS total_cr,
			    COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS total_dr,
			    COALESCE(SUM(amount) FILTER (WHERE sign='CR'), 0)
			    - COALESCE(SUM(amount) FILTER (WHERE sign='DR'), 0) AS net_position
			FROM eod_transactions
			WHERE txn_date >= CURRENT_DATE - INTERVAL '30 days'`)

		// FD outstanding as liability
		fdRows, _ := db.PGQuery(r.Context(), `
			SELECT
			    COALESCE(SUM(ngn_amount)   FILTER (WHERE transaction_type='inflow'), 0)      AS fd_liabilities,
			    COALESCE(SUM(gross_amount) FILTER (WHERE transaction_type='liquidation'), 0) AS fd_paid_out,
			    COUNT(*)                   FILTER (WHERE transaction_type='inflow')           AS active_fds
			FROM fd_transactions`)

		cashPos, fdLiab := int64(0), int64(0)
		if len(eodRows) > 0 {
			cashPos = toInt64(eodRows[0]["net_position"])
		}
		if len(fdRows) > 0 {
			fdLiab = toInt64(fdRows[0]["fd_liabilities"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"cash_position":  cashPos,
			"fd_liabilities": fdLiab,
			"net_liquidity":  cashPos - fdLiab,
			"eod_summary":    eodRows,
			"fd_summary":     fdRows,
		})
	}
}

/* ── FD Accrual ──────────────────────────────────────────────────────────── */

func finFDAccrual(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		asOf, _ := validDate(r, "date")
		if asOf == "" {
			asOf = "CURRENT_DATE"
		} else {
			asOf = fmt.Sprintf("'%s'::date", asOf)
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			    id,
			    customer_name,
			    ngn_amount AS principal,
			    rate,
			    transaction_date AS start_date,
			    maturity_date,
			    tenor_days,
			    GREATEST(0, %s - transaction_date::date) AS days_elapsed,
			    ROUND(
			        (ngn_amount::numeric * rate / 100 / 365)
			        * GREATEST(0, %s - transaction_date::date)
			    )::bigint AS accrued_interest_kobo,
			    ROUND(
			        ngn_amount::numeric * rate / 100 / 365
			    )::bigint AS daily_interest_kobo
			FROM fd_transactions
			WHERE transaction_type='inflow'
			  AND maturity_date >= CURRENT_DATE
			  AND ngn_amount IS NOT NULL AND ngn_amount > 0
			ORDER BY accrued_interest_kobo DESC`, asOf, asOf))
		if err != nil {
			respondErr(w, 500, "FD accrual query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── Income ledger ────────────────────────────────────────────────────────────
   Flattens card_cycle_data into income line items per product per cycle.
   Each row: date, source (product name), type (Interest/Fees/Penalty), amount_kobo, ref.
   Filters: type, date_from, date_to.
*/

func finIncomeList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		typeFilter := qstr(r, "type")
		dateFrom   := qstr(r, "date_from")
		dateTo     := qstr(r, "date_to")
		limit      := qint(r, "limit", 200, 1, 1000)
		offset     := qint(r, "offset", 0, 0, 1<<30)

		dateWhere := "1=1"
		var dateArgs []any
		n := 1
		if dateFrom != "" {
			dateWhere += fmt.Sprintf(" AND d.cycle_date >= $%d::date", n)
			dateArgs = append(dateArgs, dateFrom); n++
		}
		if dateTo != "" {
			dateWhere += fmt.Sprintf(" AND d.cycle_date <= $%d::date", n)
			dateArgs = append(dateArgs, dateTo); n++
		}

		buildPart := func(incomeType, col string) string {
			return fmt.Sprintf(`
			SELECT
			  d.cycle_date                              AS date,
			  COALESCE(p.product_name, d.product_code) AS source,
			  '%s'                                      AS type,
			  SUM(d.%s)                                 AS amount_kobo,
			  d.product_code                            AS ref
			FROM card_cycle_data d
			LEFT JOIN card_products p ON p.product_code = d.product_code
			WHERE %s AND d.%s > 0
			GROUP BY d.cycle_date, p.product_name, d.product_code`, incomeType, col, dateWhere, col)
		}

		allTypes := []struct{ label, col string }{
			{"Interest", "interest_charged_kobo"},
			{"Fees",     "fees_kobo"},
			{"Penalty",  "penalty_kobo"},
		}

		var parts []string
		var partCount int
		for _, t := range allTypes {
			if typeFilter == "" || typeFilter == t.label {
				parts = append(parts, buildPart(t.label, t.col))
				partCount++
			}
		}

		// PostgreSQL $N placeholders are global to the whole query — each $1 in every
		// UNION branch refers to the same first argument. Do NOT duplicate dateArgs.
		args := make([]any, 0, len(dateArgs)+2)
		args = append(args, dateArgs...)
		args = append(args, limit, offset)

		finalSQL := fmt.Sprintf(`
			SELECT * FROM (%s) inc
			ORDER BY date DESC, amount_kobo DESC
			LIMIT $%d OFFSET $%d`, strings.Join(parts, " UNION ALL "), n, n+1)

		rows, err := db.PGQuery(r.Context(), finalSQL, args...)
		if err != nil {
			respondErr(w, 500, "income query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── Income chart ─────────────────────────────────────────────────────────────
   Returns income by type comparing the two most recent cycle dates.
   Response: [{ type, current, previous }]
*/

func finIncomeChart(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dateRows, err := db.PGQuery(r.Context(),
			`SELECT DISTINCT TO_CHAR(cycle_date,'YYYY-MM-DD') AS d FROM card_cycle_data ORDER BY d DESC LIMIT 2`)
		if err != nil || len(dateRows) == 0 {
			respond(w, []map[string]any{}, "pg")
			return
		}
		current  := fmt.Sprintf("%v", dateRows[0]["d"])
		previous := ""
		if len(dateRows) > 1 {
			previous = fmt.Sprintf("%v", dateRows[1]["d"])
		}

		type chartRow struct {
			Type     string `json:"type"`
			Current  int64  `json:"current"`
			Previous int64  `json:"previous"`
		}

		types := []struct{ label, col string }{
			{"Interest", "interest_charged_kobo"},
			{"Fees",     "fees_kobo"},
			{"Penalty",  "penalty_kobo"},
		}

		out := make([]chartRow, len(types))
		for i, t := range types {
			curRows, _ := db.PGQuery(r.Context(),
				fmt.Sprintf(`SELECT COALESCE(SUM(%s),0) AS v FROM card_cycle_data WHERE cycle_date=$1::date`, t.col),
				current)
			out[i].Type = t.label
			if len(curRows) > 0 {
				out[i].Current = toInt64(curRows[0]["v"])
			}
			if previous != "" {
				prevRows, _ := db.PGQuery(r.Context(),
					fmt.Sprintf(`SELECT COALESCE(SUM(%s),0) AS v FROM card_cycle_data WHERE cycle_date=$1::date`, t.col),
					previous)
				if len(prevRows) > 0 {
					out[i].Previous = toInt64(prevRows[0]["v"])
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	}
}

/* ── Income summary (KPIs) ────────────────────────────────────────────────────
   Returns headline totals for the most recent cycle:
   card_interest, card_fees, card_penalty, loan_interest, fee_type_income.
*/

func finIncomeSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cycleDate := qstr(r, "cycle_date")

		// Default to most recent cycle
		if cycleDate == "" {
			rows, _ := db.PGQuery(r.Context(),
				`SELECT TO_CHAR(cycle_date,'YYYY-MM-DD') AS d FROM card_cycle_data ORDER BY cycle_date DESC LIMIT 1`)
			if len(rows) > 0 {
				cycleDate = fmt.Sprintf("%v", rows[0]["d"])
			}
		}

		// Per-currency card totals — exact values, no rounding
		cardQ := `
			SELECT
			  currency,
			  COALESCE(SUM(interest_charged_kobo),   0)::BIGINT AS card_interest,
			  COALESCE(SUM(fees_kobo),               0)::BIGINT AS card_fees,
			  COALESCE(SUM(penalty_kobo),            0)::BIGINT AS card_penalty,
			  COALESCE(SUM(outstanding_balance_kobo),0)::BIGINT AS card_outstanding,
			  COALESCE(SUM(billed_balance_kobo),     0)::BIGINT AS card_billed,
			  COALESCE(SUM(credit_limit_kobo),       0)::BIGINT AS card_credit_limit,
			  COALESCE(SUM(purchase_amount_kobo),    0)::BIGINT AS card_purchases,
			  COALESCE(SUM(cash_advance_kobo),       0)::BIGINT AS card_cash_advance,
			  COUNT(*)::BIGINT                                   AS card_accounts
			FROM card_cycle_data
			WHERE cycle_date = $1::date
			GROUP BY currency`

		cardRows, err := db.PGQuery(r.Context(), cardQ, cycleDate)
		if err != nil {
			respondErr(w, 500, "summary query failed")
			return
		}

		loanRows, _ := db.PGQuery(r.Context(), `
			SELECT
			  COALESCE(SUM(disbursed_amount_kobo), 0)::BIGINT AS total_disbursed_kobo,
			  COUNT(*) FILTER (WHERE disbursed_at IS NOT NULL)::BIGINT AS active_loans
			FROM loan_applications
			WHERE status IN ('disbursed','active')`)

		feeRows, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(SUM(amount_kobo), 0)::BIGINT AS fee_type_income_kobo
			FROM fee_income`)

		// Flatten by currency suffix: _ngn / _usd
		summary := map[string]any{"cycle_date": cycleDate}
		for _, cr := range cardRows {
			sfx := "_" + strings.ToLower(fmt.Sprintf("%v", cr["currency"]))
			summary["card_interest"+sfx]    = toInt64(cr["card_interest"])
			summary["card_fees"+sfx]        = toInt64(cr["card_fees"])
			summary["card_penalty"+sfx]     = toInt64(cr["card_penalty"])
			summary["card_outstanding"+sfx] = toInt64(cr["card_outstanding"])
			summary["card_billed"+sfx]      = toInt64(cr["card_billed"])
			summary["card_credit_limit"+sfx]= toInt64(cr["card_credit_limit"])
			summary["card_purchases"+sfx]   = toInt64(cr["card_purchases"])
			summary["card_cash_advance"+sfx]= toInt64(cr["card_cash_advance"])
			summary["card_accounts"+sfx]    = toInt64(cr["card_accounts"])
		}
		// Ensure NGN and USD keys always present so frontend never gets undefined
		for _, sfx := range []string{"_ngn", "_usd"} {
			for _, k := range []string{"card_interest","card_fees","card_penalty",
				"card_outstanding","card_billed","card_credit_limit",
				"card_purchases","card_cash_advance","card_accounts"} {
				if _, ok := summary[k+sfx]; !ok {
					summary[k+sfx] = int64(0)
				}
			}
		}

		summary["loan_disbursed_kobo"]  = int64(0)
		summary["active_loans"]         = int64(0)
		summary["fee_type_income_kobo"] = int64(0)
		if len(loanRows) > 0 {
			summary["loan_disbursed_kobo"] = toInt64(loanRows[0]["total_disbursed_kobo"])
			summary["active_loans"]        = toInt64(loanRows[0]["active_loans"])
		}
		if len(feeRows) > 0 {
			summary["fee_type_income_kobo"] = toInt64(feeRows[0]["fee_type_income_kobo"])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(summary) //nolint:errcheck
	}
}

/* ── Income — loans ───────────────────────────────────────────────────────────
   Returns disbursed loans with rate and estimated interest earned to date.
*/

func finIncomeLoans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit  := qint(r, "limit",  100, 1, 500)
		offset := qint(r, "offset", 0,   0, 1<<30)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  id,
			  reference                                                        AS loan_ref,
			  applicant_name,
			  loan_product                                                     AS product,
			  disbursed_amount_kobo,
			  interest_rate_bps,
			  ROUND(interest_rate_bps::numeric / 100, 2)                      AS rate_pct,
			  TO_CHAR(disbursed_at, 'YYYY-MM-DD')                             AS disbursed_at,
			  TO_CHAR(maturity_date, 'YYYY-MM-DD')                            AS maturity_date,
			  status,
			  CASE
			    WHEN maturity_date IS NOT NULL AND maturity_date::date < CURRENT_DATE
			      THEN (maturity_date::date - disbursed_at::date)
			    ELSE GREATEST(CURRENT_DATE - disbursed_at::date, 0)
			  END                                                              AS days_active,
			  ROUND(
			    disbursed_amount_kobo::numeric
			    * (interest_rate_bps::numeric / 10000)
			    * CASE
			        WHEN maturity_date IS NOT NULL AND maturity_date::date < CURRENT_DATE
			          THEN (maturity_date::date - disbursed_at::date)
			        ELSE GREATEST(CURRENT_DATE - disbursed_at::date, 0)
			      END / 365
			  )::bigint                                                        AS interest_earned_kobo,
			  CASE
			    WHEN maturity_date IS NULL THEN 'Unknown'
			    WHEN maturity_date::date < CURRENT_DATE THEN 'Matured'
			    WHEN maturity_date::date <= CURRENT_DATE + INTERVAL '30 days' THEN 'Maturing Soon'
			    ELSE 'Active'
			  END                                                              AS maturity_status
			FROM loan_applications
			WHERE disbursed_at IS NOT NULL
			ORDER BY disbursed_at DESC
			LIMIT $1 OFFSET $2`, ), limit, offset)
		if err != nil {
			respondErr(w, 500, "loan income query failed: "+err.Error())
			return
		}
		jsonRows(w, rows)
	}
}

/* ── Income — fee types ───────────────────────────────────────────────────────
   Returns fee income grouped by fee_type and date from the fee_income table.
   Table is empty until a fee-type-level report is connected.
*/

func finIncomeFeeTypes(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		feeType  := qstr(r, "fee_type")
		dateFrom := qstr(r, "date_from")
		dateTo   := qstr(r, "date_to")

		where := "1=1"
		var args []any
		n := 1
		if feeType != "" {
			where += fmt.Sprintf(" AND fee_type=$%d", n); args = append(args, feeType); n++
		}
		if dateFrom != "" {
			where += fmt.Sprintf(" AND fee_date>=$%d::date", n); args = append(args, dateFrom); n++
		}
		if dateTo != "" {
			where += fmt.Sprintf(" AND fee_date<=$%d::date", n); args = append(args, dateTo); n++
		}
		_ = n

		// Summary by fee type
		summaryRows, _ := db.PGQuery(r.Context(), `
			SELECT fee_type,
			  COUNT(*)           AS count,
			  SUM(amount_kobo)   AS total_kobo
			FROM fee_income
			GROUP BY fee_type
			ORDER BY total_kobo DESC`)

		// Detail rows
		detailRows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT
			  TO_CHAR(fee_date,'YYYY-MM-DD') AS fee_date,
			  fee_type,
			  product_code,
			  COALESCE(p.product_name, fi.product_code) AS product_name,
			  SUM(fi.amount_kobo) AS amount_kobo,
			  fi.currency
			FROM fee_income fi
			LEFT JOIN card_products p ON p.product_code = fi.product_code
			WHERE %s
			GROUP BY fee_date, fee_type, fi.product_code, p.product_name, fi.currency
			ORDER BY fee_date DESC, amount_kobo DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "fee types query failed: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary": summaryRows,
			"detail":  detailRows,
		})
	}
}
