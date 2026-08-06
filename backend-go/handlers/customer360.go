package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCustomer360(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360")
	r.With(access).Get("/directory", c360Directory(db))
	r.With(access).Get("/search", c360Search(db))
	r.With(access).Get("/{cif}", c360Profile(db))
	r.With(access).Get("/{cif}/transactions", c360Transactions(db))
	r.With(access).Get("/{cif}/loans", c360Loans(db))
	r.With(access).Get("/{cif}/collections", c360Collections(db))
}

// c360Directory lists the canonical customer base from the "Accounts" table
// (the same source c360Profile reads), so directory rows deep-link into Customer
// 360 by CIF. Supports ?q= search and ?state= filter, paginated via limit/offset.
func c360Directory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)
		where := "1=1"
		var args []any
		n := 1
		if q := qstr(r, "q"); q != "" {
			where += fmt.Sprintf(` AND (cif ILIKE $%d OR first_name ILIKE $%d OR last_name ILIKE $%d OR phone ILIKE $%d OR email ILIKE $%d)`, n, n, n, n, n)
			args = append(args, "%"+q+"%")
			n++
		}
		if v := qstr(r, "state"); v != "" {
			where += fmt.Sprintf(` AND state = $%d`, n)
			args = append(args, v)
			n++
		}

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT cif                     AS cif,
			       first_name              AS first_name,
			       last_name               AS last_name,
			       phone                   AS phone,
			       email                   AS email,
			       state                   AS state,
			       city                    AS city,
			       account_created         AS created_at
			FROM app.customers
			WHERE %s
			ORDER BY first_name, last_name
			LIMIT $%d OFFSET $%d`, where, n, n+1), append(args, limit, offset)...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}

		total := 0
		if tr, e := db.PGQuery(r.Context(),
			fmt.Sprintf(`SELECT COUNT(*) AS n FROM app.customers WHERE %s`, where), args...); e == nil && len(tr) > 0 {
			total = int(toInt64(tr[0]["n"]))
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows, "total": total}) //nolint:errcheck
	}
}

func c360Search(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := qstr(r, "q")
		limit := qint(r, "limit", 20, 1, 100)

		if q == "" {
			respond(w, []core.Row{}, "pg")
			return
		}

		like := "%" + q + "%"
		// Return a clean {cif,name,phone,email} shape the C360 search bar consumes
		// (the raw view columns are "CIF Number"/"First Name"/… which the UI can't read).
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TOP 20 CIF_Number AS cif,
			        LTRIM(RTRIM(ISNULL(First_Name,'') + ' ' + ISNULL(Last_Name,''))) AS name,
			        Phone AS phone, Email AS email, State AS state
			 FROM dbo.Contact
			 WHERE CIF_Number LIKE @p1 OR First_Name LIKE @p1 OR Last_Name LIKE @p1 OR Phone LIKE @p1
			 ORDER BY CIF_Number`,
			`SELECT cif AS cif,
			        TRIM(CONCAT(first_name, ' ', last_name)) AS name,
			        phone AS phone, email AS email, state AS state
			 FROM app.customers
			 WHERE cif ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1
			 ORDER BY cif
			 LIMIT $2`,
			like, limit)
		if err != nil {
			respondErr(w, 500, "Search failed")
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, src)
	}
}

func c360Profile(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		ctx := r.Context()

		// Account info (MSSQL+PG)
		accounts, acctSrc, _ := db.DualQuery(ctx,
			`SELECT CIF_Number, First_Name, Last_Name, Email, Phone, Birthday, State, City, Job_Title
			 FROM dbo.Contact WHERE CIF_Number = @p1`,
			`SELECT cif AS "CIF Number", first_name AS "First Name", last_name AS "Last Name", email AS "Email", phone AS "Phone Number",
			        birthday AS "Birthday", state AS "State", city AS "City", job_title AS "Job Title"
			 FROM app.customers WHERE cif = $1`,
			cif)

		// Products (MSSQL+PG)
		products, _, _ := db.DualQuery(ctx,
			`SELECT Product_Name, Account_Status, Name_On_Card, Account_Manager
			 FROM dbo.Account WHERE CIF_Number = @p1`,
			`SELECT product_name AS "Product Name", status AS "Account Status", name_on_card AS "Name On Card", NULL AS "Account Manager"
			 FROM app.accounts WHERE cif = $1`,
			cif)

		// Recent 20 transactions (MSSQL+PG)
		transactions, txSrc, _ := db.DualQuery(ctx,
			`SELECT TOP 20 Transaction_Date, Amount, Description, Merchant_Name
			 FROM dbo.Transaction_Listing WHERE CIF = @p1 ORDER BY Transaction_Date DESC`,
			`SELECT txn_date AS "Transaction Date", amount AS "Amount", description AS "Description", merchant_name AS "Merchant_Name"
			 FROM app.transactions WHERE cif = $1
			 ORDER BY txn_date DESC LIMIT 20`,
			cif)

		// Loan applications (PG only)
		loanApps, _ := db.PGQuery(ctx, `
			SELECT id, reference, product_type, amount_requested_kobo,
			       amount_approved_kobo, status, stage, created_at
			FROM loan_applications WHERE applicant_cif = $1
			ORDER BY created_at DESC`, cif)

		// Recovery cases (PG only)
		recoveryCases, _ := db.PGQuery(ctx, `
			SELECT id, case_ref, status, total_outstanding_kobo, total_recovered_kobo, created_at
			FROM recovery_cases WHERE cif_number = $1
			ORDER BY created_at DESC`, cif)

		// Credit-card position (PG — from the latest imported billing cycle for this CIF).
		// Per-card rows plus a rolled-up summary. Only credit-category products.
		cardCards, _ := db.PGQuery(ctx, `
			SELECT d.account_number, COALESCE(NULLIF(p.product_name,''), d.product_code) AS product,
			       d.outstanding_balance_kobo, d.credit_limit_kobo, d.overdue_amount_kobo,
			       d.minimum_payment_kobo, d.total_interest_kobo,
			       TO_CHAR(d.cycle_date,'YYYY-MM-DD') AS cycle_date,
			       CASE WHEN d.credit_limit_kobo > 0
			            THEN ROUND(d.outstanding_balance_kobo::numeric / d.credit_limit_kobo * 100, 1)
			            ELSE 0 END AS utilization_pct
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category = 'credit'
			WHERE d.cif = $1
			  AND d.cycle_date = (SELECT MAX(cycle_date) FROM card_cycle_data WHERE cif = $1)
			ORDER BY d.outstanding_balance_kobo DESC`, cif)

		cardSummaryRows, _ := db.PGQuery(ctx, `
			SELECT COUNT(*) AS cards,
			       COALESCE(SUM(d.outstanding_balance_kobo),0)::bigint AS outstanding_kobo,
			       COALESCE(SUM(d.credit_limit_kobo),0)::bigint        AS credit_limit_kobo,
			       COALESCE(SUM(d.overdue_amount_kobo),0)::bigint      AS overdue_kobo,
			       COALESCE(SUM(d.minimum_payment_kobo),0)::bigint     AS min_payment_kobo,
			       COALESCE(SUM(d.total_interest_kobo),0)::bigint      AS interest_kobo,
			       TO_CHAR(MAX(d.cycle_date),'YYYY-MM-DD')             AS cycle_date
			FROM card_cycle_data d
			JOIN card_products p ON p.product_code = d.product_code AND p.category = 'credit'
			WHERE d.cif = $1
			  AND d.cycle_date = (SELECT MAX(cycle_date) FROM card_cycle_data WHERE cif = $1)`, cif)

		// Financial summary (PG only — best-effort, nullable)
		summaryRows, _ := db.PGQuery(ctx, `
			SELECT
				(SELECT dpd_bucket FROM collection_assignments WHERE cif_number = $1 ORDER BY updated_at DESC LIMIT 1) AS dpd_bucket,
				(SELECT COALESCE(SUM(total_outstanding_kobo), 0) FROM recovery_cases WHERE cif_number = $1 AND status = 'active') AS recovery_outstanding_kobo,
				(SELECT amount_approved_kobo FROM loan_applications WHERE applicant_cif = $1 AND stage NOT IN ('rejected','cancelled') ORDER BY created_at DESC LIMIT 1) AS loan_approved_kobo
		`, cif)

		if accounts == nil {
			accounts = []core.Row{}
		}
		if products == nil {
			products = []core.Row{}
		}
		if transactions == nil {
			transactions = []core.Row{}
		}
		if loanApps == nil {
			loanApps = []core.Row{}
		}
		if recoveryCases == nil {
			recoveryCases = []core.Row{}
		}
		if cardCards == nil {
			cardCards = []core.Row{}
		}

		profile := map[string]any{
			"account":           firstOrNil(accounts),
			"products":          products,
			"transactions":      transactions,
			"loan_apps":         loanApps,
			"recovery_cases":    recoveryCases,
			"card_position":     firstOrNil(cardSummaryRows), // rolled-up revolving summary (nil if none)
			"card_accounts":     cardCards,                   // per-card latest-cycle rows
			"financial_summary": firstOrNil(summaryRows),
		}

		// Prefer mssql_live if any source is live
		src := acctSrc
		if txSrc == "mssql_live" {
			src = "mssql_live"
		}

		respond(w, profile, src)
	}
}

func c360Transactions(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		limit := qint(r, "limit", 50, 1, 500)
		offset := qint(r, "offset", 0, 0, 1<<30)

		data, src, err := db.DualQuery(r.Context(),
			`SELECT Transaction_Date, Amount, Description, Merchant_Name
			 FROM dbo.Transaction_Listing WHERE CIF = @p1
			 ORDER BY Transaction_Date DESC
			 OFFSET @p2 ROWS FETCH NEXT @p3 ROWS ONLY`,
			`SELECT txn_date AS "Transaction Date", amount AS "Amount", description AS "Description", merchant_name AS "Merchant_Name"
			 FROM app.transactions WHERE cif = $1
			 ORDER BY txn_date DESC
			 LIMIT $2 OFFSET $3`,
			cif, offset, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if data == nil {
			data = []core.Row{}
		}
		respond(w, data, src)
	}
}

func c360Loans(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, reference, product_type, amount_requested_kobo, amount_approved_kobo,
			       tenor_months, interest_rate_bps, status, stage, submitted_at, created_at
			FROM loan_applications WHERE applicant_cif = $1
			ORDER BY created_at DESC`, cif)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

func c360Collections(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := chi.URLParam(r, "cif")
		limit := qint(r, "limit", 50, 1, 200)
		offset := qint(r, "offset", 0, 0, 1<<30)

		rows, err := db.PGQuery(r.Context(), `
			SELECT cc.id, cc.contact_type, cc.outcome, cc.notes,
			       cc.next_action_date, cc.created_at,
			       u.full_name AS agent_name
			FROM collection_contacts cc
			LEFT JOIN o3c_users u ON cc.agent_user_id = u.id
			WHERE cc.cif_number = $1
			ORDER BY cc.created_at DESC
			LIMIT $2 OFFSET $3`, cif, limit, offset)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// firstOrNil returns the first row or nil if empty.
func firstOrNil(rows []core.Row) any {
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
