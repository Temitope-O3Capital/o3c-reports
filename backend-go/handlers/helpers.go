package handlers

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// respond writes a standard {data, data_source} JSON response.
func respond(w http.ResponseWriter, data any, source string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"data":        data,
		"data_source": source,
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

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)

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
