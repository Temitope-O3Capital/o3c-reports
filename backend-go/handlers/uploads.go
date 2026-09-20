package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

func RegisterUploads(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("uploads"))
	r.Get("/audit", uploadAuditLog(db))
	r.Get("/pending", uploadsOverdue(db))
}

// uploadsOverdue lists the manual-upload sources and how overdue each one is.
//
// Nothing ever showed this. The three manual sources sat 45-47 days stale while
// the page that launches their importers looked perfectly normal, because it only
// ever showed what HAD been uploaded — never what hadn't. Thresholds and owners
// come from app.pipeline_source via the freshness view, so this page and the
// alerts can never disagree about what counts as overdue.
func uploadsOverdue(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.PGQuery(r.Context(), `
			SELECT f.source_key, f.label, f.owner, f.state, f.notes, f.last_data_at,
			       EXTRACT(EPOCH FROM f.data_age)::bigint   AS data_age_sec,
			       EXTRACT(EPOCH FROM f.stale_after)::bigint AS stale_after_sec,
			       EXTRACT(EPOCH FROM f.warn_after)::bigint  AS warn_after_sec,
			       u.last_upload_at, u.last_upload_status, u.last_upload_by
			  FROM app.v_pipeline_freshness f
			  LEFT JOIN LATERAL (
			      SELECT a.uploaded_at AS last_upload_at,
			             a.status      AS last_upload_status,
			             usr.full_name AS last_upload_by
			        FROM app.upload_audit_log a
			        LEFT JOIN o3c_users usr ON usr.id = a.uploaded_by
			       WHERE a.report_type = f.source_key
			       ORDER BY a.uploaded_at DESC
			       LIMIT 1
			  ) u ON true
			 WHERE f.category = 'manual_upload' AND f.enabled
			 ORDER BY f.data_age DESC NULLS FIRST`)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}

func uploadAuditLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "report_type"); v != "" {
			where += fmt.Sprintf(" AND a.report_type=$%d", n)
			args = append(args, v)
			n++
		}
		// L1: optional date-range filter on uploaded_at.
		if v := qstr(r, "from"); v != "" {
			where += fmt.Sprintf(" AND a.uploaded_at >= $%d::timestamptz", n)
			args = append(args, v)
			n++
		}
		if v := qstr(r, "to"); v != "" {
			where += fmt.Sprintf(" AND a.uploaded_at <= $%d::timestamptz", n)
			args = append(args, v)
			n++
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT a.id, a.report_type, a.file_names, a.cycle_label,
			       a.row_counts, a.status, a.error_msg, a.uploaded_at,
			       u.full_name  AS uploaded_by_name,
			       u.email      AS uploaded_by_email
			-- The ledger is two sources. Manual imports write upload_audit_log
			-- (migration 245); Interswitch settlement already recorded its runs in
			-- interswitch_imports, so it is unioned in rather than double-written.
			-- Settlement ids are negated: the UI keys rows on a numeric id and the two
			-- tables' sequences overlap. The alias stays "a" so every filter above
			-- applies to both halves unchanged.
			FROM (
			    SELECT id, report_type, file_names, cycle_label, row_counts,
			           status, error_msg, uploaded_at, uploaded_by
			      FROM upload_audit_log
			    UNION ALL
			    SELECT -id, 'interswitch_settlement',
			           jsonb_build_array(files_n || ' file(s)'), NULL,
			           jsonb_build_object('legs', legs_n, 'inserted', inserted_n, 'skipped', skipped_n),
			           CASE status WHEN 'ok' THEN 'success' ELSE status END,
			           errors, started_at, triggered_by
			      FROM interswitch_imports
			) a
			LEFT JOIN o3c_users u ON u.id=a.uploaded_by
			WHERE %s
			ORDER BY a.uploaded_at DESC LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErrLog(w, 500, "Query failed", err)
			return
		}
		jsonRows(w, rows)
	}
}
