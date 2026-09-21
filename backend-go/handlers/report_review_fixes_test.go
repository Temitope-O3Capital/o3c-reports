package handlers

import (
	"bytes"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/o3c/workspace/core"
)

// Pins the fixes from the Report Builder review of 15 Sep 2026.

func TestExportValueKeepsDecimalsAndLabels(t *testing.T) {
	// An average of a whole-number field comes back from Postgres as NUMERIC text.
	if got := exportValue("12.50", colInt); got != "12.5" {
		t.Errorf("average in an int column: got %q, want 12.5", got)
	}
	if got := exportValue(int64(42), colInt); got != "42" {
		t.Errorf("int: got %q", got)
	}
	// A totals label sitting in a numeric column stays text.
	for _, typ := range []exportColType{colInt, colKobo, colMoney, colPct} {
		if got := exportValue("Total of 3 Records", typ); got != "Total of 3 Records" {
			t.Errorf("label in %s column: got %q", typ, got)
		}
	}
}

func TestCSVKeepsNegativeNumbersAndGuardsFormulas(t *testing.T) {
	cols := []exportCol{{Key: "amount", Label: "Amount", Type: colMoney}, {Key: "note", Label: "Note", Type: colText}}
	rows := []map[string]any{{"amount": "-5000", "note": "=HYPERLINK(\"x\")"}, {"amount": "-12.5", "note": "-refund"}}
	var buf bytes.Buffer
	if err := writeExportCSV(&buf, cols, rows); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	if !strings.Contains(out, "\n-5000.00,") || !strings.Contains(out, "\n-12.50,") {
		t.Errorf("negative amounts must stay numbers:\n%s", out)
	}
	if !strings.Contains(out, `'=HYPERLINK`) || !strings.Contains(out, "'-refund") {
		t.Errorf("text starting with a formula character must still be guarded:\n%s", out)
	}
}

func TestTotalsRowLabelSkipsTotalledColumns(t *testing.T) {
	res := tableResult{
		Cols:   []exportCol{{Key: "amount", Type: colKobo}, {Key: "count", Type: colInt}, {Key: "name", Type: colText}},
		Total:  7,
		Totals: map[string]any{"amount": "1500", "count": "9"},
	}
	row := tableTotalsRow(res, []string{"amount"})
	if row["amount"] != "1500" {
		t.Errorf("amount total: %v", row["amount"])
	}
	if row["count"] != "Total of 7 Records" {
		t.Errorf("label should sit in the first column that isn't totalled, got %v", row)
	}
	if _, ok := row["name"]; ok {
		t.Errorf("only one label: %v", row)
	}
	rep := renderedReport{Rows: []map[string]any{{}, {}, row}, TotalsRow: true}
	if rep.RecordCount() != 2 {
		t.Errorf("record count leaves out the totals line: %d", rep.RecordCount())
	}
}

func reviewDataset() exportDataset {
	return exportDataset{
		Key: "review", From: "app.things x", OrderBy: "x.created_at DESC", KeyCol: "x.id",
		Cols: []exportCol{
			{Key: "name", Label: "Name", Type: colText, Expr: "x.name"},
			{Key: "amount", Label: "Amount", Type: colKobo, Expr: "x.amount_kobo"},
			{Key: "opened", Label: "Opened", Type: colDate, Expr: "x.opened"},
			{Key: "at", Label: "At", Type: colDateTime, Expr: "x.at"},
			{Key: "flag", Label: "Flag", Type: colBool, Expr: "x.flag"},
			{Key: "rate", Label: "Rate", Type: colPct, Expr: "x.rate"},
		},
	}
}

func TestColumnFiltersReviewFixes(t *testing.T) {
	d := reviewDataset()
	where, args, err := buildExportWhere(d, exportRequest{ColFilters: []colFilter{
		{Column: "name", Op: "ne", Value: "Interested"},
		{Column: "name", Op: "contains", Value: "50%_off"},
		{Column: "amount", Op: "gte", Value: "₦1,000"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	sqlText := strings.Join(where, "\n")
	if !strings.Contains(sqlText, "IS DISTINCT FROM") {
		t.Errorf("'is not' must keep blank rows: %s", sqlText)
	}
	if !strings.Contains(sqlText, `ESCAPE '\'`) || args[1] != `50\%\_off` {
		t.Errorf("LIKE wildcards must match themselves: %s %v", sqlText, args)
	}
	if args[2] != "1000" {
		t.Errorf("money typed with a comma and ₦: got %v", args[2])
	}

	bad := []colFilter{
		{Column: "amount", Op: "gte", Value: "abc"},
		{Column: "opened", Op: "eq", Value: "14/09/2026"},
		{Column: "at", Op: "gte", Value: "yesterday"},
		{Column: "amount", Op: "in", Values: []string{"100", "lots"}},
	}
	for _, f := range bad {
		if _, _, err := buildExportWhere(d, exportRequest{ColFilters: []colFilter{f}}); err == nil {
			t.Errorf("%s %s %q%v should be refused", f.Column, f.Op, f.Value, f.Values)
		}
	}
	if _, _, err := buildExportWhere(d, exportRequest{ColFilters: []colFilter{{Column: "at", Op: "lte", Value: "2026-09-14T18:00"}}}); err != nil {
		t.Errorf("datetime-local value refused: %v", err)
	}
}

func TestTableOrderEndsWithUniqueKey(t *testing.T) {
	tq, err := buildTableQuery(reviewDataset(), tableSpec{Columns: []tableColumn{{Key: "name"}}, Sort: []reportSort{{Key: "amount", Dir: "desc"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tq.Select, "ORDER BY (x.amount_kobo) DESC NULLS LAST, x.created_at DESC, x.id\n") {
		t.Errorf("paging needs the unique key last:\n%s", tq.Select)
	}
	for _, d := range exportDatasets {
		if d.KeyCol == "" {
			t.Errorf("data source %s has no KeyCol", d.Key)
		}
	}
}

func TestPivotRefusesMeaninglessAggregates(t *testing.T) {
	d := reviewDataset()
	for _, v := range []pivotValue{{Column: "flag", Agg: "max"}, {Column: "flag", Agg: "min"}, {Column: "rate", Agg: "sum"}} {
		_, err := runPivot(t.Context(), nil, d, pivotSpec{Rows: []string{"name"}, Values: []pivotValue{v}})
		var ue pivotUserError
		if !errors.As(err, &ue) {
			t.Errorf("%s of %s should be a user error, got %v", v.Agg, v.Column, err)
		}
	}
}

func TestScheduleOwnerRules(t *testing.T) {
	if scheduleOwnerID(int64(0), int64(9)) != 9 || scheduleOwnerID(int64(4), int64(9)) != 4 {
		t.Error("schedule owner is its creator, else the report's owner")
	}
	bi := &core.Claims{ID: 4, Role: "bi_analyst", Pages: []string{"reports"}}
	row := core.Row{"dataset": "helpdesk_calls", "is_public": false, "report_created_by": int64(9)}
	if p := scheduleOwnerProblem(bi, row); p == "" {
		t.Error("a private report of someone else must not send as this owner")
	}
	row["is_public"] = true
	if p := scheduleOwnerProblem(bi, row); p != "" {
		t.Errorf("shared report: %s", p)
	}
	if p := scheduleOwnerProblem(nil, row); p == "" {
		t.Error("a deactivated owner can't send")
	}
	head := &core.Claims{ID: 5, Role: "cards_head", Pages: []string{"report_builder", "cards"}}
	if p := scheduleOwnerProblem(head, row); p == "" {
		t.Error("a cards head can't send call-centre data")
	}
}

// TestEveryDatasetTablePagesLive runs one Table page of every data source against the
// database, sorted by its first column, so each KeyCol and OrderBy is proven to exist.
// Read-only.
func TestEveryDatasetTablePagesLive(t *testing.T) {
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
	to := time.Now().Format("2006-01-02")
	from := time.Now().AddDate(0, 0, -2).Format("2006-01-02")
	for _, d := range exportDatasets {
		spec := tableSpec{Columns: []tableColumn{{Key: d.Cols[0].Key}}, Sort: []reportSort{{Key: d.Cols[0].Key, Dir: "asc"}}, Limit: 2, Offset: 1}
		if d.DateCol != "" {
			spec.DateFrom, spec.DateTo = from, to
		}
		if _, err := runTable(t.Context(), db, d, spec, false); err != nil {
			t.Errorf("%s: %v", d.Key, err)
		}
	}
}
