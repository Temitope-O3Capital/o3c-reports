package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/recon"
)

// RegisterRecon mounts the reconciliation engine under /api/recon.
//
// Running a reconciliation is a settlement-officer action; resolving exceptions is
// too. Sign-off is deliberately separated — it is the artifact that says a human
// accepted the day's position, so it is restricted to the reconciliation/finance
// heads rather than whoever ran the match.
func RegisterRecon(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement", "reconciliation")

	r.With(access).Post("/runs", reconRunStart(db))
	r.With(access).Get("/runs", reconRunList(db))
	r.With(access).Get("/runs/{id}", reconRunDetail(db))
	r.With(core.RequirePages("reconciliation")).Post("/runs/{id}/signoff", reconRunSignoff(db))

	r.With(access).Get("/activity", reconActivityLog(db))
	r.With(access).Get("/exceptions", reconExceptionList(db))
	r.With(access).Get("/exceptions/summary", reconExceptionSummary(db))
	r.With(access).Post("/exceptions/{id}/assign", reconExceptionAssign(db))
	r.With(access).Post("/exceptions/{id}/resolve", reconExceptionResolve(db))
	r.With(access).Post("/exceptions/bulk-resolve", reconExceptionBulkResolve(db))
}

/* ── Runs ────────────────────────────────────────────────────────────────── */

func reconRunStart(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Source       string `json:"source"`
			Counterparty string `json:"counterparty"`
			PeriodFrom   string `json:"period_from"`
			PeriodTo     string `json:"period_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if b.Source == "" {
			b.Source = recon.InterswitchSage.Source
		}
		if b.Counterparty == "" {
			b.Counterparty = recon.InterswitchSage.Counterparty
		}
		from, err := time.Parse("2006-01-02", b.PeriodFrom)
		if err != nil {
			respondErr(w, 422, "period_from must be YYYY-MM-DD")
			return
		}
		to, err := time.Parse("2006-01-02", b.PeriodTo)
		if err != nil {
			respondErr(w, 422, "period_to must be YYYY-MM-DD")
			return
		}

		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()

		res, err := recon.Run(ctx, db,
			recon.Pair{Source: b.Source, Counterparty: b.Counterparty},
			from, to, "manual", triggeredBy)
		if err != nil {
			respondErr(w, 500, "Reconciliation failed: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"run_id":               res.RunID,
			"source_n":             res.SourceN,
			"matched_n":            res.MatchedN,
			"ambiguous_n":          res.AmbiguousN,
			"amount_mismatch_n":    res.AmountMismatchN,
			"unmatched_n":          res.UnmatchedN,
			"source_value_kobo":    res.SourceValueKobo,
			"matched_value_kobo":   res.MatchedValueKobo,
			"unmatched_value_kobo": res.UnmatchedValueKobo,
			"match_rate_pct":       pct(res.MatchedN, res.SourceN),
			"per_tier":             res.PerTier,
		}) //nolint:errcheck
	}
}

func pct(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(int(float64(n)/float64(total)*10000+0.5)) / 100
}

func reconRunList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 50, 1, 200)
		rows, err := db.PGQuery(r.Context(), `
			SELECT r.id, r.source, r.counterparty, r.period_from, r.period_to, r.kind, r.status,
			       r.started_at, r.finished_at, r.error,
			       r.source_n, r.matched_n, r.ambiguous_n, r.unmatched_n,
			       r.source_value_kobo, r.matched_value_kobo, r.unmatched_value_kobo,
			       CASE WHEN r.source_n > 0
			            THEN ROUND(100.0 * r.matched_n / r.source_n, 2) ELSE 0 END AS match_rate_pct,
			       COALESCE(t.full_name, '') AS triggered_by_name,
			       COALESCE(s.full_name, '') AS signed_off_by_name,
			       r.signed_off_at, COALESCE(r.signoff_note, '') AS signoff_note
			FROM recon_runs r
			LEFT JOIN o3c_users t ON t.id = r.triggered_by
			LEFT JOIN o3c_users s ON s.id = r.signed_off_by
			ORDER BY r.started_at DESC
			LIMIT $1`, limit)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

func reconRunDetail(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		runRows, err := db.PGQuery(r.Context(), `
			SELECT r.*, COALESCE(t.full_name,'') AS triggered_by_name,
			       COALESCE(s.full_name,'') AS signed_off_by_name
			FROM recon_runs r
			LEFT JOIN o3c_users t ON t.id = r.triggered_by
			LEFT JOIN o3c_users s ON s.id = r.signed_off_by
			WHERE r.id = $1`, id)
		if err != nil || len(runRows) == 0 {
			respondErr(w, 404, "Run not found")
			return
		}

		// Per-tier breakdown makes the match auditable: how many pairings came from
		// each rule, and at what confidence.
		tiers, _ := db.PGQuery(r.Context(), `
			SELECT tier, confidence, COUNT(*) AS n, COALESCE(SUM(ABS(amount_kobo)),0) AS value_kobo
			FROM recon_matches WHERE run_id = $1
			GROUP BY tier, confidence ORDER BY confidence DESC`, id)
		if tiers == nil {
			tiers = []map[string]any{}
		}

		reasons, _ := db.PGQuery(r.Context(), `
			SELECT reason, status, COUNT(*) AS n, COALESCE(SUM(ABS(amount_kobo)),0) AS value_kobo
			FROM recon_exceptions WHERE run_id = $1
			GROUP BY reason, status ORDER BY n DESC`, id)
		if reasons == nil {
			reasons = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"run":        runRows[0],
			"tiers":      tiers,
			"exceptions": reasons,
		})
	}
}

func reconRunSignoff(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			Note string `json:"note"`
		}
		json.NewDecoder(r.Body).Decode(&b) //nolint:errcheck

		// Sign-off asserts the position was reviewed; refuse it while the run is not
		// complete, and refuse a silent re-sign of an already signed run.
		rows, err := db.PGQuery(r.Context(), `
			UPDATE recon_runs
			SET signed_off_by=$1, signed_off_at=NOW(), signoff_note=$2
			WHERE id=$3 AND status='ok' AND signed_off_at IS NULL
			RETURNING id`, user.ID, b.Note, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 409, "Run not found, not complete, or already signed off")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "signed_off"}) //nolint:errcheck
	}
}

/* ── Activity log: every run and every import ────────────────────────────── */

// reconActivityLog is the "Runs & Imports" feed — the audit artifact the old
// Batches page was trying to be. It unifies the three things that actually happen
// in this module: reconciliation runs, Paystack mirror syncs, and Interswitch EOD
// file imports (derived from imported_at, since the importer keeps no header row).
func reconActivityLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 60, 1, 200)
		ctx := r.Context()

		runs, _ := db.PGQuery(ctx, `
			SELECT 'reconciliation' AS activity, r.id, r.started_at, r.finished_at, r.status,
			       r.source || ' → ' || r.counterparty AS detail,
			       r.source_n AS records,
			       CASE WHEN r.source_n > 0
			            THEN ROUND(100.0 * r.matched_n / r.source_n, 1) ELSE NULL END AS match_rate_pct,
			       r.unmatched_n AS exceptions,
			       COALESCE(u.full_name,'system') AS actor,
			       COALESCE(r.error,'') AS error,
			       (r.signed_off_at IS NOT NULL) AS signed_off
			FROM recon_runs r
			LEFT JOIN o3c_users u ON u.id = r.triggered_by
			ORDER BY r.started_at DESC LIMIT $1`, limit)
		if runs == nil {
			runs = []map[string]any{}
		}

		syncs, _ := db.PGQuery(ctx, `
			SELECT 'paystack_sync' AS activity, s.id, s.started_at, s.finished_at, s.status,
			       s.kind AS detail,
			       (s.transactions_n + s.transfers_n + s.settlements_n + s.disputes_n) AS records,
			       NULL::numeric AS match_rate_pct,
			       0 AS exceptions,
			       COALESCE(u.full_name,'scheduler') AS actor,
			       COALESCE(s.error,'') AS error,
			       FALSE AS signed_off
			FROM paystack_sync_runs s
			LEFT JOIN o3c_users u ON u.id = s.triggered_by
			ORDER BY s.started_at DESC LIMIT $1`, limit)
		if syncs == nil {
			syncs = []map[string]any{}
		}

		// One import = one imported_at burst. Grouping to the second is enough:
		// a single upload lands its rows together.
		imports, _ := db.PGQuery(ctx, `
			SELECT 'interswitch_import' AS activity,
			       NULL::bigint AS id,
			       DATE_TRUNC('second', imported_at) AS started_at,
			       DATE_TRUNC('second', imported_at) AS finished_at,
			       'ok' AS status,
			       'EOD file · ' || MIN(txn_date)::text || ' to ' || MAX(txn_date)::text AS detail,
			       COUNT(*) AS records,
			       NULL::numeric AS match_rate_pct,
			       0 AS exceptions,
			       'upload' AS actor,
			       '' AS error,
			       FALSE AS signed_off
			FROM interswitch_txns
			GROUP BY DATE_TRUNC('second', imported_at)
			ORDER BY 3 DESC LIMIT $1`, limit)
		if imports == nil {
			imports = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"runs":    runs,
			"syncs":   syncs,
			"imports": imports,
		})
	}
}

/* ── Exceptions ──────────────────────────────────────────────────────────── */

func reconExceptionList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 100, 1, 500)
		where := "1=1"
		var args []any
		n := 1

		if v := qstr(r, "run_id"); v != "" {
			where += fmt.Sprintf(" AND e.run_id = $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "status"); v != "" {
			var ph []string
			for _, part := range strings.Split(v, ",") {
				p := strings.TrimSpace(strings.ToLower(part))
				if p == "" {
					continue
				}
				ph = append(ph, fmt.Sprintf("$%d", n))
				args = append(args, p)
				n++
			}
			if len(ph) > 0 {
				where += " AND e.status IN (" + strings.Join(ph, ",") + ")"
			}
		} else {
			where += " AND e.status IN ('open','investigating')"
		}
		if v := qstr(r, "reason"); v != "" {
			where += fmt.Sprintf(" AND e.reason = $%d", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "assigned_to"); v != "" {
			where += fmt.Sprintf(" AND e.assigned_to = $%d", n)
			args = append(args, v)
			n++
		}
		args = append(args, limit)

		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT e.id, e.run_id, e.source, e.source_key, e.source_ref, e.txn_date,
			       e.amount_kobo, e.reason, e.candidate_n, e.detail, e.status,
			       COALESCE(a.full_name,'') AS assigned_to_name, e.assigned_to,
			       COALESCE(e.resolution_code,'') AS resolution_code,
			       COALESCE(e.resolution_note,'') AS resolution_note,
			       COALESCE(rb.full_name,'') AS resolved_by_name, e.resolved_at,
			       e.created_at,
			       -- Aging is the whole point of an exception queue: an unmatched item
			       -- that nobody has touched for 30 days is a different problem to a
			       -- fresh one.
			       GREATEST(0, EXTRACT(DAY FROM NOW() - e.created_at))::int AS age_days
			FROM recon_exceptions e
			LEFT JOIN o3c_users a  ON a.id = e.assigned_to
			LEFT JOIN o3c_users rb ON rb.id = e.resolved_by
			WHERE %s
			ORDER BY e.created_at ASC, e.amount_kobo DESC
			LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed")
			return
		}
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}

// reconExceptionSummary powers the queue header and the Settlement Position page:
// how much is open, how old it is, and how much value is sitting unresolved.
func reconExceptionSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT
			  COUNT(*) FILTER (WHERE status IN ('open','investigating'))              AS open_n,
			  COALESCE(SUM(ABS(amount_kobo)) FILTER (WHERE status IN ('open','investigating')),0) AS open_value_kobo,
			  COUNT(*) FILTER (WHERE status='resolved')                               AS resolved_n,
			  COUNT(*) FILTER (WHERE status='written_off')                            AS written_off_n,
			  COUNT(*) FILTER (WHERE status IN ('open','investigating')
			                     AND created_at < NOW() - INTERVAL '7 days')          AS aged_7d_n,
			  COUNT(*) FILTER (WHERE status IN ('open','investigating')
			                     AND created_at < NOW() - INTERVAL '30 days')         AS aged_30d_n,
			  COUNT(*) FILTER (WHERE status IN ('open','investigating') AND reason='ambiguous')       AS ambiguous_n,
			  COUNT(*) FILTER (WHERE status IN ('open','investigating') AND reason='amount_mismatch') AS amount_mismatch_n,
			  COUNT(*) FILTER (WHERE status IN ('open','investigating') AND reason='no_candidate')    AS no_candidate_n
			FROM recon_exceptions`)
		if err != nil || len(rows) == 0 {
			respondErr(w, 500, "Query failed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(rows[0]) //nolint:errcheck
	}
}

func reconExceptionAssign(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		var b struct {
			UserID int64 `json:"user_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.UserID == 0 {
			respondErr(w, 422, "user_id is required")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			UPDATE recon_exceptions
			SET assigned_to=$1, status=CASE WHEN status='open' THEN 'investigating' ELSE status END,
			    updated_at=NOW()
			WHERE id=$2 AND status IN ('open','investigating')
			RETURNING id`, b.UserID, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Exception not found or already closed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "assigned"}) //nolint:errcheck
	}
}

// reconResolutionCodes are the allowed dispositions. A free-text-only resolution
// makes the queue unanalysable — you can never answer "why do things go unmatched".
var reconResolutionCodes = map[string]bool{
	"matched_manually":  true, // operator found the ledger entry by hand
	"timing_difference": true, // will match in a later period
	"fee_or_commission": true, // difference is a charge, not a missing payment
	"duplicate_in_feed": true,
	"processor_error":   true,
	"ledger_error":      true,
	"written_off":       true,
}

func reconExceptionResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		user := core.UserFromCtx(r.Context())
		var b struct {
			ResolutionCode string `json:"resolution_code"`
			Note           string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if !reconResolutionCodes[b.ResolutionCode] {
			respondErr(w, 422, "resolution_code must be one of: "+strings.Join(reconCodeList(), ", "))
			return
		}
		status := "resolved"
		if b.ResolutionCode == "written_off" {
			status = "written_off"
		}

		rows, err := db.PGQuery(r.Context(), `
			UPDATE recon_exceptions
			SET status=$1, resolution_code=$2, resolution_note=$3,
			    resolved_by=$4, resolved_at=NOW(), updated_at=NOW()
			WHERE id=$5 AND status IN ('open','investigating')
			RETURNING id`, status, b.ResolutionCode, b.Note, user.ID, id)
		if err != nil || len(rows) == 0 {
			respondErr(w, 404, "Exception not found or already closed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": status}) //nolint:errcheck
	}
}

func reconExceptionBulkResolve(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := core.UserFromCtx(r.Context())
		var b struct {
			IDs            []int64 `json:"ids"`
			ResolutionCode string  `json:"resolution_code"`
			Note           string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			respondErr(w, 400, "Invalid JSON")
			return
		}
		if len(b.IDs) == 0 {
			respondErr(w, 422, "ids must not be empty")
			return
		}
		if !reconResolutionCodes[b.ResolutionCode] {
			respondErr(w, 422, "resolution_code must be one of: "+strings.Join(reconCodeList(), ", "))
			return
		}
		status := "resolved"
		if b.ResolutionCode == "written_off" {
			status = "written_off"
		}

		// pgx stdlib does not bind slices — build a parameterised IN list.
		ph := make([]string, len(b.IDs))
		args := make([]any, 0, len(b.IDs)+4)
		args = append(args, status, b.ResolutionCode, b.Note, user.ID)
		for i, id := range b.IDs {
			ph[i] = fmt.Sprintf("$%d", i+5)
			args = append(args, id)
		}
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			UPDATE recon_exceptions
			SET status=$1, resolution_code=$2, resolution_note=$3,
			    resolved_by=$4, resolved_at=NOW(), updated_at=NOW()
			WHERE id IN (%s) AND status IN ('open','investigating')
			RETURNING id`, strings.Join(ph, ",")), args...)
		if err != nil {
			respondErr(w, 500, "Bulk resolve failed: "+err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"status":  status,
			"updated": len(rows),
		})
	}
}

func reconCodeList() []string {
	out := make([]string, 0, len(reconResolutionCodes))
	for k := range reconResolutionCodes {
		out = append(out, k)
	}
	return out
}
