package handlers

// Lead / contact document uploads — the pre-application file store (see migration 232).
//
// Mirrors the LOS document storage (R2 when configured, local disk under losDocumentDir()
// otherwise; served back by id, never by a caller-supplied path). Each upload also emits a
// 'document' activity so the file shows on the customer's timeline and follows the person.

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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// activityUploadDocument stores a document against a lead/contact/customer and records it on
// the timeline. multipart form: file, doc_type, and any of lead_id / contact_id / cif / phone.
func activityUploadDocument(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(20 << 20); err != nil {
			respondErr(w, 400, "failed to parse form")
			return
		}
		docType := strings.TrimSpace(r.FormValue("doc_type"))
		if docType == "" {
			docType = "Document"
		}
		var leadID, contactID *int64
		if v := r.FormValue("lead_id"); v != "" {
			if n, e := strconv.ParseInt(v, 10, 64); e == nil {
				leadID = &n
			}
		}
		if v := r.FormValue("contact_id"); v != "" {
			if n, e := strconv.ParseInt(v, 10, 64); e == nil {
				contactID = &n
			}
		}
		cif := strings.TrimSpace(r.FormValue("cif"))
		phone := normalizePhone(r.FormValue("phone"))
		if leadID == nil && contactID == nil && cif == "" && phone == "" {
			respondErr(w, 400, "a document needs an anchor (lead_id, contact_id, cif or phone)")
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			respondErr(w, 400, "field 'file' is required")
			return
		}
		defer file.Close() //nolint:errcheck
		data, err := io.ReadAll(file)
		if err != nil {
			respondErr(w, 500, "failed to read file")
			return
		}
		contentType := header.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		filename := strings.ReplaceAll(header.Filename, " ", "_")
		uid := fmt.Sprintf("%d", time.Now().UnixNano())

		// Store: R2 if configured, else local disk (same layout/host dir as LOS docs).
		accountID := os.Getenv("R2_ACCOUNT_ID")
		bucketName := os.Getenv("R2_BUCKET_NAME")
		accessKey := os.Getenv("R2_ACCESS_KEY_ID")
		secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")
		var fileURL, storageKey string
		if accountID != "" && bucketName != "" && accessKey != "" && secretKey != "" {
			storageKey = fmt.Sprintf("lead-documents/%s/%s", uid, filename)
			endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com/%s/%s", accountID, bucketName, storageKey)
			if err := r2Put(endpoint, accessKey, secretKey, accountID, bucketName, storageKey, contentType, data); err != nil {
				slog.Warn("activityUploadDocument: R2 upload failed", "err", err)
				respondErr(w, 502, "file upload failed")
				return
			}
			if base := strings.TrimRight(os.Getenv("R2_PUBLIC_BASE_URL"), "/"); base != "" {
				fileURL = base + "/" + storageKey
			} else {
				fileURL = endpoint
			}
		} else {
			dir := fmt.Sprintf("%s/leads/%s", strings.TrimRight(losDocumentDir(), "/"), uid)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				respondErr(w, 500, "storage error")
				return
			}
			storageKey = fmt.Sprintf("%s/%s", dir, filename)
			if err := os.WriteFile(storageKey, data, 0o644); err != nil {
				respondErr(w, 500, "write error")
				return
			}
		}

		var uploadedBy *int64
		u := core.UserFromCtx(r.Context())
		if u != nil {
			uploadedBy = &u.ID
		}
		rows, err := db.PGQuery(r.Context(), `
			INSERT INTO app.lead_documents
			    (lead_id, contact_id, cif, phone, doc_type, file_name, file_url, storage_key, file_size_bytes, uploaded_by)
			VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,NULLIF($7,''),$8,$9,$10)
			RETURNING id`,
			leadID, contactID, cif, phone, docType, filename, fileURL, storageKey, len(data), uploadedBy)
		if err != nil || len(rows) == 0 {
			respondErrLog(w, 500, "could not save document", err)
			return
		}
		docID := toInt64(rows[0]["id"])
		if fileURL == "" {
			fileURL = fmt.Sprintf("/api/activities/documents/%d/content", docID)
			db.PGExec(r.Context(), `UPDATE app.lead_documents SET file_url=$1 WHERE id=$2`, fileURL, docID) //nolint:errcheck
		}

		// Timeline: a document collected → 'document' activity, anchored like the doc row.
		aid, aname, ateam := actorOf(u)
		logActivitySafe(r.Context(), db, Activity{
			LeadID: leadID, ContactID: contactID, CIF: cif, Phone: phone,
			ActorUserID: aid, ActorName: aname, ActorTeam: ateam,
			Type: "document", Subject: "Document collected — " + docType, Source: "lead_document",
			EntityType: "lead_document", EntityID: strconv.FormatInt(docID, 10),
			Metadata: map[string]any{"doc_type": docType, "file_name": filename, "file_url": fileURL},
		})

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		respond(w, core.Row{"id": docID, "doc_type": docType, "file_name": filename, "file_url": fileURL}, "json")
	}
}

// activityDocumentContent streams one lead/contact document by id (mirrors losDocumentContent).
func activityDocumentContent(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		docID, err := strconv.ParseInt(chi.URLParam(r, "doc_id"), 10, 64)
		if err != nil {
			respondErr(w, 400, "invalid document id")
			return
		}
		rows, err := db.PGQuery(r.Context(), `
			SELECT file_name, COALESCE(storage_key,'') AS storage_key, COALESCE(file_url,'') AS file_url
			  FROM app.lead_documents WHERE id = $1`, docID)
		if err != nil {
			respondErrLog(w, 500, "could not read the document", err)
			return
		}
		if len(rows) == 0 {
			respondErr(w, 404, "document not found")
			return
		}
		name := str(rows[0]["file_name"])
		key := str(rows[0]["storage_key"])
		if key == "" || strings.HasPrefix(strings.ToLower(key), "lead-documents/") {
			if u := str(rows[0]["file_url"]); u != "" {
				http.Redirect(w, r, u, http.StatusFound)
				return
			}
			respondErr(w, 404, "this document has no stored file")
			return
		}
		f, err := os.Open(key)
		if err != nil {
			respondErrLog(w, 404, "the stored file is missing from disk", err)
			return
		}
		defer f.Close() //nolint:errcheck
		ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", name))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, max-age=300")
		if st, serr := f.Stat(); serr == nil {
			w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
		}
		if _, err := io.Copy(w, f); err != nil {
			slog.Error("lead document stream failed", "doc_id", docID, "err", err)
		}
	}
}
