package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// RegisterCreditAccommodations mounts the concession & restructuring workflow at
// /api/credit-accommodations. Anyone working the account (collections / recovery /
// risk) can propose one; a head-level role decides it.
func RegisterCreditAccommodations(r chi.Router, db *core.DB) {
	work := core.RequirePages("collections", "recovery", "credit_portfolio")
	approve := core.RequirePages("recovery_write_off", "collections_payment_approve", "risk_head", "risk_all")

	r.With(work).Get("/", listAccommodations(db))
	r.With(work).Post("/", createAccommodation(db))
	r.With(approve).Put("/{id}/approve", decideAccommodation(db, "approved"))
	r.With(approve).Put("/{id}/reject", decideAccommodation(db, "rejected"))
}

// listAccommodations returns accommodations for a customer (?cif=) or the pending
// queue (?status=pending) — with requester/decider names resolved.
func listAccommodations(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cif := strings.TrimSpace(qstr(r, "cif"))
		status := strings.TrimSpace(qstr(r, "status"))
		where := "WHERE 1=1"
		args := []any{}
		n := 1
		if cif != "" {
			where += " AND a.cif = $" + strconv.Itoa(n)
			args = append(args, cif)
			n++
		}
		if status != "" {
			where += " AND a.status = $" + strconv.Itoa(n)
			args = append(args, status)
			n++
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT a.*, ru.full_name AS requested_by_name, du.full_name AS decided_by_name,
			       COALESCE(NULLIF(TRIM(CONCAT(c.first_name,' ',c.last_name)),''), a.cif) AS customer_name
			FROM app.credit_accommodations a
			LEFT JOIN o3c_users ru   ON ru.id = a.requested_by
			LEFT JOIN o3c_users du   ON du.id = a.decided_by
			LEFT JOIN app.customers c ON c.cif = a.cif
			`+where+`
			ORDER BY a.created_at DESC`, args...)
		if err != nil {
			if strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "relation") {
				respond(w, []core.Row{}, "pg")
				return
			}
			respondErrLog(w, 500, "accommodations query failed", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, rows, "pg")
	}
}

// createAccommodation proposes a concession or restructure (status pending).
func createAccommodation(db *core.DB) http.HandlerFunc {
	type body struct {
		CIF                string `json:"cif"`
		AccountRef         string `json:"account_ref"`
		Kind               string `json:"kind"`
		ConcessionType     string `json:"concession_type"`
		AmountKobo         *int64 `json:"amount_kobo"`
		NewTenorMonths     *int   `json:"new_tenor_months"`
		NewRateBps         *int   `json:"new_rate_bps"`
		NewInstallmentKobo *int64 `json:"new_installment_kobo"`
		NewMaturityDate    string `json:"new_maturity_date"`
		Reason             string `json:"reason"`
		RecoveryCaseID     *int64 `json:"recovery_case_id"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var b body
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		b.CIF = strings.TrimSpace(b.CIF)
		if b.CIF == "" {
			respondErr(w, 422, "cif is required")
			return
		}
		if b.Kind != "concession" && b.Kind != "restructure" {
			respondErr(w, 422, "kind must be 'concession' or 'restructure'")
			return
		}
		if strings.TrimSpace(b.Reason) == "" {
			respondErr(w, 422, "reason is required")
			return
		}
		var uid any
		if u := core.UserFromCtx(r.Context()); u != nil {
			uid = u.ID
		}
		var maturity any
		if dateRE.MatchString(b.NewMaturityDate) {
			maturity = b.NewMaturityDate
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.credit_accommodations
			  (cif, account_ref, kind, concession_type, amount_kobo, new_tenor_months,
			   new_rate_bps, new_installment_kobo, new_maturity_date, reason, status,
			   requested_by, recovery_case_id)
			VALUES ($1,NULLIF($2,''),$3,NULLIF($4,''),$5,$6,$7,$8,$9::date,$10,'pending',$11,$12)
			RETURNING id`,
			b.CIF, b.AccountRef, b.Kind, b.ConcessionType, b.AmountKobo, b.NewTenorMonths,
			b.NewRateBps, b.NewInstallmentKobo, maturity, b.Reason, uid, b.RecoveryCaseID)
		if err != nil {
			respondErrLog(w, 500, "create accommodation failed", err)
			return
		}
		id := int64(0)
		if len(rows) > 0 {
			id = toInt64(rows[0]["id"])
		}
		respond(w, core.Row{"id": id, "status": "pending"}, "pg")
	}
}

// decideAccommodation approves or rejects a pending accommodation.
func decideAccommodation(db *core.DB, outcome string) http.HandlerFunc {
	type body struct {
		Note string `json:"note"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid id")
			return
		}
		var b body
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck
		var uid any
		if u := core.UserFromCtx(r.Context()); u != nil {
			uid = u.ID
		}
		res, err := db.PG.ExecContext(r.Context(), `
			UPDATE app.credit_accommodations
			   SET status=$1, decided_by=$2, decided_at=NOW(), decision_note=$3, updated_at=NOW()
			 WHERE id=$4 AND status='pending'`, outcome, uid, b.Note, id)
		if err != nil {
			respondErrLog(w, 500, "decide accommodation failed", err)
			return
		}
		if aff, _ := res.RowsAffected(); aff == 0 {
			respondErr(w, 409, "Not found or already decided")
			return
		}
		respond(w, core.Row{"id": id, "status": outcome}, "pg")
	}
}
