package handlers

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterPayroll(r chi.Router, db *core.DB) {
	read := core.RequirePages("payroll")
	mgr := core.RequirePages("payroll_manager")

	r.With(read).Get("/summary", payrollSummary(db))
	r.With(read).Get("/runs", payrollRunList(db))
	r.With(read).Get("/runs/{id}", payrollRunGet(db))
	r.With(read).Get("/runs/{id}/items", payrollItemList(db))
	r.With(mgr).Post("/runs", payrollRunCreate(db))
	r.With(mgr).Patch("/runs/{id}/items/{itemId}", payrollItemUpdate(db))
	r.With(mgr).Post("/runs/{id}/submit", payrollRunSubmit(db))
	r.With(mgr).Post("/runs/{id}/approve", payrollRunApprove(db))
	r.With(mgr).Post("/runs/{id}/pay", payrollRunPay(db))
}

// computePayeKobo calculates Nigerian PAYE for a monthly gross salary (in kobo).
// Returns annual PAYE in kobo; caller divides by 12 for monthly deduction.
func computePayeKobo(annualGrossKobo int64) int64 {
	gai := float64(annualGrossKobo) / 100.0 // gross annual income in naira

	// Consolidated Relief Allowance: higher of ₦200,000 or 1% of GI, plus 20% of GI
	cra := math.Max(200_000, gai*0.01) + gai*0.20
	taxable := gai - cra
	if taxable < 0 {
		taxable = 0
	}

	// Progressive bands (naira)
	bands := [][2]float64{
		{300_000, 0.07},
		{300_000, 0.11},
		{500_000, 0.15},
		{500_000, 0.19},
		{1_600_000, 0.21},
	}
	var tax float64
	remaining := taxable
	for _, b := range bands {
		if remaining <= 0 {
			break
		}
		in := math.Min(remaining, b[0])
		tax += in * b[1]
		remaining -= in
	}
	if remaining > 0 {
		tax += remaining * 0.24
	}

	// Minimum tax: 1% of gross if computed tax is lower
	minTax := gai * 0.01
	if tax < minTax {
		tax = minTax
	}
	return int64(tax * 100) // back to kobo
}

// computeItem derives all deduction/allowance components from gross salary.
func computeItem(grossKobo int64) (basic, housing, transport, otherAllowance, paye, pension, nhf int64) {
	basic = int64(float64(grossKobo) * 0.40)
	housing = int64(float64(grossKobo) * 0.20)
	transport = int64(float64(grossKobo) * 0.10)
	otherAllowance = grossKobo - basic - housing - transport

	annualPaye := computePayeKobo(grossKobo * 12)
	paye = annualPaye / 12

	pension = int64(float64(grossKobo) * 0.08)
	nhf = int64(float64(basic) * 0.025)
	return
}

func payrollSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.id, r.period_year, r.period_month, r.status,
			       r.headcount, r.total_gross_kobo, r.total_net_kobo,
			       r.total_paye_kobo, r.total_pension_kobo, r.total_nhf_kobo,
			       r.total_loan_deduction_kobo, r.created_at, r.approved_at, r.paid_at
			FROM payroll_runs r
			ORDER BY r.period_year DESC, r.period_month DESC
			LIMIT 12`)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		// Count active employees for snapshot
		empRow, _ := db.PGQuery(r.Context(), `SELECT COUNT(*) AS cnt FROM employees WHERE status = 'active'`)
		var activeCount int64
		if len(empRow) > 0 {
			activeCount, _ = empRow[0]["cnt"].(int64)
		}
		respond(w, map[string]any{"runs": rows, "active_employees": activeCount}, "pg")
	}
}

func payrollRunList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.id, r.period_year, r.period_month, r.status,
			       r.headcount, r.total_gross_kobo, r.total_net_kobo,
			       r.total_paye_kobo, r.total_pension_kobo, r.created_at,
			       r.approved_at, r.paid_at,
			       u.full_name AS created_by_name
			FROM payroll_runs r
			LEFT JOIN users u ON u.id = r.created_by
			ORDER BY r.period_year DESC, r.period_month DESC`)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, rows, "pg")
	}
}

func payrollRunGet(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.*, u.full_name AS created_by_name, a.full_name AS approved_by_name
			FROM payroll_runs r
			LEFT JOIN users u ON u.id = r.created_by
			LEFT JOIN users a ON a.id = r.approved_by
			WHERE r.id = $1`, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "run not found")
			return
		}
		respond(w, rows[0], "pg")
	}
}

func payrollItemList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		rows, err := db.PGQuery(r.Context(), `
			SELECT i.*
			FROM payroll_items i
			WHERE i.run_id = $1
			ORDER BY i.department, i.employee_name`, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, rows, "pg")
	}
}

func payrollRunCreate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			PeriodYear  int    `json:"period_year"`
			PeriodMonth int    `json:"period_month"`
			Notes       string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.PeriodYear == 0 || b.PeriodMonth == 0 {
			respondErr(w, 400, "period_year and period_month required")
			return
		}
		user := core.UserFromCtx(r.Context())

		// Fetch all active employees with their salary
		emps, err := db.PGQuery(r.Context(), `
			SELECT e.id, e.first_name || ' ' || e.last_name AS full_name,
			       e.staff_id, e.job_title, e.salary_kobo,
			       e.bank_name, e.account_number,
			       d.name AS department,
			       g.name AS grade_level
			FROM employees e
			LEFT JOIN departments d ON d.id = e.department_id
			LEFT JOIN grade_levels g ON g.id = e.grade_level_id
			WHERE e.status = 'active'`)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		if len(emps) == 0 {
			respondErr(w, 400, "no active employees found")
			return
		}

		ctx := r.Context()
		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var runID int64
		err = tx.QueryRowContext(ctx, `
			INSERT INTO payroll_runs (period_year, period_month, status, headcount, notes, created_by)
			VALUES ($1, $2, 'draft', $3, $4, $5)
			RETURNING id`,
			b.PeriodYear, b.PeriodMonth, len(emps), b.Notes, user.ID).Scan(&runID)
		if err != nil {
			respondErr(w, 409, "a run already exists for this period")
			return
		}

		var (
			totalGross   int64
			totalNet     int64
			totalPaye    int64
			totalPension int64
			totalNhf     int64
		)

		for _, emp := range emps {
			gross, _ := emp["salary_kobo"].(int64)
			basic, housing, transport, other, paye, pension, nhf := computeItem(gross)

			// Check for active staff loan repayments
			var loanDeduction int64
			loanRows, _ := db.PGQuery(ctx, `
				SELECT COALESCE(SUM(monthly_repayment_kobo), 0) AS total
				FROM loan_applications
				WHERE applicant_employee_id = $1 AND status = 'active' AND loan_product LIKE 'Staff%'`,
				emp["id"])
			if len(loanRows) > 0 {
				loanDeduction, _ = loanRows[0]["total"].(int64)
			}

			totalDeductions := paye + pension + nhf + loanDeduction
			net := gross - totalDeductions
			if net < 0 {
				net = 0
			}

			_, err = tx.ExecContext(ctx, `
				INSERT INTO payroll_items (run_id, employee_id, employee_name, staff_id,
				  department, grade_level, job_title, bank_name, account_number,
				  gross_kobo, basic_kobo, housing_kobo, transport_kobo, other_allowance_kobo,
				  paye_kobo, employee_pension_kobo, nhf_kobo, loan_deduction_kobo, net_kobo)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
				runID, emp["id"], emp["full_name"], emp["staff_id"],
				emp["department"], emp["grade_level"], emp["job_title"],
				emp["bank_name"], emp["account_number"],
				gross, basic, housing, transport, other,
				paye, pension, nhf, loanDeduction, net)
			if err != nil {
				respondErr(w, 500, "failed to insert payroll item: "+err.Error())
				return
			}

			totalGross += gross
			totalNet += net
			totalPaye += paye
			totalPension += pension
			totalNhf += nhf
		}

		_, err = tx.ExecContext(ctx, `
			UPDATE payroll_runs SET
			  total_gross_kobo=$1, total_net_kobo=$2, total_paye_kobo=$3,
			  total_pension_kobo=$4, total_nhf_kobo=$5, updated_at=NOW()
			WHERE id=$6`,
			totalGross, totalNet, totalPaye, totalPension, totalNhf, runID)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		if err = tx.Commit(); err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{"id": runID, "headcount": len(emps)}, "pg")
	}
}

func payrollItemUpdate(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		runID := chi.URLParam(r, "id")
		itemID := chi.URLParam(r, "itemId")

		// Ensure run is still in draft/review
		runs, _ := db.PGQuery(r.Context(), `SELECT status FROM payroll_runs WHERE id=$1`, runID)
		if len(runs) == 0 {
			respondErr(w, 404, "run not found")
			return
		}
		if s, _ := runs[0]["status"].(string); s == "approved" || s == "paid" {
			respondErr(w, 409, "cannot edit an approved or paid run")
			return
		}

		var b struct {
			OtherDeductionKobo  *int64  `json:"other_deduction_kobo"`
			OtherAllowanceKobo  *int64  `json:"other_allowance_kobo"`
			Notes               *string `json:"notes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "invalid body")
			return
		}

		itemRows, _ := db.PGQuery(r.Context(), `SELECT * FROM payroll_items WHERE id=$1 AND run_id=$2`, itemID, runID)
		if len(itemRows) == 0 {
			respondErr(w, 404, "item not found")
			return
		}
		item := itemRows[0]

		otherDed := item["other_deduction_kobo"].(int64)
		if b.OtherDeductionKobo != nil {
			otherDed = *b.OtherDeductionKobo
		}
		otherAllow := item["other_allowance_kobo"].(int64)
		if b.OtherAllowanceKobo != nil {
			otherAllow = *b.OtherAllowanceKobo
		}

		gross := item["basic_kobo"].(int64) + item["housing_kobo"].(int64) + item["transport_kobo"].(int64) + otherAllow
		totalDed := item["paye_kobo"].(int64) + item["employee_pension_kobo"].(int64) +
			item["nhf_kobo"].(int64) + item["loan_deduction_kobo"].(int64) + otherDed
		net := gross - totalDed
		if net < 0 {
			net = 0
		}

		args := []any{gross, otherAllow, otherDed, net, itemID}
		query := `UPDATE payroll_items SET gross_kobo=$1, other_allowance_kobo=$2, other_deduction_kobo=$3, net_kobo=$4`
		if b.Notes != nil {
			query += ", notes=$6"
			args = append(args, *b.Notes)
		}
		query += " WHERE id=$5"

		_, err := db.PGExec(r.Context(), query, args...)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}

		// Recalculate run totals
		db.PGExec(r.Context(), `
			UPDATE payroll_runs SET
			  total_gross_kobo   = (SELECT SUM(gross_kobo) FROM payroll_items WHERE run_id=$1),
			  total_net_kobo     = (SELECT SUM(net_kobo)   FROM payroll_items WHERE run_id=$1),
			  total_paye_kobo    = (SELECT SUM(paye_kobo)  FROM payroll_items WHERE run_id=$1),
			  total_pension_kobo = (SELECT SUM(employee_pension_kobo) FROM payroll_items WHERE run_id=$1),
			  total_nhf_kobo     = (SELECT SUM(nhf_kobo)   FROM payroll_items WHERE run_id=$1),
			  updated_at = NOW()
			WHERE id=$1`, runID) //nolint:errcheck
		respond(w, map[string]any{"ok": true, "net_kobo": net}, "pg")
	}
}

func payrollRunSubmit(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		_, err := db.PGExec(r.Context(), `
			UPDATE payroll_runs SET status='review', updated_at=NOW()
			WHERE id=$1 AND status='draft'`, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

func payrollRunApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		_, err := db.PGExec(r.Context(), `
			UPDATE payroll_runs SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
			WHERE id=$2 AND status='review'`, user.ID, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

func payrollRunPay(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		_, err := db.PGExec(r.Context(), `
			UPDATE payroll_runs SET status='paid', paid_at=NOW(), updated_at=NOW()
			WHERE id=$1 AND status='approved'`, id)
		if err != nil {
			respondErr(w, 500, err.Error())
			return
		}
		respond(w, map[string]any{"ok": true}, "pg")
	}
}

// payrollRunIDFromParam is a helper for chi URL params.
func payrollRunIDFromParam(r *http.Request) int64 {
	v, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	return v
}
