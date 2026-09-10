package handlers

// Serving uploaded LOS documents back to staff.
//
// Three things were broken here, and they compounded. The frontend called
// /api/los/applications/{id}/documents while the route was registered at
// /{id}/documents, so every upload 404'd and app.los_documents never held a row.
// With that fixed, the next problem surfaced: the upload handler writes a
// file_url of /api/los/documents/file/{app}/{uid}/{name}, and no route ever
// served that path — so a document, once uploaded, could not be opened. And the
// local fallback wrote to "/tmp/los-documents", which on Windows lands on
// whatever the current drive is and is a directory the OS may clear.
//
// The fix keeps the storage layout but addresses files by document id rather
// than by a path assembled from user input. losDocumentContent looks the row up,
// reads storage_key from the database, and streams it. There is no path segment
// a caller can influence, so directory traversal is not reachable by
// construction rather than by filtering.

import (
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// losDocumentDir is where uploaded documents live when object storage is not
// configured. E: is the data drive on this host — Postgres WAL, backups and the
// intelligence document store all sit there — and unlike a temp directory it is
// not something the OS reclaims.
func losDocumentDir() string {
	if v := strings.TrimSpace(os.Getenv("LOS_DOCUMENT_DIR")); v != "" {
		return v
	}
	return "E:/o3c-documents/los"
}

// losDocumentContent streams one uploaded document.
//
// Read-only, so it sits on viewDoor alongside the document list: compliance
// auditing a file has to be able to open the evidence, not just see that a row
// exists. It serves inline rather than as an attachment so the workspace can
// render it in a modal instead of bouncing staff into a download.
func losDocumentContent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "Invalid document ID")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT file_name, COALESCE(storage_key,'') AS storage_key, COALESCE(file_url,'') AS file_url
			  FROM app.los_documents WHERE id = $1`, docID)
		if err != nil {
			respondErrLog(w, 500, "Could not read the document", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "Document not found")
			return
		}
		name := str(rows[0]["file_name"])
		key := str(rows[0]["storage_key"])

		// An object-storage upload keeps its remote URL in file_url and nothing
		// local to stream; send the caller there rather than pretending to serve it.
		if key == "" || strings.HasPrefix(strings.ToLower(key), "los-documents/") {
			if u := str(rows[0]["file_url"]); u != "" {
				http.Redirect(w, r, u, http.StatusFound)
				return
			}
			respondErr(w, 404, "This document has no stored file")
			return
		}

		f, err := os.Open(key)
		if err != nil {
			// The row outliving its file is worth saying plainly — it means the
			// store was cleared or moved, not that the document never existed.
			respondErrLog(w, 404, "The stored file is missing from disk", err)
			return
		}
		defer f.Close() //nolint:errcheck

		ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		// inline: the workspace renders this in a modal. filename is quoted so a
		// comma or space in it cannot split the header.
		w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", name))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=300")
		if st, serr := f.Stat(); serr == nil {
			w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
		}
		if _, err := io.Copy(w, f); err != nil {
			// Headers are already sent, so an error body would corrupt the response.
			// Log and let the truncated stream speak for itself.
			slog.Error("los document stream failed", "doc_id", docID, "err", err)
		}
	}
}
