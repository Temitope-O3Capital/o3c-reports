package handlers

import (
	"context"
	"encoding/json"
	"math"
	"net/http"

	"github.com/o3c/reports/core"
)

// Sales commission. Rates are set by Finance (migration 161 seeds the three lines);
// earnings are computed from an officer's actuals × the line rate. Model (agreed
// 2026-08-18): loans and fixed_deposit pay a PERCENT of booked value (rate_bps),
// cards pay a fixed amount PER CARD issued (amount_kobo).

// commissionSetterRoles may edit the rates — Finance and top management.
var commissionSetterRoles = map[string]bool{
	"admin": true, "md": true, "cfo": true, "coo": true,
	"finance_head": true, "finance_officer": true,
}

func canSetCommission(u *core.Claims) bool {
	if u == nil {
		return false
	}
	if commissionSetterRoles[u.Role] {
		return true
	}
	for _, r := range u.ExtraRoles {
		if commissionSetterRoles[r] {
			return true
		}
	}
	return false
}

// commissionRates is the loaded rate config keyed by line.
type commissionRates struct {
	loanBps  int64
	fdBps    int64
	cardKobo int64 // fixed kobo per card
	loaded   bool
}

func loadCommissionRates(ctx context.Context, db *core.DB) commissionRates {
	cr := commissionRates{}
	rows, err := db.PGQuery(ctx, `SELECT line, basis, rate_bps, amount_kobo FROM sales_commission_rates`)
	if err != nil {
		return cr
	}
	for _, r := range rows {
		switch str(r["line"]) {
		case "loans":
			cr.loanBps = toInt64(r["rate_bps"])
		case "fixed_deposit":
			cr.fdBps = toInt64(r["rate_bps"])
		case "cards":
			cr.cardKobo = toInt64(r["amount_kobo"])
		}
	}
	cr.loaded = true
	return cr
}

// commissionKobo computes earned commission (in kobo) from an officer's actuals.
func (cr commissionRates) commissionKobo(loanKobo, fdKobo, cards int64) int64 {
	return loanKobo*cr.loanBps/10000 + fdKobo*cr.fdBps/10000 + cards*cr.cardKobo
}

// salesCommissionRates returns the current rate config for display/editing.
func salesCommissionRates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(),
			`SELECT line, basis, rate_bps, amount_kobo, updated_at FROM sales_commission_rates ORDER BY line`)
		if err != nil {
			respondErr(w, 500, "Could not load commission rates")
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{
			"rates":    rows,
			"can_edit": canSetCommission(core.UserFromCtx(r.Context())),
		}, "pg")
	}
}

// salesSetCommissionRates upserts the rates. Finance/admin only.
func salesSetCommissionRates(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		if !canSetCommission(user) {
			respondErr(w, 403, "Only Finance can set commission rates")
			return
		}
		// Percent rates arrive as a percentage (e.g. 1.5 for 1.5%); the card rate
		// arrives in naira per card. Store bps and kobo respectively.
		var b struct {
			LoanPercent   float64 `json:"loan_percent"`
			FDPercent     float64 `json:"fd_percent"`
			CardNairaEach float64 `json:"card_naira_each"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		// math.Round, not a bare int64() truncation: 2.9% would otherwise store as 289
		// bps (2.89%) because 2.9*100 is 289.9999… in float64.
		loanBps := int64(math.Round(b.LoanPercent * 100))    // 1.5% -> 150 bps
		fdBps := int64(math.Round(b.FDPercent * 100))        // 2%   -> 200 bps
		cardKobo := int64(math.Round(b.CardNairaEach * 100)) // ₦500 -> 50000 kobo

		// A single statement with a CASE per line — pgx's default (extended) protocol
		// prepares any query that carries bind args, and Postgres rejects a prepared
		// statement containing multiple commands, so three semicolon-separated UPDATEs
		// with params would 500 ("cannot insert multiple commands into a prepared
		// statement") and no rate would ever save.
		_, err := db.PGExec(r.Context(), `
			UPDATE sales_commission_rates SET
			    rate_bps    = CASE line WHEN 'loans' THEN $1 WHEN 'fixed_deposit' THEN $2 ELSE rate_bps END,
			    amount_kobo = CASE line WHEN 'cards' THEN $3 ELSE amount_kobo END,
			    updated_by  = $4,
			    updated_at  = NOW()
			 WHERE line IN ('loans','fixed_deposit','cards')`,
			loanBps, fdBps, cardKobo, user.ID)
		if err != nil {
			respondErrLog(w, 500, "Could not save commission rates", err)
			return
		}
		respond(w, map[string]any{"ok": true}, "json")
	}
}
