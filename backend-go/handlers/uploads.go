package handlers

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/reports/core"
)

func RegisterUploads(r chi.Router, db *core.DB) {
	r.Use(core.RequirePages("uploads"))
	r.Get("/audit", uploadAuditLog(db))
}

func uploadAuditLog(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := qint(r, "limit", 200, 1, 1000)
		where := "1=1"
		var args []any
		n := 1
		if v := qstr(r, "report_type"); v != "" {
			where += fmt.Sprintf(" AND a.report_type=$%d", n)
			args = append(args, v); n++
		}
		args = append(args, limit)
		rows, err := db.PGQuery(r.Context(), fmt.Sprintf(`
			SELECT a.id, a.report_type, a.file_names, a.cycle_label,
			       a.row_counts, a.status, a.error_msg, a.uploaded_at,
			       u.full_name  AS uploaded_by_name,
			       u.email      AS uploaded_by_email
			FROM upload_audit_log a
			LEFT JOIN o3c_users u ON u.id=a.uploaded_by
			WHERE %s
			ORDER BY a.uploaded_at DESC LIMIT $%d`, where, n), args...)
		if err != nil {
			respondErr(w, 500, "Query failed"); return
		}
		jsonRows(w, rows)
	}
}
