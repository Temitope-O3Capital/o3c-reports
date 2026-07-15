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

func albList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		dpd := qstr(r, "dpd_bucket")   // current, 1-30, 31-60, 61-90, 90plus
		product := qstr(r, "product")
		search := qstr(r, "search")
		limit := qint(r, "limit", 100, 1, 500)

		q := `SELECT la.id, la.reference, la.applicant_cif, la.applicant_name,
		             la.applicant_phone, la.product_type, la.loan_product,
		             la.amount_approved_kobo, la.disbursed_amount_kobo,
		             la.outstanding_kobo, la.dpd, la.next_due_date,
		             la.monthly_repayment_kobo, la.maturity_date,
		             la.disbursed_at, la.created_at,
		             u.full_name AS officer_name
		      FROM loan_applications la
		      LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
		      WHERE la.disbursed_at IS NOT NULL`
		var args []any
		n := 1

		switch dpd {
		case "current":
			q += " AND (la.dpd IS NULL OR la.dpd = 0)"
		case "1-30":
			q += " AND la.dpd BETWEEN 1 AND 30"
		case "31-60":
			q += " AND la.dpd BETWEEN 31 AND 60"
		case "61-90":
			q += " AND la.dpd BETWEEN 61 AND 90"
		case "90plus":
			q += " AND la.dpd > 90"
		}

		if product != "" {
			q += fmt.Sprintf(" AND la.product_type=$%d", n)
			args = append(args, product)
			n++
		}
		if search != "" {
			q += fmt.Sprintf(" AND (la.applicant_name ILIKE $%d OR la.applicant_cif ILIKE $%d OR la.reference ILIKE $%d)", n, n, n)
			args = append(args, "%"+search+"%")
			n++
		}
		args = append(args, limit)
		q += fmt.Sprintf(" ORDER BY la.dpd DESC NULLS LAST, la.disbursed_at DESC LIMIT $%d", n)

		rows, err := db.PGQuery(r.Context(), q, args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
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
			  COALESCE(SUM(outstanding_kobo), 0)                    AS total_outstanding_kobo,
			  COALESCE(SUM(disbursed_amount_kobo), 0)               AS total_disbursed_kobo,
			  COUNT(*) FILTER (WHERE dpd IS NULL OR dpd = 0)        AS current_count,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 1 AND 30)          AS dpd_1_30,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 31 AND 60)         AS dpd_31_60,
			  COUNT(*) FILTER (WHERE dpd BETWEEN 61 AND 90)         AS dpd_61_90,
			  COUNT(*) FILTER (WHERE dpd > 90)                      AS dpd_90plus,
			  COALESCE(SUM(outstanding_kobo) FILTER (WHERE dpd > 0), 0) AS npl_outstanding_kobo
			FROM loan_applications
			WHERE disbursed_at IS NOT NULL`)

		byProduct, _ := db.PGQuery(r.Context(), `
			SELECT COALESCE(product_type, 'Other') AS product,
			       COUNT(*) AS count,
			       COALESCE(SUM(outstanding_kobo), 0) AS outstanding_kobo
			FROM loan_applications
			WHERE disbursed_at IS NOT NULL
			GROUP BY product_type
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
			SELECT la.*, u.full_name AS officer_name
			FROM loan_applications la
			LEFT JOIN o3c_users u ON u.id = la.assigned_to_user_id
			WHERE la.id=$1 AND la.disbursed_at IS NOT NULL`, id)
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
