package handlers

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/o3c/reports/core"
)

// ── Query building: the injection boundary ────────────────────────────────────

func TestExportRejectsUndeclaredColumn(t *testing.T) {
	d, ok := exportDatasetByKey("loan_book")
	if !ok {
		t.Fatal("loan_book dataset missing")
	}
	// The whole safety model is that a caller selects columns by key and an
	// unknown key is refused rather than pasted into the SELECT.
	for _, bad := range []string{
		"cl.status; DROP TABLE app.cbs_loans",
		"(SELECT password_hash FROM app.o3c_users LIMIT 1)",
		"nonexistent_column",
	} {
		_, _, _, err := buildExportQuery(d, exportRequest{Columns: []string{bad}}, 10)
		if err == nil {
			t.Fatalf("column %q was accepted; it must be rejected", bad)
		}
	}
}

func TestExportRejectsUndeclaredFilter(t *testing.T) {
	d, _ := exportDatasetByKey("loan_book")
	_, _, _, err := buildExportQuery(d, exportRequest{
		Filters: map[string]string{"1=1 OR": "x"},
	}, 10)
	if err == nil {
		t.Fatal("undeclared filter was accepted")
	}
}

func TestExportFilterValueIsBoundNotInterpolated(t *testing.T) {
	d, _ := exportDatasetByKey("loan_book")
	evil := "Active'; DROP TABLE app.cbs_loans;--"
	q, args, _, err := buildExportQuery(d, exportRequest{
		Filters: map[string]string{"status": evil},
	}, 10)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(q, "DROP TABLE") {
		t.Fatalf("filter value reached the SQL string:\n%s", q)
	}
	found := false
	for _, a := range args {
		if a == evil {
			found = true
		}
	}
	if !found {
		t.Fatal("filter value was not passed as a bound parameter")
	}
}

func TestExportColumnOrderIsRegistryOrderNotRequestOrder(t *testing.T) {
	d, _ := exportDatasetByKey("loan_book")
	// Deterministic output is the point: the same export must not produce a
	// different column order because the caller shuffled the request.
	a, _, colsA, err := buildExportQuery(d, exportRequest{
		Columns: []string{"status", "cif", "account_number"},
	}, 10)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	b, _, colsB, err := buildExportQuery(d, exportRequest{
		Columns: []string{"account_number", "status", "cif"},
	}, 10)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if a != b {
		t.Fatal("column order followed the request instead of the registry")
	}
	want := []string{"account_number", "cif", "status"}
	for i, c := range colsA {
		if c.Key != want[i] {
			t.Fatalf("col %d = %s, want %s", i, c.Key, want[i])
		}
	}
	if len(colsA) != len(colsB) {
		t.Fatal("column count differs between equivalent requests")
	}
}

func TestExportDateRequiredIsEnforced(t *testing.T) {
	d, _ := exportDatasetByKey("card_transactions")
	if !d.DateRequired {
		t.Fatal("card_transactions must require a date range: it holds >1m rows")
	}
	if err := validateExportRequest(d, exportRequest{}); err == nil {
		t.Fatal("unbounded export of card_transactions was allowed")
	}
	if err := validateExportRequest(d, exportRequest{DateFrom: "2026-01-01", DateTo: "2026-01-31"}); err != nil {
		t.Fatalf("valid bounded request rejected: %v", err)
	}
	if err := validateExportRequest(d, exportRequest{DateFrom: "2026-02-01", DateTo: "2026-01-01"}); err == nil {
		t.Fatal("reversed date range was accepted")
	}
	if err := validateExportRequest(d, exportRequest{DateFrom: "01/02/2026", DateTo: "2026-01-01"}); err == nil {
		t.Fatal("malformed date was accepted")
	}
}

// ── PII ───────────────────────────────────────────────────────────────────────

func TestExportNeverExposesRawPANorBVNorEncryptedID(t *testing.T) {
	for _, d := range exportDatasets {
		for _, c := range d.Cols {
			expr := c.Expr + " " + c.Key
			// A full PAN in a spreadsheet is a PCI-DSS incident.
			if strings.Contains(expr, "card_pan") && !strings.Contains(c.Expr, "RIGHT(") {
				t.Errorf("%s.%s exposes an unmasked card PAN", d.Key, c.Key)
			}
			if strings.Contains(expr, "c.bvn") && !strings.Contains(c.Expr, "RIGHT(") {
				t.Errorf("%s.%s exposes an unmasked BVN", d.Key, c.Key)
			}
			if strings.Contains(expr, "id_number_enc") || strings.Contains(expr, "id_number_hmac") {
				t.Errorf("%s.%s exports an encrypted ID number", d.Key, c.Key)
			}
			if strings.Contains(expr, "password") {
				t.Errorf("%s.%s references a password column", d.Key, c.Key)
			}
		}
	}
}

// ── Registry hygiene ──────────────────────────────────────────────────────────

func TestExportRegistryIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, d := range exportDatasets {
		if seen[d.Key] {
			t.Errorf("duplicate dataset key %q", d.Key)
		}
		seen[d.Key] = true
		if d.From == "" || d.Label == "" || d.Module == "" {
			t.Errorf("dataset %q is missing From/Label/Module", d.Key)
		}
		if len(d.Cols) == 0 {
			t.Errorf("dataset %q declares no columns", d.Key)
		}
		if d.maxRows() <= 0 {
			t.Errorf("dataset %q has no row cap", d.Key)
		}
		cols := map[string]bool{}
		for _, c := range d.Cols {
			if cols[c.Key] {
				t.Errorf("dataset %q has duplicate column %q", d.Key, c.Key)
			}
			cols[c.Key] = true
			if c.Label == "" {
				t.Errorf("dataset %q column %q has no label", d.Key, c.Key)
			}
		}
		for _, f := range d.Filters {
			// Exactly one placeholder, or the positional binding silently misaligns.
			if strings.Count(f.Expr, "?") != 1 {
				t.Errorf("dataset %q filter %q must contain exactly one ?", d.Key, f.Key)
			}
		}
	}
}

// ── Writers ───────────────────────────────────────────────────────────────────

func TestCSVNeutralisesFormulaInjection(t *testing.T) {
	cols := []exportCol{{Key: "name", Label: "Name", Type: colText}}
	rows := []map[string]any{
		{"name": `=cmd|'/c calc'!A1`},
		{"name": "+1+1"},
		{"name": "-2+3"},
		{"name": "@SUM(A1:A9)"},
		{"name": "Ada Obi"},
	}
	var buf bytes.Buffer
	if err := writeExportCSV(&buf, cols, rows); err != nil {
		t.Fatalf("write: %v", err)
	}
	out := buf.String()
	for _, dangerous := range []string{"\n=cmd", "\n+1+1", "\n-2+3", "\n@SUM"} {
		if strings.Contains(out, dangerous) {
			t.Errorf("unescaped formula in CSV: %q\n%s", dangerous, out)
		}
	}
	// A benign value must survive untouched.
	if !strings.Contains(out, "Ada Obi") {
		t.Error("ordinary value was mangled")
	}
}

func TestCSVQuotesEmbeddedCommas(t *testing.T) {
	// The hand-rolled client-side exports this replaces used .join(',') with no
	// quoting, so one customer named "Doe, John" shifted every column right.
	cols := []exportCol{
		{Key: "name", Label: "Name", Type: colText},
		{Key: "amount", Label: "Amount", Type: colKobo},
	}
	rows := []map[string]any{{"name": `Doe, John "JD"`, "amount": int64(123456)}}
	var buf bytes.Buffer
	if err := writeExportCSV(&buf, cols, rows); err != nil {
		t.Fatalf("write: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %q", len(lines), buf.String())
	}
	if !strings.Contains(lines[1], `"Doe, John ""JD"""`) {
		t.Errorf("comma/quote not escaped: %s", lines[1])
	}
	if !strings.HasSuffix(strings.TrimSpace(lines[1]), "1234.56") {
		t.Errorf("kobo not converted to naira: %s", lines[1])
	}
}

func TestExportValueFormatting(t *testing.T) {
	// nil used to render as the literal string "<nil>" in finance exports.
	if got := exportValue(nil, colText); got != "" {
		t.Errorf("nil rendered as %q, want empty", got)
	}
	if got := exportValue(int64(250_000_000_00), colKobo); got != "250000000.00" {
		t.Errorf("kobo → naira gave %q", got)
	}
	if got := exportValue(true, colBool); got != "Yes" {
		t.Errorf("bool gave %q", got)
	}
}

func TestXLSXIsAValidZipWithExpectedParts(t *testing.T) {
	cols := []exportCol{
		{Key: "name", Label: "Name", Type: colText},
		{Key: "amount", Label: "Amount", Type: colKobo},
	}
	rows := []map[string]any{
		{"name": "Ada & Sons <Ltd>", "amount": int64(500000)},
		{"name": "=1+1", "amount": nil},
	}
	var buf bytes.Buffer
	if err := writeExportXLSX(&buf, cols, rows); err != nil {
		t.Fatalf("write: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("not a valid zip: %v", err)
	}
	need := map[string]bool{
		"[Content_Types].xml":        false,
		"_rels/.rels":                false,
		"xl/workbook.xml":            false,
		"xl/_rels/workbook.xml.rels": false,
		"xl/worksheets/sheet1.xml":   false,
	}
	var sheet string
	for _, f := range zr.File {
		if _, ok := need[f.Name]; ok {
			need[f.Name] = true
		}
		if f.Name == "xl/worksheets/sheet1.xml" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			sheet = string(b)
		}
	}
	for name, present := range need {
		if !present {
			t.Errorf("xlsx is missing required part %s", name)
		}
	}
	// XML special characters must be escaped or Excel refuses to open the file.
	if !strings.Contains(sheet, "Ada &amp; Sons &lt;Ltd&gt;") {
		t.Errorf("XML not escaped in sheet:\n%s", sheet)
	}
	// A numeric column must be a real number so totals work in the spreadsheet.
	if !strings.Contains(sheet, "<v>5000.00</v>") {
		t.Errorf("kobo column not written as a number:\n%s", sheet)
	}
	// "=1+1" must be an inline string — typed as text, Excel never evaluates it.
	if !strings.Contains(sheet, `t="inlineStr"`) {
		t.Error("strings are not written as inline strings")
	}
}

func TestColLetters(t *testing.T) {
	for i, want := range map[int]string{0: "A", 25: "Z", 26: "AA", 27: "AB", 51: "AZ", 52: "BA"} {
		if got := colLetters(i); got != want {
			t.Errorf("colLetters(%d) = %s, want %s", i, got, want)
		}
	}
}

func TestExportFilenameIsHeaderSafe(t *testing.T) {
	// The filename is interpolated into a quoted Content-Disposition header.
	got := exportFilename(`evil"; drop`+"\r\nX-Injected: 1", fmtCSV)
	for _, bad := range []string{`"`, "\r", "\n", ";"} {
		if strings.Contains(got, bad) {
			t.Fatalf("filename %q still contains %q", got, bad)
		}
	}
	if !strings.HasSuffix(got, ".csv") {
		t.Errorf("wrong extension: %s", got)
	}
}

func TestParseExportFormat(t *testing.T) {
	for in, want := range map[string]exportFormat{
		"": fmtCSV, "csv": fmtCSV, "CSV": fmtCSV,
		"xlsx": fmtXLSX, "excel": fmtXLSX, "json": fmtJSON,
	} {
		got, ok := parseExportFormat(in)
		if !ok || got != want {
			t.Errorf("parseExportFormat(%q) = %v/%v, want %v", in, got, ok, want)
		}
	}
	if _, ok := parseExportFormat("pdf"); ok {
		t.Error("pdf should not be accepted")
	}
}

// ── Live: every registered query must actually execute ────────────────────────

// TestExportDatasetsRunLive executes every dataset in the registry, and every BI
// module query, against the real database.
//
// This exists because the module's original failure mode was shipping SQL that
// nobody ever ran: four of the seven BI modules referenced tables or columns that
// do not exist in this database, and failed only at request time.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestExportDatasetsRunLive -v
func TestExportDatasetsRunLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}
	ctx := t.Context()

	for _, d := range exportDatasets {
		t.Run("dataset/"+d.Key, func(t *testing.T) {
			req := exportRequest{}
			if d.DateRequired {
				req.DateFrom, req.DateTo = "2020-01-01", "2030-01-01"
			}
			// All columns, so every declared expression is compiled.
			q, args, cols, err := buildExportQuery(d, req, 5)
			if err != nil {
				t.Fatalf("build: %v", err)
			}
			rows, err := db.PGQuery(ctx, q, args...)
			if err != nil {
				t.Fatalf("query failed:\n%s\nerr: %v", q, err)
			}
			// Every declared column must actually come back, or the file would
			// contain a silently empty column.
			if len(rows) > 0 {
				for _, c := range cols {
					if _, ok := rows[0][c.Key]; !ok {
						t.Errorf("column %q declared but not returned", c.Key)
					}
				}
			}
			t.Logf("%-24s %d cols, %d sample rows", d.Key, len(cols), len(rows))

			// Each declared filter must also compile.
			for _, f := range d.Filters {
				fq, fargs, _, err := buildExportQuery(d, exportRequest{
					DateFrom: req.DateFrom, DateTo: req.DateTo,
					Filters: map[string]string{f.Key: "x"},
				}, 1)
				if err != nil {
					t.Errorf("filter %q build: %v", f.Key, err)
					continue
				}
				if _, err := db.PGQuery(ctx, fq, fargs...); err != nil {
					t.Errorf("filter %q failed: %v", f.Key, err)
				}
			}
		})
	}

	// The BI report-builder modules use a different code path.
	for _, module := range []string{"LOS", "Collections", "CRM", "Finance", "Helpdesk", "Campaigns", "Compliance"} {
		t.Run("bi_module/"+module, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/?from=2020-01-01&to=2030-01-01", nil)
			q, _, err := biQueryForReport(r, map[string]any{
				"module": module, "date_range": "last_30_days",
			})
			if err != nil {
				t.Fatalf("build: %v", err)
			}
			if _, err := db.PGQuery(ctx, q); err != nil {
				t.Fatalf("module %s failed:\n%s\nerr: %v", module, q, err)
			}
		})
	}

	// And the fixed operational reports, which had no UI reaching them at all.
	t.Run("npl_return_provisions", func(t *testing.T) {
		rec := httptest.NewRecorder()
		reportNPLReturn(db)(rec, httptest.NewRequest("GET", "/", nil))
		if rec.Code != 200 {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), `"dpd_buckets":[]`) {
			t.Error("NPL return still produced empty DPD buckets")
		}
	})
}

// TestExportEndToEndLive pulls a real file through the whole engine.
//
//	EXPORT_LIVE_TEST=1 go test ./handlers -run TestExportEndToEndLive -v
func TestExportEndToEndLive(t *testing.T) {
	if os.Getenv("EXPORT_LIVE_TEST") != "1" {
		t.Skip("set EXPORT_LIVE_TEST=1")
	}
	env := readEnv(t, "../.env")
	pg, err := sql.Open("pgx", env["DATABASE_URL"])
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer pg.Close()
	db := &core.DB{PG: pg}

	d, _ := exportDatasetByKey("loan_book")
	q, args, cols, err := buildExportQuery(d, exportRequest{}, 100)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	rows, err := db.PGQuery(t.Context(), q, args...)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(rows) == 0 {
		t.Skip("no loans on the book to export")
	}

	for _, f := range []exportFormat{fmtCSV, fmtXLSX, fmtJSON} {
		rec := httptest.NewRecorder()
		if err := writeExport(rec, f, exportFilename("loan_book", f), cols, rows); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if rec.Body.Len() == 0 {
			t.Fatalf("%s produced an empty file", f)
		}
		cd := rec.Header().Get("Content-Disposition")
		if !strings.Contains(cd, "."+f.ext()) {
			t.Errorf("%s: wrong Content-Disposition %q", f, cd)
		}
		t.Logf("%-5s %d rows → %d bytes", f, len(rows), rec.Body.Len())
	}

	// CSV must have exactly one header line plus one line per row (no row may
	// contain a raw newline that breaks the line count).
	var buf bytes.Buffer
	if err := writeExportCSV(&buf, cols, rows); err != nil {
		t.Fatalf("csv: %v", err)
	}
	r := csvLineCount(buf.String())
	if r != len(rows)+1 {
		t.Errorf("csv has %d records, want %d", r, len(rows)+1)
	}
}

// csvLineCount counts CSV records, respecting quoted fields.
func csvLineCount(s string) int {
	n, inQuotes := 0, false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			inQuotes = !inQuotes
		case '\n':
			if !inQuotes {
				n++
			}
		}
	}
	if len(s) > 0 && !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

var _ = fmt.Sprintf
