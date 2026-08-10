package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
	"github.com/o3c/reports/iswsettle"
)

// RegisterInterswitchSettle mounts the real Interswitch settlement feed under
// /api/interswitch. This is distinct from /api/cards/interswitch, which serves the
// CCS EODTXN data that was historically (and wrongly) called "Interswitch".
func RegisterInterswitchSettle(r chi.Router, db *core.DB) {
	access := core.RequirePages("settlement", "reconciliation")
	r.With(core.RequirePages("uploads", "settlement")).Post("/import", iswSettleImport(db))
	r.With(access).Get("/summary", iswSettleSummary(db))
	r.With(access).Get("/imports", iswSettleImports(db))
}

// iswSettleImport accepts one or many Interswitch report files. Aggregate reports
// (global/NIBSS rollups) are skipped by the parser rather than rejected, so an
// operator can drag a whole day's folder in without curating it first.
func iswSettleImport(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(128 << 20); err != nil {
			respondErr(w, 400, "Failed to parse upload")
			return
		}
		var triggeredBy sql.NullInt64
		if u := core.UserFromCtx(r.Context()); u != nil && u.ID != 0 {
			triggeredBy = sql.NullInt64{Int64: u.ID, Valid: true}
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()

		importID, err := iswsettle.OpenRun(ctx, db, triggeredBy)
		if err != nil {
			respondErr(w, 500, "Could not open import: "+err.Error())
			return
		}

		var res iswsettle.Result
		res.ImportID = importID
		var all []iswsettle.Leg

		for _, fh := range r.MultipartForm.File["files"] {
			res.Files++
			f, err := fh.Open()
			if err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", fh.Filename, err))
				continue
			}
			legs, perr := iswsettle.ParseFile(f, fh.Filename)
			f.Close()
			if perr != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", fh.Filename, perr))
				continue
			}
			all = append(all, legs...)
		}
		res.Legs = len(all)

		if len(all) > 0 {
			ins, skip, ierr := iswsettle.Insert(ctx, db, all)
			res.Inserted, res.Skipped = ins, skip
			if ierr != nil {
				iswsettle.CloseRun(ctx, db, importID, res, ierr)
				respondErr(w, 500, "Insert failed: "+ierr.Error())
				return
			}
		}
		iswsettle.CloseRun(ctx, db, importID, res, nil)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"import_id": importID,
			"files":     res.Files,
			"legs":      res.Legs,
			"inserted":  res.Inserted,
			"skipped":   res.Skipped,
			"errors":    res.Errors,
		})
	}
}

// iswSettleSummary reports the Interswitch position by channel for a period,
// counting TRANSACTIONS (legs collapsed) rather than rows.
func iswSettleSummary(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		from, _ := validDate(r, "date_from")
		to, _ := validDate(r, "date_to")
		where := "1=1"
		var args []any
		n := 1
		if from != "" && to != "" {
			where = fmt.Sprintf("settlement_date BETWEEN $%d::date AND $%d::date", n, n+1)
			args = append(args, from, to)
			n += 2
		}

		byFamily, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT report_family, session,
			       COUNT(*)                       AS txns,
			       COALESCE(SUM(ABS(gross_kobo)),0) AS gross_kobo,
			       COALESCE(SUM(fees_kobo),0)     AS fees_kobo,
			       SUM(legs_n)                    AS legs
			FROM interswitch_transactions
			WHERE %s
			GROUP BY report_family, session
			ORDER BY txns DESC`, where), args...)
		if err != nil {
			respondErr(w, 500, "Query failed: "+err.Error())
			return
		}
		if byFamily == nil {
			byFamily = []map[string]any{}
		}

		daily, _ := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT settlement_date AS day, report_family,
			       COUNT(*) AS txns, COALESCE(SUM(ABS(gross_kobo)),0) AS gross_kobo
			FROM interswitch_transactions
			WHERE %s
			GROUP BY 1,2 ORDER BY 1`, where), args...)
		if daily == nil {
			daily = []map[string]any{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"by_family": byFamily,
			"daily":     daily,
		})
	}
}

func iswSettleImports(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, _ := db.PGQuery(r.Context(), `
			SELECT i.id, i.started_at, i.finished_at, i.status, i.files_n, i.legs_n,
			       i.inserted_n, i.skipped_n, COALESCE(i.errors,'') AS errors,
			       COALESCE(u.full_name,'system') AS actor
			FROM interswitch_imports i
			LEFT JOIN o3c_users u ON u.id = i.triggered_by
			ORDER BY i.started_at DESC LIMIT 50`)
		if rows == nil {
			rows = []map[string]any{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"data": rows}) //nolint:errcheck
	}
}
