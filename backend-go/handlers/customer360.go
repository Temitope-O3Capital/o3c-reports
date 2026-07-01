package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterCustomer360(r chi.Router, db *core.DB) {
	access := core.RequirePages("customer360")
	r.With(access).Get("/search", c360Search(db))
	r.With(access).Get("/{cif}", c360Profile(db))
	r.With(access).Get("/{cif}/transactions", c360Transactions(db))
	r.With(access).Get("/{cif}/loans", c360Loans(db))
	r.With(access).Get("/{cif}/collections", c360Collections(db))
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
		data, src, err := db.DualQuery(r.Context(),
			`SELECT TOP 20 CIF_Number, First_Name, Last_Name, Email, Phone, State
			 FROM dbo.Contact
			 WHERE CIF_Number LIKE @p1 OR First_Name LIKE @p1 OR Last_Name LIKE @p1 OR Phone LIKE @p1
			 ORDER BY CIF_Number`,
			`SELECT "CIF Number", "First Name", "Last Name", "Email", "Phone Number", "State"
			 FROM "Accounts"
			 WHERE "CIF Number" ILIKE $1 OR "First Name" ILIKE $1 OR "Last Name" ILIKE $1
			 ORDER BY "CIF Number"
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
			`SELECT "CIF Number", "First Name", "Last Name", "Email", "Phone Number",
			        "Birthday", "State", "City", "Job Title"
			 FROM "Accounts" WHERE "CIF Number" = $1`,
			cif)

		// Products (MSSQL+PG)
		products, _, _ := db.DualQuery(ctx,
			`SELECT Product_Name, Account_Status, Name_On_Card, Account_Manager
			 FROM dbo.Account WHERE CIF_Number = @p1`,
			`SELECT "Product Name", "Account Status", "Name On Card", "Account Manager"
			 FROM "Products" WHERE "CIF Number" = $1`,
			cif)

		// Recent 20 transactions (MSSQL+PG)
		transactions, txSrc, _ := db.DualQuery(ctx,
			`SELECT TOP 20 Transaction_Date, Amount, Description, Merchant_Name
			 FROM dbo.Transaction_Listing WHERE CIF = @p1 ORDER BY Transaction_Date DESC`,
			`SELECT "Transaction Date", "Amount", "Description", "Merchant_Name"
			 FROM "Transactions" WHERE "CIF Number" = $1
			 ORDER BY "Transaction Date" DESC LIMIT 20`,
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

		profile := map[string]any{
			"account":           firstOrNil(accounts),
			"products":          products,
			"transactions":      transactions,
			"loan_apps":         loanApps,
			"recovery_cases":    recoveryCases,
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
			`SELECT "Transaction Date", "Amount", "Description", "Merchant_Name"
			 FROM "Transactions" WHERE "CIF Number" = $1
			 ORDER BY "Transaction Date" DESC
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
