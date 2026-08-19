package handlers

import (
	"archive/zip"
	"bufio"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

/*
Export writers — the single place a data file is produced in this workspace.

Everything that leaves the building as a file goes through here, so the three
properties that matter are guaranteed once rather than re-implemented (and
forgotten) per page:

  1. Deterministic column order. Callers pass an ordered []exportCol. The old
     streamCSV built its header with `for k := range rows[0]`, and Go randomises
     map iteration — so the same export produced a different column order on
     every request and any downstream script or Excel template broke at random.
  2. CSV injection is neutralised. A cell beginning = + - @ (or a leading tab /
     CR, which Excel strips before parsing) is executed as a formula when the
     file is opened. Prefixing with an apostrophe keeps the value visible and
     inert. This applies to CSV only — in XLSX an inline string is typed as a
     string and is never evaluated, so escaping there would corrupt real data.
  3. Values are formatted once, consistently: kobo → naira with 2dp, timestamps
     → ISO-8601, NULL → empty (not the Go string "<nil>", which is what
     fmt.Sprintf("%v", nil) produces and what the old exports actually shipped).
*/

// exportColType drives value formatting. Anything unrecognised is treated as text.
type exportColType string

const (
	colText     exportColType = "text"
	colInt      exportColType = "int"
	colKobo     exportColType = "kobo"  // integer minor units → major units, 2dp
	colMoney    exportColType = "money" // already major units (numeric columns)
	colPct      exportColType = "pct"
	colDate     exportColType = "date"     // YYYY-MM-DD
	colDateTime exportColType = "datetime" // RFC3339
	colBool     exportColType = "bool"
)

// exportCol is one column of an export, in the order it will appear.
//
// Expr is the SQL that produces it. It is never serialised to the client and is
// never built from request input — a caller selects columns by Key, and an
// unrecognised Key is rejected rather than interpolated. That is the only thing
// standing between "let the user pick their columns" and SQL injection.
type exportCol struct {
	Key   string        `json:"key"`   // the SQL result key, and what callers select by
	Label string        `json:"label"` // the header written to the file
	Type  exportColType `json:"type"`
	Expr  string        `json:"-"` // SQL expression; defaults to Key when empty
}

// sql returns the SELECT fragment for this column.
func (c exportCol) sql() string {
	if c.Expr == "" {
		return c.Key
	}
	return c.Expr + " AS " + c.Key
}

// exportFormat is the file format requested by the caller.
type exportFormat string

const (
	fmtCSV  exportFormat = "csv"
	fmtXLSX exportFormat = "xlsx"
	fmtJSON exportFormat = "json"
)

func parseExportFormat(s string) (exportFormat, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "csv":
		return fmtCSV, true
	case "xlsx", "excel":
		return fmtXLSX, true
	case "json":
		return fmtJSON, true
	}
	return "", false
}

func (f exportFormat) ext() string {
	switch f {
	case fmtXLSX:
		return "xlsx"
	case fmtJSON:
		return "json"
	}
	return "csv"
}

func (f exportFormat) contentType() string {
	switch f {
	case fmtXLSX:
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case fmtJSON:
		return "application/json"
	}
	return "text/csv; charset=utf-8"
}

// ── Value formatting ──────────────────────────────────────────────────────────

// exportValue renders one cell as a string. A nil is the empty string: the old
// fmt.Sprintf("%v", v) path wrote the literal "<nil>" into finance exports.
func exportValue(v any, t exportColType) string {
	if v == nil {
		return ""
	}
	switch t {
	case colKobo:
		return strconv.FormatFloat(toFloat(v)/100.0, 'f', 2, 64)
	case colMoney:
		return strconv.FormatFloat(toFloat(v), 'f', 2, 64)
	case colPct:
		return strconv.FormatFloat(toFloat(v), 'f', 2, 64)
	case colInt:
		return strconv.FormatInt(toInt64(v), 10)
	case colBool:
		if b, ok := v.(bool); ok {
			if b {
				return "Yes"
			}
			return "No"
		}
	case colDate:
		if ts, ok := v.(time.Time); ok {
			return ts.Format("2006-01-02")
		}
	case colDateTime:
		if ts, ok := v.(time.Time); ok {
			return ts.UTC().Format(time.RFC3339)
		}
	}
	if ts, ok := v.(time.Time); ok {
		return ts.UTC().Format(time.RFC3339)
	}
	return fmt.Sprintf("%v", v)
}

// exportNumeric reports whether a column should be written to XLSX as a number
// rather than text, so totals and sorting work in the spreadsheet.
func exportNumeric(t exportColType) bool {
	switch t {
	case colKobo, colMoney, colInt, colPct:
		return true
	}
	return false
}

// csvSafe neutralises spreadsheet formula injection. See the note at the top of
// this file for why this is CSV-only.
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

// ── Filename ──────────────────────────────────────────────────────────────────

// exportFilename builds a safe, dated filename. The header value is quoted, so a
// name containing a quote or newline could otherwise inject response headers.
func exportFilename(base string, f exportFormat) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '-', r == '_':
			return r
		}
		return '-'
	}, base)
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "export"
	}
	return fmt.Sprintf("%s_%s.%s", safe, time.Now().UTC().Format("20060102-150405"), f.ext())
}

// ── The writer ────────────────────────────────────────────────────────────────

// writeExport streams rows to the client in the requested format. Column order
// is exactly the order of cols.
func writeExport(w http.ResponseWriter, f exportFormat, filename string, cols []exportCol, rows []map[string]any) error {
	w.Header().Set("Content-Type", f.contentType())
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	// The browser cannot see this header cross-origin without it being exposed;
	// the Data Export page reads it to show the true filename in its history.
	w.Header().Set("X-Export-Filename", filename)
	w.Header().Set("X-Export-Rows", strconv.Itoa(len(rows)))

	switch f {
	case fmtJSON:
		return writeExportJSON(w, cols, rows)
	case fmtXLSX:
		return writeExportXLSX(w, cols, rows)
	default:
		return writeExportCSV(w, cols, rows)
	}
}

func writeExportCSV(w io.Writer, cols []exportCol, rows []map[string]any) error {
	cw := csv.NewWriter(w)
	header := make([]string, len(cols))
	for i, c := range cols {
		header[i] = c.Label
	}
	if err := cw.Write(header); err != nil {
		return err
	}
	rec := make([]string, len(cols))
	for _, row := range rows {
		for i, c := range cols {
			rec[i] = csvSafe(exportValue(row[c.Key], c.Type))
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}

func writeExportJSON(w io.Writer, cols []exportCol, rows []map[string]any) error {
	// Re-projected through cols so the JSON carries exactly the requested
	// columns — never the whole row, which would leak unselected fields.
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		o := make(map[string]any, len(cols))
		for _, c := range cols {
			v := row[c.Key]
			if v == nil {
				o[c.Key] = nil
				continue
			}
			switch c.Type {
			case colKobo:
				o[c.Key] = toFloat(v) / 100.0
			case colMoney, colPct:
				o[c.Key] = toFloat(v)
			case colInt:
				o[c.Key] = toInt64(v)
			default:
				o[c.Key] = exportValue(v, c.Type)
			}
		}
		out = append(out, o)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(map[string]any{
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"row_count":    len(out),
		"columns":      cols,
		"data":         out,
	})
}

// ── Minimal XLSX writer ───────────────────────────────────────────────────────
//
// An .xlsx file is a zip of XML parts. Writing the five required parts directly
// keeps this dependency-free, which matters for an on-prem financial backend
// where every third-party module is another thing to audit and keep patched.
// Strings are written as inline strings (t="inlineStr"), which avoids the
// shared-strings table entirely and — because the cell is explicitly typed as a
// string — means a value like "=1+1" is displayed, never evaluated.

func colLetters(n int) string {
	// 0 → A, 25 → Z, 26 → AA
	name := ""
	n++
	for n > 0 {
		n--
		name = string(rune('A'+(n%26))) + name
		n /= 26
	}
	return name
}

func writeExportXLSX(w io.Writer, cols []exportCol, rows []map[string]any) error {
	zw := zip.NewWriter(w)

	add := func(name, body string) error {
		f, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(f, body)
		return err
	}

	if err := add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`+
		`<Default Extension="xml" ContentType="application/xml"/>`+
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`+
		`<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`+
		`</Types>`); err != nil {
		return err
	}

	if err := add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`+
		`</Relationships>`); err != nil {
		return err
	}

	if err := add("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `+
		`xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`+
		`<sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`); err != nil {
		return err
	}

	if err := add("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>`+
		`</Relationships>`); err != nil {
		return err
	}

	// The sheet is streamed rather than built in memory — a 1.1m-row card
	// transaction export must not be materialised as one giant string.
	sheet, err := zw.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(sheet, 64*1024)
	esc := func(s string) string {
		var b strings.Builder
		xml.EscapeText(&b, []byte(s)) //nolint:errcheck
		return b.String()
	}

	fmt.Fprint(bw, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)

	// Header row
	fmt.Fprint(bw, `<row r="1">`)
	for i, c := range cols {
		fmt.Fprintf(bw, `<c r="%s1" t="inlineStr"><is><t>%s</t></is></c>`, colLetters(i), esc(c.Label))
	}
	fmt.Fprint(bw, `</row>`)

	for rIdx, row := range rows {
		fmt.Fprintf(bw, `<row r="%d">`, rIdx+2)
		for i, c := range cols {
			ref := fmt.Sprintf("%s%d", colLetters(i), rIdx+2)
			v := row[c.Key]
			if v == nil {
				continue // an omitted cell is a blank cell
			}
			val := exportValue(v, c.Type)
			if exportNumeric(c.Type) {
				// Guard against a non-numeric sneaking in and producing a
				// corrupt file that Excel refuses to open at all.
				if _, err := strconv.ParseFloat(val, 64); err == nil {
					fmt.Fprintf(bw, `<c r="%s"><v>%s</v></c>`, ref, val)
					continue
				}
			}
			fmt.Fprintf(bw, `<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, esc(val))
		}
		fmt.Fprint(bw, `</row>`)
	}

	fmt.Fprint(bw, `</sheetData></worksheet>`)
	if err := bw.Flush(); err != nil {
		return err
	}
	return zw.Close()
}
