package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// Saved-report export logging.
//
// This was the only part of the legacy BI module (handlers/bi.go) that live code
// actually used: reports_saved.go calls it twice and report_table.go once, so a saved
// report downloaded through the real Report Builder lands in the same report_export_log
// as a dataset export. It moved here when bi.go was deleted, and it was called
// logBIExport until then — a name that would otherwise be the last trace of a module
// that no longer exists, pointing readers at a file they cannot find.

// logReportExport records a saved-report download in the same log as dataset exports,
// so the compliance view of "what left the building" is complete.
func logReportExport(ctx context.Context, db *core.DB, r *http.Request,
	name, module string, format exportFormat, rowCount int) {

	var uid any
	var actorName, actorRole string
	if u := core.UserFromCtx(ctx); u != nil {
		uid, actorName, actorRole = u.ID, u.FullName, u.Role
	}
	meta, _ := json.Marshal(map[string]any{"module": module, "saved_report": name})

	ip := ""
	if r != nil {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		} else {
			ip = r.RemoteAddr
		}
	}

	if _, err := db.PGExec(ctx, `
		INSERT INTO report_export_log
			(report_type, filters, row_count, created_by, format, status,
			 actor_name, actor_role, ip_address)
		VALUES ($1, $2::jsonb, $3, $4, $5, 'ok', $6, $7, $8)`,
		"saved_report", string(meta), rowCount, uid, string(format),
		actorName, actorRole, ip); err != nil {
		slog.Error("logReportExport", "report", name, "err", err)
	}
}
