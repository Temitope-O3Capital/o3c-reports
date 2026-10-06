package handlers

// Manual fee capture: cards (app.fee_income, migration 049/341) and loans
// (app.loan_fee_income, migration 341).
//
// Neither card joining fees nor a loan management/other fee split exists reliably
// anywhere upstream — see migration 341's header for why this has to be a place for
// Finance to record what they know, not a sync job. Maker-checker mirrors
// manual_postings (handlers/settlements_ops.go) exactly: a pending row is excluded from
// every report until approved, so a mistaken entry costs nothing until signed off.

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterFeeIncomeOps wires the manual fee-capture endpoints under /api/finance.
func RegisterFeeIncomeOps(r chi.Router, db *core.DB) {
	access := core.RequirePages("finance")

	r.With(access).Get("/fee-income", feeIncomeList(db))
	r.With(access).Post("/fee-income", feeIncomeCreate(db))
	r.With(access).Put("/fee-income/{id}/approve", feeIncomeApprove(db))
	r.With(access).Put("/fee-income/{id}/reject", feeIncomeReject(db))

	r.With(access).Get("/loan-fee-income", loanFeeIncomeList(db))
	r.With(access).Post("/loan-fee-income", loanFeeIncomeCreate(db))
	r.With(access).Put("/loan-fee-income/{id}/approve", loanFeeIncomeApprove(db))
	r.With(access).Put("/loan-fee-income/{id}/reject", loanFeeIncomeReject(db))
}

var feeIncomeTypes = map[string]bool{
	"membership": true, "reissue": true, "maintenance": true,
	"joining": true, "blink": true, "other": true,
}

func feeIncomeList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "WHERE 1=1"
		var args []any
		n := 1
		if v := qstr(r, "status"); v != "" {
			where += " AND status = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "fee_type"); v != "" {
			where += " AND fee_type = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if from, _ := validDate(r, "date_from"); from != "" {
			where += " AND fee_date >= $" + itoa(n) + "::date"
			args = append(args, from)
			n++
		}
		if to, _ := validDate(r, "date_to"); to != "" {
			where += " AND fee_date <= $" + itoa(n) + "::date"
			args = append(args, to)
			n++
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT id, fee_date, fee_type, product_code, account_number, cif, currency,
			       amount_kobo, ref, status, branch_name, initiated_by, approved_by, approved_at
			  FROM app.fee_income `+where+`
			 ORDER BY fee_date DESC, id DESC LIMIT 500`, args...)
		if err != nil {
			respondErrLog(w, 500, "fee income list failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func feeIncomeCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			FeeDate       string `json:"fee_date"`
			FeeType       string `json:"fee_type"`
			ProductCode   string `json:"product_code"`
			AccountNumber string `json:"account_number"`
			CIF           string `json:"cif"`
			Currency      string `json:"currency"`
			AmountKobo    int64  `json:"amount_kobo"`
			Ref           string `json:"ref"`
			BranchName    string `json:"branch_name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.FeeType = strings.ToLower(strings.TrimSpace(b.FeeType))
		if !feeIncomeTypes[b.FeeType] {
			respondErr(w, 422, "fee_type must be one of: membership, reissue, maintenance, joining, blink, other")
			return
		}
		if b.AccountNumber == "" || b.AmountKobo <= 0 || b.FeeDate == "" {
			respondErr(w, 422, "fee_date, account_number and a positive amount_kobo are required")
			return
		}
		if b.Currency == "" {
			b.Currency = "NGN"
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.fee_income
			    (fee_date, fee_type, product_code, account_number, cif, currency, amount_kobo,
			     ref, branch_name, status, initiated_by)
			VALUES ($1,$2,NULLIF($3,''),$4,NULLIF($5,''),$6,$7,NULLIF($8,''),NULLIF($9,''),'pending',$10)
			ON CONFLICT (fee_date, account_number, fee_type) DO UPDATE SET
			    amount_kobo = EXCLUDED.amount_kobo, ref = EXCLUDED.ref,
			    branch_name = EXCLUDED.branch_name, status = 'pending',
			    initiated_by = EXCLUDED.initiated_by, approved_by = NULL, approved_at = NULL
			RETURNING id, fee_date, fee_type, amount_kobo, status`,
			b.FeeDate, b.FeeType, b.ProductCode, b.AccountNumber, b.CIF, b.Currency, b.AmountKobo,
			b.Ref, b.BranchName, user.ID)
		if err != nil {
			respondErrLog(w, 500, "fee income create failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func feeIncomeApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.fee_income
			   SET status='approved', approved_by=$1, approved_at=NOW()
			 WHERE id=$2 AND status='pending'
			RETURNING id`, user.ID, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Fee entry not found or not pending")
			return
		}
		jsonMsg(w, "approved")
	}
}

func feeIncomeReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct{ Reason string `json:"reason"` }
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.fee_income
			   SET status='rejected', rejected_by=$1, rejection_reason=$2
			 WHERE id=$3 AND status='pending'
			RETURNING id`, user.ID, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Fee entry not found or not pending")
			return
		}
		jsonMsg(w, "rejected")
	}
}

// ── loans ────────────────────────────────────────────────────────────────────

func loanFeeIncomeList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		where := "WHERE 1=1"
		var args []any
		n := 1
		if v := qstr(r, "status"); v != "" {
			where += " AND lfi.status = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "fee_type"); v != "" {
			where += " AND lfi.fee_type = $" + itoa(n)
			args = append(args, v)
			n++
		}
		if from, _ := validDate(r, "date_from"); from != "" {
			where += " AND lfi.fee_date >= $" + itoa(n) + "::date"
			args = append(args, from)
			n++
		}
		if to, _ := validDate(r, "date_to"); to != "" {
			where += " AND lfi.fee_date <= $" + itoa(n) + "::date"
			args = append(args, to)
			n++
		}
		// SME vs Individual resolved here, at read time, from the loan book itself —
		// never stored on the row. See migration 341's table comment.
		rows, err := db.PGQuery(r.Context(), `
			SELECT lfi.id, lfi.fee_date, lfi.fee_type, lfi.loan_account, lfi.amount_kobo,
			       lfi.currency, lfi.ref, lfi.status, lfi.initiated_by_name, lfi.approved_by_name,
			       lfi.approved_at,
			       cl.branch_name,
			       CASE cl.product_code WHEN '402' THEN 'SME' WHEN '401' THEN 'Individual' ELSE NULL END
			           AS loan_segment
			  FROM app.loan_fee_income lfi
			  LEFT JOIN app.cbs_loans cl ON cl.cbs_account_number = lfi.loan_account
			 `+where+`
			 ORDER BY lfi.fee_date DESC, lfi.id DESC LIMIT 500`, args...)
		if err != nil {
			respondErrLog(w, 500, "loan fee income list failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		jsonRows(w, rows)
	}
}

func loanFeeIncomeCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			FeeDate     string `json:"fee_date"`
			FeeType     string `json:"fee_type"`
			LoanAccount string `json:"loan_account"`
			AmountKobo  int64  `json:"amount_kobo"`
			Currency    string `json:"currency"`
			Ref         string `json:"ref"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.FeeType = strings.ToLower(strings.TrimSpace(b.FeeType))
		if b.FeeType != "management" && b.FeeType != "other" {
			respondErr(w, 422, "fee_type must be 'management' or 'other'")
			return
		}
		if b.LoanAccount == "" || b.AmountKobo <= 0 || b.FeeDate == "" {
			respondErr(w, 422, "fee_date, loan_account and a positive amount_kobo are required")
			return
		}
		if b.Currency == "" {
			b.Currency = "NGN"
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.loan_fee_income
			    (fee_date, fee_type, loan_account, amount_kobo, currency, ref,
			     initiated_by, initiated_by_name)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8)
			RETURNING id, fee_date, fee_type, amount_kobo, status`,
			b.FeeDate, b.FeeType, b.LoanAccount, b.AmountKobo, b.Currency, b.Ref,
			user.ID, user.FullName)
		if err != nil {
			respondErrLog(w, 500, "loan fee income create failed", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func loanFeeIncomeApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.loan_fee_income
			   SET status='approved', approved_by=$1, approved_by_name=$2, approved_at=NOW(), updated_at=NOW()
			 WHERE id=$3 AND status='pending'
			RETURNING id`, user.ID, user.FullName, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Loan fee entry not found or not pending")
			return
		}
		jsonMsg(w, "approved")
	}
}

func loanFeeIncomeReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct{ Reason string `json:"reason"` }
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.loan_fee_income
			   SET status='rejected', rejected_by=$1, rejection_reason=$2, updated_at=NOW()
			 WHERE id=$3 AND status='pending'
			RETURNING id`, user.ID, b.Reason, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Loan fee entry not found or not pending")
			return
		}
		jsonMsg(w, "rejected")
	}
}

// jsonMsg writes {"status": msg} — the small, repeated shape every approve/reject in this
// file (and settlements_ops.go before it) returns.
func jsonMsg(w http.ResponseWriter, status string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": status}) //nolint:errcheck
}
