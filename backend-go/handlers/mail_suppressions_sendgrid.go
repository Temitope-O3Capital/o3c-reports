package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/o3c/workspace/core"
)

// ── SendGrid suppression management ─────────────────────────────────────────
//
// SendGrid keeps its OWN suppression lists (global unsubscribes, bounces,
// blocks, spam reports, invalid addresses) and enforces them BEFORE delivery —
// independent of our local mail_suppressions table. A recipient on any of these
// is silently dropped ("drop / Unsubscribed Address"), so mail can be accepted
// (HTTP 202) yet never delivered. These admin endpoints surface those lists in
// the workspace (Mail Health) and let an admin look one up or remove an entry —
// e.g. a customer who unsubscribed but has since asked to receive mail again —
// without leaving for the SendGrid dashboard.

// sgSupType maps a friendly type to its SendGrid list + single-record paths.
type sgSupType struct {
	listPath   string // GET list
	itemPath   string // GET/DELETE single: email appended
	deletePath string // DELETE single: email appended (global unsub uses the asm path)
}

var sgSupTypes = map[string]sgSupType{
	"unsubscribes": {"/v3/suppression/unsubscribes", "/v3/asm/suppressions/global/", "/v3/asm/suppressions/global/"},
	"bounces":      {"/v3/suppression/bounces", "/v3/suppression/bounces/", "/v3/suppression/bounces/"},
	"blocks":       {"/v3/suppression/blocks", "/v3/suppression/blocks/", "/v3/suppression/blocks/"},
	"spam":         {"/v3/suppression/spam_reports", "/v3/suppression/spam_reports/", "/v3/suppression/spam_reports/"},
	"invalid":      {"/v3/suppression/invalid_emails", "/v3/suppression/invalid_emails/", "/v3/suppression/invalid_emails/"},
}

var sgSupOrder = []string{"unsubscribes", "bounces", "blocks", "spam", "invalid"}

// sendgridAPIRequest performs an authenticated call to the SendGrid REST API and
// returns the status code and raw body. Read-only for GET; DELETE mutates.
func sendgridAPIRequest(ctx context.Context, db *core.DB, method, path string, body []byte) (int, []byte, error) {
	key := resolveCredKey(ctx, db, "SENDGRID_API_KEY")
	if key == "" {
		return 0, nil, errSendgridKey
	}
	var rdr io.Reader
	if len(body) > 0 {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.sendgrid.com"+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b, nil
}

var errSendgridKey = &sgErr{"SENDGRID_API_KEY not configured"}

type sgErr struct{ s string }

func (e *sgErr) Error() string { return e.s }

// sgSuppressionsList returns one SendGrid suppression list (paged), normalised.
func sgSuppressionsList(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		typ := qstr(r, "type")
		if typ == "" {
			typ = "unsubscribes"
		}
		t, ok := sgSupTypes[typ]
		if !ok {
			respondErr(w, 400, "Unknown suppression type")
			return
		}
		limit := qint(r, "limit", 200, 1, 500)
		offset := qint(r, "offset", 0, 0, 1000000)
		q := url.Values{}
		q.Set("limit", strconv.Itoa(limit))
		q.Set("offset", strconv.Itoa(offset))
		code, body, err := sendgridAPIRequest(ctx, db, "GET", t.listPath+"?"+q.Encode(), nil)
		if err != nil {
			respondErrLog(w, 502, "Could not reach SendGrid", err)
			return
		}
		if code < 200 || code >= 300 {
			respondErr(w, 502, "SendGrid error: "+truncateMsg(body))
			return
		}
		var raw []map[string]any
		_ = json.Unmarshal(body, &raw)
		filter := strings.ToLower(strings.TrimSpace(qstr(r, "q")))
		out := make([]map[string]any, 0, len(raw))
		for _, e := range raw {
			email := str(e["email"])
			if filter != "" && !strings.Contains(strings.ToLower(email), filter) {
				continue
			}
			out = append(out, map[string]any{
				"email":   email,
				"type":    typ,
				"reason":  e["reason"],
				"status":  e["status"],
				"created": e["created"], // unix seconds
			})
		}
		respond(w, map[string]any{"type": typ, "items": out, "count": len(out), "offset": offset, "limit": limit}, "sendgrid")
	}
}

// sgSuppressionDelete removes an address from a SendGrid suppression list and
// mirrors the removal onto our local list so the two agree.
func sgSuppressionDelete(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		typ := chi.URLParam(r, "type")
		email := strings.TrimSpace(chi.URLParam(r, "email"))
		// chi returns the path param still percent-encoded (the frontend sends the
		// address encodeURIComponent'd, so "@" arrives as "%40"); decode it.
		if dec, err := url.PathUnescape(email); err == nil {
			email = strings.TrimSpace(dec)
		}
		t, ok := sgSupTypes[typ]
		if !ok {
			respondErr(w, 400, "Unknown suppression type")
			return
		}
		if !strings.Contains(email, "@") {
			respondErr(w, 422, "A valid email is required")
			return
		}
		code, body, err := sendgridAPIRequest(ctx, db, "DELETE", t.deletePath+url.PathEscape(email), nil)
		if err != nil {
			respondErrLog(w, 502, "Could not reach SendGrid", err)
			return
		}
		if code < 200 || code >= 300 {
			respondErr(w, 502, "SendGrid error: "+truncateMsg(body))
			return
		}
		// Keep our local list consistent (harmless if the address isn't on it).
		db.PGExec(ctx, `UPDATE mail_suppressions SET is_active=false, updated_at=NOW() WHERE lower(email)=lower($1)`, email) //nolint:errcheck
		who := ""
		if u := core.UserFromCtx(ctx); u != nil {
			who = u.Sub
		}
		slog.Info("sendgrid suppression removed", "type", typ, "email", email, "by", who)
		respondOK(w, "Removed "+email+" from SendGrid "+typ)
	}
}

// sgSuppressionLookup reports which SendGrid lists an address currently sits on —
// a single-customer deliverability check for tracking / Customer 360.
func sgSuppressionLookup(db *core.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		email := strings.TrimSpace(qstr(r, "email"))
		if !strings.Contains(email, "@") {
			respondErr(w, 422, "A valid email is required")
			return
		}
		on := map[string]any{}
		anyOn := false
		for _, typ := range sgSupOrder {
			t := sgSupTypes[typ]
			code, body, err := sendgridAPIRequest(ctx, db, "GET", t.itemPath+url.PathEscape(email), nil)
			if err != nil || code < 200 || code >= 300 {
				on[typ] = false
				continue
			}
			present := false
			if typ == "unsubscribes" {
				// global check returns {"recipient_email":"..."} when present, {} when not
				var m map[string]any
				_ = json.Unmarshal(body, &m)
				present = str(m["recipient_email"]) != ""
			} else {
				var arr []any
				_ = json.Unmarshal(body, &arr)
				present = len(arr) > 0
			}
			on[typ] = present
			anyOn = anyOn || present
		}
		respond(w, map[string]any{"email": email, "suppressed": anyOn, "on": on}, "sendgrid")
	}
}

func truncateMsg(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	if s == "" {
		s = "no detail"
	}
	return s
}
