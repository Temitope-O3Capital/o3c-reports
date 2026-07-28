package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/o3c/reports/core"
)

var dateRE      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var periodRE    = regexp.MustCompile(`^\d{4}-\d{2}$`)
var htmlTagRE   = regexp.MustCompile(`<[^>]*>`)

// stripHTMLTags removes HTML/XML tags from s to prevent stored-XSS in log fields.
func stripHTMLTags(s string) string { return htmlTagRE.ReplaceAllString(s, "") }

var (
	pwUpperRE   = regexp.MustCompile(`[A-Z]`)
	pwDigitRE   = regexp.MustCompile(`[0-9]`)
	pwSpecialRE = regexp.MustCompile(`[^A-Za-z0-9]`)
)

// validatePasswordComplexity returns an error message if pw does not meet the policy
// (min 12 chars, at least one uppercase, one digit, one special character).
// Returns "" if the password is valid.
func validatePasswordComplexity(pw string) string {
	if len(pw) < 12 {
		return "Password must be at least 12 characters"
	}
	if !pwUpperRE.MatchString(pw) {
		return "Password must contain at least one uppercase letter"
	}
	if !pwDigitRE.MatchString(pw) {
		return "Password must contain at least one digit"
	}
	if !pwSpecialRE.MatchString(pw) {
		return "Password must contain at least one special character"
	}
	return ""
}

// A10: Standardised machine-readable error codes for API consumers.
// Use in respondErr(w, code, ErrXxx) for documented error conditions.
const (
	ErrNotFound          = "RESOURCE_NOT_FOUND"
	ErrUnauthorized      = "UNAUTHORIZED"
	ErrForbidden         = "FORBIDDEN"
	ErrBadRequest        = "BAD_REQUEST"
	ErrValidation        = "VALIDATION_FAILED"
	ErrConflict          = "CONFLICT"
	ErrInternal          = "INTERNAL_ERROR"
	ErrInsufficientFunds = "INSUFFICIENT_FUNDS"
	ErrDuplicate         = "DUPLICATE_RECORD"
	ErrSessionExpired    = "SESSION_EXPIRED"
	ErrRateLimited       = "RATE_LIMITED"
	ErrIdempotencyReplay = "IDEMPOTENCY_KEY_REPLAYED"
)

// nullStr returns a *string pointer for s, or nil if s is empty (stores as SQL NULL).
func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// blindContactHMAC computes HMAC-SHA256(lower(trim(value)), ENCRYPTION_KEY) as a hex string.
// Returns "" if value or the key is empty — callers should store NULL in that case.
func blindContactHMAC(value string) string {
	key := os.Getenv("ENCRYPTION_KEY")
	value = strings.ToLower(strings.TrimSpace(value))
	if key == "" || value == "" {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

// respond writes a standard {data, data_source, data_as_of} JSON response.
// data_as_of is the server time the response was generated — frontends should
// display this instead of client render time so users know how fresh the data is.
func respond(w http.ResponseWriter, data any, source string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"data":        data,
		"data_source": source,
		"data_as_of":  time.Now().UTC().Format(time.RFC3339),
	})
}

// respondPaginated writes { data, total, data_source, data_as_of } — the standard
// paginated list response. Use instead of respond(w, map[string]any{"data":…,"total":…})
// which would double-wrap the payload inside respond's own "data" key.
func respondPaginated(w http.ResponseWriter, data any, total any, source string) {
	w.Header().Set("Content-Type", "application/json")
	if data == nil {
		data = []core.Row{}
	}
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"data":        data,
		"total":       total,
		"data_source": source,
		"data_as_of":  time.Now().UTC().Format(time.RFC3339),
	})
}

// respondErr writes a {detail, error_code} JSON error (A10).
func respondErr(w http.ResponseWriter, code int, msg string) {
	// S11: Strip internal error details from 5xx responses so DB errors, stack
	// traces, and internal paths are never sent to the client. Log at ERROR level
	// so the detail is still available in Railway logs.
	clientMsg := msg
	errorCode := msg
	if code >= 500 {
		slog.Error("internal error", "status", code, "detail", msg)
		clientMsg = "Internal server error"
		errorCode = ErrInternal
	} else if code == 404 {
		errorCode = ErrNotFound
	} else if code == 403 {
		errorCode = ErrForbidden
	} else if code == 401 {
		errorCode = ErrUnauthorized
	} else if code == 409 {
		errorCode = ErrConflict
	} else if code == 429 {
		errorCode = ErrRateLimited
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
		"detail":     clientMsg,
		"error_code": errorCode,
	})
}

// checkIdempotency checks the Idempotency-Key header against the idempotency_keys table.
// Returns (cached_body, cached_status, true) if a replay is found, or ("", 0, false) if new.
// On a new key, it inserts a pending row; the caller must call finaliseIdempotency once done.
func checkIdempotency(ctx context.Context, db *core.DB, w http.ResponseWriter, r *http.Request, operation string) (string, int, bool) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		return "", 0, false
	}
	userID := int64(0)
	if u := core.UserFromCtx(ctx); u != nil {
		userID = u.ID
	}
	rows, err := db.PGQuery(ctx,
		`SELECT response_status, response_body FROM idempotency_keys
		 WHERE idempotency_key=$1 AND user_id=$2 AND operation=$3`,
		key, userID, operation)
	if err == nil && len(rows) > 0 {
		status, _ := rows[0]["response_status"].(int64)
		body, _ := rows[0]["response_body"].(string)
		if status > 0 && body != "" {
			w.Header().Set("Idempotency-Replayed", "true")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(int(status))
			w.Write([]byte(body)) //nolint:errcheck
			return body, int(status), true
		}
	}
	// Register new key (pending — no response yet).
	db.PGExec(ctx, //nolint:errcheck
		`INSERT INTO idempotency_keys (idempotency_key, user_id, operation, created_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (idempotency_key, user_id, operation) DO NOTHING`,
		key, userID, operation)
	return "", 0, false
}

// finaliseIdempotency stores the response body and status for future replays.
func finaliseIdempotency(ctx context.Context, db *core.DB, r *http.Request, operation string, status int, body string) {
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		return
	}
	userID := int64(0)
	if u := core.UserFromCtx(ctx); u != nil {
		userID = u.ID
	}
	db.PGExec(ctx, //nolint:errcheck
		`UPDATE idempotency_keys SET response_status=$1, response_body=$2, completed_at=NOW()
		 WHERE idempotency_key=$3 AND user_id=$4 AND operation=$5`,
		status, body, key, userID, operation)
}

// respondOK writes a {"message": msg} JSON body with HTTP 200.
// Use for action-confirmation responses (approve, assign, etc.) instead of respondErr(w, 200, ...).
func respondOK(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": msg}) //nolint:errcheck
}

// qstr reads a query parameter string (empty string if absent).
func qstr(r *http.Request, key string) string {
	return strings.TrimSpace(r.URL.Query().Get(key))
}

// qint reads a query parameter integer, returning def if absent or invalid.
func qint(r *http.Request, key string, def, min, max int) int {
	s := r.URL.Query().Get(key)
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil || v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// validDate returns the date string if it matches YYYY-MM-DD, empty string if absent, error if malformed.
func validDate(r *http.Request, key string) (string, error) {
	s := r.URL.Query().Get(key)
	if s == "" {
		return "", nil
	}
	if !dateRE.MatchString(s) {
		return "", fmt.Errorf("invalid %s — must be YYYY-MM-DD", key)
	}
	return s, nil
}

// source selects "mssql_live" if any source in the slice is live, else "supabase_snapshot".
func pickSource(sources []string) string {
	for _, s := range sources {
		if s == "mssql_live" {
			return "mssql_live"
		}
	}
	return "supabase_snapshot"
}

// ── Filter — parameterized WHERE clause builder ───────────────────────────────
//
// Both MSSQL and PG receive the same args slice. Placeholders differ:
//   MSSQL: @p1, @p2, ...
//   PG:    $1,  $2, ...
//
// Usage:
//   var f Filter
//   f.Date("Transaction_Date", `"Transaction Date"`, dateFrom, dateTo)
//   f.Eq(" AND Agent=?", ` AND "Agent"=?`, agentVal)
//   data, src, err := db.DualQuery(ctx,
//       "SELECT ... FROM tbl WHERE 1=1" + f.MS(),
//       `SELECT ... FROM "tbl" WHERE 1=1` + f.PG(),
//       f.Args()...)

type Filter struct {
	ms   strings.Builder
	pg   strings.Builder
	args []any
}

func (f *Filter) next() int { return len(f.args) + 1 }

// Date appends a date-range filter. Either or both bounds may be empty.
// msCol is the MSSQL column expression (e.g. "Transaction_Date"),
// pgCol is the PG equivalent (e.g. `"Transaction Date"`).
func (f *Filter) Date(msCol, pgCol, from, to string) {
	n := f.next()
	switch {
	case from != "" && to != "":
		fmt.Fprintf(&f.ms, " AND CAST(%s AS DATE) BETWEEN @p%d AND @p%d", msCol, n, n+1)
		fmt.Fprintf(&f.pg, " AND %s::date BETWEEN $%d AND $%d", pgCol, n, n+1)
		f.args = append(f.args, from, to)
	case from != "":
		fmt.Fprintf(&f.ms, " AND CAST(%s AS DATE) >= @p%d", msCol, n)
		fmt.Fprintf(&f.pg, " AND %s::date >= $%d", pgCol, n)
		f.args = append(f.args, from)
	case to != "":
		fmt.Fprintf(&f.ms, " AND CAST(%s AS DATE) <= @p%d", msCol, n)
		fmt.Fprintf(&f.pg, " AND %s::date <= $%d", pgCol, n)
		f.args = append(f.args, to)
	}
}

// Eq appends an equality filter. Pass "?" as the placeholder in both clauses;
// it will be replaced with @pN / $N. Skipped when val is empty.
func (f *Filter) Eq(msClause, pgClause, val string) {
	if val == "" {
		return
	}
	n := f.next()
	f.ms.WriteString(strings.ReplaceAll(msClause, "?", fmt.Sprintf("@p%d", n)))
	f.pg.WriteString(strings.ReplaceAll(pgClause, "?", fmt.Sprintf("$%d", n)))
	f.args = append(f.args, val)
}

func (f *Filter) MS() string  { return f.ms.String() }
func (f *Filter) PG() string  { return f.pg.String() }
func (f *Filter) Args() []any { return f.args }

// coalesce returns a if non-empty, else b.
func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ── GL journal ────────────────────────────────────────────────────────────────

// glEntry describes one double-entry journal line.
type glEntry struct {
	Date          time.Time
	Description   string
	Reference     string
	DebitAccount  string
	CreditAccount string
	AmountKobo    int64
	SourceType    string
	SourceID      int64
	PostedBy      int64
}

// postJournalTx inserts a GL journal entry inside an existing transaction.
// Returns an error — callers must roll back and surface it.
func postJournalTx(ctx context.Context, tx *sql.Tx, e glEntry) error {
	if e.AmountKobo <= 0 {
		return fmt.Errorf("gl journal amount must be positive (got %d)", e.AmountKobo)
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO gl_journal_entries
			(entry_date, description, reference, debit_account, credit_account,
			 amount_kobo, source_type, source_id, posted_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
		e.Date, e.Description, e.Reference,
		e.DebitAccount, e.CreditAccount,
		e.AmountKobo, e.SourceType, e.SourceID, e.PostedBy)
	if err != nil {
		slog.Error("gl journal insert failed", "source", e.SourceType, "id", e.SourceID, "err", err)
	}
	return err
}

// postJournal inserts a GL journal entry outside a transaction (fire-safe helper for
// operations that don't already have a tx open). Logs on error and returns the error.
func postJournal(ctx context.Context, db *core.DB, e glEntry) error {
	tx, err := db.PG.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := postJournalTx(ctx, tx, e); err != nil {
		tx.Rollback() //nolint:errcheck
		return err
	}
	return tx.Commit()
}

// ── Credit activity log helpers ───────────────────────────────────────────────

// fmtKoboStr converts a kobo integer (any numeric type) to a 2-decimal naira string.
func fmtKoboStr(kobo any) string {
	var k int64
	switch v := kobo.(type) {
	case int64:
		k = v
	case float64:
		k = int64(v)
	case int:
		k = int64(v)
	}
	return fmt.Sprintf("%.2f", float64(k)/100)
}

// logCreditEvent writes one structured event to credit_activity_log.
// It is fire-and-forget: errors are logged but never propagated to callers.
func logCreditEvent(ctx context.Context, db *core.DB, r *http.Request, module, entityType, entityID, cif, action, description string, prev, next any) {
	user := core.UserFromCtx(ctx)
	if user == nil {
		return
	}
	ip := ""
	if r != nil {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			ip = strings.TrimSpace(parts[len(parts)-1])
		} else {
			ip = r.RemoteAddr
		}
	}
	var prevJSON, nextJSON any
	if prev != nil {
		if b, err := json.Marshal(prev); err == nil {
			prevJSON = string(b)
		}
	}
	if next != nil {
		if b, err := json.Marshal(next); err == nil {
			nextJSON = string(b)
		}
	}
	if _, err := db.PGQuery(ctx, `
		INSERT INTO credit_activity_log
			(module, actor_id, actor_name, actor_role, entity_type, entity_id,
			 account_cif, action, description, previous_state, new_state, ip_address)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		module, user.ID, user.FullName, user.Role,
		entityType, entityID, cif,
		action, description, prevJSON, nextJSON, ip,
	); err != nil {
		slog.Error("logCreditEvent", "module", module, "action", action, "err", err)
	}
}

// ── CSV helper ────────────────────────────────────────────────────────────────

func streamCSV(w http.ResponseWriter, filename string, rows []map[string]any) {
	if len(rows) == 0 {
		w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		w.Header().Set("Content-Type", "text/csv")
		return
	}

	cols := make([]string, 0, len(rows[0]))
	for k := range rows[0] {
		cols = append(cols, k)
	}

	safe := strings.NewReplacer(`"`, `_`, "\n", `_`, "\r", `_`).Replace(filename)
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="`+safe+`"`)

	cw := csv.NewWriter(w)
	cw.Write(cols) //nolint:errcheck
	for _, row := range rows {
		record := make([]string, len(cols))
		for i, c := range cols {
			if v := row[c]; v != nil {
				record[i] = fmt.Sprintf("%v", v)
			}
		}
		cw.Write(record) //nolint:errcheck
	}
	cw.Flush()
}
