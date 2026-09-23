package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// Account-officer corrections on the Udara loan and FD books.
//
// WHY THIS EXISTS. Two things are called "the account officer" here and until now
// only one could be corrected:
//
//	Cards / relationship book — app.customer_officers, editable from the CRM via
//	/api/sales/book/assign. Migration 283 stopped the CBS sync overwriting a manual
//	correction there.
//
//	Loan and FD book — resolved from Udara's own accountOfficerName on each record
//	through app.cbs_officer_map, and NOT correctable at all. That attribution drives
//	Top Performers, the FD book's by-officer split, executive deposit concentration,
//	the maturity alerts and sales targets — which means commission.
//
// Udara's API cannot fix it. Probed against the live host on 2026-09-23: the officer
// is a field on the loan/FD ACCOUNT (accountOfficerCode / accountOfficerName), the
// customer record carries no officer field at all, and the only write endpoints that
// exist are createcustomeraccount, updatecustomeraccount, loanaccount/add,
// loanaccount/disburseloan and fixeddepositaccount/add. There is no update endpoint
// for a loan or a fixed deposit.
//
// Editing app.cbs_officer_map is not a fix either — it maps a NAME to a user, so
// repointing one moves every record that officer holds.
//
// So the correction lives in app.cbs_officer_overrides (migration 284) and is applied
// by app.v_loan_officer / app.v_fd_officer, which every officer-attribution query now
// reads. Precedence is account override > party override > Udara's own name.
//
// Head-only, for the same reason reassignment on the sales book is: an officer must
// not be able to move a deposit onto their own book unilaterally, least of all one
// that pays commission. Every change is written to app.cbs_officer_override_history,
// including removals.

// RegisterOfficerOverrides mounts the correction endpoints under /api/officer-overrides.
func RegisterOfficerOverrides(r chi.Router, db *core.DB) {
	// Reading a correction is part of reading the book, so it follows the same
	// page gates the loan and FD books already use.
	read := core.RequirePages("sales", "fixed_deposit", "active_loan_book", "executive")
	r.With(read).Get("/", listOfficerOverrides(db))
	r.With(read).Get("/history", officerOverrideHistory(db))

	headOnly := core.RequirePages("sales")
	r.With(headOnly).Post("/", setOfficerOverride(db))
	r.With(headOnly).Delete("/{id}", clearOfficerOverride(db))
}

type officerOverrideReq struct {
	Scope     string `json:"scope"`     // loan | fd | party
	ScopeKey  string `json:"scope_key"` // cbs_account_number, or party_id for scope=party
	OfficerID int64  `json:"officer_id"`
	Reason    string `json:"reason"`
}

// listOfficerOverrides returns every correction on record, newest first, with the
// officer Udara names on the record beside the one it was corrected to — so the list
// reads as "this was X per Udara, we say Y, because Z" rather than as a bare mapping.
func listOfficerOverrides(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT o.id, o.scope, o.scope_key, o.officer_user_id, o.reason,
			       o.created_at, o.updated_at,
			       u.full_name  AS officer_name,
			       cb.full_name AS created_by_name,
			       -- What Udara says for the record(s) this override covers. A party
			       -- override can span several accounts, so the names are aggregated.
			       COALESCE(
			         (SELECT string_agg(DISTINCT v.udara_officer_name, ', ')
			            FROM app.v_fd_officer v
			           WHERE (o.scope = 'fd'    AND v.cbs_account_number = o.scope_key)),
			         (SELECT string_agg(DISTINCT v.udara_officer_name, ', ')
			            FROM app.v_loan_officer v
			           WHERE (o.scope = 'loan'  AND v.cbs_account_number = o.scope_key))
			       ) AS udara_officer_name,
			       CASE o.scope
			         WHEN 'party' THEN
			           (SELECT COUNT(*) FROM app.v_fd_officer v WHERE v.officer_source = 'override_party'
			              AND v.cbs_customer_id IN (SELECT k.cbs_customer_id FROM app.cbs_links k
			                                         WHERE k.entity_type='party' AND k.entity_id::text = o.scope_key))
			           + (SELECT COUNT(*) FROM app.v_loan_officer v WHERE v.officer_source = 'override_party'
			              AND v.cbs_customer_id IN (SELECT k.cbs_customer_id FROM app.cbs_links k
			                                         WHERE k.entity_type='party' AND k.entity_id::text = o.scope_key))
			         ELSE 1 END AS records_affected
			  FROM app.cbs_officer_overrides o
			  LEFT JOIN o3c_users u  ON u.id  = o.officer_user_id
			  LEFT JOIN o3c_users cb ON cb.id = o.created_by
			 ORDER BY o.updated_at DESC`)
		if err != nil {
			respondErrLog(w, 500, "Could not load officer overrides", err)
			return
		}
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"data": rows}, "pg")
	}
}

func officerOverrideHistory(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT h.id, h.scope, h.scope_key, h.from_officer_id, h.to_officer_id,
			       h.reason, h.changed_at,
			       fo.full_name AS from_officer_name,
			       to_.full_name AS to_officer_name,
			       cb.full_name  AS changed_by_name
			  FROM app.cbs_officer_override_history h
			  LEFT JOIN o3c_users fo  ON fo.id  = h.from_officer_id
			  LEFT JOIN o3c_users to_ ON to_.id = h.to_officer_id
			  LEFT JOIN o3c_users cb  ON cb.id  = h.changed_by
			 ORDER BY h.changed_at DESC
			 LIMIT 500`)
		if rows == nil {
			rows = []core.Row{}
		}
		respond(w, map[string]any{"data": rows}, "pg")
	}
}

// setOfficerOverride records or updates a correction.
func setOfficerOverride(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req officerOverrideReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		req.Scope = strings.ToLower(strings.TrimSpace(req.Scope))
		req.ScopeKey = strings.TrimSpace(req.ScopeKey)
		req.Reason = strings.TrimSpace(req.Reason)

		switch req.Scope {
		case "loan", "fd", "party":
		default:
			respondErr(w, 400, "scope must be loan, fd or party")
			return
		}
		if req.ScopeKey == "" {
			respondErr(w, 400, "scope_key is required")
			return
		}
		// A reason is mandatory, not a nicety: this moves commission, and "who
		// changed this and why" has to be answerable a year later.
		if req.Reason == "" {
			respondErr(w, 400, "A reason is required — this changes who is credited with the business")
			return
		}
		if req.OfficerID == 0 {
			respondErr(w, 400, "officer_id is required (use DELETE to fall back to Udara's own officer)")
			return
		}

		ctx := r.Context()

		// The target must be a real, active user. An override onto a deactivated
		// account would quietly strand the record with nobody accountable for it.
		var active bool
		if err := db.PG.QueryRowContext(ctx,
			`SELECT is_active FROM o3c_users WHERE id=$1`, req.OfficerID).Scan(&active); err != nil {
			respondErr(w, 400, "No such officer")
			return
		}
		if !active {
			respondErr(w, 400, "That user is deactivated and cannot hold a book")
			return
		}

		// The key must actually match something, or a typo creates an override that
		// silently corrects nothing and quietly stays on the list forever.
		var exists bool
		switch req.Scope {
		case "fd":
			_ = db.PG.QueryRowContext(ctx,
				`SELECT EXISTS (SELECT 1 FROM cbs_fixed_deposits WHERE cbs_account_number=$1)`, req.ScopeKey).Scan(&exists)
		case "loan":
			_ = db.PG.QueryRowContext(ctx,
				`SELECT EXISTS (SELECT 1 FROM cbs_loans WHERE cbs_account_number=$1)`, req.ScopeKey).Scan(&exists)
		case "party":
			_ = db.PG.QueryRowContext(ctx,
				`SELECT EXISTS (SELECT 1 FROM app.cbs_links WHERE entity_type='party' AND entity_id::text=$1)`, req.ScopeKey).Scan(&exists)
		}
		if !exists {
			respondErr(w, 404, "No "+req.Scope+" found for that key")
			return
		}

		var changedBy sql.NullInt64
		if u := core.UserFromCtx(ctx); u != nil && u.ID != 0 {
			changedBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var prev sql.NullInt64
		_ = tx.QueryRowContext(ctx,
			`SELECT officer_user_id FROM app.cbs_officer_overrides WHERE scope=$1 AND scope_key=$2`,
			req.Scope, req.ScopeKey).Scan(&prev)

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO app.cbs_officer_overrides (scope, scope_key, officer_user_id, reason, created_by)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (scope, scope_key) DO UPDATE
			   SET officer_user_id = EXCLUDED.officer_user_id,
			       reason          = EXCLUDED.reason,
			       updated_at      = NOW()`,
			req.Scope, req.ScopeKey, req.OfficerID, req.Reason, changedBy); err != nil {
			respondErrLog(w, 500, "Could not save the override", err)
			return
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO app.cbs_officer_override_history
			    (scope, scope_key, from_officer_id, to_officer_id, reason, changed_by)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			req.Scope, req.ScopeKey, prev, req.OfficerID, req.Reason, changedBy); err != nil {
			respondErrLog(w, 500, "History write failed", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		respond(w, map[string]any{"ok": true, "scope": req.Scope, "scope_key": req.ScopeKey}, "pg")
	}
}

// clearOfficerOverride removes a correction, so the record falls back to the officer
// Udara itself names. Nothing is destroyed by this — the fallback is the original
// answer, and the removal is recorded in history with to_officer_id NULL.
func clearOfficerOverride(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
		if err != nil || id <= 0 {
			respondErr(w, 400, "Invalid id")
			return
		}
		ctx := r.Context()
		var changedBy sql.NullInt64
		if u := core.UserFromCtx(ctx); u != nil && u.ID != 0 {
			changedBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		tx, err := db.PG.BeginTx(ctx, nil)
		if err != nil {
			respondErr(w, 500, "Could not start transaction")
			return
		}
		defer tx.Rollback() //nolint:errcheck

		var scope, key string
		var prev int64
		if err := tx.QueryRowContext(ctx,
			`DELETE FROM app.cbs_officer_overrides WHERE id=$1
			 RETURNING scope, scope_key, officer_user_id`, id).Scan(&scope, &key, &prev); err != nil {
			respondErr(w, 404, "No such override")
			return
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO app.cbs_officer_override_history
			    (scope, scope_key, from_officer_id, to_officer_id, reason, changed_by)
			VALUES ($1,$2,$3,NULL,'Override removed; reverted to the officer Udara names',$4)`,
			scope, key, prev, changedBy); err != nil {
			respondErrLog(w, 500, "History write failed", err)
			return
		}
		if err := tx.Commit(); err != nil {
			respondErr(w, 500, "Commit failed")
			return
		}
		respond(w, map[string]any{"ok": true, "removed": id}, "pg")
	}
}
