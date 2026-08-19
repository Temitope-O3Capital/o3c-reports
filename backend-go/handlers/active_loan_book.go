package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterActiveLoanBook(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("active_loan_book"))
	r.Get("/", albList(db))
	r.Get("/stats", albStats(db))
	r.Get("/{id}", albGet(db))
	r.Patch("/{id}", albUpdate(db))
	r.Post("/{id}/repayment", albRecordRepayment(db))
}

// The active loan book is the LIVE Udara/CBS credit book (app owns no origination).
// The "active" book is every open loan (status NOT IN Closed/Revoked). Customer
// name/phone come from the Sage master by CIF (cbs_customer_id == cif), falling
// back to the CBS record's name.
const cbsLoanName = `COALESCE((SELECT NULLIF(trim(a.first_name||' '||COALESCE(a.last_name,'')),'')
	         FROM app.customers a WHERE a.cif = cl.cbs_customer_id LIMIT 1), cl.raw->>'name')`

// DPD is derived from the rebuilt amortisation schedule, NOT from days past final
// maturity. The old proxy scored a loan four instalments in arrears as "Current"
// until its maturity date passed — it reported PAR30 at 12% when the real figure
// was 48%, and hid all six loans CBS had flagged 'Defaulting'. See migration
// 151_real_dpd_and_sectors.sql for the derivation and its validation.
//
// The `cl.`-qualified forms are for queries that alias cbs_loans as cl; the Bare
// forms are for queries that select from cbs_loans unaliased.
const cbsLoanDPD = `app.cbs_loan_dpd(cl.status, cl.start_date, cl.maturity_date,
	         cl.first_installment_date, cl.loan_amount_kobo, cl.outstanding_principal_kobo)`
const cbsLoanArrears = `app.cbs_loan_arrears_kobo(cl.start_date, cl.maturity_date,
	         cl.first_installment_date, cl.loan_amount_kobo, cl.outstanding_principal_kobo)`
const cbsLoanBand = `app.cbs_risk_band_dpd(cl.status, ` + cbsLoanDPD + `)`
const cbsLoanScore = `app.cbs_risk_score_dpd(cl.status, ` + cbsLoanDPD + `)`

const cbsLoanDPDBare = `app.cbs_loan_dpd(status, start_date, maturity_date,
	         first_installment_date, loan_amount_kobo, outstanding_principal_kobo)`
const cbsLoanArrearsBare = `app.cbs_loan_arrears_kobo(start_date, maturity_date,
	         first_installment_date, loan_amount_kobo, outstanding_principal_kobo)`
const cbsLoanBandBare = `app.cbs_risk_band_dpd(status, ` + cbsLoanDPDBare + `)`
const cbsLoanScoreBare = `app.cbs_risk_score_dpd(status, ` + cbsLoanDPDBare + `)`

func albList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dpd := qstr(r, "dpd_bucket") // current, 1-30, 31-60, 61-90, 90plus
		product := qstr(r, "product")
		search := qstr(r, "search")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT * FROM (
		      SELECT cl.cbs_id AS id, cl.cbs_account_number AS reference,
		             cl.cbs_customer_id AS applicant_cif, ` + cbsLoanName + ` AS applicant_name,
		             (SELECT a.phone FROM app.customers a WHERE a.cif = cl.cbs_customer_id LIMIT 1) AS applicant_phone,
		             cl.product_name AS product_type, cl.product_name AS loan_product,
		             cl.loan_amount_kobo AS amount_approved_kobo, cl.loan_amount_kobo AS disbursed_amount_kobo,
		             cl.outstanding_principal_kobo AS outstanding_kobo, ` + cbsLoanDPD + ` AS dpd,
		             cl.maturity_date AS next_due_date, cl.installment_amount_kobo AS monthly_repayment_kobo,
		             cl.maturity_date, cl.start_date AS disbursed_at, cl.start_date AS created_at,
		             cl.date_booked, cl.first_installment_date,
		             cl.collateral_type, cl.collateral_description, cl.collateral_valuation_kobo,
		             cl.ledger_balance_kobo, cl.interest_frequency, cl.lending_model,
		             cl.officer_name, cl.status
		      FROM cbs_loans cl
		      WHERE cl.status NOT IN ('Closed','Revoked')
		      ) x WHERE 1=1`
		var args []any
		n := 1

		switch dpd {
		case "current":
			q += " AND dpd = 0"
		case "1-30":
			q += " AND dpd BETWEEN 1 AND 30"
		case "31-60":
			q += " AND dpd BETWEEN 31 AND 60"
		case "61-90":
			q += " AND dpd BETWEEN 61 AND 90"
		case "90plus":
			q += " AND dpd > 90"
		}

		if product != "" {
			q += fmt.Sprintf(" AND product_type=$%d", n)
			args = append(args, product)
			n++
		}
		if search != "" {
			if clause, sargs, nn := buildCustomerSearch(search,
				[]string{"applicant_name", "applicant_cif", "reference"}, "", n); clause != "" {
				q += " AND " + clause
				args = append(args, sargs...)
				n = nn
			}
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY dpd DESC NULLS LAST, disbursed_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func albStats(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats, _ := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*)                                               AS total_loans,
			  COALESCE(SUM(outstanding_principal_kobo), 0)          AS total_outstanding_kobo,
			  COALESCE(SUM(loan_amount_kobo), 0)                    AS total_disbursed_kobo,
			  COUNT(*) FILTER (WHERE dpd = 0)                       AS current_count,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 1 AND 30)          AS dpd_1_30,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 31 AND 60)         AS dpd_31_60,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 61 AND 90)         AS dpd_61_90,
			  COUNT(*) FILTER (WHERE dpd > 90)                      AS dpd_90plus,
			  COALESCE(SUM(outstanding_principal_kobo) FILTER (WHERE dpd > 0), 0) AS npl_outstanding_kobo
			FROM (SELECT outstanding_principal_kobo, loan_amount_kobo,
			             `+cbsLoanDPDBare+` AS dpd
			      FROM cbs_loans WHERE status NOT IN ('Closed','Revoked')) x`)

		byProduct, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(NULLIF(product_name,''), 'Other') AS product,
			       COUNT(*) AS count,
			       COALESCE(SUM(outstanding_principal_kobo), 0) AS outstanding_kobo
			FROM cbs_loans
			WHERE status NOT IN ('Closed','Revoked')
			GROUP BY product_name
			ORDER BY outstanding_kobo DESC`)

		statsRow := map[string]any{}
		if len(stats) > 0 {
			statsRow = stats[0]
		}
		if byProduct == nil {
			byProduct = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"summary":    statsRow,
			"by_product": byProduct,
		})
	}
}

func albGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT cl.cbs_id AS id, cl.cbs_account_number AS reference,
			       cl.cbs_customer_id AS applicant_cif, `+cbsLoanName+` AS applicant_name,
			       (SELECT a.phone FROM app.customers a WHERE a.cif = cl.cbs_customer_id LIMIT 1) AS applicant_phone,
			       cl.product_name AS product_type, cl.product_name AS loan_product,
			       cl.loan_amount_kobo AS amount_approved_kobo, cl.loan_amount_kobo AS disbursed_amount_kobo,
			       cl.outstanding_principal_kobo AS outstanding_kobo,
			       cl.outstanding_interest_kobo, cl.outstanding_fee_kobo,
			       `+cbsLoanDPD+` AS dpd, cl.maturity_date AS next_due_date,
			       cl.interest_rate, cl.tenor_days, cl.maturity_date,
			       cl.start_date AS disbursed_at, cl.start_date AS created_at,
			       cl.date_booked, cl.first_installment_date,
			       cl.collateral_type, cl.collateral_description, cl.collateral_valuation_kobo,
			       cl.ledger_balance_kobo, cl.interest_frequency, cl.lending_model,
			       cl.status, cl.officer_name
			FROM cbs_loans cl
			WHERE cl.cbs_id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Active loan not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func albRecordRepayment(db *core.DB) http.HandlerFunc {
	type body struct {
		AmountKobo  int64  `json:"amount_kobo"`
		PaymentDate string `json:"payment_date"`
		Reference   string `json:"reference"`
		Channel     string `json:"channel"`
		Notes       string `json:"notes"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())

		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.AmountKobo <= 0 {
			respondErr(w, 422, "amount_kobo must be greater than zero")
			return
		}
		payDate := b.PaymentDate
		if payDate == "" {
			payDate = time.Now().Format("2006-01-02")
		}
		channel := b.Channel
		if channel == "" {
			channel = "manual"
		}

		// Read current outstanding balance
		rows, err := db.PGQuery(r.Context(), `SELECT outstanding_kobo FROM loan_applications WHERE id=$1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Loan not found")
			return
		}
		outstanding := toInt64(rows[0]["outstanding_kobo"])
		newOutstanding := outstanding - b.AmountKobo
		if newOutstanding < 0 {
			newOutstanding = 0
		}

		tx, err := db.PG.BeginTx(r.Context(), nil)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var repaymentID int64
		err = tx.QueryRowContext(r.Context(), `
			INSERT INTO loan_repayments (loan_id, amount_kobo, payment_date, reference, channel, notes, recorded_by)
			VALUES ($1, $2, $3::date, $4, $5, $6, $7)
			RETURNING id`,
			id, b.AmountKobo, payDate, b.Reference, channel, b.Notes, user.ID).Scan(&repaymentID)
		if err != nil {
			respondErr(w, 500, "Failed to record repayment: "+err.Error())
			return
		}

		_, err = tx.ExecContext(r.Context(), `
			UPDATE loan_applications SET outstanding_kobo=$1, updated_at=NOW() WHERE id=$2`,
			newOutstanding, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		if err = postJournalTx(r.Context(), tx, glEntry{
			Date:          time.Now(),
			Description:   fmt.Sprintf("Loan %s repayment", id),
			Reference:     b.Reference,
			DebitAccount:  "1001",
			CreditAccount: "1100",
			AmountKobo:    b.AmountKobo,
			SourceType:    "loan_repayment",
			PostedBy:      user.ID,
		}); err != nil {
			respondErr(w, 500, "GL journal failed: "+err.Error())
			return
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"id":               repaymentID,
			"outstanding_kobo": newOutstanding,
		})
	}
}

func albUpdate(db *core.DB) http.HandlerFunc {
	type body struct {
		OutstandingKobo      *int64  `json:"outstanding_kobo"`
		DPD                  *int    `json:"dpd"`
		NextDueDate          *string `json:"next_due_date"`
		DisbursedAmountKobo  *int64  `json:"disbursed_amount_kobo"`
		MaturityDate         *string `json:"maturity_date"`
		MonthlyRepaymentKobo *int64  `json:"monthly_repayment_kobo"`
		LoanProduct          *string `json:"loan_product"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}

		q := `UPDATE loan_applications SET updated_at=NOW()`
		var args []any
		n := 1
		add := func(col string, v any) {
			q += fmt.Sprintf(", %s=$%d", col, n)
			args = append(args, v)
			n++
		}
		if b.OutstandingKobo != nil {
			add("outstanding_kobo", *b.OutstandingKobo)
		}
		if b.DPD != nil {
			add("dpd", *b.DPD)
		}
		if b.NextDueDate != nil {
			add("next_due_date", *b.NextDueDate)
		}
		if b.DisbursedAmountKobo != nil {
			add("disbursed_amount_kobo", *b.DisbursedAmountKobo)
		}
		if b.MaturityDate != nil {
			add("maturity_date", *b.MaturityDate)
		}
		if b.MonthlyRepaymentKobo != nil {
			add("monthly_repayment_kobo", *b.MonthlyRepaymentKobo)
		}
		if b.LoanProduct != nil {
			add("loan_product", *b.LoanProduct)
		}
		args = append(args, id)
		q += fmt.Sprintf(" WHERE id=$%d RETURNING *", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Loan not found")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}
