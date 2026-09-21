package handlers

// Upload ledger.
//
// Every manual dataset import records one row in app.upload_audit_log (migration
// 245) — successful, partial or failed. Before this, three of the four manual
// sources (CCS EODTXN, card cycle, CC statements) left no run record anywhere:
// an upload that failed was indistinguishable from an upload nobody attempted, and
// the Data Management page's ledger endpoint read a table that did not exist.

import (
	"context"
	"encoding/json"
	"log/slog"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/o3c/workspace/core"
)

// maxUploadErrLen caps error_msg. A bulk import can produce one error per line;
// the ledger needs enough to diagnose, not a copy of the file.
const maxUploadErrLen = 2000

// recordUpload writes one ledger row. Status is derived rather than passed so
// every importer uses the same vocabulary:
//
//	success  errCount == 0
//	error    errCount > 0 and nothing imported
//	partial  errCount > 0 and something imported
//
// Best-effort by design: a ledger write failure is logged and never fails the
// import the user is waiting on.
func recordUpload(ctx context.Context, db *core.DB, r *http.Request, reportType string,
	files []string, cycleLabel string, counts map[string]any, okCount, errCount int, errs []string) {

	status := "success"
	switch {
	case errCount > 0 && okCount == 0:
		status = "error"
	case errCount > 0:
		status = "partial"
	}

	var userID int64
	if u := core.UserFromCtx(r.Context()); u != nil {
		userID = u.ID
	}
	if files == nil {
		files = []string{}
	}
	if counts == nil {
		counts = map[string]any{}
	}
	fileJSON, _ := json.Marshal(files)
	countJSON, _ := json.Marshal(counts)

	msg := strings.Join(errs, "; ")
	if len(msg) > maxUploadErrLen {
		msg = msg[:maxUploadErrLen] + "…"
	}

	if _, err := db.PGExec(ctx, `
		INSERT INTO app.upload_audit_log
		    (uploaded_by, report_type, file_names, cycle_label, row_counts, status, error_msg)
		VALUES (NULLIF($1::bigint, 0), $2, $3::jsonb, NULLIF($4, ''), $5::jsonb, $6, NULLIF($7, ''))`,
		userID, reportType, string(fileJSON), cycleLabel, string(countJSON), status, msg); err != nil {
		slog.Warn("upload ledger: could not record upload", "report_type", reportType, "status", status, "err", err)
	}
}

// uploadFileNames lists the original filenames of a multipart upload.
func uploadFileNames(fhs []*multipart.FileHeader) []string {
	names := make([]string, 0, len(fhs))
	for _, fh := range fhs {
		if fh != nil {
			names = append(names, fh.Filename)
		}
	}
	return names
}
