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

var dateRE   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
var periodRE = regexp.MustCompile(`^\d{4}-\d{2}$`)

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

// respondErr writes a {detail} JSON error.
func respondErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"detail": msg}) //nolint:errcheck
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
