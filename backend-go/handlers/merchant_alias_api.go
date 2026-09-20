package handlers

// Merchant alias review.
//
// app.refresh_merchant_aliases() (migration 244) merges a truncated merchant
// spelling into the fuller spelling it is a strict prefix of — MEGA CHICKEN
// RESTAUR into MEGA CHICKEN RESTAURA. Those merges apply immediately, because a
// split merchant is wrong in every ranking until it is fixed, and they are marked
// reviewed=false so a person can confirm or veto each one.
//
// 597 were generated and all 597 sat unreviewed, because there was nowhere to
// review them. This is that surface: see the merge, see how many transactions and
// how much spend sit on each side of it, then keep it, drop it, or write a better
// one by hand.
//
// A manual row is never touched by the daily refresh (ON CONFLICT DO NOTHING), so
// a correction made here is permanent.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/o3c/workspace/core"
)

// RegisterMerchantAliases mounts the review endpoints under /api/admin.
//
// Gated on "uploads" — the Data Management audience (BI, Cards, Finance,
// Settlement, COO, CFO) rather than the IT-admin bundle. Judging whether two
// spellings are the same business is product knowledge, not server administration.
func RegisterMerchantAliases(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("uploads"))
	r.Get("/", merchantAliasList(db))
	r.Post("/", merchantAliasUpsert(db))
	r.Post("/approve", merchantAliasApprove(db))
	r.Post("/reject", merchantAliasReject(db))
}

// merchantAliasUsageSQL counts the purchase rows behind each cleaned spelling.
// Purchases only: on every other transaction type merchant_name is a narrative,
// a staff username or an ATM location (migration 244).
const merchantAliasUsageSQL = `
	WITH purchase AS (
	    SELECT app.clean_merchant_basic(t.merchant_name) AS basic,
	           count(*)                          AS txns,
	           COALESCE(SUM(t.amount_debit), 0)  AS spend
	      FROM app.transactions t
	      JOIN app.card_txn_codes c ON c.code = t.txn_code AND c.category = 'purchase'
	     WHERE NULLIF(btrim(t.merchant_name), '') IS NOT NULL
	     GROUP BY 1
	)`

func merchantAliasList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		status := qstr(r, "status")
		if status != "all" && status != "reviewed" {
			status = "pending"
		}
		search := qstr(r, "q")
		limit := qint(r, "limit", 200, 1, 1000)

		rows, err := db.PGQuery(r.Context(), merchantAliasUsageSQL+`
			SELECT a.clean_name, a.canonical, a.source, a.reviewed, a.created_at,
			       COALESCE(s.txns, 0)  AS short_txns,
			       COALESCE(s.spend, 0) AS short_spend,
			       COALESCE(l.txns, 0)  AS canonical_txns,
			       COALESCE(l.spend, 0) AS canonical_spend
			  FROM app.merchant_alias a
			  LEFT JOIN purchase s ON s.basic = a.clean_name
			  LEFT JOIN purchase l ON l.basic = a.canonical
			 WHERE ($1 = 'all'
			        OR ($1 = 'pending'  AND NOT a.reviewed)
			        OR ($1 = 'reviewed' AND a.reviewed))
			   AND ($2 = '' OR a.clean_name ILIKE '%' || $2 || '%'
			                OR a.canonical  ILIKE '%' || $2 || '%')
			 ORDER BY (NOT a.reviewed) DESC, COALESCE(s.txns, 0) DESC, a.clean_name
			 LIMIT $3`, status, search, limit)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}

		counts, err := db.PGQuery(r.Context(), `
			SELECT count(*)                                            AS total,
			       count(*) FILTER (WHERE NOT reviewed)                AS pending,
			       count(*) FILTER (WHERE reviewed)                    AS reviewed,
			       count(*) FILTER (WHERE source = 'manual')           AS manual,
			       count(*) FILTER (WHERE source = 'auto_prefix')      AS automatic
			  FROM app.merchant_alias`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		summary := core.Row{}
		if len(counts) > 0 {
			summary = counts[0]
		}
		respond(w, map[string]any{"aliases": rows, "counts": summary}, "pg")
	}
}

// merchantAliasUpsert writes a mapping by hand: either correcting one the refresh
// proposed, or merging two spellings it could not see (a misspelling, a trading
// name). Both sides go through clean_merchant_basic so what is stored matches
// what the lookup will search for.
func merchantAliasUpsert(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CleanName string `json:"clean_name"`
			Canonical string `json:"canonical"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			respondErr(w, 400, "Invalid request body")
			return
		}
		from, to := strings.TrimSpace(body.CleanName), strings.TrimSpace(body.Canonical)
		if from == "" || to == "" {
			respondErr(w, 400, "Both the spelling and what it should become are required")
			return
		}

		// The CHECK constraint rejects a self-mapping, and a two-row cycle
		// (A→B, B→A) would make the canonical name depend on lookup order, so
		// both are refused here with an explanation rather than a 500.
		rows, err := db.PGQuery(r.Context(), `
			SELECT app.clean_merchant_basic($1) AS from_clean,
			       app.clean_merchant_basic($2) AS to_clean,
			       EXISTS (SELECT 1 FROM app.merchant_alias
			                WHERE clean_name = app.clean_merchant_basic($2)
			                  AND canonical  = app.clean_merchant_basic($1)) AS would_cycle`,
			from, to)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		if len(rows) == 0 || str(rows[0]["from_clean"]) == "" || str(rows[0]["to_clean"]) == "" {
			respondErr(w, 400, "Those names contain no letters once cleaned — nothing to map")
			return
		}
		fromClean, toClean := str(rows[0]["from_clean"]), str(rows[0]["to_clean"])
		if fromClean == toClean {
			respondErr(w, 400, "Both names clean up to the same thing, so no mapping is needed")
			return
		}
		if rows[0]["would_cycle"] == true {
			respondErr(w, 409, "That would point the two names at each other. Remove the opposite mapping first.")
			return
		}

		if _, err := db.PGExec(r.Context(), `
			INSERT INTO app.merchant_alias (clean_name, canonical, source, reviewed)
			VALUES ($1, $2, 'manual', true)
			ON CONFLICT (clean_name) DO UPDATE
			   SET canonical = EXCLUDED.canonical, source = 'manual', reviewed = true`,
			fromClean, toClean); err != nil {
			respondErrLog(w, 500, "Could not save the mapping", err)
			return
		}
		slog.Info("merchant alias saved", "from", fromClean, "to", toClean, "by", merchantAliasActor(r))
		respond(w, map[string]any{"clean_name": fromClean, "canonical": toClean, "reviewed": true}, "ok")
	}
}

func merchantAliasApprove(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, ok := merchantAliasName(w, r)
		if !ok {
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			UPDATE app.merchant_alias SET reviewed = true
			 WHERE clean_name = $1 RETURNING clean_name, canonical`, name)
		if err != nil {
			respondErrLog(w, 500, "Could not approve the mapping", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "No such mapping")
			return
		}
		slog.Info("merchant alias approved", "name", name, "by", merchantAliasActor(r))
		respond(w, rows[0], "ok")
	}
}

// merchantAliasReject deletes the mapping, so the two spellings rank separately
// again, and records the decision in app.merchant_alias_rejected (migration 258)
// so the daily refresh does not propose the same merge tomorrow.
//
// The tombstone exists because ON CONFLICT DO NOTHING only protects an alias that
// EXISTS: a deleted one was re-created on the next run, and rejecting it was
// therefore a chore with no end. The alias row itself must still be deleted —
// app.clean_merchant applies any row it finds — so the decision has to be kept
// somewhere the row is not.
func merchantAliasReject(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, ok := merchantAliasName(w, r)
		if !ok {
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			WITH gone AS (
			    DELETE FROM app.merchant_alias WHERE clean_name = $1
			     RETURNING clean_name, canonical
			)
			INSERT INTO app.merchant_alias_rejected (clean_name, canonical, rejected_by)
			SELECT clean_name, canonical, NULLIF($2::bigint, 0) FROM gone
			ON CONFLICT (clean_name) DO UPDATE
			   SET canonical = EXCLUDED.canonical, rejected_at = now(),
			       rejected_by = EXCLUDED.rejected_by
			 RETURNING clean_name, canonical`, name, merchantAliasActor(r))
		if err != nil {
			respondErrLog(w, 500, "Could not remove the mapping", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "No such mapping")
			return
		}
		slog.Info("merchant alias rejected", "name", name, "by", merchantAliasActor(r))
		respond(w, rows[0], "ok")
	}
}

func merchantAliasName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		CleanName string `json:"clean_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		respondErr(w, 400, "Invalid request body")
		return "", false
	}
	name := strings.TrimSpace(body.CleanName)
	if name == "" {
		respondErr(w, 400, "clean_name is required")
		return "", false
	}
	return name, true
}

func merchantAliasActor(r *http.Request) int64 {
	if u := core.UserFromCtx(r.Context()); u != nil {
		return u.ID
	}
	return 0
}
